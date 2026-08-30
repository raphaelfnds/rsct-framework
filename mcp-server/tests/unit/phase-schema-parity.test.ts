import { describe, it, expect } from 'vitest'
import type { ZodObject, ZodRawShape } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import {
  phaseReviewStartTool,
  phaseReviewStartInputSchema,
} from '../../src/tools/phase-review-start.js'
import {
  phaseReviewCompleteTool,
  phaseReviewCompleteInputSchema,
} from '../../src/tools/phase-review-complete.js'
import {
  phaseVerificationStartTool,
  phaseVerificationStartInputSchema,
} from '../../src/tools/phase-verification-start.js'
import {
  phaseVerificationCompleteTool,
  phaseVerificationCompleteInputSchema,
} from '../../src/tools/phase-verification-complete.js'

// The HAND-WRITTEN inputSchema is what MCP exposes to the agent; the zod object is
// what the handler validates. They are maintained separately and nothing compared
// them for any phase tool — so a parameter added to zod and forgotten in the exposed
// schema ships green and completely INERT: the agent never sees the parameter the
// tool description tells it to use, and a client that validates arguments against the
// published schema rejects it outright.
//
// #40 hit exactly this: `findings_run_id` reached zod first and the exposed schema
// second, and only a hand-check caught it.

interface Exposed {
  type: string
  properties: Record<string, { type?: string; description?: string }>
  required?: string[]
  additionalProperties?: boolean
}

const CASES: Array<{ name: string; tool: Tool; schema: ZodObject<ZodRawShape> }> = [
  { name: 'rsct_phase_review_start', tool: phaseReviewStartTool, schema: phaseReviewStartInputSchema },
  { name: 'rsct_phase_review_complete', tool: phaseReviewCompleteTool, schema: phaseReviewCompleteInputSchema },
  {
    name: 'rsct_phase_verification_start',
    tool: phaseVerificationStartTool,
    schema: phaseVerificationStartInputSchema,
  },
  {
    name: 'rsct_phase_verification_complete',
    tool: phaseVerificationCompleteTool,
    schema: phaseVerificationCompleteInputSchema,
  },
]

describe.each(CASES)('$name — zod ↔ exposed inputSchema parity', ({ tool, schema }) => {
  const exposed = tool.inputSchema as unknown as Exposed
  const zodKeys = Object.keys(schema.shape).sort()

  it('exposes exactly the keys the handler accepts', () => {
    expect(Object.keys(exposed.properties).sort()).toEqual(zodKeys)
  })

  // The exposed schema may require MORE than zod, never less. `dev_approval` is the
  // standing case: it is `z.unknown()`, which zod treats as optional because unknown
  // admits undefined, while the handler genuinely demands it — so the exposed schema
  // is the stricter and more truthful of the two. The direction that must never
  // happen is a key zod requires and the agent is never told about.
  it('never exposes as optional something zod requires', () => {
    const zodRequired = zodKeys.filter((k) => !schema.shape[k]!.isOptional())
    const exposedRequired = new Set(exposed.required ?? [])
    for (const key of zodRequired) {
      expect(exposedRequired.has(key), `${key} is required by zod but exposed as optional`).toBe(true)
    }
  })

  it('mirrors zod .strict() as additionalProperties:false', () => {
    expect(exposed.additionalProperties).toBe(false)
    // Build a payload that satisfies every required key, so the ONLY reason to
    // reject is the unknown one. Parsing a bare `{unknown: 1}` would fail on the
    // missing required keys whether or not the schema is strict — which made the
    // previous form of this assertion pass against `.passthrough()`.
    const valid: Record<string, unknown> = {}
    for (const key of zodKeys) {
      if (schema.shape[key]!.isOptional()) continue
      valid[key] = key === 'dev_approval' ? {} : 'x'
    }
    expect(schema.safeParse(valid).success).toBe(true)
    expect(schema.safeParse({ ...valid, definitely_not_a_real_key: 1 }).success).toBe(false)
  })

  it('describes every exposed parameter — the description is the agent-visible contract', () => {
    for (const [key, prop] of Object.entries(exposed.properties)) {
      // project_root is uniform boilerplate across the catalog; the rest carry meaning.
      if (key === 'project_root' || key === 'dev_approval') continue
      expect((prop.description ?? '').length, `${key} needs a description`).toBeGreaterThan(0)
    }
  })
})

