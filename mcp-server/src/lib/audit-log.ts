import { appendFileSync, copyFileSync, existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { ensureParentDir } from './io-utils.js'
import { anchorFor, sameDirectory, type AnchorStatus } from './repo-anchor.js'
import type { RsctAuditConfig } from './project-root.js'

export interface AuditEntry {
  event: string
  [key: string]: unknown
}

export type AuditAppendResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'disabled' | 'write_failed'; path?: string; error?: string }

const DEFAULT_RELATIVE_PATH = '.rsct/audit.log'

/**
 * Project an `AuditAppendResult` into the `{audit_path, audit_error}` pair that
 * every tool returns to the caller. A disabled audit is not an error, so it maps
 * to `{null, null}` — only a genuine write failure surfaces `audit_error`.
 *
 * Lives here (beside `AuditAppendResult`) because 15 tools had each declared an
 * identical private copy; see issue #10.
 */
export function auditFields(audit: AuditAppendResult): {
  audit_path: string | null
  audit_error: string | null
} {
  if (audit.ok) return { audit_path: audit.path, audit_error: null }
  if (audit.reason === 'disabled') return { audit_path: null, audit_error: null }
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? 'write_failed',
  }
}

/**
 * Where the audit log lives, and what it is contained by.
 *
 * #92: the base is the REPOSITORY the action lands in, not the caller's
 * `project_root` string. A crafted subdirectory of a real repo resolves back to
 * that repo, so it cannot present a fresh ceiling, a fresh lock or a blank
 * history for commits that land in the parent.
 *
 * `escaped` reports a configured `audit.path` that resolves OUTSIDE that base.
 * Such a path is NOT honoured — the log falls back to the default location —
 * because MEASURED, an absolute `audit.path` relocates both free-lane anchors
 * from the correct root and therefore survives the binding untouched. The
 * fallback is the safe direction; the caller surfaces `escaped` so the
 * developer is told rather than silently redirected.
 */
export interface AuditPathDecision {
  path: string
  /** Directory the log is contained by — the repository anchor root. */
  base: string
  /** A configured `audit.path` pointed outside `base` and was refused. */
  escaped: string | null
  /** Anchor status, so a caller can report a relocation or a degraded read. */
  anchor: AnchorStatus
}

const migrationAttempted = new Set<string>()

/**
 * AUDIT-2 — carry an existing install's history to the relocated location.
 *
 * Without this, the first run after the upgrade in a RELOCATING project (a
 * monorepo package, a project nested in an unrelated repo) finds no log at the
 * new base. `audit_history_absent` fires and the lane suspends — the safe
 * direction — but the old log is orphaned, and with it go the free-commit count,
 * the `free_commit.locked` latch, the tier ratchet, every `settings.baseline`
 * and every consumed-approval record. **A locked budget would silently unlock
 * and a spent approval would become replayable**: the exact failure this release
 * exists to prevent, delivered by its own upgrade.
 *
 * Copy, never move: the old file stays as evidence, and a half-finished
 * migration cannot destroy the only copy. If BOTH exist the migration is
 * skipped — merging two histories blind would double-count the ceiling, and the
 * new location is authoritative once it exists.
 *
 * A deliberate side effect at an otherwise pure resolver, because this is the
 * one choke point every reader and writer of the log already passes through.
 * Memoized per root so it is attempted once per process.
 */
function migrateLegacyLog(projectRoot: string, base: string, target: string): void {
  if (sameDirectory(projectRoot, base)) return
  const key = resolve(projectRoot)
  if (migrationAttempted.has(key)) return
  migrationAttempted.add(key)

  const legacy = join(resolve(projectRoot), DEFAULT_RELATIVE_PATH)
  try {
    if (!existsSync(legacy) || existsSync(target)) return
    ensureParentDir(target)
    copyFileSync(legacy, target)
    appendFileSync(
      target,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'audit_log.migrated',
        from: legacy.replace(/\\/g, '/'),
        to: target.replace(/\\/g, '/'),
        reason: 'anchor bound to the repository (#92); history carried forward',
      }) + '\n',
      'utf8',
    )
  } catch {
    // Never throw from a path resolver. A failed migration leaves the legacy
    // file untouched and the new location empty, which fails CLOSED at the
    // history signal rather than silently resetting the ceiling.
  }
}

