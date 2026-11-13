import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { decideAuditPath, type AuditEntry } from './audit-log.js'
import { DIALOG_LIST_SHOWN, writeListReport } from './gate-exceptions.js'
import { dialogList, specLabel } from './dialog-text.js'
import type { GitExecutor } from './git.js'
import type { RsctAuditConfig } from './project-root.js'
import { canonicalPath } from './repo-anchor.js'
import { helperUrl } from './git-url.js'

export const GIT_PROGRAMS_BASELINE_EVENT = 'git_programs.baseline'

const VALUE_SHOWN = 200
const LABEL_SHOWN = 600
const CORE_PROGRAM_KEYS = new Set(['sshcommand', 'askpass', 'gitproxy', 'alternaterefscommand'])
const FILTER_KEYS = new Set(['clean', 'smudge', 'process'])
const REMOTE_PROGRAM_KEYS = new Set(['receivepack', 'uploadpack', 'vcs'])
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const BOOLEAN_WORDS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', '1', '0', ''])

export type ProgramScope = 'repository' | 'remote'

export interface ProgramEntry {
  identity: string
  label: string
}

export type ProgramsRead =
  | { ok: true; scopeKey: string; entries: ProgramEntry[] }
  | { ok: false; reason: string }

export type ProgramsBaseline = Map<string, Set<string>>

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}

export function maskCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1***@')
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

interface ConfigEntry {
  origin: string
  key: string
  value: string | null
}

export function parseConfigList(raw: string): ConfigEntry[] {
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
    default:
      return false
  }
}

function configEntry(entry: ConfigEntry, scope: ProgramScope): ProgramEntry {
  const { section } = splitKey(entry.key)
  const value = entry.value ?? ''
  const valueShown = section === 'credential' ? credentialShown(value) : shown(value)
  const where = scope === 'remote' ? 'local remote ' : ''
  return {
    identity: digest('config', scope, entry.key.toLowerCase(), value),
    label: `${where}config ${shown(entry.key)} = ${specLabel(`"${valueShown}"`)} (${specLabel(entry.origin)})`,
  }
}

function hookEntries(hooksDir: string, scope: ProgramScope): ProgramEntry[] | null {
  let names: string[]
  try {
    names = readdirSync(hooksDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? [] : null
  }
  const entries: ProgramEntry[] = []
  for (const name of names.sort()) {
    if (name.endsWith('.sample')) continue
    const path = join(hooksDir, name)
    let content: Buffer
    let executable = true
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      if (process.platform !== 'win32') executable = (st.mode & 0o111) !== 0
      content = readFileSync(path)
    } catch {
      return null
    }
    const hash = createHash('sha256').update(content).digest('hex')
    const where = scope === 'remote' ? 'local remote ' : ''
    entries.push({
      identity: digest('hook', scope, name, hash),
      label: `${where}hook ${specLabel(`"${name}"`)} (${specLabel(path.replace(/\\/g, '/'))}, sha256 ${hash.slice(0, 12)}${executable ? '' : ', not executable'})`,
    })
  }
  return entries
}

function readRepository(cwd: string, executor: GitExecutor, scope: ProgramScope): { ok: true; gitDir: string; entries: ProgramEntry[] } | { ok: false; reason: string } {
  const where = specLabel(cwd.replace(/\\/g, '/'))
  const rev = executor(cwd, ['rev-parse', '--git-dir', '--git-common-dir', '--git-path', 'hooks'])
  const lines = rev.ok ? rev.stdout.split(/\r?\n/).filter((l) => l.length > 0) : []
  if (!rev.ok || lines.length !== 3) return { ok: false, reason: `git could not read the repository at ${where} (${(rev.stderr || rev.error || 'no answer').trim().slice(0, 200)})` }
  const config = executor(cwd, ['config', '--show-origin', '-z', '--list'])
  if (!config.ok) return { ok: false, reason: `git could not read the configuration at ${where}` }
  const hooksDir = isAbsolute(lines[2]!) ? lines[2]! : resolve(cwd, lines[2]!)
  const hooks = hookEntries(hooksDir, scope)
  if (hooks === null) return { ok: false, reason: `the hooks folder ${specLabel(hooksDir.replace(/\\/g, '/'))} or a file in it could not be read` }
  const entries = [
    ...hooks,
    ...parseConfigList(config.stdout)
      .filter((e) => isProgramKey(e.key, e.value, scope))
      .map((e) => configEntry(e, scope)),
  ]
  const gitDir = isAbsolute(lines[0]!) ? lines[0]! : resolve(cwd, lines[0]!)
  return { ok: true, gitDir, entries }
}

export function localPathRemote(url: string, cwd: string): string | null {
  const file = /^file:\/\/(.*)$/i.exec(url)
  if (file) return resolve(file[1]!.replace(/^\/([A-Za-z]:)/, '$1'))
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) || url.includes('::')) return null
  if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith('/') || url.startsWith('\\') || url.startsWith('.')) return resolve(cwd, url)
  if (/^[^/\\]*:/.test(url)) return null
  return resolve(cwd, url)
}

