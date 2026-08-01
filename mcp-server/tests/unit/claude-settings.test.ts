import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import {
  PROJECT_SETTINGS_FILES,
  readClaudeSettings,
  type SettingsStatus,
} from '../../src/lib/claude-settings.js'

/**
 * The four `SettingsStatus` values split into two groups that mean opposite
 * things to `lib/version-drift.ts` — `ok`/`absent` are evidence, and
 * `unreadable`/`malformed` are the absence of it. That split decides whether a
 * project gets a `security` banner, so it is pinned here directly: through the
 * drift module alone, three of the four values are indistinguishable, and
 * inverting the `ENOENT` branch would keep the whole suite green.
 */
describe('readClaudeSettings', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function root(): string {
    const r = mkdtempSync(join(tmpdir(), 'rsct-cs-'))
    dirs.push(r)
    return r
  }

  const statusOf = (r: string, name: string): SettingsStatus | undefined =>
    readClaudeSettings(r).find((f) => f.path.endsWith(name))?.status

  it('returns one entry per candidate, in declaration order, even for an empty project', () => {
    const files = readClaudeSettings(root())
    expect(files).toHaveLength(PROJECT_SETTINGS_FILES.length)
    expect(files.map((f) => f.status)).toEqual(['absent', 'absent'])
    // Order matters: `settings.json` is the file /rsct-setup writes.
    expect(files[0]?.path.endsWith('settings.json')).toBe(true)
    expect(files[1]?.path.endsWith('settings.local.json')).toBe(true)
  })

  it('reports absent for a missing file — a fact about the project, not a failure', () => {
    const r = root()
    mkdirSync(join(r, '.claude'))
    writeFileSync(join(r, '.claude', 'settings.json'), '{}\n')
    expect(statusOf(r, 'settings.json')).toBe('ok')
    expect(statusOf(r, 'settings.local.json')).toBe('absent')
  })

  it('reports unreadable — NOT absent — when the path exists but cannot be read', () => {
    // A directory where the file should be: readFileSync fails with EISDIR on
    // every platform, which is the stand-in for the EACCES / stalled-UNC cases
    // that cannot be provoked portably. Misclassifying this as `absent` would
    // turn "I could not look" into a security claim.
    const r = root()
    mkdirSync(join(r, '.claude', 'settings.json'), { recursive: true })
    expect(statusOf(r, 'settings.json')).toBe('unreadable')
  })

  it('reports malformed for unparseable JSON, with no data', () => {
    const r = root()
    mkdirSync(join(r, '.claude'))
    writeFileSync(join(r, '.claude', 'settings.json'), '{"hooks":{},}\n')
    const file = readClaudeSettings(r)[0]
    expect(file?.status).toBe('malformed')
    expect(file?.data).toBeNull()
  })

  it('reports malformed for a BOM-prefixed document, matching every other RSCT reader', () => {
    // Deliberate: the sanitizer and all five bash blocks parse raw, so a BOM'd
    // file is one no RSCT surface can act on. Seeing through it here would let
    // this module report enforcement as live while it is not.
    const r = root()
    mkdirSync(join(r, '.claude'))
    writeFileSync(join(r, '.claude', 'settings.json'), '\uFEFF{"hooks":{}}\n')
    expect(statusOf(r, 'settings.json')).toBe('malformed')
  })

  it('parses a valid document and hands back the data untouched', () => {
    const r = root()
    mkdirSync(join(r, '.claude'))
    writeFileSync(join(r, '.claude', 'settings.json'), '{"theme":"dark","hooks":{}}\n')
    const file = readClaudeSettings(r)[0]
    expect(file?.status).toBe('ok')
    expect(file?.data).toEqual({ theme: 'dark', hooks: {} })
  })

  it('returns [] for a non-string or empty project root rather than reading the cwd', () => {
    expect(readClaudeSettings('')).toEqual([])
    expect(readClaudeSettings(undefined as unknown as string)).toEqual([])
  })

  it('never throws on any of these', () => {
    const r = root()
    mkdirSync(join(r, '.claude'))
    for (const body of ['', 'null', '[]', '"x"', '{', '\u0000']) {
      writeFileSync(join(r, '.claude', 'settings.json'), body)
      expect(() => readClaudeSettings(r)).not.toThrow()
    }
  })
})
