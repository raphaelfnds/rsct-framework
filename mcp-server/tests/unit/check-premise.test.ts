import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  checkPremiseHandler,
  type CheckPremiseOutput,
} from '../../src/tools/check-premise.js'
import { tokenize } from '../../src/lib/premise-check.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')

describe('lib/premise-check — tokenize', () => {
  it('drops stopwords and length<3 tokens, lowercases', () => {
    const tokens = tokenize('I want to use Redis as session store')
    expect(tokens).toContain('redis')
    expect(tokens).toContain('session')
    expect(tokens).toContain('store')
    expect(tokens).not.toContain('want')
    expect(tokens).not.toContain('use')
  })

  it('keeps pt-BR accented words', () => {
    const tokens = tokenize('decisão sobre autenticação')
    expect(tokens).toContain('decisão')
    expect(tokens).toContain('autenticação')
  })
})

describe('rsct_check_premise — recommendations', () => {
  it('returns proceed when no decisions overlap the claim domain', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'switch to Tailwind CSS for the admin theme',
    })) as CheckPremiseOutput

    expect(out.recommendation).toBe('proceed')
    expect(out.matches.length).toBe(0)
    expect(out.scanned_decisions).toBeGreaterThan(0)
  })

  it('returns conflict when matched decision contains negation language', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'use Redis as session store',
      against: 'adrs',
    })) as CheckPremiseOutput

    expect(out.recommendation).toBe('conflict')
    expect(out.matches.length).toBeGreaterThanOrEqual(1)
    expect(out.matches[0]?.entry.id).toBe('ADR-004')
    expect(out.matches[0]?.negation_signal).toBe(true)
    expect(out.hints.some((h) => h.includes('CONFLICT signal'))).toBe(true)
  })

  it('returns requires_revision when claim matches a firm premise without negation', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'allow UPDATE statements on financial events tables',
      against: 'premises',
    })) as CheckPremiseOutput

    expect(out.recommendation).toBe('requires_revision')
    expect(out.matches.some((m) => m.entry.id === '#1')).toBe(true)
    expect(out.hints.some((h) => h.includes('REVISION required'))).toBe(true)
  })

  it('returns requires_revision when claim matches an active ADR', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'integrate Stripe Checkout for credit card payments',
      against: 'adrs',
    })) as CheckPremiseOutput

    expect(out.recommendation).toBe('requires_revision')
    expect(out.matches.some((m) => m.entry.id === 'ADR-002')).toBe(true)
  })
})

describe('rsct_check_premise — against filter', () => {
  it('honors against=premises (no ADR results)', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'use PostgreSQL as primary store',
      against: 'premises',
    })) as CheckPremiseOutput

    expect(out.matches.every((m) => m.entry.kind === 'premise')).toBe(true)
  })

  it('honors against=adrs (no premise results)', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'PostgreSQL is the primary store',
      against: 'adrs',
    })) as CheckPremiseOutput

    expect(out.matches.every((m) => m.entry.kind === 'adr')).toBe(true)
  })

  it('against=both is the default', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'use Redis as session store',
    })) as CheckPremiseOutput

    expect(out.against).toBe('both')
  })
})

describe('rsct_check_premise — match metadata', () => {
  it('returns shared_tokens, score and negation_signal per match', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'use Redis as session store',
      against: 'adrs',
    })) as CheckPremiseOutput

    const top = out.matches[0]
    expect(top).toBeDefined()
    expect(top?.score).toBeGreaterThanOrEqual(2)
    expect(top?.shared_tokens.length).toBe(top?.score)
    expect(top?.shared_tokens).toEqual(top?.shared_tokens.slice().sort())
    expect(top?.negation_signal).toBe(true)
  })

  it('sorts matches by score descending', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'webhook reliability for events captured by orders service',
    })) as CheckPremiseOutput

    for (let i = 1; i < out.matches.length; i++) {
      expect(out.matches[i]!.score).toBeLessThanOrEqual(out.matches[i - 1]!.score)
    }
  })
})

