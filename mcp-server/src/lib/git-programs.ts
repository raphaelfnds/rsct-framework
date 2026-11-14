import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { decideAuditPath, type AuditEntry } from './audit-log.js'
import { DIALOG_LIST_SHOWN, writeListReport } from './gate-exceptions.js'
import { dialogList, specLabel } from './dialog-text.js'
import type { GitExecutor } from './git.js'
import { helperUrl } from './git-url.js'
import type { RsctAuditConfig } from './project-root.js'
import { holdsGitRepository } from './protected-paths.js'
import { canonicalPath } from './repo-anchor.js'

const GIT_PROGRAMS_BASELINE_EVENT = 'git_programs.baseline'

const VALUE_SHOWN = 200
const LABEL_SHOWN = 600
const HASH_SHOWN = 12
const CORE_PROGRAM_KEYS = new Set(['sshcommand', 'askpass', 'gitproxy', 'alternaterefscommand'])
const FILTER_KEYS = new Set(['clean', 'smudge', 'process'])
const REMOTE_PROGRAM_KEYS = new Set(['receivepack', 'uploadpack', 'vcs'])
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const BOOLEAN_WORDS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', '1', '0', ''])
const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin'
const PROGRAMS_MOVED_REASON =
  'the hooks or configured programs git would run changed after the approval was asked for, so the developer did not see what would run — ask again'

type ProgramScope = 'repository' | 'remote'

export interface ProgramEntry {
  scopeKey: string
  identity: string
  label: string
}

export type ProgramsRead =
  | { ok: true; scopeKey: string; scopeKeys: string[]; entries: ProgramEntry[] }
  | { ok: false; reason: string }

type ProgramsBaseline = Map<string, Set<string>>

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}

function maskCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1***@')
    .replace(/^([^\s/@:]+)@([^\s/:]+:)/, '***@$2')
}

function shown(text: string): string {
  const masked = maskCredentials(text)
  return masked.length > VALUE_SHOWN ? `${masked.slice(0, VALUE_SHOWN)}…` : masked
}

function credentialShown(value: string): string {
  const trimmed = value.trimStart()
  return trimmed.startsWith('!') ? `!… (shell code, ${trimmed.length} characters)` : shown(value)
}

function posix(path: string): string {
  return path.replace(/\\/g, '/')
}

interface ConfigEntry {
  origin: string
  key: string
  value: string | null
}

function parseConfigList(raw: string): ConfigEntry[] {
  const fields = raw.split('\0')
  const entries: ConfigEntry[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const origin = fields[i]!
    const record = fields[i + 1]!
    const nl = record.indexOf('\n')
    entries.push(nl === -1 ? { origin, key: record, value: null } : { origin, key: record.slice(0, nl), value: record.slice(nl + 1) })
  }
  return entries
}

function splitKey(key: string): { section: string; subsection: string | null; name: string } {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  if (first === -1) return { section: key.toLowerCase(), subsection: null, name: '' }
  return {
    section: key.slice(0, first).toLowerCase(),
    subsection: first === last ? null : key.slice(first + 1, last),
    name: key.slice(last + 1).toLowerCase(),
  }
}

export function isProgramKey(key: string, value: string | null, scope: ProgramScope): boolean {
  const { section, subsection, name } = splitKey(key)
  const v = value ?? ''
  switch (section) {
    case 'core':
      if (name === 'fsmonitor') return scope === 'remote' && !BOOLEAN_WORDS.has(v.trim().toLowerCase())
      return CORE_PROGRAM_KEYS.has(name)
    case 'filter':
      return FILTER_KEYS.has(name)
    case 'merge':
      return name === 'driver'
    case 'gpg':
      return name === 'program' || (subsection?.toLowerCase() === 'ssh' && name === 'defaultkeycommand')
    case 'commit':
    case 'push':
      return name === 'gpgsign' && (value === null || TRUE_WORDS.has(v.trim().toLowerCase()))
    case 'credential':
      return name === 'helper'
    case 'remote':
      return REMOTE_PROGRAM_KEYS.has(name) || ((name === 'url' || name === 'pushurl') && helperUrl(v))
    case 'hook':
      return true
    case 'gc':
      return name === 'recentobjectshook'
    default:
      return false
  }
}

function configEntry(entry: ConfigEntry, scope: ProgramScope, scopeKey: string): ProgramEntry {
  const { section } = splitKey(entry.key)
  const value = entry.value ?? ''
  const valueShown = section === 'credential' ? credentialShown(value) : shown(value)
  const where = scope === 'remote' ? 'local remote ' : ''
  return {
    scopeKey,
    identity: digest('config', scope, entry.key.toLowerCase(), value),
    label: `${where}config ${shown(entry.key)} = ${specLabel(`"${valueShown}"`)} (${specLabel(entry.origin)})`,
  }
}