export function readGitPrograms(
  projectRoot: string,
  executor: GitExecutor,
  push?: { urls: readonly string[] },
): ProgramsRead {
  const repo = readRepository(projectRoot, executor, 'repository')
  if (!repo.ok) return repo
  const entries = [...repo.entries]
  for (const url of push?.urls ?? []) {
    if (helperUrl(url)) entries.push({ identity: digest('push-url', url), label: `push URL run by a transport helper ${specLabel(`"${shown(url)}"`)}` })
    const local = localPathRemote(url, projectRoot)
    if (local === null) continue
    if (!existsSync(local)) return { ok: false, reason: `the push URL names a local path that does not exist (${specLabel(local.replace(/\\/g, '/'))})` }
    const remote = readRepository(local, executor, 'remote')
    if (!remote.ok) return remote
    entries.push(...remote.entries)
  }
  return { ok: true, scopeKey: scopeKeyOf(repo.gitDir), entries }
}

function scopeKeyOf(gitDir: string): string {
  const canonical = canonicalPath(gitDir).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' || process.platform === 'darwin' ? canonical.toLowerCase() : canonical
}

export function readProgramsBaseline(projectRoot: string, auditConfig?: RsctAuditConfig): ProgramsBaseline | null {
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

export function newProgramEntries(read: Extract<ProgramsRead, { ok: true }>, baseline: ProgramsBaseline | null): ProgramEntry[] {
  const known = baseline?.get(read.scopeKey)
  return read.entries.filter((e) => known === undefined || !known.has(e.identity))
}

export function sameProgramList(a: Extract<ProgramsRead, { ok: true }>, b: Extract<ProgramsRead, { ok: true }>): boolean {
  if (a.scopeKey !== b.scopeKey) return false
  const left = a.entries.map((e) => e.identity).sort()
  const right = b.entries.map((e) => e.identity).sort()
  return left.length === right.length && left.every((id, i) => id === right[i])
}

export function baselineEntry(read: Extract<ProgramsRead, { ok: true }>, baseline: ProgramsBaseline | null): AuditEntry {
  const scopes: Record<string, string[]> = {}
  for (const [key, ids] of baseline ?? new Map<string, Set<string>>()) scopes[key] = [...ids].sort()
  scopes[read.scopeKey] = read.entries.map((e) => e.identity).sort()
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
  const freshIds = new Set(fresh.map((e) => e.identity))
  const ordered = [
    ...read.entries.filter((e) => freshIds.has(e.identity)).map((e) => `NEW OR CHANGED: ${e.label}`),
    ...read.entries.filter((e) => !freshIds.has(e.identity)).map((e) => e.label),
  ]
  const head = `${fresh.length > 0 ? '⚠ ' : ''}Programs git runs inside this ${action}: ${read.entries.length} — ${fresh.length} new or changed since your last approved call (hook entry files only):`
  const report = ordered.length > DIALOG_LIST_SHOWN ? writeListReport(projectRoot, tool, 'git-programs', `Programs git runs inside one ${tool} call`, ordered) : null
  return [head, dialogList(ordered, DIALOG_LIST_SHOWN, LABEL_SHOWN), ...(report !== null ? [`Full list: ${report}`] : [])]
}

export const PROGRAMS_MOVED_REASON =
  'the hooks or configured programs git would run changed after the approval was asked for, so the developer did not see what would run — ask again'

export type ProgramsCheck =
  | { ok: true; read: Extract<ProgramsRead, { ok: true }>; baseline: ProgramsBaseline | null; fresh: ProgramEntry[] }
  | { ok: false; reason: string }

export function checkGitPrograms(
  projectRoot: string,
  executor: GitExecutor,
  auditConfig?: RsctAuditConfig,
  push?: { urls: readonly string[] },
): ProgramsCheck {
  const read = readGitPrograms(projectRoot, executor, push)
  if (!read.ok) return read
  const baseline = readProgramsBaseline(projectRoot, auditConfig)
  return { ok: true, read, baseline, fresh: newProgramEntries(read, baseline) }
}

export function programsStillSame(
  check: Extract<ProgramsCheck, { ok: true }>,
  projectRoot: string,
  executor: GitExecutor,
  push?: { urls: readonly string[] },
): { ok: true } | { ok: false; kind: 'programs_moved' | 'programs_unreadable'; reason: string } {
  const now = readGitPrograms(projectRoot, executor, push)
  if (!now.ok) return { ok: false, kind: 'programs_unreadable', reason: now.reason }
  return sameProgramList(check.read, now) ? { ok: true } : { ok: false, kind: 'programs_moved', reason: PROGRAMS_MOVED_REASON }
}
