import { describe, it, expect } from 'vitest'
import {
  addedAllowEntries,
  evaluateSettingsDrift,
  hashSettingsContent,
  readBaselineFromLog,
  type SettingsBaseline,
} from '../../src/lib/settings-drift.js'

const BASE: SettingsBaseline = { hash: 'abc', recorded_at: '2026-08-01T00:00:00Z' }

const settingsWith = (allow: string[]): string =>
  JSON.stringify({ permissions: { allow } }, null, 2) + '\n'

describe('hashSettingsContent', () => {
  it('is CRLF-insensitive — the file is committed and Windows checkouts differ', () => {
    // `.claude/settings.json` is versioned, so an autocrlf checkout materialises
    // CRLF while the same content is LF on Linux. Hashing raw bytes would report
    // drift on every platform boundary (CLAUDE.md anti-pattern #4).
    const lf = settingsWith(['Bash(ls)'])
    expect(hashSettingsContent(lf.replace(/\n/g, '\r\n'))).toBe(hashSettingsContent(lf))
  })

  it('is BOM-insensitive, matching every other reader after #12', () => {
    const plain = settingsWith(['Bash(ls)'])
    expect(hashSettingsContent('﻿' + plain)).toBe(hashSettingsContent(plain))
  })

  it('still distinguishes real content changes', () => {
    expect(hashSettingsContent(settingsWith(['Bash(ls)']))).not.toBe(
      hashSettingsContent(settingsWith(['Bash(ls)', 'Bash(rm -rf /)'])),
    )
  })
})

describe('readBaselineFromLog', () => {
  const line = (o: Record<string, unknown>): string => JSON.stringify(o)

  it('returns the NEWEST baseline — the log is append-only', () => {
    const raw = [
      line({ event: 'settings.baseline', hash: 'old', ts: '2026-08-01T00:00:00Z' }),
      line({ event: 'sanitize.stripped', file: 'x' }),
      line({ event: 'settings.baseline', hash: 'new', ts: '2026-08-01T01:00:00Z' }),
    ].join('\n')
    expect(readBaselineFromLog(raw)?.hash).toBe('new')
  })

  it('is null when the log has no baseline, is empty, or is garbage', () => {
    expect(readBaselineFromLog('')).toBeNull()
    expect(readBaselineFromLog(line({ event: 'classify.verdict', tier: 'small' }))).toBeNull()
    expect(readBaselineFromLog('not json\n{broken\n')).toBeNull()
  })

  it('skips a baseline entry with no usable hash rather than throwing', () => {
    const raw = [
      line({ event: 'settings.baseline', hash: 'good', ts: 'a' }),
      line({ event: 'settings.baseline', hash: 42 }),
      line({ event: 'settings.baseline' }),
    ].join('\n')
    expect(readBaselineFromLog(raw)?.hash).toBe('good')
  })

  it('tolerates CRLF line endings in the log', () => {
    const raw = line({ event: 'settings.baseline', hash: 'h', ts: 't' }) + '\r\n'
    expect(readBaselineFromLog(raw)?.hash).toBe('h')
  })
})

describe('addedAllowEntries', () => {
  it('lists entries present now and absent at HEAD, verbatim and in order', () => {
    const head = settingsWith(['Bash(mvn -version)'])
    const now = settingsWith(['Bash(mvn -version)', 'Bash(echo "exit=$?")', 'mcp__rsct__rsct_tutor_step'])
    expect(addedAllowEntries(now, head)).toEqual([
      'Bash(echo "exit=$?")',
      'mcp__rsct__rsct_tutor_step',
    ])
  })

  it('treats an untracked-at-HEAD file as all-new', () => {
    expect(addedAllowEntries(settingsWith(['Bash(ls)']), null)).toEqual(['Bash(ls)'])
  })

  it('returns [] rather than throwing on malformed JSON on either side', () => {
    expect(addedAllowEntries('{broken', settingsWith(['Bash(ls)']))).toEqual([])
    expect(addedAllowEntries(settingsWith(['Bash(ls)']), '{broken')).toEqual(['Bash(ls)'])
  })

  it('ignores non-string entries', () => {
    const now = JSON.stringify({ permissions: { allow: ['Bash(ls)', 42, null] } })
    expect(addedAllowEntries(now, null)).toEqual(['Bash(ls)'])
  })
})

describe('evaluateSettingsDrift', () => {
  const args = (over: Partial<Parameters<typeof evaluateSettingsDrift>[0]> = {}) =>
    evaluateSettingsDrift({
      currentHash: 'abc',
      baseline: BASE,
      staged: false,
      currentText: settingsWith([]),
      headText: settingsWith([]),
      ...over,
    })

  it('is silent with no baseline — a project that never ran the hook is not drifting', () => {
    expect(args({ baseline: null }).verdict).toBe('silent')
    expect(args({ baseline: null }).hint).toBeNull()
  })

  it('is silent when the settings file is absent or unreadable', () => {
    expect(args({ currentHash: null }).verdict).toBe('silent')
  })

  it('is quiet when the file matches the baseline', () => {
    expect(args().verdict).toBe('unchanged')
    expect(args().hint).toBeNull()
  })

  it('does NOT report a change the dev already staged — that is ownership, taken', () => {
    // The whole point of the check is to find changes nobody claimed. A staged
    // file has been claimed; nagging about it would second-guess a decision the
    // dev already made.
    const r = args({ currentHash: 'different', staged: true })
    expect(r.verdict).toBe('staged')
    expect(r.hint).toBeNull()
  })

  it('reports an unstaged divergence, listing the new entries verbatim', () => {
    const r = args({
      currentHash: 'different',
      currentText: settingsWith(['Bash(mvn -version)', 'Bash(echo "exit=$?")']),
      headText: settingsWith(['Bash(mvn -version)']),
    })
    expect(r.verdict).toBe('drifted')
    expect(r.added_entries).toEqual(['Bash(echo "exit=$?")'])
    expect(r.hint).toContain('Bash(echo "exit=$?")')
  })

  it('offers exactly the three resolutions, and decides none of them', () => {
    const r = args({ currentHash: 'different', currentText: settingsWith(['Bash(x)']), headText: settingsWith([]) })
    expect(r.hint).toContain('stage it with this commit')
    expect(r.hint).toContain('settings.local.json')
    expect(r.hint).toContain('git checkout --')
    expect(r.hint).toContain('never blocks')
  })

  it('still reports when the change is outside allow[] — it just says so', () => {
    // A theme or hook edit changes the hash without adding an allow entry. The
    // report must not pretend it found entries it did not.
    const r = args({
      currentHash: 'different',
      currentText: JSON.stringify({ theme: 'dark', permissions: { allow: [] } }),
      headText: settingsWith([]),
    })
    expect(r.verdict).toBe('drifted')
    expect(r.added_entries).toEqual([])
    expect(r.hint).toContain('the change is elsewhere in the file')
  })
})
