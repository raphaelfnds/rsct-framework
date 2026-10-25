import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { judgeCommand } from '../../src/lib/terminal-guard.js'

const PROMPTS_DIR = resolve(__dirname, '../../../prompts')

function bashBlocks(markdown: string): Array<{ line: number; code: string }> {
  const blocks: Array<{ line: number; code: string }> = []
  const lines = markdown.split(/\r?\n/)
  let open: { line: number; lines: string[] } | null = null
  lines.forEach((l, idx) => {
    if (open === null) {
      if (/^\s*```(bash|sh|shell)\s*$/.test(l)) open = { line: idx + 1, lines: [] }
      return
    }
    if (/^\s*```\s*$/.test(l)) {
      blocks.push({ line: open.line, code: open.lines.join('\n') })
      open = null
      return
    }
    open.lines.push(l)
  })
  return blocks
}

const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md'))

describe('terminal guard — the framework\'s own prompt blocks still run', () => {
  it('finds the prompt files and their bash blocks', () => {
    expect(files).toContain('01-setup.md')
    expect(files).toContain('03-uninstall.md')
    const total = files.reduce((n, f) => n + bashBlocks(readFileSync(join(PROMPTS_DIR, f), 'utf8')).length, 0)
    expect(total).toBeGreaterThan(50)
  })

  for (const f of files) {
    it(`allows every bash block of prompts/${f}`, () => {
      const refused = bashBlocks(readFileSync(join(PROMPTS_DIR, f), 'utf8'))
        .map((b) => ({ ...b, v: judgeCommand(b.code, { resolveAlias: () => ({ found: false }), database: true }) }))
        .filter((b) => b.v.verdict === 'deny')
        .map((b) => `${f}:${b.line} — ${b.v.verdict === 'deny' ? b.v.reason : ''}`)
      expect(refused).toEqual([])
    })
  }
})