function hookEntries(hooksDir: string, scope: ProgramScope, scopeKey: string): ProgramEntry[] | null {
  let names: string[]
  try {
    names = readdirSync(hooksDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? [] : null
  }
  const where = scope === 'remote' ? 'local remote ' : ''
  const entries: ProgramEntry[] = []
  for (const name of names.sort()) {
    if (name.endsWith('.sample')) continue
    const path = join(hooksDir, name)
    try {
      if (lstatSync(path).isSymbolicLink() && !existsSync(path)) {
        const target = readlinkSync(path)
        entries.push({
          scopeKey,
          identity: digest('hook', scope, name, 'dangling', target),
          label: `${where}hook ${specLabel(`"${name}"`)} (${specLabel(posix(path))}, a link to the missing ${specLabel(posix(target))})`,
        })
        continue
      }
      const st = statSync(path)
      if (!st.isFile()) continue
      const executable = process.platform === 'win32' || (st.mode & 0o111) !== 0
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
      entries.push({
        scopeKey,
        identity: digest('hook', scope, name, hash, executable ? 'executable' : 'not executable'),
        label: `${where}hook ${specLabel(`"${name}"`)} (${specLabel(posix(path))}, sha256 ${hash.slice(0, HASH_SHOWN)}${executable ? '' : ', not executable'})`,
      })
    } catch {
      return null
    }
  }
  return entries
}

function scopeKeyOf(gitDir: string): string {
  const canonical = posix(canonicalPath(gitDir)).replace(/\/+$/, '')
  return CASE_BLIND ? canonical.toLowerCase() : canonical
}

type RepositoryRead = { ok: true; scopeKey: string; gitFolder: string; hooksDir: string; entries: ProgramEntry[] } | { ok: false; reason: string }

function readRepository(cwd: string, executor: GitExecutor, scope: ProgramScope, gitDir?: string): RepositoryRead {
  const where = specLabel(posix(gitDir ?? cwd))
  const pin = gitDir !== undefined ? ['--git-dir', gitDir] : []
  const rev = executor(cwd, [...pin, 'rev-parse', '--git-dir', '--git-path', 'hooks'])
  const lines = rev.ok ? rev.stdout.split(/\r?\n/).filter((l) => l.length > 0) : []
  if (!rev.ok || lines.length !== 2) return { ok: false, reason: `git could not read the repository at ${where} (${(rev.stderr || rev.error || 'no answer').trim().slice(0, VALUE_SHOWN)})` }
  const config = executor(cwd, [...pin, 'config', '--show-origin', '-z', '--list'])
  if (!config.ok) return { ok: false, reason: `git could not read the configuration at ${where}` }
  const realCwd = canonicalPath(cwd)
  const gitFolder = isAbsolute(lines[0]!) ? lines[0]! : resolve(realCwd, lines[0]!)
  const scopeKey = scopeKeyOf(gitFolder)
  const hooksDir = isAbsolute(lines[1]!) ? lines[1]! : resolve(scope === 'remote' ? gitFolder : realCwd, lines[1]!)
  const hooks = hookEntries(hooksDir, scope, scopeKey)
  if (hooks === null) return { ok: false, reason: `the hooks folder ${specLabel(posix(hooksDir))} or a file in it could not be read` }
  const entries = [
    ...hooks,
    ...parseConfigList(config.stdout)
      .filter((e) => isProgramKey(e.key, e.value, scope))
      .map((e) => configEntry(e, scope, scopeKey)),
  ]
  return { ok: true, scopeKey, gitFolder, hooksDir, entries }
}

export function localPathRemote(url: string, cwd: string, home: string = homedir()): string | null {
  const file = /^file:\/\/(.*)$/i.exec(url)
  if (file) return resolve(file[1]!.replace(/^\/([A-Za-z]:)/, '$1'))
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) || url.includes('::')) return null
  if (url === '~' || url.startsWith('~/') || url.startsWith('~\\')) return resolve(home, url.slice(2))
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(url)) return resolve(cwd, url)
  if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith('/') || url.startsWith('\\') || url.startsWith('.')) return resolve(cwd, url)
  if (/^[^/\\]*:/.test(url)) return null
  return resolve(cwd, url)
}

