import { describe, it, expect } from 'vitest'

import {
  PERSONAS,
  PERSONA_SLUGS,
  getPersonaBySlug,
  scorePersonas,
} from '../../src/lib/personas.js'

describe('lib/personas — data integrity', () => {
  it('exposes 6 personas (architect, senior-dev, qa, devops, security, tutor)', () => {
    expect(PERSONAS).toHaveLength(6)
    expect(PERSONA_SLUGS).toEqual([
      'architect',
      'senior-dev',
      'qa',
      'devops',
      'security',
      'tutor',
    ])
  })

  it('every persona has the required fields populated', () => {
    for (const p of PERSONAS) {
      expect(typeof p.slug).toBe('string')
      expect(typeof p.name).toBe('string')
      expect(typeof p.one_liner).toBe('string')
      expect(p.focus_areas.length).toBeGreaterThan(0)
      expect(p.questions_to_ask.length).toBeGreaterThan(0)
      expect(p.anti_patterns_to_check.length).toBeGreaterThan(0)
      expect(p.knowledge_categories_to_consult.length).toBeGreaterThan(0)
      expect(p.keywords.length).toBeGreaterThan(0)
    }
  })

  it('persona slugs are unique', () => {
    const set = new Set(PERSONAS.map((p) => p.slug))
    expect(set.size).toBe(PERSONAS.length)
  })

  it('getPersonaBySlug returns the persona for a known slug', () => {
    const p = getPersonaBySlug('architect')
    expect(p).not.toBeNull()
    expect(p?.name).toBe('Architect')
  })

  it('getPersonaBySlug returns null for an unknown slug', () => {
    expect(getPersonaBySlug('does-not-exist')).toBeNull()
  })
})

describe('lib/personas — scorePersonas', () => {
  it('returns empty array when no keyword matches', () => {
    const r = scorePersonas('this is a generic sentence about nothing')
    expect(r).toEqual([])
  })

  it('returns the security persona at the top for an auth-heavy task', () => {
    const r = scorePersonas(
      'review the authentication flow for jwt token refresh and oauth login',
    )
    expect(r[0]?.persona).toBe('security')
    expect(r[0]?.score).toBeGreaterThanOrEqual(3)
  })

  it('returns the devops persona for an infrastructure task', () => {
    const r = scorePersonas(
      'add kubernetes deploy pipeline with rollback and monitoring',
    )
    expect(r[0]?.persona).toBe('devops')
  })

  it('returns the qa persona for a coverage / regression task', () => {
    const r = scorePersonas(
      'add unit test coverage for the regression in payment validation',
    )
    expect(r[0]?.persona).toBe('qa')
  })

  it('returns the architect persona for an architecture task', () => {
    const r = scorePersonas(
      'rearchitect the payments module to decouple from the billing layer',
    )
    expect(r[0]?.persona).toBe('architect')
  })

  it('ranks by score descending (multi-persona match)', () => {
    const r = scorePersonas(
      'security review of the kubernetes pipeline with auth and monitoring',
    )
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1]!.score).toBeGreaterThanOrEqual(r[i]!.score)
    }
  })

  it('matches are case-insensitive (substring)', () => {
    const r = scorePersonas('ARCHITECTURE REVIEW — REFACTOR ACROSS MODULES')
    expect(r[0]?.persona).toBe('architect')
  })
})
