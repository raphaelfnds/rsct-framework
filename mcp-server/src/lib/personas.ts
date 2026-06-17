/**
 * F3 personas — the L3 layer of the rsct-mcp consciousness stack.
 *
 * 5 personas at MVP (per project_mcp-consciousness design):
 * Architect, Senior Dev, QA, DevOps, Security. Each is a static
 * lens — a curated set of focus areas, questions, anti-patterns, and
 * suggested knowledge categories Claude consults when reviewing a
 * subject under that persona.
 *
 * Personas are READ-ONLY: tools that surface them (rsct_persona_review,
 * rsct_auto_persona) do not §C-gate and do not persist state.
 * Persona ACTIVATION (a future tool that would write phase-state.json
 * with the chosen persona) is parked — the per-call shape proved
 * sufficient for v1.
 *
 * The `persona?` parameter on phase _start tools has been plumbed
 * through to the audit log since v0.3.0 (`requested_persona`); F3
 * makes the slug meaningful by mapping it to a lens here.
 */

export type PersonaSlug =
  | 'architect'
  | 'senior-dev'
  | 'qa'
  | 'devops'
  | 'security'
  | 'tutor'

export interface Persona {
  slug: PersonaSlug
  name: string
  one_liner: string
  focus_areas: string[]
  questions_to_ask: string[]
  anti_patterns_to_check: string[]
  knowledge_categories_to_consult: string[]
  /**
   * Keywords for `rsct_auto_persona` matching. Substring (case-insensitive)
   * against the task_description; each hit is one signal.
   */
  keywords: string[]
  /**
   * When `false`, `rsct_auto_persona` excludes this persona from
   * recommendation ranking (it remains queryable via `rsct_persona_review`).
   * Used for opt-in-only personas like Tutor: per the memory design,
   * Tutor must be activated deliberately, not automatically picked.
   * Defaults to `true` when absent.
   */
  auto_pickable?: boolean
}