function gitDirOfLocal(path: string): string | null {
  for (const candidate of [join(path, '.git'), path, join(`${path}.git`, '.git'), `${path}.git`]) {
    let st
    try {
      st = statSync(candidate)
    } catch {
      continue
    }
    if (st.isFile()) {
      try {
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(candidate, 'utf8'))?.[1]
        return pointer === undefined ? null : resolve(dirname(candidate), pointer)
      } catch {
        return null
      }
    }
    if (st.isDirectory() && holdsGitRepository(candidate)) return resolve(candidate)
  }
  return null
}

function unresolvedLocal(url: string): boolean {
  const file = /^file:\/\/(.*)$/i.exec(url)
  if (file) return !/^(\/|[A-Za-z]:)/.test(file[1]!)
  return /^~[^/\\]/.test(url)
}

export interface GitCallTargets {
  urls?: readonly string[]
  incoming?: { tip: string; operation: 'merge' | 'rebase' }
}

const ABSENT = '-'

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function treeHooks(executor: GitExecutor, top: string, rev: string, rel: string): Map<string, string> | null {
  const listed = executor(top, ['ls-tree', '-z', rev, ...(rel === '' ? [] : ['--', `:(literal)${rel}/`])])
  if (!listed.ok) return null
  const hooks = new Map<string, string>()
  for (const record of listed.stdout.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    const name = record.slice(tab + 1).split('/').pop() ?? ''
    if (type !== 'blob' || name.endsWith('.sample')) continue
    hooks.set(name, `${mode} ${oid}`)
  }
  return hooks
}

function mergeBases(executor: GitExecutor, top: string, tip: string): string[] | null {
  const r = executor(top, ['merge-base', '--all', 'HEAD', tip])
  if (r.ok) return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
  return r.exitCode === 1 ? [] : null
}

function revList(executor: GitExecutor, top: string, args: string[]): string[] | null {
  const r = executor(top, ['rev-list', ...args])
  return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0) : null
}

function folderNotTree(executor: GitExecutor, top: string, rel: string, revs: readonly string[]): string | null | undefined {
  const parts = rel.split('/')
  const prefixes = parts.map((_, i) => `:(literal)${parts.slice(0, i + 1).join('/')}`)
  for (const rev of revs) {
    const listed = executor(top, ['ls-tree', '-z', rev, '--', ...prefixes])
    if (!listed.ok) return null
    for (const record of listed.stdout.split('\0')) {
      const type = record.split(' ')[1]
      if (record.includes('\t') && type !== 'tree') return rev
    }
  }
  return undefined
}

function blobShown(blob: string): string {
  return blob === ABSENT ? 'none' : blob.split(' ')[1]!.slice(0, HASH_SHOWN)
}