describe('rsct_check_premise — graceful degradation', () => {
  it('returns proceed + hint when decisions.md is missing', async () => {
    const out = (await checkPremiseHandler({
      project_root: NO_RSCT,
      claim: 'use anything you like since no decisions exist',
    })) as CheckPremiseOutput

    expect(out.recommendation).toBe('proceed')
    expect(out.decisions_file.exists).toBe(false)
    expect(
      out.hints.some(
        (h) =>
          h.includes('decisions.md not found') || h.includes('Project is not rsct-managed'),
      ),
    ).toBe(true)
  })
})

describe('rsct_check_premise — anti-decisions cross-check', () => {
  it('upgrades to conflict when claim matches an anti-decision (AD-NNN)', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'use DynamoDB for orders pipeline',
    })) as CheckPremiseOutput

    expect(out.recommendation).toBe('conflict')
    expect(out.anti_decision_matches.length).toBeGreaterThanOrEqual(1)
    expect(out.anti_decision_matches[0]?.entry.id).toBe('AD-001')
    expect(out.anti_decision_matches[0]?.score).toBeGreaterThanOrEqual(2)
  })

  it('surfaces anti_decisions_file metadata and scanned_anti_decisions count', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'switch to Tailwind CSS for the admin theme',
    })) as CheckPremiseOutput

    expect(out.anti_decisions_file.exists).toBe(true)
    expect(out.anti_decisions_file.path).toMatch(/anti-decisions\.md$/)
    expect(out.scanned_anti_decisions).toBeGreaterThanOrEqual(2)
    expect(out.anti_decision_matches).toEqual([])
  })

  it('anti-decision dominates over a matched premise (claim hits both)', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim:
        'introduce service-mesh sidecar for inter-service synchronous webhook acks',
    })) as CheckPremiseOutput

    expect(out.matches.some((m) => m.entry.id === '#3')).toBe(true)
    expect(out.anti_decision_matches.some((m) => m.entry.id === 'AD-002')).toBe(
      true,
    )
    expect(out.recommendation).toBe('conflict')
    expect(out.reason).toContain('AD-002')
  })

  it('emits an ANTI-DECISION hint when matched', async () => {
    const out = (await checkPremiseHandler({
      project_root: SAMPLE_RSCT,
      claim: 'use DynamoDB for orders pipeline',
    })) as CheckPremiseOutput

    expect(out.hints.some((h) => h.includes('ANTI-DECISION'))).toBe(true)
  })

  it('surfaces a missing-anti-decisions hint when the file is absent', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-cp-noanti-'))
    try {
      writeFileSync(join(tmpRoot, '.rsct.json'), '{"rsct_version":"1.0.0","app":{"name":"x","org":"y"}}', 'utf8')
      const docs = join(tmpRoot, 'documentation')
      mkdirSync(docs, { recursive: true })
      writeFileSync(
        join(docs, 'decisions.md'),
        '# decisions\n\n### ADR-001 — sample\nDummy.\n',
        'utf8',
      )

      const out = (await checkPremiseHandler({
        project_root: tmpRoot,
        claim: 'switch to Tailwind CSS for the admin theme',
      })) as CheckPremiseOutput

      expect(out.anti_decisions_file.exists).toBe(false)
      expect(out.decisions_file.exists).toBe(true)
      expect(
        out.hints.some((h) => h.includes('anti-decisions.md not found')),
      ).toBe(true)
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe('rsct_check_premise — input validation', () => {
  it('rejects missing claim', async () => {
    await expect(checkPremiseHandler({ project_root: SAMPLE_RSCT })).rejects.toThrow()
  })

  it('rejects claim shorter than 5 chars', async () => {
    await expect(
      checkPremiseHandler({ project_root: SAMPLE_RSCT, claim: 'abc' }),
    ).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      checkPremiseHandler({
        project_root: SAMPLE_RSCT,
        claim: 'use Redis',
        unknown_key: 'x',
      }),
    ).rejects.toThrow()
  })

  it('rejects invalid against enum', async () => {
    await expect(
      checkPremiseHandler({
        project_root: SAMPLE_RSCT,
        claim: 'use Redis',
        against: 'all',
      }),
    ).rejects.toThrow()
  })
})

// #58 — the flags are worthless without the wiring. Every case below reverts to
// green if the hint block in `buildHints` is removed, which is the whole point:
// #49 tested the hints rather than the snapshot fields for the same reason.
describe('rsct_check_premise — corpus-miss reporting (#58)', () => {
  let root: string

  const writeDecisions = (content: string): void => {
    mkdirSync(join(root, 'documentation'), { recursive: true })
    writeFileSync(join(root, 'documentation', 'decisions.md'), content, 'utf8')
  }
  const writeAnti = (content: string): void => {
    mkdirSync(join(root, 'documentation', 'knowledge'), { recursive: true })
    writeFileSync(
      join(root, 'documentation', 'knowledge', 'anti-decisions.md'),
      content,
      'utf8',
    )
  }
  const hintsOf = async (claim: string): Promise<string[]> => {
    const out = (await checkPremiseHandler({
      project_root: root,
      claim,
    })) as CheckPremiseOutput
    return out.hints
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rsct-cp-miss-'))
    writeFileSync(
      join(root, '.rsct.json'),
      JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test', org: 'test' } }),
      'utf8',
    )
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reports a decisions.md that exists but cannot be read', async () => {
    mkdirSync(join(root, 'documentation', 'decisions.md'), { recursive: true })
    writeAnti('### AD-001 — Something unrelated\nBody.\n')

    const hints = await hintsOf('add a caching layer')
    expect(hints.some((h) => h.includes('decisions.md') && h.includes('could not be READ'))).toBe(
      true,
    )
  })

  it('reports a decisions.md that mentions ids but parses to nothing', async () => {
    writeDecisions('# Decisions\n\n#### ADR-001 -- wrong level and separator\nBody.\n')
    writeAnti('### AD-001 — Something unrelated\nBody.\n')

    const hints = await hintsOf('add a caching layer')
    expect(hints.some((h) => h.includes('mentions decision ids but none parsed'))).toBe(true)
  })

  it('reports an anti-decisions.md that exists but cannot be read', async () => {
    writeDecisions('### ADR-001 — Something unrelated\nBody.\n')
    mkdirSync(join(root, 'documentation', 'knowledge', 'anti-decisions.md'), {
      recursive: true,
    })

    const hints = await hintsOf('add a caching layer')
    expect(
      hints.some((h) => h.includes('anti-decisions.md') && h.includes('could not be READ')),
    ).toBe(true)
  })

  it('reports an anti-decisions.md that mentions AD ids but parses to nothing', async () => {
    writeDecisions('### ADR-001 — Something unrelated\nBody.\n')
    writeAnti('# Anti-decisions\n\n#### AD-001 -- wrong level and separator\nBody.\n')

    const hints = await hintsOf('add a caching layer')
    expect(hints.some((h) => h.includes('mentions AD ids but none parsed'))).toBe(true)
  })

  it('stays quiet when both corpora are readable and parse', async () => {
    writeDecisions('### ADR-001 — Something unrelated\nBody.\n')
    writeAnti('### AD-001 — Something else unrelated\nBody.\n')

    const hints = await hintsOf('add a caching layer')
    expect(hints.some((h) => h.includes('could not be READ'))).toBe(false)
    expect(hints.some((h) => h.includes('none parsed'))).toBe(false)
  })

  it('does not claim the answer defaulted to "proceed" when it did not', async () => {
    // No decisions.md at all, but an anti-decision the claim hits: the recommendation
    // is `conflict`, and the not-found hint used to assert "defaulted to proceed" —
    // contradicting both the field beside it and the ANTI-DECISION hint below it.
    writeAnti('### AD-001 — DynamoDB for orders\nTried it; cost forced a rollback.\n')

    const out = (await checkPremiseHandler({
      project_root: root,
      claim: 'use DynamoDB for the orders pipeline',
    })) as CheckPremiseOutput

    expect(out.recommendation).toBe('conflict')
    expect(out.hints.some((h) => h.includes('decisions.md not found'))).toBe(true)
    expect(
      out.hints.some((h) => h.includes('"proceed"')),
      'a hint claimed "proceed" while the recommendation was conflict',
    ).toBe(false)
  })
})
