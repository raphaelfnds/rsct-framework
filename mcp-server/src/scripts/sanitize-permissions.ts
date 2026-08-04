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

// Node builtins only, transitively — this file is bundled into a standalone
// SessionStart hook, and it stays small (~11 KB) precisely by never reaching zod.
import { stripBom } from '../lib/io-utils.js'
import { hashSettingsFile } from '../lib/settings-drift.js'

/**
 * A git GLOBAL option — one of the tokens that may legally sit between `git` and
 * its subcommand (#32).
 *
 * This is the gap that let five bypass forms through: every pattern used to
 * assume `commit|push|merge` came immediately after `git`, but
 * `git -C <path> commit` is valid — and it commits in ANOTHER repository, which
 * also escapes the project-scoped reasoning the rest of the framework relies on.
 *
 * The value-taking forms accept a quoted argument, because a Windows path with
 * spaces (`git -C "C:\Program Files\repo" commit`) is exactly the shape that
 * would otherwise slip past.
 */
const GIT_GLOBAL_OPT = [
  '-[cC]\\s+(?:"[^"]*"|\'[^\']*\'|[^\\s)]+)', // -C <path>, -c key=value
  '--(?:git-dir|work-tree|exec-path|namespace)=(?:"[^"]*"|[^\\s)]+)',
  '--(?:no-pager|paginate|bare|literal-pathspecs|no-replace-objects)',
  '-p\\b',
].join('|')

/** Zero or more global options, each preceded by whitespace. */
const GIT_GLOBALS = `(?:\\s+(?:${GIT_GLOBAL_OPT}))*`

const POISON_PILL_PATTERNS: RegExp[] = [
  // Git mutations, with any run of global options between `git` and the
  // subcommand: Bash(git commit ...), Bash(git -C /repo commit),
  // Bash(git --git-dir=/r/.git push), Bash(git -c user.name=x merge).
  new RegExp(`^Bash\\(\\s*git${GIT_GLOBALS}\\s+(?:commit|push|merge)(?![\\w-])`, 'i'),
  // A wildcard stands where the SUBCOMMAND should be, so it authorises every
  // subcommand — commit included: Bash(git*), Bash(git:*), Bash(git -C:*).
  // The option class deliberately excludes `:` and `*` so the wildcard is not
  // swallowed as part of an option token.
  /^Bash\(\s*git(?:\s+-[^\s:*)]*)*\s*[:*]/i,
  // Blanket Bash wildcard at start: Bash(*), Bash(:*)
  /^Bash\(\s*[:*]/i,
  // Path-prefixed git mutation: Bash(/usr/bin/git commit), Bash(./bin/git push),
  // Bash(C:/Program Files/Git/bin/git merge). Lazy `[^)]*?` allows spaces inside
  // the path (Windows "Program Files") without sliding past the final separator.
  // The closing `git\s+(commit|push|merge)(?![\w-])` anchor pins the basename so
  // Bash(/somewhere/git-credential-store ...) (a different binary) does NOT
  // match — the `\s+` requires whitespace, not a dash, after `git`.
  /^Bash\(\s*[^)]*?[/\\]git\s+(commit|push|merge)(?![\w-])/i,
  // Shell wrapper around a git mutation: Bash(sh -c "git commit ..."), Bash(bash -c 'git push origin')
  // Any of the common POSIX shells + -c flag + content containing git commit/push/merge.
  /^Bash\(\s*(?:sh|bash|zsh|dash|fish|ksh|csh)\s+-c\b[^)]*\bgit\s+(commit|push|merge)(?![\w-])/i,
  // Wildcard-around-git: Bash(*git*) and similar — the bash matcher would
  // pick up commit/push/merge inside the wildcard envelope.
  /^Bash\([^)]*\*[^)]*\bgit\b[^)]*\*/i,
]

const SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

export type FileStatus =
  | 'absent'
  | 'malformed'
  | 'no_change'
  | 'sanitized'
  // plan-lifecycle-v2 Trilha 2: machine-absolute additionalDirectories moved
  // from the versioned settings.json into the per-user settings.local.json.
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

/**
 * plan-lifecycle-v2 Trilha 2: is `v` a machine-absolute path? `isAbsolute`
 * catches POSIX `/...` and, on win32, `C:\...`; the drive-letter regex is the
 * OR-complement so a `C:\...` / `C:/...` string is ALSO flagged when this runs
 * on a POSIX-built Node (where `isAbsolute('C:/x')` is false). Host-independent.
 */
