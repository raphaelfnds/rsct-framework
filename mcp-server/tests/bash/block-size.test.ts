import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPromptBlocks, repoRoot } from './lib/bash-lint.js'

const ROOT = repoRoot(__dirname)
const MARK = '▶ Run from a file'
const LIMIT = 7000

function inlineCost(code: string): number {
  const text = code.replace(/\r/g, '')
  return text.length + 4 * (text.split("'").length - 1)
}

function lineBeforeFence(source: string, fenceLine: number): string {
  const lines = readFileSync(resolve(ROOT, 'prompts', source), 'utf8').replace(/\r/g, '').split('\n')
  for (let i = fenceLine - 2; i >= 0; i--) {
    if (lines[i]!.trim() !== '') return lines[i]!
  }
  return ''
}

describe('prompt bash blocks too long for the inline Bash tool', () => {
  const oversized = loadPromptBlocks(ROOT).filter((b) => inlineCost(b.code) > LIMIT)

  it('the size check sees the blocks it exists for', () => {
    expect(oversized.some((b) => b.code.includes('CHECKPOINT: Phase 4.4b executing canonical .gitignore RSCT block install'))).toBe(true)
  })

  it('every block over the limit is marked to run from a file', () => {
    const unmarked = oversized
      .filter((b) => !lineBeforeFence(b.source, b.startLine).includes(MARK))
      .map((b) => `${b.source}:${b.startLine} (${inlineCost(b.code)} chars)`)
    expect(unmarked).toEqual([])
  })

  it('the rule the mark points to is stated in every prompt that uses the mark', () => {
    for (const source of new Set(oversized.map((b) => b.source))) {
      const text = readFileSync(resolve(ROOT, 'prompts', source), 'utf8')
      expect(text).toContain('A block marked `▶ Run from a file` is too long to send inline.')
    }
  })
})