function incomingHooks(executor: GitExecutor, projectRoot: string, repo: Extract<RepositoryRead, { ok: true }>, incoming: NonNullable<GitCallTargets['incoming']>): ProgramEntry[] | null {
  const { tip, operation } = incoming
  const hooksDir = canonicalPath(repo.hooksDir)
  if (within(canonicalPath(repo.gitFolder), hooksDir)) return []
  const toplevel = executor(projectRoot, ['rev-parse', '--show-toplevel'])
  if (!toplevel.ok) return null
  const top = canonicalPath(toplevel.stdout.trim())
  if (!within(top, hooksDir)) return []
  const rel = posix(relative(top, hooksDir))
  const bases = mergeBases(executor, top, tip)
  if (bases === null) return null
  const replayed = operation === 'rebase' ? revList(executor, top, ['--full-history', `${tip}..HEAD`, '--', `:(literal)${rel === '' ? '.' : rel}`]) : []
  const merges = operation === 'rebase' ? revList(executor, top, ['--merges', '--max-count=1', `${tip}..HEAD`]) : []
  if (replayed === null || merges === null) return null
  const now = treeHooks(executor, top, 'HEAD', rel)
  const then = treeHooks(executor, top, tip, rel)
  const baseHooks = bases.map((b) => treeHooks(executor, top, b, rel))
  const replayedHooks = replayed.map((c) => ({ commit: c, hooks: treeHooks(executor, top, c, rel) }))
  if (now === null || then === null || baseHooks.some((h) => h === null) || replayedHooks.some((h) => h.hooks === null)) return null

  const entries: ProgramEntry[] = []
  if (rel !== '') {
    const broken = folderNotTree(executor, top, rel, [...bases, 'HEAD', tip, ...replayed])
    if (broken === null) return null
    if (broken !== undefined) {
      entries.push({
        scopeKey: repo.scopeKey,
        identity: digest('hooks-folder', rel, broken),
        label: `the hooks folder ${specLabel(`"${rel}"`)} is not a folder at ${broken.slice(0, HASH_SHOWN)}: git may run hooks from a place this list cannot read`,
      })
    }
  }

  const names = new Set([...then.keys(), ...now.keys(), ...baseHooks.flatMap((h) => [...h!.keys()]), ...replayedHooks.flatMap((r) => [...r.hooks!.keys()])])
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const where = specLabel(rel === '' ? name : `${rel}/${name}`)
    const tipBlob = then.get(name) ?? ABSENT
    const headBlob = now.get(name) ?? ABSENT
    const baseBlobs = bases.length === 0 ? [ABSENT] : baseHooks.map((h) => h!.get(name) ?? ABSENT)
    const distinctBases = [...new Set(baseBlobs)].sort()
    const base = distinctBases[0]!
    const merged = (why: string): void => {
      entries.push({
        scopeKey: repo.scopeKey,
        identity: digest('merged-hook', operation, name, ...distinctBases, headBlob, tipBlob),
        label: `hook ${specLabel(`"${name}"`)} ${why}, so the content git runs is not known before it runs (${where}: HEAD blob ${blobShown(headBlob)}, ${tip.slice(0, HASH_SHOWN)} blob ${blobShown(tipBlob)})`,
      })
    }
    const exact = (blob: string, at: string, how: string): void => {
      entries.push({
        scopeKey: repo.scopeKey,
        identity: digest('incoming-hook', name, blob),
        label: `hook ${specLabel(`"${name}"`)} as ${how} (${where} at ${at.slice(0, HASH_SHOWN)}, blob ${blobShown(blob)})`,
      })
    }

    if (operation === 'merge') {
      if (tipBlob === headBlob) continue
      if (distinctBases.length > 1) merged('differs between the merge bases: git merges the versions while it runs')
      else if (tipBlob === base) continue
      else if (headBlob === base) {
        if (tipBlob !== ABSENT) exact(tipBlob, tip, 'this operation brings it')
      } else merged('changed on both sides: git merges the two versions while it runs')
      continue
    }

    if (tipBlob !== ABSENT && tipBlob !== headBlob) exact(tipBlob, tip, 'this operation brings it')
    const carried = replayedHooks.filter((r) => (r.hooks!.get(name) ?? ABSENT) !== base)
    const touched = carried.length > 0
    if (distinctBases.length > 1 || (touched && (merges.length > 0 || tipBlob !== base))) {
      merged('is merged during the rebase')
      continue
    }
    const seen = new Set([headBlob, tipBlob, ABSENT])
    for (const r of carried) {
      const blob = r.hooks!.get(name) ?? ABSENT
      if (seen.has(blob)) continue
      seen.add(blob)
      exact(blob, r.commit, 'a replayed commit brings it')
    }
  }
  return entries
}

export function readGitPrograms(
  projectRoot: string,
  executor: GitExecutor,
  targets?: GitCallTargets,
): ProgramsRead {
  const repo = readRepository(projectRoot, executor, 'repository')
  if (!repo.ok) return repo
  const entries = [...repo.entries]
  if (targets?.incoming !== undefined) {
    const brought = incomingHooks(executor, projectRoot, repo, targets.incoming)
    if (brought === null) return { ok: false, reason: `git could not read the hooks this operation brings from ${specLabel(targets.incoming.tip.slice(0, HASH_SHOWN))}` }
    entries.push(...brought)
  }
  const scopeKeys = new Set([repo.scopeKey])
  for (const url of targets?.urls ?? []) {
    if (helperUrl(url)) {
      entries.push({ scopeKey: repo.scopeKey, identity: digest('push-url', url), label: `push URL run by a transport helper ${specLabel(`"${shown(url)}"`)}` })
    }
    const local = localPathRemote(url, projectRoot)
    if (local === null) continue
    if (unresolvedLocal(url)) return { ok: false, reason: `the push URL names a local path RSCT does not resolve, another user's home or a relative file:// URL (${specLabel(`"${shown(url)}"`)})` }
    const gitDir = gitDirOfLocal(local)
    if (gitDir === null) return { ok: false, reason: `the push URL names a local path git cannot read as a repository (${specLabel(posix(local))})` }
    const remote = readRepository(projectRoot, executor, 'remote', gitDir)
    if (!remote.ok) return remote
    scopeKeys.add(remote.scopeKey)
    entries.push(...remote.entries)
  }
  return { ok: true, scopeKey: repo.scopeKey, scopeKeys: [...scopeKeys], entries }
}

