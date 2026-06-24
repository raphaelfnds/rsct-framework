import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import { findActivePlan } from '../lib/plan.js'
import { type RsctPhase } from '../lib/phase-machine.js'
import { stampClassifyVerdict } from '../lib/phase-scope.js'

const TIER_VALUES = ['trivial', 'small', 'standard', 'complex'] as const
type Tier = (typeof TIER_VALUES)[number]

export const classifyTaskInputSchema = z
  .object({
    project_root: z.string().optional(),
    task_description: z
      .string()
      .min(3, 'task_description required (≥3 chars)')
      .describe(
        'Free-form natural-language description of the task. Heuristic v1 scans this text.',
      ),
    use_active_plan_slug: z
      .boolean()
      .default(false)
      .describe(
        'When true, look up the most-recent plan_<slug>.md in the project root and surface the slug + status in the response. Does NOT change the tier.',
      ),
  })
  .strict()

export type ClassifyTaskInput = z.infer<typeof classifyTaskInputSchema>

export interface ClassifyTaskOutput {
  tier: Tier
  reasoning: string
  recommended_phases: RsctPhase[]
  signals: string[]
  active_plan: { slug: string; status: string | null } | null
  hints: string[]
}

export const classifyTaskTool: Tool = {
  name: 'rsct_classify_task',
  description:
    'Heuristic-only task classifier. Scans task_description for keyword signals (architecture / security / multi-file / mutation / docs / typo) AND multi-concern + step-count signals (CAP-29) and returns a tier (trivial|small|standard|complex) + the recommended RSCT phase sequence. Tier recommendations are advisory at this layer; rsct_phase_code_start enforces the V gate mechanically per CAP-28 (standard+complex require completed verification). Optional `use_active_plan_slug` lifts the slug+status of the most-recent plan_<slug>.md into the response for context.',
  inputSchema: {
    type: 'object',
    required: ['task_description'],
    properties: {
      project_root: { type: 'string' },
      task_description: { type: 'string', minLength: 3 },
      use_active_plan_slug: { type: 'boolean', default: false },
    },
    additionalProperties: false,
  },
}

/**
 * Keyword lexicons used by the classify_task heuristic.
 *
 * Multilingual by design (CAP-6 / v0.6.2): each list mixes English and
 * pt-BR (Brazilian Portuguese) terms. Substring match is case-
 * insensitive and language-agnostic — adding more languages later means
 * appending more entries to the existing arrays, not refactoring the
 * matcher. Translation-on-the-fly was deliberately rejected (violates
 * the framework's zero-external-deps premise and adds non-determinism).
 */

const ARCHITECTURE_KEYWORDS = [
  // English — base
  'architecture',
  'redesign',
  'rearchitect',
  'migration',
  'migrate',
  'restructure',
  'refactor across',
  'auth',
  'authentication',
  'authorization',
  'security',
  'encryption',
  'rbac',
  'rls',
  'multi-tenant',
  'multi-region',
  // English — expanded (CAP-6 EN mirror)
  'decouple',
  'decoupling',
  'clean architecture',
  'hexagonal architecture',
  'onion architecture',
  'aggregate',
  'adapter',
  'microservices',
  'monolith',
  'gateway',
  'service mesh',
  'cqrs',
  'event sourcing',
  'event-driven',
  'breaking change',
  'api contract',
  'ports and adapters',
  // pt-BR formal
  'arquitetura',
  'redesenhar',
  'reformular',
  'reestruturar',
  'migração',
  'migrar',
  'refatorar em',
  'autenticação',
  'autorização',
  'segurança',
  'criptografia',
  'multi-tenant',
  'multi-região',
  // Architecture pt-BR specific (Cat C)
  'camadas',
  'ddd',
  'domain-driven',
  'bounded context',
  'contexto delimitado',
  'solid',
  'clean architecture',
  'arquitetura hexagonal',
  'arquitetura limpa',
  'inversão de dependência',
  'baixo acoplamento',
  'alta coesão',
]

