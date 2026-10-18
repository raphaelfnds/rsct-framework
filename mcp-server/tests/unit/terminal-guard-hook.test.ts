import { describe, it, expect } from 'vitest'
import { decideTerminal } from '../../src/lib/terminal-guard-hook.js'
import type { AliasResolver } from '../../src/lib/terminal-guard.js'

const NO_ALIASES: AliasResolver = () => ({ found: false })

function call(tool: unknown, input: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...extra })
}

describe('decideTerminal', () => {
  it('refuses a git commit from each terminal tool with exit 2 and a message', () => {
    for (const tool of ['Bash', 'PowerShell', 'Monitor']) {
      const d = decideTerminal(call(tool, { command: 'git commit -m x' }), {}, '/work', { resolveAlias: NO_ALIASES })
      expect(d.exitCode).toBe(2)
      expect(d.message).toMatch(/^\[rsct\] Terminal command blocked: /)
    }
  })

  it('judges PowerShell text with PowerShell rules', () => {
    const d = decideTerminal(call('PowerShell', { command: "Write-Output 'it''s fine'" }), {}, '/work', { resolveAlias: NO_ALIASES })
    expect(d).toEqual({ exitCode: 0, message: null })
  })

  it('allows a tool that is not a terminal without a word on stdout or stderr', () => {
    expect(decideTerminal(call('Read', { file_path: '/x' }), {}, '/work')).toEqual({ exitCode: 0, message: null })
    expect(decideTerminal(call('Edit', { file_path: '/x', new_string: 'git commit' }), {}, '/work')).toEqual({ exitCode: 0, message: null })
  })

  it('allows a Monitor watch that opens a WebSocket and runs no command', () => {
    expect(decideTerminal(call('Monitor', { ws: { url: 'wss://example.invalid' } }), {}, '/work')).toEqual({ exitCode: 0, message: null })
  })

  it('refuses a call it cannot read', () => {
    expect(decideTerminal('', {}, '/work').exitCode).toBe(2)
    expect(decideTerminal('[]', {}, '/work').exitCode).toBe(2)
    expect(decideTerminal(call(undefined, { command: 'ls' }), {}, '/work').exitCode).toBe(2)
    expect(decideTerminal(call('Bash', { command: 42 }), {}, '/work').exitCode).toBe(2)
    expect(decideTerminal(call('Bash', null), {}, '/work').exitCode).toBe(2)
  })

  it('refuses, and tells the agent to stop, when the guard itself fails', () => {
    const exploding: AliasResolver = () => {
      throw new Error('resolver exploded')
    }
    const d = decideTerminal(call('Bash', { command: 'git ci' }), {}, '/work', { resolveAlias: exploding })
    expect(d.exitCode).toBe(2)
    expect(d.message).toContain('resolver exploded')
    expect(d.message).toContain('STOP and tell the developer')
  })

  it('resolves aliases in the folder the call ran in', () => {
    const seen: Array<string | undefined> = []
    const spy: AliasResolver = (_name, _dir, cwd) => {
      seen.push(cwd)
      return { found: false }
    }
    decideTerminal(call('Bash', { command: 'git ci' }, { cwd: '/repo/sub' }), { CLAUDE_PROJECT_DIR: '/repo' }, '/proc', { resolveAlias: spy })
    decideTerminal(call('Bash', { command: 'git ci' }), { CLAUDE_PROJECT_DIR: '/repo' }, '/proc', { resolveAlias: spy })
    expect(seen).toEqual(['/repo/sub', '/repo'])
  })
})