function readProgramsBaseline(projectRoot: string, auditConfig?: RsctAuditConfig): ProgramsBaseline | null {
  let raw: string
  try {
    const path = decideAuditPath(projectRoot, auditConfig).path
    if (!existsSync(path)) return null
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let newest: ProgramsBaseline | null = null
  for (const line of raw.split('\n')) {
    if (!line.includes(GIT_PROGRAMS_BASELINE_EVENT)) continue
    try {
      const entry = JSON.parse(line.replace(/\r$/, '')) as Record<string, unknown>
      if (entry.event !== GIT_PROGRAMS_BASELINE_EVENT) continue
      const scopes = entry.scopes
      if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) continue
      const map: ProgramsBaseline = new Map()
      for (const [key, ids] of Object.entries(scopes as Record<string, unknown>)) {
        if (Array.isArray(ids)) map.set(key, new Set(ids.filter((x): x is string => typeof x === 'string')))
      }
      newest = map
    } catch {
      continue
    }
  }
  return newest
}

function newProgramEntries(read: Extract<ProgramsRead, { ok: true }>, baseline: ProgramsBaseline | null): ProgramEntry[] {
  return read.entries.filter((e) => !(baseline?.get(e.scopeKey)?.has(e.identity) ?? false))
}

function listKey(read: Extract<ProgramsRead, { ok: true }>): string[] {
  return [...read.scopeKeys.map((k) => `scope:${k}`), ...read.entries.map((e) => `${e.scopeKey}\0${e.identity}`)].sort()
}

function sameProgramList(a: Extract<ProgramsRead, { ok: true }>, b: Extract<ProgramsRead, { ok: true }>): boolean {
  const left = listKey(a)
  const right = listKey(b)
  return left.length === right.length && left.every((id, i) => id === right[i])
}

export function baselineEntry(read: Extract<ProgramsRead, { ok: true }>, baseline: ProgramsBaseline | null): AuditEntry {
  const scopes: Record<string, string[]> = {}
  for (const [key, ids] of baseline ?? new Map<string, Set<string>>()) scopes[key] = [...ids].sort()
  for (const key of read.scopeKeys) scopes[key] = read.entries.filter((e) => e.scopeKey === key).map((e) => e.identity).sort()
  return { event: GIT_PROGRAMS_BASELINE_EVENT, scopes }
}

export function programsDialogLines(
  projectRoot: string,
  tool: string,
  action: string,
  read: Extract<ProgramsRead, { ok: true }>,
  fresh: readonly ProgramEntry[],
): string[] {
  if (read.entries.length === 0) return []
  const freshIds = new Set(fresh.map((e) => `${e.scopeKey}\0${e.identity}`))
  const isFresh = (e: ProgramEntry): boolean => freshIds.has(`${e.scopeKey}\0${e.identity}`)
  const ordered = [
    ...read.entries.filter(isFresh).map((e) => `NEW OR CHANGED: ${e.label}`),
    ...read.entries.filter((e) => !isFresh(e)).map((e) => e.label),
  ]
  const head = `${fresh.length > 0 ? '⚠ ' : ''}Programs git runs inside this ${action}: ${read.entries.length} — ${fresh.length} new or changed since your last approved call (hook entry files only):`
  const report = ordered.length > DIALOG_LIST_SHOWN ? writeListReport(projectRoot, tool, 'git-programs', `Programs git runs inside one ${tool} call`, ordered) : null
  return [head, dialogList(ordered, DIALOG_LIST_SHOWN, LABEL_SHOWN), ...(report !== null ? [`Full list: ${report}`] : [])]
}

export type ProgramsCheck =
  | { ok: true; read: Extract<ProgramsRead, { ok: true }>; baseline: ProgramsBaseline | null; fresh: ProgramEntry[] }
  | { ok: false; reason: string }

export function checkGitPrograms(
  projectRoot: string,
  executor: GitExecutor,
  auditConfig?: RsctAuditConfig,
  targets?: GitCallTargets,
): ProgramsCheck {
  const read = readGitPrograms(projectRoot, executor, targets)
  if (!read.ok) return read
  const baseline = readProgramsBaseline(projectRoot, auditConfig)
  return { ok: true, read, baseline, fresh: newProgramEntries(read, baseline) }
}

export function programsStillSame(
  check: Extract<ProgramsCheck, { ok: true }>,
  projectRoot: string,
  executor: GitExecutor,
  targets?: GitCallTargets,
): { ok: true } | { ok: false; kind: 'programs_moved' | 'programs_unreadable'; reason: string } {
  const now = readGitPrograms(projectRoot, executor, targets)
  if (!now.ok) return { ok: false, kind: 'programs_unreadable', reason: now.reason }
  return sameProgramList(check.read, now) ? { ok: true } : { ok: false, kind: 'programs_moved', reason: PROGRAMS_MOVED_REASON }
}
