import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { stripBom } from './io-utils.js'

/**
 * `.claude/settings.json` drift (#17) — the versioned file nobody owns.
 *
 * The Claude Code harness auto-appends approved permissions to the VERSIONED
 * `.claude/settings.json` during a session. The agent did not write those lines
 * and correctly reports it did not modify the file, so it never stages them; the
 * dev did not write them either. The result is a versioned file that is
 * permanently dirty, drifting with entries nobody owns — while RSCT, which
 * governs that exact file, says nothing about it at any gate.
 *
 * This module gives the drift an owner and a moment: the sanitizer records a
 * post-scrub baseline at SessionStart, and `rsct_request_commit` reports any
 * later divergence. It never blocks, never auto-commits, never auto-discards and
 * never edits entry content — the framework surfaces and offers; the dev decides.
 * Auto-committing entries nobody reviewed would be strictly worse than the
 * current state.
 *
 * **Where the baseline lives, and why not a file.** It is an append-only
 * `settings.baseline` event in `.rsct/audit.log`, read back with the same scan
 * idiom `deriveAuditCeiling` uses. A new file under `.rsct/` would need a line in
 * the canonical `.gitignore` block PLUS a chained backfill clause for existing
 * installs, PLUS inventory/removal/report/`rm -f` handling in the uninstall — and
 * without every one of those the baseline is born untracked (the exact dirt this
 * issue removes) and survives uninstall, which then prints a false statement
 * about files the framework did not create. The audit log costs none of that and
 * inherits the append-only property for free.
 */

/** Hash of the settings file as the framework last left it. */
export interface SettingsBaseline {
  hash: string
  recorded_at: string
}

/**
 * Content hash, CRLF-normalised and BOM-stripped.
 *
 * `.claude/settings.json` is committed, so a Windows `autocrlf` checkout
 * materialises CRLF while the same content on Linux is LF. Hashing raw bytes
 * would report drift on every platform boundary — the project's CRLF
 * anti-pattern (#4), applied to a hash instead of a regex.
 */
export function hashSettingsContent(text: string): string {
  return createHash('sha256').update(stripBom(text).replace(/\r/g, '')).digest('hex')
}

/** Project-relative path of the versioned settings file, in posix form. */
export const SETTINGS_REL_PATH = '.claude/settings.json'

/** Read a file as text, or null when absent/unreadable. Never throws. */
export function readTextOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Hash the project's settings file, or null when it is absent/unreadable. */
export function hashSettingsFile(projectRoot: string): string | null {
  const text = readTextOrNull(join(projectRoot, '.claude', 'settings.json'))
  return text === null ? null : hashSettingsContent(text)
}

/**
 * The newest `settings.baseline` event in an audit log. Never throws; a missing,
 * unreadable or baseline-free log yields null, and every caller treats null as
 * "no baseline recorded yet" — silence, never a report.
 *
 * Takes the log TEXT rather than a path so the scan stays pure and testable; the
 * tool layer owns resolving `.rsct/audit.log`.
 */
export function readBaselineFromLog(raw: string): SettingsBaseline | null {
  let found: SettingsBaseline | null = null
  for (const line of raw.split('\n')) {
    const clean = line.replace(/\r/g, '').trim()
    if (!clean) continue
    let entry: Record<string, unknown>
    try {
      const parsed = JSON.parse(clean) as unknown
      if (!parsed || typeof parsed !== 'object') continue
      entry = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.event !== 'settings.baseline') continue
    const hash = entry.hash
    if (typeof hash !== 'string' || hash.length === 0) continue
    // Later lines win: the log is append-only, so the last one is current.
    found = { hash, recorded_at: typeof entry.ts === 'string' ? entry.ts : '' }
  }
  return found
}

export type SettingsDriftVerdict =
  /** No baseline, no file, or nothing to say. */
  | 'silent'
  /** File matches the baseline the framework recorded. */
  | 'unchanged'
  /** File diverged from the baseline and is NOT staged — nobody owns this. */
  | 'drifted'
  /** File diverged but the dev already staged it — it is part of the commit. */
  | 'staged'

export interface SettingsDrift {
  verdict: SettingsDriftVerdict
  /** Entries present now and absent from HEAD. Verbatim, never rewritten. */
  added_entries: string[]
  hint: string | null
}

const SILENT: SettingsDrift = { verdict: 'silent', added_entries: [], hint: null }

/**
 * Entries in `permissions.allow[]` that the current file has and `base` does
 * not. Verbatim and order-preserving: the report exists so the dev can read what
 * actually appeared, and a normalised or sorted list would hide the shape of it.
 *
 * Only `allow[]` is compared. That is the array the harness appends to, and
 * widening the comparison would turn every theme or model tweak into a report —
 * a signal that fires on everything is one nobody reads.
 */
export function addedAllowEntries(
  currentText: string | null,
  headText: string | null,
): string[] {
  const allowOf = (text: string | null): string[] => {
    if (text === null) return []
    try {
      const doc = JSON.parse(stripBom(text)) as {
        permissions?: { allow?: unknown[] }
      }
      const allow = doc.permissions?.allow
      return Array.isArray(allow) ? allow.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  const before = new Set(allowOf(headText))
  return allowOf(currentText).filter((e) => !before.has(e))
}

/**
 * Compare the settings file against the recorded baseline.
 *
 * `staged` is deliberately NOT reported: a dev who staged the file has claimed
 * it, which is precisely the ownership this check exists to establish. Reporting
 * it anyway would nag about a decision already made.
 */
export function evaluateSettingsDrift(args: {
  currentHash: string | null
  baseline: SettingsBaseline | null
  /** Is `.claude/settings.json` in the staged set? */
  staged: boolean
  currentText: string | null
  headText: string | null
}): SettingsDrift {
  if (args.baseline === null || args.currentHash === null) return SILENT
  if (args.currentHash === args.baseline.hash) return { ...SILENT, verdict: 'unchanged' }
  if (args.staged) return { ...SILENT, verdict: 'staged' }

  const added = addedAllowEntries(args.currentText, args.headText)
  const list = added.length > 0 ? added.map((e) => `  • ${e}`).join('\n') : '  (no new allow[] entries — the change is elsewhere in the file)'
  return {
    verdict: 'drifted',
    added_entries: added,
    hint:
      `.claude/settings.json has changed since this session started and is NOT staged. ` +
      `It is a VERSIONED file that the harness appends to on its own, so this is most ` +
      `likely machine-written, not yours:\n${list}\n` +
      `Three ways to resolve it, your call — RSCT will not decide: ` +
      `(1) stage it with this commit if the entries belong to the team; ` +
      `(2) move machine-specific ones to .claude/settings.local.json, which is gitignored; ` +
      `(3) discard them with git checkout -- .claude/settings.json. (report only, never blocks)`,
  }
}