// Top-level parity is not enough on its own: the biggest surface #40 added is an
// array of OBJECTS, and a field dropped from the nested zod shape while the exposed
// schema still advertises it is the same inert-parameter failure one level down.
describe('rsct_phase_review_start — nested findings[] parity', () => {
  const exposed = phaseReviewStartTool.inputSchema as unknown as {
    properties: {
      findings: { items: { properties: Record<string, unknown>; required: string[] } }
    }
  }
  const items = exposed.properties.findings.items

  /**
   * A type-appropriate probe value per advertised field.
   *
   * `line` was already special-cased because a string is not a number. #75 adds
   * `evidence`, the first OBJECT-typed field here, and probing it with `'v'` would
   * report "advertised but rejected" for a field zod accepts perfectly well — a
   * false alarm, not a caught defect.
   *
   * The guard is unchanged in strength: the probe still sends a value that MUST
   * parse, so dropping `evidence` from the zod shape while leaving it advertised
   * still fails here (the object becomes an unknown key against a `.strict()`
   * schema). What changed is that `evidence` is now genuinely exercised instead of
   * being asserted against with the wrong type.
   */
  const PROBE: Record<string, unknown> = {
    line: 1,
    evidence: { kind: 'hypothesis', how_to_falsify: 'run the command and compare' },
  }

  function acceptsKey(key: string): boolean {
    const finding: Record<string, unknown> = { id: 'r-1', category: 'c', title: 't' }
    finding[key] = key in PROBE ? PROBE[key] : 'v'
    return phaseReviewStartInputSchema.safeParse({ spec_ref: 'x', findings: [finding] }).success
  }

  function acceptsEvidence(evidence: unknown): boolean {
    return phaseReviewStartInputSchema.safeParse({
      spec_ref: 'x',
      findings: [{ id: 'r-1', category: 'c', title: 't', evidence }],
    }).success
  }

  it('every advertised finding field is actually accepted by zod', () => {
    for (const key of Object.keys(items.properties)) {
      expect(acceptsKey(key), `findings[].${key} is advertised but rejected`).toBe(true)
    }
  })

  it('rejects a finding field it does not advertise', () => {
    expect(acceptsKey('not_a_real_field')).toBe(false)
  })

  /**
   * #75. `evidence` is advertised as a FLAT property bag because no schema in this
   * catalog uses a JSON-Schema combinator, so the mutual exclusion between kinds
   * lives only in its `description`. A description is a claim; this is the test
   * that makes it true. Without it, the schema could quietly start accepting a
   * mixed object and the only thing contradicting the docs would be a runtime
   * rejection the agent cannot predict.
   */
  it('enforces the evidence-kind exclusivity its description promises', () => {
    expect(acceptsEvidence(undefined)).toBe(true)
    expect(
      acceptsEvidence({
        kind: 'measured',
        command: 'c',
        output_excerpt: 'o',
        also_explained_by: 'a',
      }),
    ).toBe(true)
    // A kind missing its own fields.
    expect(acceptsEvidence({ kind: 'measured', command: 'c' })).toBe(false)
    // Fields borrowed from another kind.
    expect(
      acceptsEvidence({
        kind: 'measured',
        command: 'c',
        output_excerpt: 'o',
        also_explained_by: 'a',
        how_to_falsify: 'x',
      }),
    ).toBe(false)
    // An unrecognised kind never reaches storage.
    expect(acceptsEvidence({ kind: 'vibes' })).toBe(false)
  })

  it('advertises every evidence field the union actually names', () => {
    const advertised = Object.keys(
      (items.properties.evidence as { properties: Record<string, unknown> }).properties,
    ).sort()
    expect(advertised).toEqual([
      'also_explained_by',
      'command',
      'commit_sha',
      'how_to_falsify',
      'kind',
      'output_excerpt',
      'source',
      'verified_against',
    ])
  })

  it('advertises the same required finding fields zod enforces', () => {
    for (const key of items.required) {
      const partial: Record<string, unknown> = { id: 'r-1', category: 'c', title: 't' }
      delete partial[key]
      expect(
        phaseReviewStartInputSchema.safeParse({ spec_ref: 'x', findings: [partial] }).success,
        `findings[].${key} is advertised required but zod accepts it missing`,
      ).toBe(false)
    }
  })
})