export function isAbsoluteEntry(v: unknown): v is string {
  return typeof v === 'string' && (isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v))
}

/**
 * Home-directory shapes, matched ANYWHERE in a string (#12).
 *
 * `permissions.allow[]` entries are not paths — they are `Bash(...)`,
 * `Read(...)`, `WebFetch(...)` or `mcp__...` strings that may EMBED one. So
 * `isAbsoluteEntry` is useless here: it is start-anchored, and every allow entry
 * starts with a tool name. Measured against a corpus of real entries, it matched
 * 0 of 21 — including every genuine leak.
 *
 * The obvious replacement — "an absolute path anywhere" — is worse than useless,
 * because a false positive DELETES a working permission from the file the team
 * shares. Measured false positives on that predicate:
 *
 *   WebFetch(domain:https://github.com)      → `//github.com` reads as POSIX absolute
 *   Bash(curl -s https://registry.npmjs.org/) → same
 *   Bash(sed "s:/opt:/srv:")                  → the `:` delimiter reads as a drive letter
 *
 * So anchor on the HOME shapes instead, never on a bare `/`. That is also the
 * honest scope: §E is about "absolute paths with the OS username", and
 * `Read(/etc/hosts)` or `Bash(cd /tmp && ls)` carry no username, are identical on
 * every machine, and relocating them would only make teammates re-approve them.
 *
 * `//wsl.localhost/` is in the list because the WSL2-from-Windows setup is
 * exactly the environment that produces those entries (CAP-41 field report).
 */
const MACHINE_HOME_RE = new RegExp(
  [
    // C:\Users\ · c:/users/ — a drive letter is unambiguous wherever it appears,
    // so this branch needs no anchor. Case-folded by explicit class rather than
    // the `i` flag, because the POSIX branches below MUST stay case-sensitive.
    '[A-Za-z]:[\\\\/]{1,2}[Uu][Ss][Ee][Rr][Ss][\\\\/]',
    // /home/<user>/ and /Users/<user>/ must start a TOKEN, not appear mid-path.
    // Unanchored, `/home/` matched `Read(src/pages/home/**)` and `/users/`
    // matched `Bash(gh api /users/octocat)` — and a false positive here DELETES a
    // working permission from the file the whole team shares.
    '(^|[\\s"\'=(,;])/home/',
    // Capital U is load-bearing: macOS is `/Users/`, while `/users/` lower-case
    // is an API path (`gh api /users/x`, `localhost:3000/api/users/1`).
    '(^|[\\s"\'=(,;])/Users/',
    // WSL reaching a Windows drive. Not subsumed by the branch above: here
    // `/Users/` is preceded by the drive letter, not by a token boundary.
    '/mnt/[a-z]/[Uu]sers/',
    // Windows reaching WSL, in both spellings — the `\\` form is what a Windows
    // shell actually produces, and it is the CAP-41 field-report environment.
    '//wsl\\.localhost/',
    '\\\\\\\\wsl\\.localhost\\\\',
  ].join('|'),
)

/**
 * Does this entry embed a machine home path? Used for `permissions.allow[]`,
 * where the path is buried inside a command string.
 */
export function containsMachinePath(v: unknown): v is string {
  return typeof v === 'string' && MACHINE_HOME_RE.test(v)
}

