import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import { findActivePlan } from '../lib/plan.js'
import { type RsctPhase } from '../lib/phase-machine.js'
import { stampClassifyVerdict } from '../lib/phase-scope.js'
import { appendAuditEntry } from '../lib/audit-log.js'

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

const ARCHITECTURE_KEYWORDS = [
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
  'rename across',
  'replace all',
  'update all',
  'refactor across',
  'every file',
  'all files',
  'all callers',
  'across the codebase',
  'across packages',
  'repository-wide',
  'project-wide',
  'system-wide',
  'throughout the codebase',
  'in all modules',
  'in all packages',
  'in every module',
  'in every package',
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
  'fix typo',
  'fix a typo',
  'rename a comment',
  'update comment',
  'update a comment',
  'docs',
  'readme',
  'documentation',
  'one-liner',
  'comment fix',
  'formatting fix',
  'whitespace',
  'spelling',
  'spell check',
  'corrigir typo',
  'corrigir erro de digitação',
  'atualizar comentário',
  'atualizar comentários',
  'documentação',
  'renomear comentário',
]

const CONCERN_LEXICONS: Record<string, readonly string[]> = {
  dto: [
    'dto',
    ' record ',
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

function countSteps(text: string): number {
  const lower = text.toLowerCase()
  const stepMatches = lower.match(/\b(?:passo|step)\s+\d+\b/g) ?? []
  const listMatches = text.match(/(?:^|\n|\s)(\d+)\.\s+\S/g) ?? []
  return Math.max(stepMatches.length, listMatches.length)
}

function detectConcerns(text: string): Set<string> {
  const lower = ` ${text.toLowerCase()} `
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
      reasoning: `Architecture / security keywords detected (${archHits.join(', ')}). Treat as complex — likely cross-cutting, deserves full R→S→V→C→T→REVIEW cycle.`,
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
      reasoning: `Trivial shape (${trivialHits.join(', ')}) and short description (${wordCount} words). No spec or code phases; any code change still owes the mandatory REVIEW before it can be committed.`,
    }
  }
  if (stepCount >= 4) {
    return {
      tier: 'complex',
      signals,
      reasoning: `Multi-step plan detected (${stepCount} numbered steps). Treat as complex — multi-step orchestration warrants R→S→V→C→T→REVIEW.`,
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
      reasoning: `Single mutation verb (${mutationHits.join(', ')}) in a short description (${wordCount} words). Small — collapse R into S; run S→C→T→REVIEW.`,
    }
  }
  return {
    tier: 'standard',
    signals,
    reasoning: `Defaulting to standard — no architecture / multi-file / trivial signals matched the description (${wordCount} words). Full R→S→C→T→REVIEW cycle recommended; consider verification phase if the change touches code with many importers.`,
  }
}

const RECOMMENDED_PHASES: Record<Tier, RsctPhase[]> = {
  trivial: ['review'],
  small: ['spec', 'code', 'test', 'review'],
  standard: ['research', 'spec', 'code', 'test', 'review'],
  complex: ['research', 'spec', 'verification', 'code', 'test', 'review'],
}

export async function classifyTaskHandler(
  rawInput: unknown,
): Promise<ClassifyTaskOutput> {
  const input = classifyTaskInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const { tier, signals, reasoning } = classify(input.task_description)
  const recommended = RECOMMENDED_PHASES[tier]

  const stampHints: string[] = []
  if (resolution.rsct_installed) {
    const stamp = stampClassifyVerdict(resolution.root, {
      tier,
      signalsSummary: signals.join(' | '),
    })
    appendAuditEntry(
      resolution.root,
      { event: 'classify.verdict', tool: 'rsct_classify_task', tier, recorded: stamp.ok },
      resolution.config?.audit,
    )
    if (!stamp.ok) {
      stampHints.push(
        `⚠ tier='${tier}' was NOT recorded (${stamp.reason}): ${stamp.reason === 'unreadable_state' ? stamp.error : stamp.path}. rsct_phase_code_start refuses to start until that file is repaired or deleted.`,
      )
    }
  }

  let activePlan: ClassifyTaskOutput['active_plan'] = null
  if (input.use_active_plan_slug) {
    const plan = findActivePlan(resolution.root)
    if (plan) activePlan = { slug: plan.slug, status: plan.status }
  }

  const hints: string[] = [...stampHints]
  if (tier === 'trivial') {
    hints.push(
      'Trivial tier — no spec or code phases needed. A change that touches code still needs rsct_phase_review_start / _complete before rsct_request_commit accepts it; a docs-only change does not.',
    )
  } else if (tier === 'small') {
    hints.push(
      'Small tier — research can be folded into the spec phase. Start with rsct_phase_spec_start; finish with the tests and then the mandatory REVIEW.',
    )
  } else if (tier === 'standard') {
    hints.push(
      'Standard tier — start with rsct_phase_research_start. The verification step is required before coding: rsct_phase_code_start will refuse until you run rsct_phase_verification_start + _complete (or pass override_verification_skip=true). After the tests, the REVIEW is mandatory: rsct_request_commit refuses code that no completed REVIEW covers.',
    )
  } else {
    hints.push(
      'Complex tier — run the full cycle (research → spec → verification → code → test → review). The verification step is required before coding: rsct_phase_code_start will refuse until verification is complete (or pass override_verification_skip=true). After the tests, the REVIEW is mandatory: rsct_request_commit refuses code that no completed REVIEW covers.',
    )
    hints.push(
      'Complex tier — if this expands into a multi-phase plan whose file groups are DISJOINT, consider running the non-overlapping groups in parallel via separate `git worktree`s: RSCT phase-state, any plan-authorization token, and the anti-reuse store are isolated per worktree (§C). Decide this against the WRITTEN plan — this classifier runs before the plan, so it cannot see the phase count. Phases that share files must stay serial.',
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
