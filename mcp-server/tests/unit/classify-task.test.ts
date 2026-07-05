import { describe, it, expect } from 'vitest'

import {
  classifyTaskHandler,
  type ClassifyTaskOutput,
} from '../../src/tools/classify-task.js'

describe('rsct_classify_task — heuristic per tier', () => {
  it('returns trivial for "fix typo" + short description', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'fix typo in error message in handler',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('trivial')
    expect(r.recommended_phases).toEqual([])
  })

  it('returns complex for architecture / security keywords', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'redesign the authentication flow for multi-tenant',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('complex')
    expect(r.recommended_phases).toEqual([
      'research',
      'spec',
      'verification',
      'code',
      'review',
      'test',
    ])
  })

  it('returns standard for multi-file refactor keywords', async () => {
    const r = (await classifyTaskHandler({
      task_description:
        'rename across the codebase the getOrderTotal helper to computeOrderTotal',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('standard')
    expect(r.recommended_phases).toContain('research')
    expect(r.recommended_phases).toContain('spec')
    expect(r.recommended_phases).toContain('code')
    expect(r.recommended_phases).toContain('test')
  })

  it('returns small for simple mutation verbs in a short description', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'add a new field to the OrderResponse DTO',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('small')
    expect(r.recommended_phases).toEqual(['spec', 'code', 'test'])
  })

  it('defaults to standard when no signal hits', async () => {
    const r = (await classifyTaskHandler({
      task_description:
        'investigate the slow response time on the dashboard widget and propose alternatives carefully',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('standard')
  })

  it('emits a tier-specific hint', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'rewrite the authentication subsystem end-to-end',
    })) as ClassifyTaskOutput
    expect(r.hints.some((h) => h.toLowerCase().includes('complex'))).toBe(true)
  })

  it('PH-3: complex tier emits BOTH the verification guidance AND the worktree nudge', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'rewrite the authentication subsystem end-to-end',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('complex')
    // additive, not a replacement — the verification guidance must survive
    expect(r.hints.some((h) => h.includes('rsct_phase_code_start'))).toBe(true)
    // and the worktree nudge is present
    expect(r.hints.some((h) => h.includes('git worktree'))).toBe(true)
    expect(r.hints.length).toBeGreaterThanOrEqual(2)
  })

  it('PH-3: the worktree nudge does NOT leak into standard tier', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'rename OrderService across the codebase and update all callers',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('standard')
    expect(r.hints.some((h) => h.includes('git worktree'))).toBe(false)
  })

  it('PH-3: the worktree nudge does NOT leak into small tier', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'add a new field to the OrderResponse DTO',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('small')
    expect(r.hints.some((h) => h.includes('git worktree'))).toBe(false)
  })

  it('PH-3: the worktree nudge does NOT leak into trivial tier', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'fix typo in readme',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('trivial')
    expect(r.hints.some((h) => h.includes('git worktree'))).toBe(false)
  })

  it('rejects empty / too-short description (zod)', async () => {
    await expect(classifyTaskHandler({ task_description: 'a' })).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      classifyTaskHandler({ task_description: 'add a field', bogus: 'x' }),
    ).rejects.toThrow()
  })

  it('signals include word_count', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'one two three four five six seven eight',
    })) as ClassifyTaskOutput
    expect(r.signals.some((s) => s.startsWith('word_count:'))).toBe(true)
  })
})

describe('rsct_classify_task — pt-BR (CAP-6 / v0.6.2)', () => {
  it('returns small for "adicionar validação de CPF no cadastro de cliente" (real pt-BR dogfood case)', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'adicionar validação de CPF no cadastro de cliente',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('small')
    expect(r.signals.some((s) => s.startsWith('mutation-verbs:'))).toBe(true)
  })

  it('returns complex for pt-BR architecture/security task', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'implementar autenticação JWT com autorização RBAC',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('complex')
  })

  it('returns standard for pt-BR multi-file refactor task', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'renomear em todos os arquivos a função getOrderTotal',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('standard')
  })

  it('returns trivial for pt-BR trivial doc fix', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'corrigir typo na documentação do README',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('trivial')
  })

  it('returns complex for pt-BR refactor across architecture task', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'redesenhar a arquitetura do módulo de pagamentos',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('complex')
  })
})

describe('rsct_classify_task — EN expanded vocabulary (CAP-6 / v0.6.2)', () => {
  it('returns complex for tasks using DDD / CQRS / event sourcing terms', async () => {
    const r = (await classifyTaskHandler({
      task_description:
        'introduce event sourcing and CQRS for the orders aggregate',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('complex')
  })

  it('returns standard for repository-wide / system-wide refactor verbs', async () => {
    const r = (await classifyTaskHandler({
      task_description:
        'normalize logger usage repository-wide and update all callers',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('standard')
  })

  it('returns small for EN extended mutation verbs (refactor/replace/patch)', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'refactor the email validator helper',
    })) as ClassifyTaskOutput
    // Either small (mutation verb match) or default standard — both acceptable
    expect(['small', 'standard']).toContain(r.tier)
  })
})

describe('rsct_classify_task — CAP-29 multi-concern + step-count', () => {
  it('upgrades to complex when 3+ technical concerns detected', async () => {
    // 5 concerns: dto + service + listener + template + test
    const r = (await classifyTaskHandler({
      task_description:
        'criar novo DTO ItemReprovadoExibicaoDTO, adicionar service para enviar email com template HTML, registrar listener de evento e cobrir com unit test',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('complex')
    expect(r.signals.some((s) => s.startsWith('concerns:['))).toBe(true)
    expect(r.reasoning.toLowerCase()).toContain('concern')
  })

  it('upgrades to standard when exactly 2 technical concerns detected', async () => {
    // 2 concerns: service + repository (persistence)
    const r = (await classifyTaskHandler({
      task_description:
        'add a method to the OrderService to query the OrderRepository for pending items',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('standard')
    const concernSignal = r.signals.find((s) => s.startsWith('concerns:['))
    expect(concernSignal).toBeDefined()
  })

  it('upgrades to complex when 4+ numbered steps detected', async () => {
    const r = (await classifyTaskHandler({
      task_description:
        'rollout plan: 1. extract the helper, 2. introduce a feature flag, 3. dual-write for a week, 4. switch reads, 5. drop the legacy path',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('complex')
    const stepSignal = r.signals.find((s) => s.startsWith('steps:'))
    expect(stepSignal).toBeDefined()
    expect(r.reasoning.toLowerCase()).toContain('multi-step')
  })

  it('keeps single-concern + short mutation as small (no regression)', async () => {
    // 1 concern (dto) + mutation + 8 words → small per CAP-29 cascade step 7
    const r = (await classifyTaskHandler({
      task_description: 'add a new field to the OrderResponse DTO',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('small')
  })

  it('upgrades to complex on acme-api-like task (real dogfood case)', async () => {
    // Real case that returned standard pre-CAP-29 and triggered the
    // verification gate skip in 2026-06-09 session. Concerns: dto +
    // service + listener + template + test = 5. Tier must be complex.
    const r = (await classifyTaskHandler({
      task_description:
        'event-driven email notification: extract AprovacaoFilterUtil from service, create RequisicaoParaAprovacaoEvent, write NotificacaoAprovacaoListener with @TransactionalEventListener(AFTER_COMMIT), add native query for aggregated data, build new email template, update EmailService and add unit test',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('complex')
  })

  it('does not upgrade trivial doc-fix when concerns absent', async () => {
    const r = (await classifyTaskHandler({
      task_description: 'fix typo in README',
    })) as ClassifyTaskOutput
    expect(r.tier).toBe('trivial')
  })
})
