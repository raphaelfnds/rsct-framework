import { decideAuditPath } from './audit-log.js'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { resolveProjectRootFromArgs } from './hook-project-root.js'
import { stripBom } from './io-utils.js'
import { hashSettingsFile } from './settings-drift.js'

const GIT_GLOBAL_OPT = [
  '-[cC]\\s+(?:"[^"]*"|\'[^\']*\'|[^\\s)]+)',
  '--(?:git-dir|work-tree|exec-path|namespace)=(?:"[^"]*"|[^\\s)]+)',
  '--(?:no-pager|paginate|bare|literal-pathspecs|no-replace-objects)',
  '-p\\b',
].join('|')

const GIT_GLOBALS = `(?:\\s+(?:${GIT_GLOBAL_OPT}))*`

const POISON_PILL_PATTERNS: RegExp[] = [
  new RegExp(`^Bash\\(\\s*git${GIT_GLOBALS}\\s+(?:commit|push|merge|rebase|cherry-pick|revert)(?![\\w-])`, 'i'),
  /^Bash\(\s*git(?:\s+-[^\s:*)]*)*\s*[:*]/i,
  /^Bash\(\s*[:*]/i,
  /^Bash\(\s*[^)]*?[/\\]git\s+(commit|push|merge|rebase|cherry-pick|revert)(?![\w-])/i,
  /^Bash\(\s*(?:sh|bash|zsh|dash|fish|ksh|csh)\s+-c\b[^)]*\bgit\s+(commit|push|merge|rebase|cherry-pick|revert)(?![\w-])/i,
  /^Bash\([^)]*\*[^)]*\bgit\b[^)]*\*/i,
  /^Bash\(\s*(?:[^)]*?[/\\])?gh\s+pr\s+merge(?![\w-])/i,
]

const SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

export type FileStatus =
  | 'absent'
  | 'malformed'
  | 'no_change'
  | 'sanitized'
  | 'migrated'
  | 'migration_skipped'

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
    additionalDirectories?: unknown[]
    [k: string]: unknown
  }
  [k: string]: unknown
}

export function isPoisonPill(entry: unknown): entry is string {
  if (typeof entry !== 'string') return false
  return POISON_PILL_PATTERNS.some((re) => re.test(entry))
}

export function isAbsoluteEntry(v: unknown): v is string {
  return typeof v === 'string' && (isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v))
}

const MACHINE_HOME_RE = new RegExp(
  [
    '[A-Za-z]:[\\\\/]{1,2}[Uu][Ss][Ee][Rr][Ss][\\\\/]',
    '(^|[\\s"\'=(,;])/home/',
    '(^|[\\s"\'=(,;])/Users/',
    '/mnt/[a-z]/[Uu]sers/',
    '//wsl\\.localhost/',
    '\\\\\\\\wsl\\.localhost\\\\',
  ].join('|'),
)

export function containsMachinePath(v: unknown): v is string {
  return typeof v === 'string' && MACHINE_HOME_RE.test(v)
}

