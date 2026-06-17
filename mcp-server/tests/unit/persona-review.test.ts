import { describe, it, expect } from 'vitest'

import {
  personaReviewHandler,
  type PersonaReviewOutput,
} from '../../src/tools/persona-review.js'

describe('rsct_persona_review', () => {
  it('returns the persona lens for a known slug', async () => {
    const r = (await personaReviewHandler({
      subject: 'add oauth login with jwt refresh tokens',
      persona: 'security',
    })) as PersonaReviewOutput
    expect(r.persona).toBe('security')
    expect(r.name).toBe('Security')
    expect(r.focus_areas.length).toBeGreaterThan(0)
    expect(r.questions_to_ask.length).toBeGreaterThan(0)
    expect(r.anti_patterns_to_check.length).toBeGreaterThan(0)
    expect(r.knowledge_categories_to_consult).toContain('anti-decisions')
  })

  it('populates subject_signals with persona keywords found in subject', async () => {
    const r = (await personaReviewHandler({
      subject: 'add oauth login with jwt refresh tokens',
      persona: 'security',
    })) as PersonaReviewOutput
    expect(r.subject_signals.length).toBeGreaterThan(0)
    expect(r.subject_signals).toContain('oauth')
  })

  it('returns hint when the chosen persona has no signal in the subject', async () => {
    const r = (await personaReviewHandler({
      subject: 'investigate the authentication and oauth flow comprehensively',
      persona: 'devops',
    })) as PersonaReviewOutput
    expect(r.subject_signals).toHaveLength(0)
    expect(
      r.hints.some(
        (h) =>
          h.includes('None of') ||
          h.includes('security') ||
          h.includes('alternatives'),
      ),
    ).toBe(true)
  })

  it('returns hint listing matched signals when the persona is a fit', async () => {
    const r = (await personaReviewHandler({
      subject: 'rearchitect the payments module to fix coupling',
      persona: 'architect',
    })) as PersonaReviewOutput
    expect(r.hints.some((h) => h.includes('matched'))).toBe(true)
  })

  it('rejects unknown persona slug', async () => {
    await expect(
      personaReviewHandler({
        subject: 'investigate the slow response time in production',
        persona: 'invalid-slug',
      }),
    ).rejects.toThrow()
  })

  it('rejects subject < 10 chars', async () => {
    await expect(
      personaReviewHandler({
        subject: 'short',
        persona: 'qa',
      }),
    ).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      personaReviewHandler({
        subject: 'review the database migration carefully',
        persona: 'devops',
        bogus: 'x',
      }),
    ).rejects.toThrow()
  })
})
