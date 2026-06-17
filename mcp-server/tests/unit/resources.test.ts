import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import {
  RESOURCE_TEMPLATES,
  STATIC_RESOURCES,
  readResource,
} from '../../src/resources.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')

describe('MCP resources — registry', () => {
  it('exposes 4 static resources', () => {
    expect(STATIC_RESOURCES.map((r) => r.uri).sort()).toEqual(
      ['rsct://architecture', 'rsct://decisions', 'rsct://plan', 'rsct://progress'].sort(),
    )
    for (const r of STATIC_RESOURCES) {
      expect(r.mimeType).toBe('text/markdown')
      expect(r.name).toBeTruthy()
    }
  })

  it('exposes the knowledge template', () => {
    expect(RESOURCE_TEMPLATES.length).toBe(1)
    expect(RESOURCE_TEMPLATES[0]?.uriTemplate).toBe('rsct://knowledge/{category}')
  })
})

describe('MCP resources — readResource', () => {
  it('reads rsct://decisions', () => {
    const r = readResource('rsct://decisions', SAMPLE_RSCT)
    expect(r.uri).toBe('rsct://decisions')
    expect(r.mimeType).toBe('text/markdown')
    expect(r.text).toContain('Append-only finance events')
  })

  it('reads rsct://architecture', () => {
    const r = readResource('rsct://architecture', SAMPLE_RSCT)
    expect(r.text).toContain('Spring Boot')
  })

  it('reads rsct://plan when an active plan exists', () => {
    const r = readResource('rsct://plan', SAMPLE_RSCT)
    expect(r.uri).toBe('rsct://plan')
    expect(r.text.length).toBeGreaterThan(0)
  })

  it('reads rsct://knowledge/<category>', () => {
    const r = readResource('rsct://knowledge/business-rules', SAMPLE_RSCT)
    expect(r.text).toContain('BR-001')
    expect(r.mimeType).toBe('text/markdown')
  })

  it('throws on a knowledge URI for a missing category', () => {
    expect(() => readResource('rsct://knowledge/nonexistent', SAMPLE_RSCT)).toThrow(
      /Resource not found/,
    )
  })

  it('throws on unknown rsct:// URI', () => {
    expect(() => readResource('rsct://does-not-exist', SAMPLE_RSCT)).toThrow(
      /Resource not found/,
    )
  })

  it('rejects path-traversal style knowledge categories', () => {
    expect(() => readResource('rsct://knowledge/../decisions', SAMPLE_RSCT)).toThrow(
      /Resource not found/,
    )
  })

  it('throws when the active plan is missing', () => {
    expect(() => readResource('rsct://plan', NO_RSCT)).toThrow(/Resource not found/)
  })

  it('throws on rsct://progress when no plan exists', () => {
    expect(() => readResource('rsct://progress', NO_RSCT)).toThrow(/Resource not found/)
  })
})
