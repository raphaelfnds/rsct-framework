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

interface TreeRecord {
  mode: string
  type: string
  oid: string
  name: string
}

interface HookTree {
  hooks: Map<string, string>
  links: string
}

interface SideChanges {
  changed: Set<string>
  renamedInto: Map<string, string>
}

function treeRecords(stdout: string): TreeRecord[] {
  const records: TreeRecord[] = []
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    records.push({ mode: mode!, type: type!, oid: oid!, name: record.slice(tab + 1) })
  }
  return records
}

function folder(caseBlind: boolean): (s: string) => string {
  return (s) => (caseBlind ? s.toLowerCase() : s)
}

function hookTree(executor: GitExecutor, top: string, rev: string, rels: readonly string[], caseBlind: boolean): HookTree | null {
  const fold = folder(caseBlind)
  const hooks = new Map<string, string>()
  const links: string[] = []
  for (const rel of rels) {
    let trees = [`${rev}^{tree}`]
    for (const part of rel === '' ? [] : rel.split('/')) {
      const next: string[] = []
      for (const tree of trees) {
        const listed = executor(top, ['ls-tree', '-z', tree])
        if (!listed.ok) return null
        for (const r of treeRecords(listed.stdout)) {
          if (fold(r.name) !== fold(part)) continue
          if (r.type === 'tree') next.push(r.oid)
          else links.push(`${rel}:${r.name} ${r.mode} ${r.oid}`)
        }
      }
      trees = next
    }
    for (const tree of trees) {
      const listed = executor(top, ['ls-tree', '-z', tree])
      if (!listed.ok) return null
      for (const r of treeRecords(listed.stdout)) {
        if (r.type !== 'blob' || fold(r.name).endsWith('.sample')) continue
        const key = fold(r.name)
        const blob = `${r.mode} ${r.oid}`
        const had = hooks.get(key)
        hooks.set(key, had === undefined || had === blob ? blob : [...new Set([...had.split('|'), blob])].sort().join('|'))
      }
    }
  }
  return { hooks, links: links.sort().join('\n') }
}

function childOf(path: string, rel: string): string | null {
  if (rel === '') return path.includes('/') ? null : path
  if (!path.startsWith(`${rel}/`)) return null
  const rest = path.slice(rel.length + 1)
  return rest.includes('/') ? null : rest
}

