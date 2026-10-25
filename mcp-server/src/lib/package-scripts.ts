import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export type PackageRead = { kind: 'missing' } | { kind: 'text'; text: string } | { kind: 'unreadable'; reason: string }
export type PackageReader = (path: string) => PackageRead
export type PackageListing = { files: string[]; complete: boolean }
export type PackageLister = (root: string, file: string) => PackageListing

export type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'composer'
export type PackageFile = 'package.json' | 'composer.json'

export const MAX_PACKAGE_BYTES = 1024 * 1024
const MAX_LISTED = 200
const MAX_LISTED_DIRS = 2000
const MAX_LIST_DEPTH = 5

export const MANAGERS: ReadonlyMap<string, Manager> = new Map([
  ['npm', 'npm'],
  ['pnpm', 'pnpm'],
  ['yarn', 'yarn'],
  ['yarnpkg', 'yarn'],
  ['bun', 'bun'],
  ['composer', 'composer'],
  ['composer.phar', 'composer'],
])
export const EXEC_RUNNERS: ReadonlySet<string> = new Set(['npx', 'pnpx', 'bunx'])

export const PACKAGE_FILE_NAME = /\b(?:package\.json5?|package\.yaml|composer\.json|packag~\d+\.(?:jso|yam)|compos~\d+\.jso)\b/i

export const defaultPackageReader: PackageReader = (path) => {
  let st
  try {
    st = statSync(path)
  } catch {
    return { kind: 'missing' }
  }
  if (!st.isFile()) return { kind: 'unreadable', reason: `${path} is not a regular file` }
  if (st.size > MAX_PACKAGE_BYTES) return { kind: 'unreadable', reason: `${path} is larger than ${MAX_PACKAGE_BYTES / 1024} KiB` }
  try {
    return { kind: 'text', text: readFileSync(path, 'utf8') }
  } catch (e) {
    return { kind: 'unreadable', reason: `${path} could not be read (${(e as Error).message})` }
  }
}

export const defaultPackageLister: PackageLister = (root, file) => {
  const files: string[] = []
  let dirs = 0
  let complete = true
  const walk = (dir: string, depth: number): void => {
    if (!complete) return
    if (++dirs > MAX_LISTED_DIRS) {
      complete = false
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isFile() || e.name !== file) continue
      if (files.length >= MAX_LISTED) {
        complete = false
        return
      }
      files.push(join(dir, e.name))
    }
    if (depth >= MAX_LIST_DEPTH) return
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'vendor' && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return { files, complete }
}

export function resolveFolder(base: string | undefined, target: string): string | undefined {
  let t = target
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) t = join(homedir(), t.slice(1))
  if (process.platform === 'win32') {
    const drive = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(t)
    if (drive) t = `${drive[1]!.toUpperCase()}:\\${drive[2] ?? ''}`
  }
  if (isAbsolute(t)) return resolve(t)
  return base === undefined ? undefined : resolve(base, t)
}