export const PERSONAS: readonly Persona[] = [
  {
    slug: 'architect',
    name: 'Architect',
    one_liner:
      'Evaluates changes against system boundaries, contracts, coupling, and downstream blast radii.',
    focus_areas: [
      'system design',
      'module boundaries',
      'data flow',
      'contracts',
      'coupling',
      'layer separation',
    ],
    questions_to_ask: [
      'Which modules does this couple to, and are those couplings new?',
      'Does it violate any architecture invariants documented in architecture.md or impact/*.md?',
      'What is the rollback path if this fails in production?',
      'Does this introduce new layer dependencies (e.g., domain importing infra)?',
      'What is the blast radius of changes to this file (count of importers, transitive consumers)?',
    ],
    anti_patterns_to_check: [
      'God object — single class doing too many unrelated things',
      'Circular dependencies between modules or layers',
      'Tight coupling to volatile external interfaces without a port/adapter',
      'Hidden state shared across layers (singleton magic, ambient context)',
      'Re-implementing functionality that already exists as a library or service',
    ],
    knowledge_categories_to_consult: [
      'anti-decisions',
      'vendor-relationships',
      'cost-constraints',
    ],
    keywords: [
      // English
      'architecture',
      'architect',
      'design',
      'boundary',
      'boundaries',
      'contract',
      'coupling',
      'layer',
      'module',
      'rearchitect',
      'redesign',
      'refactor across',
      'restructure',
      'migration',
      // English — expanded (CAP-6 EN mirror)
      'decouple',
      'decoupling',
      'clean architecture',
      'hexagonal architecture',
      'onion architecture',
      'aggregate',
      'adapter',
      'port',
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
      'arquiteto',
      'desenho',
      'fronteira',
      'fronteiras',
      'contrato',
      'acoplamento',
      'camada',
      'módulo',
      'redesenhar',
      'reformular',
      'reestruturar',
      'refatorar em',
      'migração',
      // Architecture pt-BR specific (Cat C)
      'camadas',
      'ddd',
      'domain-driven',
      'bounded context',
      'contexto delimitado',
      'agregado',
      'adaptador',
      'porta',
      'solid',
      'single responsibility',
      'clean architecture',
      'arquitetura hexagonal',
      'arquitetura limpa',
      'inversão de dependência',
      'baixo acoplamento',
      'alta coesão',
    ],
  },
  {
    slug: 'senior-dev',
    name: 'Senior Dev',
    one_liner:
      'Evaluates code quality, patterns, readability, and consistency with the existing codebase.',
    focus_areas: [
      'code style',
      'maintainability',
      'patterns',
      'idioms',
      'error handling',
      'testability',
    ],
    questions_to_ask: [
      'Is this consistent with how similar problems are solved elsewhere in the codebase?',
      'Are errors handled at the appropriate boundary, not paved over with try-catch-ignore?',
      'Will this be readable by someone joining the team in 6 months?',
      'Is there a simpler way to express this logic?',
      'Are there hidden complexities (implicit ordering, race conditions, lazy initialization)?',
    ],
    anti_patterns_to_check: [
      'Copy-paste duplication of existing utilities',
      'Premature abstraction (interface for one implementation)',
      'Inconsistent naming or style with adjacent files',
      'Magic numbers or strings without constants',
      'Mutable shared state without synchronization',
    ],
    knowledge_categories_to_consult: [
      'anti-decisions',
      'business-rules',
      'workflow-rituals',
    ],
    keywords: [
      // English
      'refactor',
      'cleanup',
      'readability',
      'code quality',
      'patterns',
      'style',
      'consistency',
      'duplication',
      'idiom',
      // English — expanded (CAP-6 EN mirror)
      'clean code',
      'tech debt',
      'code smell',
      'antipattern',
      'anti-pattern',
      'dry',
      'kiss',
      'yagni',
      'design pattern',
      'best practices',
      'rewrite',
      'simplify',
      'generalize',
      'generalise',
      'encapsulate',
      'abstract',
      'abstraction',
      // pt-BR formal
      'refatorar',
      'limpar',
      'legibilidade',
      'qualidade',
      'padrão',
      'padrões',
      'estilo',
      'consistência',
      'duplicação',
      'manutenção',
      'manutenibilidade',
      // Code quality pt-BR specific (Cat G)
      'clean code',
      'código limpo',
      'débito técnico',
      'tech debt',
      'code smell',
      'smell de código',
      'antipadrão',
      'antipattern',
      'padrão de projeto',
      'design pattern',
      'boas práticas',
      'melhores práticas',
      'reescrever',
      'simplificar',
      'encapsular',
      'modular',
      'generalizar',
    ],
  },
  {
    slug: 'qa',
    name: 'QA',
    one_liner:
      'Evaluates test coverage, edge cases, regression risk, and observability.',
    focus_areas: [
      'test coverage',
      'edge cases',
      'happy path vs failure paths',
      'observability',
      'regression risk',
    ],
    questions_to_ask: [
      'What edge cases is this not handling (empty inputs, null, max sizes, concurrency)?',
      'How will failures be observed in production (logs, metrics, alerts)?',
      'What regression risk does this introduce (which existing flows could break)?',
      'Are the new tests reproducing the original bug deterministically?',
      'Are integration test seams visible enough to exercise without heavy mocking?',
    ],
    anti_patterns_to_check: [
      'Tests that only cover the happy path',
      'Tests that mock the system under test (testing the mock, not the code)',
      'Untestable async code (no seams for fake time / cancellation)',
      'Snapshot tests that obscure the change being verified',
      'Tests without observable assertions (just "should not throw")',
    ],
    knowledge_categories_to_consult: [
      'incident-log',
      'domain-edge-cases',
      'business-rules',
    ],
    keywords: [
      // English
      'test',
      'edge case',
      'regression',
      'qa',
      'validation',
      'coverage',
      'verify',
      'reproduce',
      'snapshot',
      'integration test',
      'unit test',
      // English — expanded (CAP-6 EN mirror)
      'e2e test',
      'end-to-end test',
      'bdd',
      'tdd',
      'contract test',
      'mutation testing',
      'fuzz test',
      'chaos test',
      'chaos engineering',
      'load test',
      'stress test',
      'soak test',
      'a/b test',
      'acceptance criteria',
      'code coverage',
      'branch coverage',
      'line coverage',
      'fake',
      'spy',
      // pt-BR formal
      'teste',
      'testes',
      'caso de borda',
      'caso limite',
      'regressão',
      'validação',
      'cobertura',
      'verificar',
      'reproduzir',
      'asserção',
      'mock',
      'teste de integração',
      'teste unitário',
      // QA pt-BR specific (Cat F)
      'cenário de teste',
      'caso de teste',
      'caso de uso',
      'critério de aceitação',
      'definição de pronto',
      'dod',
      'teste e2e',
      'teste fim a fim',
      'smoke test',
      'teste de fumaça',
      'fixture',
      'stub',
      'code coverage',
      'cobertura de código',
      'cenário feliz',
      'caminho infeliz',
      'happy path',
    ],
  },
  {
    slug: 'devops',
    name: 'DevOps',
    one_liner:
      'Evaluates infrastructure impact, deploy ordering, rollback paths, and operational cost.',
    focus_areas: [
      'infrastructure impact',
      'deploy ordering',
      'rollback paths',
      'operational cost',
      'observability',
      'capacity',
    ],
    questions_to_ask: [
      'Does this require a config / secret change in the deploy pipeline?',
      'What is the deploy ordering vs other services (who must ship first)?',
      'Can this be rolled back without data migration?',
      'What is the resource cost (CPU / memory / storage / network egress)?',
      'How does this affect the runtime SLOs and monitoring?',
    ],
    anti_patterns_to_check: [
      'Hardcoded environment URLs, paths, or region identifiers',
      'Implicit assumptions about deploy order between services',
      'Long-running operations without timeouts or circuit breakers',
      'Schema changes without backward-compat shims',
      'Logs without correlation IDs in distributed systems',
    ],
    knowledge_categories_to_consult: [
      'cost-constraints',
      'vendor-relationships',
      'incident-log',
    ],
    keywords: [
      // English
      'deploy',
      'deployment',
      'infra',
      'infrastructure',
      'kubernetes',
      'k8s',
      'docker',
      'ci',
      'cd',
      'pipeline',
      'rollback',
      'cost',
      'observability',
      'monitoring',
      'metric',
      'alert',
      'slo',
      'capacity',
      // English — expanded (CAP-6 EN mirror)
      'spin up',
      'tear down',
      'spin down',
      'roll out',
      'roll back',
      'canary',
      'canary release',
      'canary deploy',
      'blue-green',
      'blue/green',
      'shadow traffic',
      'staging',
      'prod',
      'production',
      'iac',
      'terraform',
      'ansible',
      'puppet',
      'chef',
      'argocd',
      'fluxcd',
      'prometheus',
      'grafana',
      'kibana',
      'elastic',
      'splunk',
      'pagerduty',
      'opsgenie',
      'runbook',
      'postmortem',
      'post-mortem',
      'on-call',
      'oncall',
      'sre',
      'error budget',
      'latency',
      'p99',
      'p95',
      'p50',
      'throughput',
      'rps',
      'qps',
      // pt-BR formal
      'implantação',
      'implantar',
      'infraestrutura',
      'pipeline',
      'reversão',
      'custo',
      'observabilidade',
      'monitoramento',
      'monitorar',
      'métrica',
      'alerta',
      'capacidade',
      'rolar de volta',
      // DevOps pt-BR specific (Cat E)
      'subir aplicação',
      'subir serviço',
      'derrubar',
      'rolar deploy',
      'promover release',
      'voltar versão',
      'reverter',
      'hotfix',
      'hot fix',
      'esteira de deploy',
      'esteira ci/cd',
      'cluster',
      'pod',
      'helm chart',
      'service mesh',
      'balanceador',
      'load balancer',
      'cache hit',
      'hit rate',
      'ttl',
      'timeout',
      'circuit breaker',
    ],
  },
  {
    slug: 'security',
    name: 'Security',
    one_liner:
      'Evaluates secret handling, injection vectors, auth/authz boundaries, and data exposure.',
    focus_areas: [
      'secret handling',
      'injection vectors',
      'auth/authz boundaries',
      'data exposure',
      'supply chain',
    ],
    questions_to_ask: [
      'Are user inputs validated and escaped at every trust boundary?',
      'Is sensitive data logged, cached, or echoed unintentionally?',
      'What is the auth/authz check for this code path? Where does it live?',
      'Does this introduce a new dependency? Is its supply chain trusted?',
      'Could this be abused for resource exhaustion or amplification?',
    ],
    anti_patterns_to_check: [
      'String concatenation of user input into SQL / HTML / shell commands',
      'Hardcoded credentials or API keys',
      'Trust-on-first-use without verification',
      'Permissive CORS or unsigned tokens',
      'Crypto rolled by hand instead of vetted library primitives',
    ],
    knowledge_categories_to_consult: [
      'anti-decisions',
      'incident-log',
      'vendor-relationships',
    ],
    keywords: [
      // English
      'auth',
      'authentication',
      'authorization',
      'login',
      'logout',
      'secret',
      'credential',
      'token',
      'encrypt',
      'encryption',
      'security',
      'vulnerability',
      'injection',
      'xss',
      'csrf',
      'rbac',
      'rls',
      'sso',
      'jwt',
      'oauth',
      // English — expanded (CAP-6 EN mirror)
      'threat model',
      'threat modeling',
      'attack surface',
      'privilege escalation',
      'privesc',
      'rce',
      'remote code execution',
      'ssrf',
      'server-side request forgery',
      'owasp top 10',
      'csp',
      'content security policy',
      'hsts',
      'https',
      'tls',
      'mtls',
      'zero trust',
      'least privilege',
      'defense in depth',
      'input validation',
      'output encoding',
      'command injection',
      'path traversal',
      'session fixation',
      'session hijacking',
      'replay attack',
      // pt-BR formal
      'autenticação',
      'autenticar',
      'autorização',
      'autorizar',
      'login',
      'logout',
      'segredo',
      'credencial',
      'credenciais',
      'criptografia',
      'criptografar',
      'segurança',
      'vulnerabilidade',
      'injeção',
      'vazamento',
      'exposição',
      'acesso indevido',
      // Security pt-BR specific (Cat D)
      'hash',
      'hashear',
      'salt',
      'bcrypt',
      'argon2',
      'oauth2',
      'oidc',
      'saml',
      'mfa',
      '2fa',
      'validação de entrada',
      'sanitização',
      'escapar input',
      'escapar string',
      'owasp',
      'brute force',
      'força bruta',
      'ataque',
      'sql injection',
      'não autorizado',
      'não autenticado',
      'token expirado',
      'token revogado',
      'refresh token',
      'access token',
    ],
  },
  {
    slug: 'tutor',
    name: 'Tutor',
    one_liner:
      'Interactive step-by-step facilitator. Proposes ONE step at a time, waits for the dev to execute or consent, observes the result, proposes the next step. Use for learning, live production work, sensitive ops, and code reviews where every change deserves a deliberate beat.',
    focus_areas: [
      'one step at a time',
      'human-in-the-loop pacing',
      'explicit consent per action',
      'observation before next step',
      'understanding over speed',
    ],
    questions_to_ask: [
      'What is the smallest next step that produces an observable signal?',
      'Did the dev consent to executing this step, or do they want to run it themselves?',
      'What did the result of the previous step actually show — should the next step adapt?',
      'Are these read-only commands batchable in one beat, or must each run separately?',
      'Is the dev still tracking, or should I pause and recap?',
    ],
    anti_patterns_to_check: [
      'Chaining multiple mutations without per-step consent',
      'Skipping ahead because the next step "feels obvious"',
      'Long autonomous loops without checking back in',
      'Hiding intermediate output behind a summary instead of showing the raw result',
      'Mixing read-only and mutating commands in the same batch',
    ],
    knowledge_categories_to_consult: [
      'workflow-rituals',
      'incident-log',
      'team-capabilities',
    ],
    keywords: [
      // English
      'tutor',
      'step by step',
      'step-by-step',
      'walk through',
      'walkthrough',
      'teach me',
      'show me',
      'learn',
      'debug live',
      'production',
      'manual',
      'guide',
      // English — expanded (CAP-6 EN mirror)
      'mentor',
      'mentoring',
      'pair programming',
      'pair',
      'explain',
      // pt-BR
      'me ensine',
      'me ensina',
      'me mostre',
      'me mostra',
      'passo a passo',
      'passo-a-passo',
      'me guie',
      'me guia',
      'aprender',
      'debug ao vivo',
      'produção',
      'guia',
      'tutorial',
    ],
    auto_pickable: false,
  },
] as const

