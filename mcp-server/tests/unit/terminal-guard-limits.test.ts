import { describe, it, expect } from 'vitest'
import { judgeCommand, MAX_COMMAND_BYTES, MAX_COMMAND_WORDS, type AliasResolver, type ShellDialect } from '../../src/lib/terminal-guard.js'

const NO_ALIASES: AliasResolver = () => ({ found: false })
const BOUND_MS = 1500

function timed(command: string, dialect: ShellDialect = 'bash'): { verdict: string; ms: number } {
  const start = performance.now()
  const verdict = judgeCommand(command, { dialect, resolveAlias: NO_ALIASES }).verdict
  return { verdict, ms: performance.now() - start }
}

const nearCap = (unit: string, prefix: string, suffix: string): string =>
  prefix + unit.repeat(Math.floor((MAX_COMMAND_BYTES - 1024 - prefix.length - suffix.length) / unit.length)) + suffix

const wordsOf = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length
const atWordCap = (unit: string, prefix: string): string => prefix + unit.repeat(Math.floor((MAX_COMMAND_WORDS - wordsOf(prefix)) / wordsOf(unit)))

describe('terminal guard — input built to be slow is judged in bounded time', () => {
  it.each([
    ['repeated git options with no verb, inside interpreter code', nearCap('--git-dir --x ', 'node -e "/* git ', '! */ 1"')],
    ['quoted option values with no verb', nearCap('--git-dir "a b" ', "node -e '/* git ", "! */ 1'")],
    ['repeated gh options with no merge', nearCap('-a -a ', 'node -e "/* gh ', '! */ 1"')],
    ['an argument list of value options with no verb', nearCap('"-c", "-a", ', `node -e 'x(["git", `, "])'")],
    ['many short commands that change folder', nearCap('cd a; ', '', '')],
    ['many subshells', nearCap('(cd a); ', '', '')],
  ])('%s', (_name, command) => {
    expect(Buffer.byteLength(command, 'utf8')).toBeLessThan(MAX_COMMAND_BYTES)
    const r = timed(command)
    expect(r.verdict).toBe('allow')
    expect(r.ms).toBeLessThan(BOUND_MS)
  })

  it.each([
    ['words after a variable', atWordCap('$x -a ', 'echo ')],
    ['plain words', atWordCap('a ', 'echo ')],
    ['words naming git', atWordCap('git ', 'echo ')],
    ['words naming gh', atWordCap('gh ', 'echo ')],
    ['a variable before pr view', atWordCap('$x pr view ', 'echo ')],
    ['words naming cmd', atWordCap('cmd ', 'echo ')],
    ['words naming node', atWordCap('node ', 'echo ')],
    ['words naming python3', atWordCap('python3 ', 'echo ')],
    ['words naming su', atWordCap('su ', 'echo ')],
    ['words naming script', atWordCap('script ', 'echo ')],
    ['words naming pwsh', atWordCap('pwsh ', 'echo ')],
  ])('a command at the word limit: %s', (_name, command) => {
    expect(wordsOf(command)).toBeLessThanOrEqual(MAX_COMMAND_WORDS)
    for (const dialect of ['bash', 'powershell'] as const) {
      const r = timed(command, dialect)
      expect(r.verdict).toBe('allow')
      expect(r.ms).toBeLessThan(BOUND_MS)
    }
  })

  it('refuses a single command over the word limit, in both dialects', () => {
    const many = `echo ${'a '.repeat(MAX_COMMAND_WORDS)}`
    for (const dialect of ['bash', 'powershell'] as const) {
      const v = judgeCommand(many, { dialect, resolveAlias: NO_ALIASES })
      expect(v.verdict === 'deny' && v.reason).toMatch(/more than 2048 words is refused/)
    }
    expect(judgeCommand(`echo ${'a '.repeat(MAX_COMMAND_WORDS - 1)}`, { resolveAlias: NO_ALIASES }).verdict).toBe('allow')
  })

  it('still refuses the git call that comes after the slow part', () => {
    const r = timed(nearCap('--git-dir --x ', 'node -e "/* git ', '! */ require(\'child_process\').execSync(\'git commit -am x\')"'))
    expect(r.verdict).toBe('deny')
    expect(r.ms).toBeLessThan(BOUND_MS)
  })

  it('refuses a command over the size limit, in both dialects', () => {
    const big = `echo ${'a'.repeat(MAX_COMMAND_BYTES)}`
    for (const dialect of ['bash', 'powershell'] as const) {
      const v = judgeCommand(big, { dialect, resolveAlias: NO_ALIASES })
      expect(v.verdict).toBe('deny')
      expect(v.verdict === 'deny' && v.reason).toMatch(/over 64 KiB is refused/)
    }
    expect(judgeCommand(`echo ${'a'.repeat(MAX_COMMAND_BYTES - 1024)}`, { resolveAlias: NO_ALIASES }).verdict).toBe('allow')
  })

  it('refuses when judging runs past its time budget', () => {
    let t = 0
    const now = () => (t += 1000)
    const v = judgeCommand('echo a b c d e f g h i j k', { resolveAlias: NO_ALIASES, now, workBudgetMs: 5000 })
    expect(v.verdict).toBe('deny')
    expect(v.verdict === 'deny' && v.reason).toMatch(/could not finish judging this command in time/)
  })

  it('a value option followed by a quoted value naming a verb is not the verb itself', () => {
    expect(judgeCommand('node -e "/* git -c \\"a push\\" status */ 1"', { resolveAlias: NO_ALIASES }).verdict).toBe('allow')
    expect(judgeCommand('node -e "require(\'child_process\').execSync(\'git -c user.name=x push\')"', { resolveAlias: NO_ALIASES }).verdict).toBe('deny')
  })
})