const MULTI_FILE_KEYWORDS = [
  // English — base
  'rename across',
  'replace all',
  'update all',
  'refactor across',
  'every file',
  'all files',
  'all callers',
  'across the codebase',
  'across packages',
  // English — expanded (CAP-6 EN mirror)
  'repository-wide',
  'project-wide',
  'system-wide',
  'throughout the codebase',
  'in all modules',
  'in all packages',
  'in every module',
  'in every package',
  // pt-BR
  'renomear em todos',
  'renomear em todo',
  'em todos os arquivos',
  'em todo o projeto',
  'em todo o codebase',
  'em todos os módulos',
  'em vários módulos',
  'em vários arquivos',
  'todos os chamadores',
  'em todos os pacotes',
]

const TRIVIAL_KEYWORDS = [
  // English — base
  'fix typo',
  'fix a typo',
  'rename a comment',
  'update comment',
  'update a comment',
  'docs',
  'readme',
  'documentation',
  // English — expanded (CAP-6 EN mirror)
  'one-liner',
  'comment fix',
  'formatting fix',
  'whitespace',
  'spelling',
  'spell check',
  // pt-BR
  'corrigir typo',
  'corrigir erro de digitação',
  'atualizar comentário',
  'atualizar comentários',
  'documentação',
  'renomear comentário',
]

/**
 * CAP-29: technical-concern lexicon. Each category captures one
 * independent "thing the task touches" (DTO + service + listener +
 * template + test = 5 distinct concerns). When a task description
 * mentions 3 or more concerns, the heuristic upgrades to complex
 * even without architecture keywords — multi-concern tasks need V
 * phase verification regardless of vocabulary used.
 *
 * Lexicon scoped narrowly per category to avoid bleed (e.g., "test"
 * is a TEST concern, not a SERVICE concern). Substring match,
 * case-insensitive, multilingual.
 */
const CONCERN_LEXICONS: Record<string, readonly string[]> = {
  dto: [
    'dto',
    ' record ', // word boundary via spaces — avoids "recorded"
    'schema',
    'entity',
    'value object',
    ' vo ',
    'payload',
  ],
  service: [
    'service',
    'business logic',
    'regra de negócio',
    'regra de negocio',
    'use case',
    'caso de uso',
  ],
  listener: [
    'listener',
    'event handler',
    'evento',
    'event-driven',
    'subscriber',
    'consumer',
    'publisher',
  ],
  template: [
    'template',
    'email template',
    'render',
    ' html ',
    ' view ',
    ' ui ',
  ],
  test: [
    ' test ',
    'unit test',
    'integration test',
    'junit',
    'jest',
    'vitest',
    'assertj',
    'mockito',
    ' mock ',
    'mocking',
  ],
  persistence: [
    ' query ',
    ' sql ',
    'repository',
    'jpa',
    'hibernate',
    'migration',
    'flyway',
    'liquibase',
    'database',
    'banco de dados',
  ],
  api: [
    'endpoint',
    'controller',
    ' rest ',
    'route',
    ' rota ',
    ' http ',
    'webhook',
  ],
}

/**
 * CAP-29: step-count detector. Multi-step plans (4+ numbered steps)
 * indicate orchestration that warrants the full R→S→V→C→REVIEW→T cycle.
 *
 * Matches sequences like "1. foo\n2. bar\n3. baz\n4. qux" (numbered
 * list with dots) OR "passo 1", "step 1" form with at least 4
 * occurrences. Returns the count.
 */
function countSteps(text: string): number {
  const lower = text.toLowerCase()
  // Match "passo N" / "step N" — count distinct integers seen.
  const stepMatches = lower.match(/\b(?:passo|step)\s+\d+\b/g) ?? []
  // Match numbered list lines like "1. foo", "2. bar" — token must be
  // at start of line or after whitespace to avoid false positives like
  // "node 1.2.3" (semver).
  const listMatches = text.match(/(?:^|\n|\s)(\d+)\.\s+\S/g) ?? []
  return Math.max(stepMatches.length, listMatches.length)
}

/**
 * CAP-29: distinct concern categories that hit. Returns the set of
 * category keys (e.g., {'dto', 'service', 'listener'}). Cardinality
 * drives the tier upgrade (≥3 → complex, ===2 → standard).
 */
function detectConcerns(text: string): Set<string> {
  const lower = ` ${text.toLowerCase()} ` // padding so " term " spaces match at edges
  const hit = new Set<string>()
  for (const [category, terms] of Object.entries(CONCERN_LEXICONS)) {
    for (const term of terms) {
      if (lower.includes(term)) {
        hit.add(category)
        break
      }
    }
  }
  return hit
}