export function findUp(dir: string, file: string, reader: PackageReader): { path: string; read: Exclude<PackageRead, { kind: 'missing' }> } | null {
  let current = resolve(dir)
  for (;;) {
    const path = join(current, file)
    const read = reader(path)
    if (read.kind !== 'missing') return { path, read }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function repoRoot(dir: string, reader: PackageReader): string | null {
  let current = resolve(dir)
  for (;;) {
    if (reader(join(current, '.git')).kind !== 'missing') return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export type Parsed = { ok: true; json: Record<string, unknown> } | { ok: false; reason: string }

export function parsePackage(path: string, read: Exclude<PackageRead, { kind: 'missing' }>): Parsed {
  if (read.kind === 'unreadable') return { ok: false, reason: read.reason }
  const text = read.text.charCodeAt(0) === 0xfeff ? read.text.slice(1) : read.text
  try {
    const json = JSON.parse(text) as unknown
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: `${path} is not a JSON object` }
    return { ok: true, json: json as Record<string, unknown> }
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` }
  }
}

function scriptsOf(json: Record<string, unknown>): Record<string, unknown> | null {
  const s = json.scripts
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : null
}

export function scriptTexts(manager: Manager, json: Record<string, unknown>, name: string): string[] {
  const scripts = scriptsOf(json)
  if (scripts === null || !Object.prototype.hasOwnProperty.call(scripts, name)) return []
  if (manager !== 'composer') {
    const v = scripts[name]
    return typeof v === 'string' ? [v] : []
  }
  return composerTexts(scripts, name, new Set())
}

function composerTexts(scripts: Record<string, unknown>, name: string, seen: Set<string>): string[] {
  if (seen.has(name) || !Object.prototype.hasOwnProperty.call(scripts, name)) return []
  seen.add(name)
  const raw = scripts[name]
  const items = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  const texts: string[] = []
  for (const item of items) {
    const s = item.trim()
    if (s.startsWith('@putenv')) continue
    if (s.startsWith('@php ')) texts.push(`php ${s.slice(5)}`)
    else if (s.startsWith('@composer ')) texts.push(`composer ${s.slice(10)}`)
    else if (s.startsWith('@')) texts.push(...composerTexts(scripts, s.slice(1).split(/\s+/)[0]!, seen))
    else if (/^[A-Za-z_\\][\w\\]*::\w+$/.test(s)) continue
    else texts.push(s)
  }
  return texts
}

export type ArgValue = { at: number; value: string }

export interface ExecPlan {
  execAt: number | null
  execCode: ArgValue[]
}

export interface ManagerPlan extends ExecPlan {
  file: PackageFile
  names: string[]
  nameAt: number[]
  folders: ArgValue[]
  workspaces: boolean
  versionCommit: boolean
  writesPackage: boolean
  global: boolean
}

const INSTALL_WORDS = new Set([
  'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'ci', 'clean-install',
  'ic', 'install-clean', 'isntall-clean', 'install-test', 'it', 'install-ci-test', 'cit', 'clean-install-test', 'sit',
  'update', 'up', 'upgrade', 'udpate', 'rebuild', 'rb', 'link', 'ln', 'remove', 'rm', 'r', 'un', 'uninstall', 'unlink',
  'dedupe', 'ddp', 'prune',
])
const INSTALL_LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies']
const TEST_LIFECYCLE = ['pretest', 'test', 'posttest']
const COMPOSER_INSTALL_EVENTS = [
  'pre-install-cmd', 'post-install-cmd', 'pre-update-cmd', 'post-update-cmd', 'pre-autoload-dump', 'post-autoload-dump',
  'pre-operations-exec', 'pre-pool-create', 'pre-package-install',
  'post-package-install', 'pre-package-update', 'post-package-update', 'pre-package-uninstall', 'post-package-uninstall',
]
const COMPOSER_EVENT_WORDS = new Set(['install', 'i', 'update', 'u', 'upgrade', 'require', 'r', 'remove', 'rm', 'dump-autoload', 'dumpautoload', 'reinstall', 'create-project'])
const COMPOSER_CREATE_PROJECT_EVENTS = ['post-root-package-install', 'post-create-project-cmd']
const NO_SCRIPT_SWITCHES = new Set(['--no-scripts', '--ignore-scripts', '--ignore-scripts=true'])
const COMPOSER_ARCHIVE_EVENTS = ['pre-archive-cmd', 'post-archive-cmd']
const DIRECT_LIFECYCLE: ReadonlyMap<string, string[]> = new Map([
  ['test', TEST_LIFECYCLE],
  ['start', ['prestart', 'start', 'poststart']],
  ['stop', ['prestop', 'stop', 'poststop']],
  ['restart', ['prerestart', 'restart', 'postrestart', 'prestop', 'stop', 'poststop', 'prestart', 'start', 'poststart']],
  ['publish', ['prepublishOnly', 'prepack', 'prepare', 'postpack', 'publish', 'postpublish']],
  ['pack', ['prepack', 'prepare', 'postpack']],
])
const VERSION_HOOKS = ['preversion', 'version', 'postversion']
const WRITE_SUBWORDS = new Set(['set', 'delete', 'fix'])

const FOLDER_OPTIONS: ReadonlyMap<Manager, ReadonlySet<string>> = new Map([
  ['npm', new Set(['--prefix', '-C'])],
  ['pnpm', new Set(['-C', '--dir'])],
  ['yarn', new Set(['--cwd'])],
  ['bun', new Set(['--cwd'])],
  ['composer', new Set(['-d', '--working-dir'])],
])
const WORKSPACE_SWITCHES: ReadonlyMap<Manager, ReadonlySet<string>> = new Map([
  ['npm', new Set(['--workspaces', '-ws', '--include-workspace-root'])],
  ['pnpm', new Set(['-r', '--recursive'])],
  ['yarn', new Set()],
  ['bun', new Set()],
  ['composer', new Set()],
])
const WORKSPACE_VALUES: ReadonlyMap<Manager, ReadonlySet<string>> = new Map([
  ['npm', new Set(['-w', '--workspace'])],
  ['pnpm', new Set(['--filter', '-F'])],
  ['yarn', new Set(['--filter', '-F'])],
  ['bun', new Set(['--filter', '-F'])],
  ['composer', new Set()],
])
const GLOBAL_SWITCHES = new Set(['-g', '--global', '--location=global', '--localtion=global'])
const WORKSPACE_WORDS = new Set(['workspace', 'workspaces'])
const RUN_WORDS = new Set(['run', 'run-script', 'rum', 'urn'])
const VALUE_OPTIONS = new Set(['--loglevel', '--registry', '--userconfig', '--globalconfig', '--cache', '--tag', '--otp', '--access', '--scope', '--reporter'])
const EXEC_WORDS = new Set(['exec', 'x', 'dlx'])
const EXEC_VALUE_OPTIONS = new Set(['-p', '--package', '-w', '--workspace', '--prefix', '-C', '--dir', '--filter', '-F', '--cwd', '--registry'])
const EXEC_CODE_OPTIONS = new Set(['-c', '--call', '--shell-mode'])
const NO_TAG_SWITCHES = new Set(['--no-git-tag-version', '--git-tag-version=false'])
const COMPOSER_BUILTINS = new Set([
  'about', 'archive', 'audit', 'browse', 'home', 'bump', 'check-platform-reqs', 'clear-cache', 'clearcache', 'config',
  'create-project', 'depends', 'why', 'diagnose', 'dump-autoload', 'dumpautoload', 'exec', 'fund', 'global', 'help',
  'init', 'install', 'i', 'licenses', 'list', 'outdated', 'prohibits', 'why-not', 'reinstall', 'remove', 'require',
  'run-script', 'run', 'search', 'self-update', 'selfupdate', 'show', 'info', 'status', 'suggests', 'update', 'u',
  'upgrade', 'validate',
])

const YARN_BUILTINS = new Set([
  'add', 'audit', 'autoclean', 'bin', 'cache', 'check', 'config', 'constraints', 'create', 'dedupe', 'dlx', 'exec',
  'explain', 'generate-lock-entry', 'global', 'help', 'import', 'info', 'init', 'install', 'licenses', 'link', 'list',
  'login', 'logout', 'node', 'npm', 'outdated', 'owner', 'pack', 'patch', 'patch-commit', 'plugin', 'policies',
  'publish', 'rebuild', 'remove', 'set', 'stage', 'tag', 'team', 'unlink', 'unplug', 'up', 'upgrade',
  'upgrade-interactive', 'version', 'versions', 'why', 'workspace', 'workspaces', 'run',
])
const PNPM_BUILTINS = new Set([
  'add', 'audit', 'bin', 'config', 'create', 'dedupe', 'deploy', 'dlx', 'doctor', 'env', 'exec', 'fetch', 'import',
  'init', 'install', 'i', 'install-test', 'it', 'licenses', 'link', 'list', 'ls', 'outdated', 'pack', 'patch',
  'patch-commit', 'prune', 'publish', 'rebuild', 'remove', 'rm', 'root', 'server', 'setup', 'store', 'unlink',
  'update', 'up', 'why', 'version', 'ci', 'run', 'test', 't', 'start', 'restart', 'stop',
])
const BUN_BUILTINS = new Set([
  'test', 'install', 'i', 'add', 'a', 'remove', 'rm', 'x', 'build', 'init', 'create', 'upgrade', 'pm', 'link', 'unlink',
  'outdated', 'publish', 'patch', 'repl', 'exec', 'run', 'update', 'audit', 'info', 'why',
])
const FALLBACK_BUILTINS: ReadonlyMap<Manager, ReadonlySet<string>> = new Map([
  ['yarn', YARN_BUILTINS],
  ['pnpm', PNPM_BUILTINS],
  ['bun', BUN_BUILTINS],
])

function withHooks(name: string): string[] {
  return [`pre${name}`, name, `post${name}`]
}

export function planExecRunner(args: string[]): ExecPlan {
  return execFrom(args, 0)
}

function execFrom(args: string[], from: number): ExecPlan {
  const execCode: ArgValue[] = []
  let k = from
  while (k < args.length) {
    const a = args[k]!
    if (a === '--') return { execAt: k + 1 < args.length ? k + 1 : null, execCode }
    const eq = /^(--[\w-]+)=(.*)$/s.exec(a)
    if (eq) {
      if (EXEC_CODE_OPTIONS.has(eq[1]!)) execCode.push({ at: k, value: eq[2]! })
      k++
      continue
    }
    if (EXEC_CODE_OPTIONS.has(a)) {
      if (k + 1 < args.length) execCode.push({ at: k + 1, value: args[k + 1]! })
      k += 2
      continue
    }
    if (a.startsWith('-')) {
      k += EXEC_VALUE_OPTIONS.has(a) ? 2 : 1
      continue
    }
    return { execAt: k, execCode }
  }
  return { execAt: null, execCode }
}

export function planManager(manager: Manager, args: string[]): ManagerPlan {
  const folderOptions = FOLDER_OPTIONS.get(manager)!
  const workspaceSwitches = WORKSPACE_SWITCHES.get(manager)!
  const workspaceValues = WORKSPACE_VALUES.get(manager)!
  const words: ArgValue[] = []
  const folders: ArgValue[] = []
  const switches = new Set<string>()
  let workspaces = false
  let global = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '--') break
    const eq = /^(--?[\w-]+)=(.*)$/s.exec(a)
    if (eq) {
      switches.add(a)
      if (GLOBAL_SWITCHES.has(a.toLowerCase())) global = true
      if (folderOptions.has(eq[1]!)) folders.push({ at: k, value: eq[2]! })
      if (workspaceValues.has(eq[1]!)) workspaces = true
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      const takesValue = folderOptions.has(a) || workspaceValues.has(a) || VALUE_OPTIONS.has(a)
      if (manager !== 'composer' && !takesValue && /^(true|false)$/.test(args[k + 1] ?? '')) {
        switches.add(`${a}=${args[k + 1]}`)
        k++
        continue
      }
      switches.add(a)
      if (GLOBAL_SWITCHES.has(a)) global = true
      if (workspaceSwitches.has(a)) workspaces = true
      if (folderOptions.has(a)) {
        if (k + 1 < args.length) folders.push({ at: k + 1, value: args[k + 1]! })
        k++
      } else if (workspaceValues.has(a)) {
        workspaces = true
        if (args[k + 1] !== undefined && !args[k + 1]!.startsWith('-')) k++
      } else if (VALUE_OPTIONS.has(a)) k++
      continue
    }
    words.push({ value: a, at: k })
  }
  const file: PackageFile = manager === 'composer' ? 'composer.json' : 'package.json'
  const first = words[0]?.value
  const lifecycleFirst = (manager === 'npm' || manager === 'pnpm') && (first === 't' || first === 'tst') ? 'test' : first
  const builtins = FALLBACK_BUILTINS.get(manager)

  let nameWord: ArgValue | undefined
  const names = new Set<string>()
  if (manager === 'composer') {
    if ((first === 'run' || first === 'run-script') && words[1] !== undefined) nameWord = words[1]
    else if (first !== undefined && !COMPOSER_BUILTINS.has(first)) nameWord = words[0]
    if (first !== undefined && COMPOSER_EVENT_WORDS.has(first)) for (const n of COMPOSER_INSTALL_EVENTS) names.add(n)
    if (first === 'create-project') for (const n of COMPOSER_CREATE_PROJECT_EVENTS) names.add(n)
    if (first === 'archive') for (const n of COMPOSER_ARCHIVE_EVENTS) names.add(n)
    if (nameWord !== undefined) names.add(nameWord.value)
  } else {
    if (RUN_WORDS.has(first ?? '')) nameWord = words[1]
    else if (manager === 'yarn' && first === 'workspace') nameWord = words[2]
    else if (manager === 'yarn' && first === 'workspaces') {
      const at = words.findIndex((w) => w.value === 'run')
      nameWord = at !== -1 ? words[at + 1] : undefined
    } else if (manager !== 'npm' && first !== undefined && !builtins!.has(first) && !(manager === 'bun' && /[./\\]/.test(first))) {
      nameWord = words[0]
    }
    if (first !== undefined) {
      if (INSTALL_WORDS.has(first)) for (const n of INSTALL_LIFECYCLE) names.add(n)
      for (const n of DIRECT_LIFECYCLE.get(lifecycleFirst ?? first) ?? []) names.add(n)
      if (first === 'version' && (words.length > 1 || manager === 'yarn')) for (const n of VERSION_HOOKS) names.add(n)
    }
    if (manager === 'yarn' && words.length === 0) for (const n of INSTALL_LIFECYCLE) names.add(n)
    if (nameWord !== undefined) for (const n of withHooks(nameWord.value)) names.add(n)
  }
  if (manager === 'yarn' && WORKSPACE_WORDS.has(first ?? '')) workspaces = true
  if ((manager === 'npm' || manager === 'composer') && [...switches].some((s) => NO_SCRIPT_SWITCHES.has(s))) {
    names.clear()
    if (nameWord !== undefined) names.add(nameWord.value)
    if (lifecycleFirst !== undefined && ['test', 'start', 'stop', 'restart'].includes(lifecycleFirst)) names.add(lifecycleFirst)
  }

  const nameAt = [...new Set([words[0]?.at, nameWord?.at].filter((n): n is number => n !== undefined))]

  const versionAt = words.findIndex((w) => w.value === 'version')
  const versionIsCommand =
    versionAt === 0 ||
    (manager === 'yarn' && WORKSPACE_WORDS.has(first ?? '') && versionAt > 0) ||
    (manager === 'bun' && first === 'pm' && versionAt === 1)
  let versionCommit = false
  if (manager !== 'composer' && versionIsCommand && !(manager === 'bun' && versionAt === 0)) {
    const noTag = [...switches].some((s) => NO_TAG_SWITCHES.has(s)) || args.some((a, j) => a === '--git-tag-version' && args[j + 1] === 'false')
    versionCommit = !noTag && (manager === 'yarn' || words.length > versionAt + 1)
  }

  const writesPackage = isPackageWrite(manager, first, words)

  let exec: ExecPlan = { execAt: null, execCode: [] }
  if (manager === 'bun' && first === 'exec') {
    if (words[1] !== undefined) exec = { execAt: null, execCode: [words[1]] }
  } else if (first !== undefined && EXEC_WORDS.has(first) && (manager !== 'composer' || first === 'exec')) {
    exec = execFrom(args, words[0]!.at + 1)
  } else if (first !== undefined && builtins !== undefined) {
    if (first === 'run' && words[1] !== undefined) exec = { execAt: words[1].at, execCode: [] }
    else if (!builtins.has(first)) exec = { execAt: words[0]!.at, execCode: [] }
  }

  return { file, names: [...names], nameAt, folders, workspaces, versionCommit, writesPackage, global, ...exec }
}

function isPackageWrite(manager: Manager, first: string | undefined, words: ArgValue[]): boolean {
  if (first === undefined) return false
  if (manager === 'composer') return first === 'init' || (first === 'config' && words.length >= 3)
  if (first === 'init' || first === 'innit' || first === 'create' || first === 'set-script') return true
  if ((manager === 'npm' || manager === 'pnpm') && first === 'pkg') return WRITE_SUBWORDS.has(words[1]?.value ?? '')
  return false
}