/** Test seam — the memo is process-wide and would leak between cases. */
export function clearAuditMigrationMemo(): void {
  migrationAttempted.clear()
}

export function decideAuditPath(
  projectRoot: string,
  config?: RsctAuditConfig,
): AuditPathDecision {
  const anchor = anchorFor(projectRoot)
  const base = anchor.root
  const fallback = join(base, DEFAULT_RELATIVE_PATH)
  migrateLegacyLog(projectRoot, base, fallback)

  const configured = config?.path
  if (configured && configured.length > 0) {
    const candidate = isAbsolute(configured) ? resolve(configured) : resolve(base, configured)
    if (!isInside(base, candidate)) {
      return { path: fallback, base, escaped: candidate, anchor: anchor.status }
    }
    return { path: candidate, base, escaped: null, anchor: anchor.status }
  }
  return { path: fallback, base, escaped: null, anchor: anchor.status }
}

/**
 * Containment test. Compares through the same normalization the anchor uses —
 * a raw `startsWith` would disagree with `sameDirectory` on a trailing
 * separator, on `/` versus `\`, and on drive-letter case, which is precisely
 * the divergence class this issue exists to close.
 *
 * The `sameDirectory` call is not redundant with the prefix test: a path equal
 * to the base has no trailing separator to match against `base + '/'`.
 */
function isInside(base: string, candidate: string): boolean {
  if (sameDirectory(base, candidate)) return true
  const b = resolve(base).replace(/\\/g, '/').replace(/\/+$/, '')
  const c = resolve(candidate).replace(/\\/g, '/')
  const prefix = process.platform === 'win32' ? b.toLowerCase() + '/' : b + '/'
  const target = process.platform === 'win32' ? c.toLowerCase() : c
  return target.startsWith(prefix)
}

/**
 * Resolve the audit log path for a project. Kept as the one-line reader the
 * existing call sites expect; {@link decideAuditPath} carries the containment
 * and anchor detail for callers that report it.
 */
export function resolveAuditPath(projectRoot: string, config?: RsctAuditConfig): string {
  return decideAuditPath(projectRoot, config).path
}

/**
 * Append a single JSONL entry to the project audit log.
 *
 * Behavior:
 *  - If `audit.enabled === false` in config, returns `{ ok: false, reason: 'disabled' }`
 *    without touching disk. Audit defaults to enabled when the block is absent.
 *  - Auto-creates the parent directory (typically `.rsct/`) if missing.
 *  - Every entry is stamped with an ISO-8601 `ts` field (overrides any caller-provided `ts`).
 *  - Writes are append-only via `appendFileSync` with newline terminator.
 *  - Failures (read-only FS, permission denied) return `{ ok: false, reason: 'write_failed' }`.
 *    Never throws — mutating tools must continue when audit is unavailable, surfacing
 *    the failure via the result so the caller can log it back to the dev.
 */
export function appendAuditEntry(
  projectRoot: string,
  entry: AuditEntry,
  config?: RsctAuditConfig,
): AuditAppendResult {
  if (config?.enabled === false) {
    return { ok: false, reason: 'disabled' }
  }

  const path = resolveAuditPath(projectRoot, config)

  try {
    ensureParentDir(path)
    const stamped = { ...entry, ts: new Date().toISOString() }
    const line = `${JSON.stringify(stamped)}\n`
    appendFileSync(path, line, { encoding: 'utf8' })
    return { ok: true, path }
  } catch (err) {
    return {
      ok: false,
      reason: 'write_failed',
      path,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