function migrateAbsoluteEntries(
  projectRoot: string,
  key: 'additionalDirectories' | 'allow',
  matches: (v: unknown) => v is string,
  audit: (entry: Record<string, unknown>) => void,
): FileResult | null {
  const settingsPath = join(projectRoot, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return null
  let settings: SettingsShape
  try {
    settings = JSON.parse(stripBom(readFileSync(settingsPath, 'utf8'))) as SettingsShape
  } catch {
    return null
  }
  const dirs = settings.permissions?.[key]
  if (!Array.isArray(dirs) || dirs.length === 0) return null
  const absolute = dirs.filter(matches)
  if (absolute.length === 0) return null

  const localPath = join(projectRoot, '.claude', 'settings.local.json')
  let local: SettingsShape = {}
  if (existsSync(localPath)) {
    try {
      local = JSON.parse(stripBom(readFileSync(localPath, 'utf8'))) as SettingsShape
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      audit({ event: 'sanitize.migration_skipped', file: settingsPath, reason: 'local_malformed', error })
      return { path: settingsPath, status: 'migration_skipped', error: `settings.local.json malformed: ${error}` }
    }
  }
  const localPerms =
    local.permissions && typeof local.permissions === 'object' ? { ...local.permissions } : {}
  const localDirs = Array.isArray(localPerms[key]) ? (localPerms[key] as unknown[]) : []
  const localSet = new Set(localDirs.filter((x): x is string => typeof x === 'string'))
  const toAdd = absolute.filter((a) => !localSet.has(a))
  const nextLocal: SettingsShape = {
    ...local,
    permissions: { ...localPerms, [key]: [...localDirs, ...toAdd] },
  }
  try {
    mkdirSync(dirname(localPath), { recursive: true })
    writeFileSync(localPath, JSON.stringify(nextLocal, null, 2) + '\n', 'utf8')
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    audit({ event: 'sanitize.migration_skipped', file: settingsPath, reason: 'local_write_failed', error })
    return { path: settingsPath, status: 'migration_skipped', error: `settings.local.json write failed: ${error}` }
  }

  const keptDirs = dirs.filter((d) => !matches(d))
  const nextSettings: SettingsShape = {
    ...settings,
    permissions: { ...settings.permissions, [key]: keptDirs },
  }
  try {
    writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2) + '\n', 'utf8')
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    audit({ event: 'sanitize.migration_skipped', file: settingsPath, reason: 'source_write_failed', error })
    return { path: settingsPath, status: 'migration_skipped', error: `settings.json write failed: ${error}` }
  }
  audit({ event: 'sanitize.migrated', file: settingsPath, key, migrated: absolute, to: localPath, count: absolute.length })
  return { path: settingsPath, status: 'migrated', stripped: absolute }
}

function mergeMigrations(results: (FileResult | null)[]): FileResult | null {
  const present = results.filter((r): r is FileResult => r !== null)
  if (present.length === 0) return null
  const skipped = present.find((r) => r.status === 'migration_skipped')
  if (skipped) return skipped
  const stripped = present.flatMap((r) => r.stripped ?? [])
  return { path: present[0]!.path, status: 'migrated', stripped }
}

export function sanitize(
  projectRoot: string,
  options: SanitizeOptions = {},
): SanitizeResult {
  const now = options.now ?? new Date()
  const audit =
    options.auditWriter ?? ((entry) => defaultAuditWriter(projectRoot, entry, now))
  const result: SanitizeResult = { projectRoot, files: [] }
  const migration = mergeMigrations([
    migrateAbsoluteEntries(projectRoot, 'additionalDirectories', isAbsoluteEntry, audit),
    migrateAbsoluteEntries(projectRoot, 'allow', containsMachinePath, audit),
  ])
  if (migration) result.files.push(migration)
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
      parsed = JSON.parse(stripBom(raw)) as SettingsShape
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

  const baselineHash = hashSettingsFile(projectRoot)
  if (baselineHash !== null) {
    audit({ event: 'settings.baseline', file: join(projectRoot, '.claude', 'settings.json'), hash: baselineHash })
  }

  return result
}

function resolveAuditLogPath(projectRoot: string): string {
  let configured: string | undefined
  try {
    const raw = stripBom(readFileSync(join(projectRoot, '.rsct.json'), 'utf8'))
    const cfg = JSON.parse(raw) as { audit?: { path?: unknown } }
    if (typeof cfg.audit?.path === 'string' && cfg.audit.path.length > 0) {
      configured = cfg.audit.path
    }
  } catch {
  }
  return decideAuditPath(projectRoot, configured === undefined ? undefined : { path: configured })
    .path
}

function defaultAuditWriter(
  projectRoot: string,
  entry: Record<string, unknown>,
  now: Date,
): void {
  try {
    const auditPath = resolveAuditLogPath(projectRoot)
    mkdirSync(dirname(auditPath), { recursive: true })
    const stamped = { ...entry, ts: now.toISOString() }
    appendFileSync(auditPath, JSON.stringify(stamped) + '\n', 'utf8')
  } catch {
  }
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
    } else if (file.status === 'migrated') {
      const count = file.stripped?.length ?? 0
      const label = count === 1 ? 'path' : 'paths'
      options.stderr(
        `[rsct-sanitize] migrated ${count} machine-absolute ${label} from ${file.path} to settings.local.json (keep machine paths out of the versioned file)`,
      )
    } else if (file.status === 'migration_skipped') {
      options.stderr(
        `[rsct-sanitize] skipped migrating absolute paths from ${file.path}: ${file.error ?? 'unknown error'} (settings.json left untouched)`,
      )
    }
  }
  return 0
}
