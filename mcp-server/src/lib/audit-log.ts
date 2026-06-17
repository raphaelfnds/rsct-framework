import { appendFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { ensureParentDir } from './io-utils.js'
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
 * Resolve the audit log path for a project. Honors `audit.path` from
 * `.rsct.json` (relative paths anchored at project root); defaults to
 * `<root>/.rsct/audit.log`.
 */
export function resolveAuditPath(projectRoot: string, config?: RsctAuditConfig): string {
  const configured = config?.path
  if (configured && configured.length > 0) {
    return isAbsolute(configured) ? configured : resolve(projectRoot, configured)
  }
  return join(projectRoot, DEFAULT_RELATIVE_PATH)
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