function sideChanges(executor: GitExecutor, top: string, from: string, to: string, rels: readonly string[], caseBlind: boolean): SideChanges | null {
  const r = executor(top, ['diff', '-z', '--name-status', '-M', '-l0', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', from, to, '--'])
  if (!r.ok) return null
  const fold = folder(caseBlind)
  const fields = r.stdout.split('\0')
  const changed = new Set<string>()
  const renamedInto = new Map<string, string>()
  for (let i = 0; i < fields.length; ) {
    const status = fields[i]!
    if (status === '') {
      i++
      continue
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const src = fold(fields[i + 1] ?? '')
      const dst = fold(fields[i + 2] ?? '')
      changed.add(src)
      changed.add(dst)
      if (status.startsWith('R')) {
        for (const rel of rels) {
          const name = childOf(dst, fold(rel))
          if (name !== null) renamedInto.set(name, src)
        }
      }
      i += 3
    } else {
      changed.add(fold(fields[i + 1] ?? ''))
      i += 2
    }
  }
  return { changed, renamedInto }
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

function configTrue(executor: GitExecutor, top: string, key: string): boolean {
  const r = executor(top, ['config', '--bool', '--get', key])
  return r.ok && r.stdout.trim() === 'true'
}

function blobShown(blob: string): string {
  if (blob === ABSENT) return 'none'
  if (blob.includes('|')) return 'several, differing in letter case'
  return blob.split(' ')[1]!.slice(0, HASH_SHOWN)
}

function incomingHooks(executor: GitExecutor, projectRoot: string, repo: Extract<RepositoryRead, { ok: true }>, incoming: NonNullable<GitCallTargets['incoming']>): ProgramEntry[] | null {
  const { tip, operation } = incoming
  const hooksDir = canonicalPath(repo.hooksDir)
  if (within(canonicalPath(repo.gitFolder), hooksDir)) return []
  const toplevel = executor(projectRoot, ['rev-parse', '--show-toplevel'])
  const head = executor(projectRoot, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (!toplevel.ok || !head.ok) return null
  const headOid = head.stdout.trim()
  const top = canonicalPath(toplevel.stdout.trim())
  if (!within(top, hooksDir)) return []
  const rel = posix(relative(top, hooksDir))
  const configured = posix(relative(top, repo.hooksDir))
  const rels = [...new Set([rel, ...(within(top, repo.hooksDir) && !configured.startsWith('..') ? [configured] : [])])]
  const caseBlind = CASE_BLIND || configTrue(executor, top, 'core.ignorecase')
  const fold = folder(caseBlind)
  const pathspecs = rels.map((r) => `:(${caseBlind ? 'icase,' : ''}literal)${r === '' ? '.' : r}`)

  const bases = mergeBases(executor, top, tip)
  if (bases === null) return null
  const replayed = operation === 'rebase' ? revList(executor, top, ['--full-history', `${tip}..HEAD`, '--', ...pathspecs]) : []
  const upstream = operation === 'rebase' ? revList(executor, top, ['--full-history', `HEAD..${tip}`, '--', ...pathspecs]) : []
  const merges = operation === 'rebase' ? revList(executor, top, ['--merges', '--max-count=1', `${tip}..HEAD`]) : []
  if (replayed === null || upstream === null || merges === null) return null
  const read = (rev: string): HookTree | null => hookTree(executor, top, rev, rels, caseBlind)
  const now = read('HEAD')
  const then = read(tip)
  const baseTrees = bases.map(read)
  const replayedTrees = replayed.map((commit) => ({ commit, tree: read(commit) }))
  const upstreamTrees = upstream.map(read)
  if (now === null || then === null || baseTrees.some((t) => t === null) || replayedTrees.some((r) => r.tree === null) || upstreamTrees.some((t) => t === null)) return null
  const renamed = new Set<string>()
  for (const base of bases) {
    const ours = sideChanges(executor, top, base, 'HEAD', rels, caseBlind)
    const theirs = sideChanges(executor, top, base, tip, rels, caseBlind)
    if (ours === null || theirs === null) return null
    for (const [side, other] of [[ours, theirs], [theirs, ours]] as const) {
      for (const [name, src] of side.renamedInto) if (other.changed.has(src)) renamed.add(name)
    }
  }

  const entries: ProgramEntry[] = []
  const seenIds = new Set<string>()
  const push = (entry: ProgramEntry): void => {
    if (seenIds.has(entry.identity)) return
    seenIds.add(entry.identity)
    entries.push(entry)
  }
  const moved = [...bases.map((b, i) => [b, baseTrees[i]!] as const), [tip, then] as const, ...replayedTrees.map((r) => [r.commit, r.tree!] as const), ...upstream.map((u, i) => [u, upstreamTrees[i]!] as const)].find(([, t]) => t.links !== now.links)
  if (moved !== undefined) {
    push({
      scopeKey: repo.scopeKey,
      identity: digest('hooks-folder', ...rels, moved[0], moved[1].links),
      label: `the hooks folder ${specLabel(`"${rels.join('", "')}"`)} changes at ${moved[0].slice(0, HASH_SHOWN)}: git may run hooks from a place this list cannot read`,
    })
  }

  const names = new Set([...then.hooks.keys(), ...now.hooks.keys(), ...baseTrees.flatMap((t) => [...t!.hooks.keys()]), ...replayedTrees.flatMap((r) => [...r.tree!.hooks.keys()]), ...upstreamTrees.flatMap((t) => [...t!.hooks.keys()])])
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const where = specLabel(rel === '' ? name : `${rel}/${name}`)
    const tipBlob = then.hooks.get(name) ?? ABSENT
    const headBlob = now.hooks.get(name) ?? ABSENT
    const baseBlobs = bases.length === 0 ? [ABSENT] : baseTrees.map((t) => t!.hooks.get(name) ?? ABSENT)
    const distinctBases = [...new Set(baseBlobs)].sort()
    const base = distinctBases[0]!
    const merged = (why: string): void => {
      push({
        scopeKey: repo.scopeKey,
        identity: digest('merged-hook', operation, name, headOid, tip),
        label: `hook ${specLabel(`"${name}"`)} ${why}, so the content git runs is not known before it runs (${where}: HEAD blob ${blobShown(headBlob)}, ${tip.slice(0, HASH_SHOWN)} blob ${blobShown(tipBlob)})`,
      })
    }
    const exact = (blob: string, at: string, how: string): void => {
      push({
        scopeKey: repo.scopeKey,
        identity: digest('incoming-hook', name, blob),
        label: `hook ${specLabel(`"${name}"`)} as ${how} (${where} at ${at.slice(0, HASH_SHOWN)}, blob ${blobShown(blob)})`,
      })
    }

    if (renamed.has(fold(name))) {
      merged(operation === 'rebase' ? 'is merged during the rebase with content a rename moves into it' : 'receives content a rename moves into it while the other side changed that content: git merges them while it runs')
      continue
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
    const carried = replayedTrees.filter((r) => (r.tree!.hooks.get(name) ?? ABSENT) !== base)
    const upstreamTouched = upstreamTrees.some((t) => (t!.hooks.get(name) ?? ABSENT) !== base)
    if (distinctBases.length > 1 || (carried.length > 0 && (merges.length > 0 || upstreamTouched))) {
      merged('is merged during the rebase')
      continue
    }
    const seen = new Set([headBlob, tipBlob, ABSENT])
    for (const r of carried) {
      const blob = r.tree!.hooks.get(name) ?? ABSENT
      if (seen.has(blob)) continue
      seen.add(blob)
      exact(blob, r.commit, 'a replayed commit brings it')
    }
  }

  if (configTrue(executor, top, operation === 'rebase' ? 'rebase.autoStash' : 'merge.autoStash')) {
    for (const [name, blob] of [...now.hooks].sort(([a], [b]) => a.localeCompare(b))) {
      push({
        scopeKey: repo.scopeKey,
        identity: digest('incoming-hook', name, blob),
        label: `hook ${specLabel(`"${name}"`)} as committed at HEAD, which git runs when ${operation === 'rebase' ? 'rebase' : 'merge'}.autoStash puts local changes aside (${specLabel(rel === '' ? name : `${rel}/${name}`)} at ${headOid.slice(0, HASH_SHOWN)}, blob ${blobShown(blob)})`,
      })
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
