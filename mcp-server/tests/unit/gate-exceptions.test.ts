import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DIALOG_LIST_SHOWN, agentReasonLine, findingLabel, protectedBranchLine, secretFindingLines } from '../../src/lib/gate-exceptions.js'
import type { SecretFinding } from '../../src/lib/secrets.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-gate-exc-'))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

const finding = (n: number, commit?: string): SecretFinding => ({
  file: `f${n}.env`,
  line_number: n,
  reason: 'key-name',
  excerpt: `token = "***MASKED***" ${n}`,
  ...(commit !== undefined && { commit }),
})

describe('gate exception lines', () => {
  it('names the commit a finding comes from, shortened, and nothing when there is none', () => {
    expect(findingLabel(finding(3, 'c'.repeat(40)))).toBe(`"f3.env":3 — key-name (commit ${'c'.repeat(12)})`)
    expect(findingLabel(finding(3))).toBe('"f3.env":3 — key-name')
  })

  it('lists findings inline up to the limit and writes the rest to a report named after the tool', () => {
    expect(secretFindingLines(root, 'push', [])).toEqual([])
    const few = secretFindingLines(root, 'push', [finding(1)])
    expect(few).toHaveLength(2)
    expect(few[1]).toContain('"f1.env":1')

    const many = Array.from({ length: DIALOG_LIST_SHOWN + 2 }, (_, i) => finding(i + 1))
    const lines = secretFindingLines(root, 'push', many)
    const report = lines.at(-1)!.replace('Full list: ', '')
    expect(report).toMatch(/^\.rsct\/reports\/push-secrets-[0-9a-f]{16}\.md$/)
    const text = readFileSync(join(root, report), 'utf8')
    expect(text).toContain('# Secret scan findings for one push approval')
    expect(text).toContain('token = "***MASKED***" 12')
    expect(lines[1]).toContain('… and 2 more')
  })

  it('words the protected branch with the action, and the agent reason only when there is one', () => {
    expect(protectedBranchLine('main', 'pushing here')).toBe("⚠ 'main' is a protected branch: pushing here needs your exception.")
    expect(agentReasonLine('the protected branch', undefined)).toEqual([])
    expect(agentReasonLine('the protected branch', { reason: 'release' })).toEqual(['Agent\'s reason for the protected branch: "release"'])
  })
})
