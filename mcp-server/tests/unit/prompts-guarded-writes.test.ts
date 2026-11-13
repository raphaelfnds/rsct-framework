import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PROMPTS = resolve(__dirname, '..', '..', '..', 'prompts')
const EDITOR_TOOL = /\b(?:Edit|Write|MultiEdit|NotebookEdit) tool\b|\bfile-write tool\b|\beditor tools?\b/i
const GUARDED = /\.mcp\.json|\.claude\.json|settings(?:\.local)?\.json|managed-settings|enabledMcpjsonServers|enableAllProjectMcpServers/i

function proseParagraphs(text: string): string[] {
  const prose = text.replace(/^```[\s\S]*?^```/gm, '')
  return prose.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0)
}

export function editorWritesToGuarded(text: string): string[] {
  return proseParagraphs(text).filter((p) => EDITOR_TOOL.test(p) && GUARDED.test(p))
}

describe('prompts write the files the edit guard refuses only from bash blocks (2.24.1)', () => {
  it('no prompt paragraph tells the agent to use its editor tools on server registrations, approvals or settings', () => {
    const offenders = readdirSync(PROMPTS)
      .filter((f) => f.endsWith('.md'))
      .flatMap((f) => editorWritesToGuarded(readFileSync(join(PROMPTS, f), 'utf8')).map((p) => `${f}: ${p.slice(0, 160)}`))
    expect(offenders).toEqual([])
  })

  it('setup and uninstall still write those files, from bash', () => {
    const setup = readFileSync(join(PROMPTS, '01-setup.md'), 'utf8')
    const uninstall = readFileSync(join(PROMPTS, '03-uninstall.md'), 'utf8')
    const bashBlocks = (text: string): string => (text.match(/^```bash[\s\S]*?^```/gm) ?? []).join('\n')
    expect(bashBlocks(setup)).toMatch(/\.mcp\.json/)
    expect(bashBlocks(setup)).toMatch(/enabledMcpjsonServers/)
    expect(bashBlocks(uninstall)).toMatch(/\.mcp\.json/)
    expect(bashBlocks(uninstall)).toMatch(/enabledMcpjsonServers/)
  })

  it('positive control — a paragraph that asks for the editor on .mcp.json is reported, one in a bash block is not', () => {
    expect(editorWritesToGuarded('Use your Edit tool to add the rsct entry to `.mcp.json`.')).toHaveLength(1)
    expect(editorWritesToGuarded('```bash\n# Edit tool on .mcp.json\n```\n')).toEqual([])
  })
})