const MUTATION_VERBS = [
  // English — base
  'add',
  'implement',
  'fix',
  'change',
  'update',
  'modify',
  'create',
  'remove',
  'delete',
  'rename',
  // English — expanded (CAP-6 EN mirror)
  'refactor',
  'adjust',
  'replace',
  'substitute',
  'enable',
  'disable',
  'handle',
  'process',
  'calculate',
  'list',
  'filter',
  'sort',
  'save',
  'load',
  'send',
  'receive',
  'display',
  'show',
  'restart',
  'patch',
  'push',
  'pull',
  'sync',
  'spin up',
  'tear down',
  'roll out',
  'roll back',
  'restore',
  'rebuild',
  'regenerate',
  'bump',
  'upgrade',
  'downgrade',
  'validate',
  'verify',
  'treat',
  // pt-BR formal
  'adicionar',
  'acrescentar',
  'implementar',
  'corrigir',
  'consertar',
  'alterar',
  'mudar',
  'atualizar',
  'modificar',
  'criar',
  'remover',
  'excluir',
  'deletar',
  'apagar',
  'renomear',
  'ajustar',
  'substituir',
  'refatorar',
  // Brazilian dev jargon (verbiado do inglês — Cat A)
  'pushar',
  'comitar',
  'deployar',
  'dropar',
  'bugar',
  'crashar',
  'logar',
  'mockar',
  'stubbar',
  'lintar',
  // Common spec verbs (curated — Cat B; "permitir"/"garantir" skipped as too generic)
  'validar',
  'verificar',
  'tratar',
  'calcular',
  'listar',
  'filtrar',
  'ordenar',
  'salvar',
  'carregar',
  'enviar',
  'receber',
  'processar',
  'exibir',
  'bloquear',
]

function hits(text: string, terms: readonly string[]): string[] {
  const lower = text.toLowerCase()
  return terms.filter((t) => lower.includes(t))
}

function classify(description: string): {
  tier: Tier
  signals: string[]
  reasoning: string
} {
  const wordCount = description.trim().split(/\s+/).length
  const archHits = hits(description, ARCHITECTURE_KEYWORDS)
  const multiHits = hits(description, MULTI_FILE_KEYWORDS)
  const trivialHits = hits(description, TRIVIAL_KEYWORDS)
  const mutationHits = hits(description, MUTATION_VERBS)
  // CAP-29: new signals
  const concerns = detectConcerns(description)
  const stepCount = countSteps(description)

  const signals: string[] = []
  if (archHits.length > 0) signals.push(`architecture:[${archHits.join(',')}]`)
  if (multiHits.length > 0) signals.push(`multi-file:[${multiHits.join(',')}]`)
  if (trivialHits.length > 0)
    signals.push(`trivial-shape:[${trivialHits.join(',')}]`)
  if (mutationHits.length > 0)
    signals.push(`mutation-verbs:[${mutationHits.join(',')}]`)
  if (concerns.size > 0)
    signals.push(`concerns:[${Array.from(concerns).sort().join(',')}]`)
  if (stepCount > 0) signals.push(`steps:${stepCount}`)
  signals.push(`word_count:${wordCount}`)

  if (archHits.length > 0) {
    return {
      tier: 'complex',
      signals,
      reasoning: `Architecture / security keywords detected (${archHits.join(', ')}). Treat as complex — likely cross-cutting, deserves full R→S→V→C→REVIEW→T cycle.`,
    }
  }
  if (multiHits.length > 0) {
    return {
      tier: 'standard',
      signals,
      reasoning: `Multi-file scope keywords detected (${multiHits.join(', ')}). Treat as standard — runs full cycle with mandatory verification of importer breakage.`,
    }
  }
  if (
    trivialHits.length > 0 &&
    archHits.length === 0 &&
    multiHits.length === 0 &&
    concerns.size === 0 &&
    stepCount < 4 &&
    wordCount < 12
  ) {
    return {
      tier: 'trivial',
      signals,
      reasoning: `Trivial shape (${trivialHits.join(', ')}) and short description (${wordCount} words). Skip phase machine entirely.`,
    }
  }
  // CAP-29: orchestration signals — multi-step plan or multi-concern.
  if (stepCount >= 4) {
    return {
      tier: 'complex',
      signals,
      reasoning: `Multi-step plan detected (${stepCount} numbered steps). Treat as complex — multi-step orchestration warrants R→S→V→C→REVIEW→T.`,
    }
  }
  if (concerns.size >= 3) {
    return {
      tier: 'complex',
      signals,
      reasoning: `${concerns.size} distinct technical concerns detected (${Array.from(concerns).sort().join(', ')}). Treat as complex — touching multiple concerns warrants V phase before code.`,
    }
  }
  if (concerns.size === 2) {
    return {
      tier: 'standard',
      signals,
      reasoning: `Two technical concerns detected (${Array.from(concerns).sort().join(', ')}). Treat as standard — full cycle recommended; V phase strongly advised.`,
    }
  }
  if (mutationHits.length > 0 && wordCount <= 20 && concerns.size <= 1) {
    return {
      tier: 'small',
      signals,
      reasoning: `Single mutation verb (${mutationHits.join(', ')}) in a short description (${wordCount} words). Small — collapse R into S; run S→C→T.`,
    }
  }
  return {
    tier: 'standard',
    signals,
    reasoning: `Defaulting to standard — no architecture / multi-file / trivial signals matched the description (${wordCount} words). Full R→S→C→REVIEW→T cycle recommended; consider verification phase if the change touches code with many importers.`,
  }
}

