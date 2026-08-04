import { describe, it, expect } from 'vitest'
import { statusTool, statusInputSchema } from '../../src/tools/status.js'

// The HAND-WRITTEN inputSchema is what MCP exposes to the agent; the zod object is
// what the handler validates against. They are maintained separately, and nothing
// else in the suite compares them — so a field added to zod and forgotten in
// inputSchema ships green and completely inert: the agent never sees the parameter
// it is being told to use.
describe('rsct_status — zod ↔ exposed inputSchema parity', () => {
  const exposed = statusTool.inputSchema as {
    type: string
    properties: Record<string, { type?: string; enum?: string[]; description?: string }>
    additionalProperties?: boolean
    required?: string[]
  }
  const zodKeys = Object.keys(statusInputSchema.shape).sort()

  it('exposes exactly the keys the handler accepts', () => {
    expect(Object.keys(exposed.properties).sort()).toEqual(zodKeys)
  })

  it('mirrors zod .strict() as additionalProperties:false', () => {
    expect(exposed.additionalProperties).toBe(false)
  })

  it('declares every parameter optional, matching zod', () => {
    expect(exposed.required ?? []).toEqual([])
    for (const key of zodKeys) {
      expect(statusInputSchema.shape[key as keyof typeof statusInputSchema.shape].isOptional()).toBe(true)
    }
  })

  it('describes every exposed parameter (the description is the agent-visible contract)', () => {
    for (const [key, prop] of Object.entries(exposed.properties)) {
      expect(prop.type, `${key} needs a type`).toBe('string')
      expect((prop.description ?? '').length, `${key} needs a description`).toBeGreaterThan(20)
    }
  })

  // Deliberate asymmetry, documented in status.ts: the exposed schema advertises the
  // strict contract while zod stays a loose string, so a paraphrased value degrades
  // to a hint instead of failing the session-bootstrap tool.
  it('advertises update_check as an on/off enum while zod accepts a plain string', () => {
    expect(exposed.properties.update_check?.enum).toEqual(['on', 'off'])
    expect(statusInputSchema.safeParse({ update_check: 'On' }).success).toBe(true)
    expect(statusInputSchema.safeParse({ update_check: 'garbage' }).success).toBe(true)
    expect(statusInputSchema.safeParse({ nope: 1 }).success).toBe(false)
  })
})
