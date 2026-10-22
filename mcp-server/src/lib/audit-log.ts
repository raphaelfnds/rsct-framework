import { appendFileSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ensureParentDir } from './io-utils.js'
import { anchorFor, protectRelocatedState, sameDirectory, type AnchorStatus } from './repo-anchor.js'
import type { RsctAuditConfig } from './project-root.js'

export interface AuditEntry {
  event: string
  [key: string]: unknown
}

export type AuditAppendResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'disabled' | 'write_failed'; path?: string; error?: string }

const DEFAULT_RELATIVE_PATH = '.rsct/audit.log'

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

export interface AuditPathDecision {
  path: string
  base: string
  escaped: string | null
  unusable: { path: string; reason: AuditPathUnusable } | null
  anchor: AnchorStatus
}

export type AuditPathUnusable = 'stream' | 'name' | 'not_a_file'

const WINDOWS_FORBIDDEN = /[<>"|?*]/

const PORT_DIGITS = `0-9${String.fromCharCode(0xb9, 0xb2, 0xb3)}`

const WINDOWS_RESERVED = new RegExp(`^(?:con|prn|aux|nul|com[${PORT_DIGITS}]|lpt[${PORT_DIGITS}]|conin\\$|conout\\$)(?:\\..*)?$`, 'i')

function unusableTail(base: string, candidate: string): AuditPathUnusable | null {
  const tail = relative(base, candidate)
  if (tail === '') return 'not_a_file'
  const windows = process.platform === 'win32'
  if (windows && tail.includes(':')) return 'stream'
  if (/\p{Cc}/u.test(tail)) return 'name'
  const segments = tail.split(sep)
  if (windows) {
    if (WINDOWS_FORBIDDEN.test(tail)) return 'name'
    if (segments.some((s) => WINDOWS_RESERVED.test(s) || /[. ]$/.test(s))) return 'name'
  }
  for (let i = 1; i < segments.length; i += 1) {
    if (statSync(join(base, ...segments.slice(0, i)), { throwIfNoEntry: false })?.isDirectory() === false) return 'not_a_file'
  }
  return statSync(candidate, { throwIfNoEntry: false })?.isFile() === false ? 'not_a_file' : null
}

const migrationAttempted = new Set<string>()

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
    protectRelocatedState(projectRoot)
  } catch {
  }
}

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
      return { path: fallback, base, escaped: candidate, unusable: null, anchor: anchor.status }
    }
    let reason: AuditPathUnusable | null
    try {
      reason = unusableTail(base, candidate)
    } catch {
      reason = 'not_a_file'
    }
    if (reason !== null) {
      return { path: fallback, base, escaped: null, unusable: { path: configured, reason }, anchor: anchor.status }
    }
    return { path: candidate, base, escaped: null, unusable: null, anchor: anchor.status }
  }
  return { path: fallback, base, escaped: null, unusable: null, anchor: anchor.status }
}

function isInside(base: string, candidate: string): boolean {
  if (sameDirectory(base, candidate)) return true
  const b = resolve(base).replace(/\\/g, '/').replace(/\/+$/, '')
  const c = resolve(candidate).replace(/\\/g, '/')
  const prefix = process.platform === 'win32' ? b.toLowerCase() + '/' : b + '/'
  const target = process.platform === 'win32' ? c.toLowerCase() : c
  return target.startsWith(prefix)
}

export function resolveAuditPath(projectRoot: string, config?: RsctAuditConfig): string {
  return decideAuditPath(projectRoot, config).path
}

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
    protectRelocatedState(projectRoot)
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