/**
 * plan-lifecycle-v2 Trilha 2, generalised in #12: move entries carrying a
 * machine path out of the VERSIONED `.claude/settings.json` into the per-user,
 * auto-gitignored `.claude/settings.local.json`. A `C:\Users\me\...` path in the
 * shared file breaks teammates and leaks the local layout (§E).
 *
 * Parameterised by `key` + `matches` so `additionalDirectories` (bare paths,
 * `isAbsoluteEntry`) and `allow` (paths embedded in command strings,
 * `containsMachinePath`) share one migration engine. The DETECTION differs; the
 * migration does not — and the migration is the part with the atomicity rules
 * worth having exactly once.
 *
 * Entries are relocated VERBATIM. The command text is never rewritten and the
 * path is never genericised: the goal is to get it out of the versioned file,
 * not to guess what the dev meant.
 *
 * LOCAL-WRITE-FIRST for atomicity: write the entries into settings.local.json
 * BEFORE stripping them from settings.json, and ABORT (leaving settings.json
 * untouched) if the local file is malformed or unwritable — so a failed
 * migration can never lose the entries. Dedups against what local already has.
 * Returns a FileResult for the source, or null when there is nothing to migrate.
 */
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
    return null // the main loop reports settings.json as malformed
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

  // Local now holds the entries → strip them from the versioned settings.json.
  const keptDirs = dirs.filter((d) => !matches(d))
  const nextSettings: SettingsShape = {
    ...settings,
    permissions: { ...settings.permissions, [key]: keptDirs },
  }
  try {
    writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2) + '\n', 'utf8')
  } catch (err) {
    // Entries are safe in local; settings.json still has them. A re-run retries
    // the strip (dedup prevents local duplicates). Report as skipped.
    const error = err instanceof Error ? err.message : String(err)
    audit({ event: 'sanitize.migration_skipped', file: settingsPath, reason: 'source_write_failed', error })
    return { path: settingsPath, status: 'migration_skipped', error: `settings.json write failed: ${error}` }
  }
  audit({ event: 'sanitize.migrated', file: settingsPath, key, migrated: absolute, to: localPath, count: absolute.length })
  return { path: settingsPath, status: 'migrated', stripped: absolute }
}

/**
 * Fold the per-key migration results into ONE result per file. Without this a
 * single `settings.json` yields two entries, the stderr loop prints "migrated N
 * machine-absolute paths" twice, and a reader counts the same file as two.
 *
 * A `migration_skipped` dominates: it means the local file could not be written,
 * so nothing moved and the source was left untouched — reporting a partial
 * success beside it would misdescribe the state on disk.
 */
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
  // Trilha 2 + #12: migrate machine paths out of the versioned settings.json
  // FIRST — the poison-pill loop below then re-reads the (migrated) file.
  //
  // The order is load-bearing, not incidental. An entry can be BOTH a machine
  // path and a poison pill (`Bash(git -C "C:\Users\me\repo" commit)`). Running
  // the migration first relocates it verbatim into settings.local.json, and the
  // loop's SECOND iteration — over that same local file — strips the pill in the
  // same pass. Reversed, the pill would be stripped from the versioned file and
  // then... nothing, because the migration would find no entry to move. Worse,
  // migrating after would move a live §C bypass into the file nobody reviews and
  // leave it there until the next session.
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

  // #17: record what `.claude/settings.json` looks like as the framework leaves
  // it. Anything that diverges from this later in the session is drift the
  // framework did not author — which is what `rsct_request_commit` reports.
  //
  // LAST, deliberately: both the migration and the poison-pill strip may have
  // rewritten the file above, and a baseline taken before them would freeze the
  // very entries this run just removed, reporting the framework's own cleanup as
  // drift on the next commit.
  const baselineHash = hashSettingsFile(projectRoot)
  if (baselineHash !== null) {
    audit({ event: 'settings.baseline', file: join(projectRoot, '.claude', 'settings.json'), hash: baselineHash })
  }

  return result
}

/**
 * Where the audit log lives for this project, honouring `audit.path` in
 * `.rsct.json` exactly as `lib/audit-log.ts` `resolveAuditPath` does.
 *
 * Reimplemented here rather than imported, and that is deliberate: this file is
 * bundled into a standalone SessionStart hook, and `resolveAuditPath` sits in a
 * module that reaches zod. Reading the one key with a bare `JSON.parse` keeps the
 * bundle on node builtins.
 *
 * It has to agree with the real resolver, and #17 is why that suddenly matters:
 * the `settings.baseline` this hook writes is read back by
 * `rsct_request_commit`. Written to a different file than the reader looks at,
 * the drift report is silently dead in any project that configured `audit.path`.
 */
function resolveAuditLogPath(projectRoot: string): string {
  try {
    const raw = stripBom(readFileSync(join(projectRoot, '.rsct.json'), 'utf8'))
    const cfg = JSON.parse(raw) as { audit?: { path?: unknown } }
    const configured = cfg.audit?.path
    if (typeof configured === 'string' && configured.length > 0) {
      return isAbsolute(configured) ? configured : resolve(projectRoot, configured)
    }
  } catch {
    // No config, unreadable, or malformed → the default below.
  }
  return join(projectRoot, '.rsct', 'audit.log')
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