const RECOMMENDED_PHASES: Record<Tier, RsctPhase[]> = {
  trivial: [],
  small: ['spec', 'code', 'test'],
  // NOTE: 'verification' is deliberately omitted from the standard array
  // (a pre-existing choice — V is still ENFORCED for standard at
  // rsct_phase_code_start regardless of this hint). DX-4 adds 'review'
  // (the code review of the diff) for standard + complex; the recommended
  // cycle is R→S→V→C→REVIEW→T.
  standard: ['research', 'spec', 'code', 'review', 'test'],
  complex: ['research', 'spec', 'verification', 'code', 'review', 'test'],
}

export async function classifyTaskHandler(
  rawInput: unknown,
): Promise<ClassifyTaskOutput> {
  const input = classifyTaskInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const { tier, signals, reasoning } = classify(input.task_description)
  const recommended = RECOMMENDED_PHASES[tier]

  // CAP-30: persist the verdict with tier_max ratchet — phase_code_start
  // reads back the highest tier ever classified for this project state
  // and rejects downgrades (input.spec_tier < tier_max) without explicit
  // override_classify_downgrade. Best-effort write; failures swallowed
  // (classify is read-only at the API contract and never fails on
  // metadata write). Skip when rsct is not installed — no .rsct/ to
  // write into.
  if (resolution.rsct_installed) {
    stampClassifyVerdict(resolution.root, {
      tier,
      signalsSummary: signals.join(' | '),
    })
  }

  let activePlan: ClassifyTaskOutput['active_plan'] = null
  if (input.use_active_plan_slug) {
    const plan = findActivePlan(resolution.root)
    if (plan) activePlan = { slug: plan.slug, status: plan.status }
  }

  const hints: string[] = []
  if (tier === 'trivial') {
    hints.push(
      'Trivial tier — you can skip the phase machine and edit directly (trivial doc-only fixes).',
    )
  } else if (tier === 'small') {
    hints.push(
      'Small tier — research can be folded into the spec phase. Start with rsct_phase_spec_start.',
    )
  } else if (tier === 'standard') {
    hints.push(
      'Standard tier — start with rsct_phase_research_start. The verification step is required before coding: rsct_phase_code_start will refuse until you run rsct_phase_verification_start + _complete (or pass override_verification_skip=true). A code review before tests is strongly recommended: record the decision at rsct_phase_spec_complete via include_review (rsct_phase_test_start enforces it).',
    )
  } else {
    hints.push(
      'Complex tier — run the full cycle (research → spec → verification → code → review → test). The verification step is required before coding: rsct_phase_code_start will refuse until verification is complete (or pass override_verification_skip=true). A code review before tests is strongly recommended: record the decision at rsct_phase_spec_complete via include_review (rsct_phase_test_start enforces it).',
    )
  }
  if (activePlan) {
    hints.push(
      `Active plan detected: ${activePlan.slug} (status: ${activePlan.status ?? 'unknown'}). Pass as spec_ref to phase tools when starting the cycle.`,
    )
  }

  return {
    tier,
    reasoning,
    recommended_phases: recommended,
    signals,
    active_plan: activePlan,
    hints,
  }
}
