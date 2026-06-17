import { describe, it, expect } from 'vitest'

import {
  autoPersonaHandler,
  type AutoPersonaOutput,
} from '../../src/tools/auto-persona.js'

describe('rsct_auto_persona — recommendations', () => {
  it('recommends security for an auth / oauth task', async () => {
    const r = (await autoPersonaHandler({
      task_description: 'add oauth login with jwt refresh and rbac roles',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('security')
    expect(r.recommendation_score).toBeGreaterThanOrEqual(2)
  })

  it('recommends devops for a deploy / kubernetes task', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'add a new kubernetes deploy step with rollback and monitoring',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('devops')
  })

  it('recommends qa for a test / regression task', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'add regression test coverage for the validation edge case',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('qa')
  })

  it('recommends architect for an architecture task', async () => {
    const r = (await autoPersonaHandler({
      task_description: 'rearchitect the orders module to fix coupling',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('architect')
  })

  it('returns ranked alternatives when multiple personas match', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'security review of the kubernetes deploy pipeline with auth tokens',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBeTruthy()
    expect(r.alternatives.length).toBeGreaterThan(0)
    // Ranked: score descending
    for (let i = 1; i < r.alternatives.length; i++) {
      expect(r.alternatives[i - 1]!.score).toBeGreaterThanOrEqual(
        r.alternatives[i]!.score,
      )
    }
  })

  it('returns null recommended_persona when no keyword matches', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'just doing some generic stuff with no obvious keyword markers here ok',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBeNull()
    expect(r.recommendation_score).toBe(0)
    expect(
      r.hints.some((h) => h.toLowerCase().includes('no persona keyword')),
    ).toBe(true)
  })

  it('always exposes the full persona slug list for discovery (includes tutor)', async () => {
    const r = (await autoPersonaHandler({
      task_description: 'just a generic task with no special keywords here',
    })) as AutoPersonaOutput
    expect(r.all_persona_slugs).toEqual([
      'architect',
      'senior-dev',
      'qa',
      'devops',
      'security',
      'tutor',
    ])
  })

  it('NEVER recommends tutor (auto_pickable=false), even when keywords hit', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'walk me through this step by step — tutor mode please, debug live',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).not.toBe('tutor')
    expect(r.alternatives.every((a) => a.persona !== 'tutor')).toBe(true)
  })
})

describe('rsct_auto_persona — pt-BR (CAP-6 / v0.6.2)', () => {
  it('recommends security for pt-BR auth task', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'implementar autenticação JWT com autorização e criptografia',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('security')
    expect(r.recommendation_score).toBeGreaterThanOrEqual(3)
  })

  it('recommends devops for pt-BR deploy task', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'implantar com kubernetes e monitoramento de métricas e alerta',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('devops')
  })

  it('recommends qa for pt-BR test/regression task', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'adicionar cobertura de teste para regressão de validação',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('qa')
  })

  it('recommends architect for pt-BR architecture task', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'redesenhar a arquitetura do módulo de pagamentos para reduzir acoplamento',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('architect')
  })
})

describe('rsct_auto_persona — EN expanded vocabulary (CAP-6 / v0.6.2)', () => {
  it('recommends devops for EN infra jargon (terraform + prometheus + p99)', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'tune the terraform module and add prometheus alert on p99 latency',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('devops')
    expect(r.recommendation_score).toBeGreaterThanOrEqual(3)
  })

  it('recommends security for EN OWASP / SSRF / threat model task', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'threat model the API gateway against SSRF and OWASP top 10 attacks',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('security')
  })

  it('recommends qa for EN BDD / TDD / contract test task', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'add BDD scenarios and contract tests with branch coverage targets',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('qa')
  })

  it('recommends architect for EN clean architecture / aggregate task', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'decouple the orders aggregate using hexagonal architecture and ports and adapters',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('architect')
  })

  it('recommends senior-dev for EN tech debt / code smell / DRY task', async () => {
    const r = (await autoPersonaHandler({
      task_description:
        'reduce tech debt and remove the code smell duplication violating DRY',
    })) as AutoPersonaOutput
    expect(r.recommended_persona).toBe('senior-dev')
  })

  it('rejects task_description < 10 chars', async () => {
    await expect(
      autoPersonaHandler({ task_description: 'short' }),
    ).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      autoPersonaHandler({
        task_description: 'review the architecture changes carefully',
        bogus: 'x',
      }),
    ).rejects.toThrow()
  })
})
