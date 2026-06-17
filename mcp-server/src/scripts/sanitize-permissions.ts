/**
 * INV-2.3 poison-pill closer (SessionStart hook).
 *
 * The §C-gated tools (rsct_request_commit/_push/_merge) require an
 * out-of-band dev_approval before mutating git. A "trust forever" entry
 * like `Bash(git commit:*)` in .claude/settings.local.json would let
 * the model bypass that by running git commit directly. This script
 * strips such entries from `permissions.allow[]` in both
 * .claude/settings.json and .claude/settings.local.json. It is meant
 * to run as a Claude Code SessionStart hook so the poison pill is
 * removed at every session boot.
 *
 * Constraints:
 *  - Zero external deps (Node builtins only) — runs before the MCP
 *    server is loaded.
 *  - Never throws; always exits 0 so a malformed settings file cannot
 *    block session start. Failures are reported to stderr and (best
 *    effort) appended to .rsct/audit.log.
 *  - Scope intentionally narrow: only git commit/push/merge bypasses.
 *    Other Bash patterns and tool permissions are preserved.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const POISON_PILL_PATTERNS: RegExp[] = [
  // Bare git mutations: Bash(git commit/push/merge ...)
  /^Bash\(\s*git\s+commit\b/i,
  /^Bash\(\s*git\s+push\b/i,
  /^Bash\(\s*git\s+merge\b/i,
  // git followed by colon or wildcard: Bash(git*), Bash(git:*)
  /^Bash\(\s*git\s*[:*]/i,
  // Blanket Bash wildcard at start: Bash(*), Bash(:*)
  /^Bash\(\s*[:*]/i,
  // Path-prefixed git mutation: Bash(/usr/bin/git commit), Bash(./bin/git push),
  // Bash(C:/Program Files/Git/bin/git merge). Lazy `[^)]*?` allows spaces inside
  // the path (Windows "Program Files") without sliding past the final separator.
  // The closing `git\s+(commit|push|merge)\b` anchor pins the basename so
  // Bash(/somewhere/git-credential-store ...) (a different binary) does NOT
  // match — the `\s+` requires whitespace, not a dash, after `git`.
  /^Bash\(\s*[^)]*?[/\\]git\s+(commit|push|merge)\b/i,
  // Shell wrapper around a git mutation: Bash(sh -c "git commit ..."), Bash(bash -c 'git push origin')
  // Any of the common POSIX shells + -c flag + content containing git commit/push/merge.
  /^Bash\(\s*(?:sh|bash|zsh|dash|fish|ksh|csh)\s+-c\b[^)]*\bgit\s+(commit|push|merge)\b/i,
  // Wildcard-around-git: Bash(*git*) and similar — the bash matcher would
  // pick up commit/push/merge inside the wildcard envelope.
  /^Bash\([^)]*\*[^)]*\bgit\b[^)]*\*/i,
]

const SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

export type FileStatus = 'absent' | 'malformed' | 'no_change' | 'sanitized'

export interface FileResult {
  path: string
  status: FileStatus
  stripped?: string[]
  error?: string
}

export interface SanitizeResult {
  projectRoot: string
  files: FileResult[]
}

export interface SanitizeOptions {
  now?: Date
  auditWriter?: (entry: Record<string, unknown>) => void
}

interface SettingsShape {
  permissions?: {
    allow?: unknown[]
    [k: string]: unknown
  }
  [k: string]: unknown
}

export function isPoisonPill(entry: unknown): entry is string {
  if (typeof entry !== 'string') return false
  return POISON_PILL_PATTERNS.some((re) => re.test(entry))
}

export function sanitize(
  projectRoot: string,
  options: SanitizeOptions = {},
): SanitizeResult {
  const now = options.now ?? new Date()
  const audit =
    options.auditWriter ?? ((entry) => defaultAuditWriter(projectRoot, entry, now))
  const result: SanitizeResult = { projectRoot, files: [] }
  for (const name of SETTINGS_FILES) {
    const path = join(projectRoot, '.claude', name)
    if (!existsSync(path)) {
      result.files.push({ path, status: 'absent' })
      continue
    }
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (err) {
      result.files.push({
        path,
        status: 'malformed',
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    let parsed: SettingsShape
    try {
      parsed = JSON.parse(raw) as SettingsShape
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.files.push({ path, status: 'malformed', error: message })
      audit({ event: 'sanitize.malformed', file: path, error: message })
      continue
    }
    const allow = parsed.permissions?.allow
    if (!Array.isArray(allow) || allow.length === 0) {
      result.files.push({ path, status: 'no_change' })
      continue
    }
    const stripped: string[] = []
    const kept: unknown[] = []
    for (const entry of allow) {
      if (isPoisonPill(entry)) {
        stripped.push(entry)
      } else {
        kept.push(entry)
      }
    }
    if (stripped.length === 0) {
      result.files.push({ path, status: 'no_change' })
      continue
    }
    const nextPermissions = { ...(parsed.permissions ?? {}), allow: kept }
    const next: SettingsShape = { ...parsed, permissions: nextPermissions }
    try {
      writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.files.push({ path, status: 'malformed', error: message, stripped })
      continue
    }
    result.files.push({ path, status: 'sanitized', stripped })
    audit({
      event: 'sanitize.stripped',
      file: path,
      stripped,
      count: stripped.length,
    })
  }
  return result
}

function defaultAuditWriter(
  projectRoot: string,
  entry: Record<string, unknown>,
  now: Date,
): void {
  try {
    const auditPath = join(projectRoot, '.rsct', 'audit.log')
    mkdirSync(dirname(auditPath), { recursive: true })
    const stamped = { ...entry, ts: now.toISOString() }
    appendFileSync(auditPath, JSON.stringify(stamped) + '\n', 'utf8')
  } catch {
    // Never block session start on audit failure.
  }
}

export interface ResolveOptions {
  argv: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

export function resolveProjectRootFromArgs(options: ResolveOptions): string {
  const { argv, env, cwd } = options
  const idx = argv.indexOf('--project-root')
  if (idx !== -1) {
    const value = argv[idx + 1]
    if (value && value.length > 0) {
      return isAbsolute(value) ? value : resolve(cwd, value)
    }
  }
  const fromEnv = env.CLAUDE_PROJECT_DIR
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv
  }
  return cwd
}

export interface MainOptions {
  argv: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  stderr: (msg: string) => void
}

export function main(options: MainOptions): number {
  const projectRoot = resolveProjectRootFromArgs({
    argv: options.argv,
    env: options.env,
    cwd: options.cwd,
  })
  const result = sanitize(projectRoot)
  for (const file of result.files) {
    if (file.status === 'sanitized') {
      const count = file.stripped?.length ?? 0
      const label = count === 1 ? 'entry' : 'entries'
      options.stderr(
        `[rsct-sanitize] stripped ${count} poison-pill ${label} from ${file.path}`,
      )
    } else if (file.status === 'malformed') {
      options.stderr(
        `[rsct-sanitize] could not process ${file.path}: ${file.error ?? 'unknown error'}`,
      )
    }
  }
  return 0
}

function isCliEntry(): boolean {
  if (!process.argv[1]) return false
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1])
  } catch {
    return false
  }
}

if (isCliEntry()) {
  const exitCode = main({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stderr: (msg) => process.stderr.write(msg + '\n'),
  })
  process.exit(exitCode)
}