export const PERSONA_SLUGS: readonly PersonaSlug[] = PERSONAS.map(
  (p) => p.slug,
) as readonly PersonaSlug[]

export function getPersonaBySlug(slug: string): Persona | null {
  return PERSONAS.find((p) => p.slug === slug) ?? null
}

export interface PersonaMatchScore {
  persona: PersonaSlug
  name: string
  score: number
  matched_keywords: string[]
}

/**
 * Substring (case-insensitive) keyword match against subject text.
 * Returns a ranked list — highest score first. Personas with zero
 * matches are dropped. Personas with `auto_pickable: false` (e.g.,
 * Tutor) are EXCLUDED from the ranking entirely — they remain
 * queryable via `getPersonaBySlug` and `rsct_persona_review`, but
 * `rsct_auto_persona` will not recommend them. This implements the
 * "opt-in only" contract for Tutor per the M3 design.
 */
export function scorePersonas(subject: string): PersonaMatchScore[] {
  const lower = subject.toLowerCase()
  const scores: PersonaMatchScore[] = []
  for (const persona of PERSONAS) {
    if (persona.auto_pickable === false) continue
    const matched: string[] = []
    for (const kw of persona.keywords) {
      if (lower.includes(kw)) matched.push(kw)
    }
    if (matched.length === 0) continue
    scores.push({
      persona: persona.slug,
      name: persona.name,
      score: matched.length,
      matched_keywords: matched,
    })
  }
  scores.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.persona.localeCompare(b.persona)
  })
  return scores
}
