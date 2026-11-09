import type { GitExecutor } from './git.js'

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string }

export type SubmoduleMode = 'check' | 'no'

const SCHEME_URL = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i
const SCP_LIKE = /^(?:([^@/:]+)@)?([^/:]+):(.*)$/
const WINDOWS_DRIVE = /^[A-Za-z]$/

export function maskUrl(url: string): string {
  const scheme = SCHEME_URL.exec(url)
  if (scheme) {
    const authority = scheme[2]!
    const at = authority.lastIndexOf('@')
    return at === -1 ? url : `${scheme[1]}://***@${authority.slice(at + 1)}${scheme[3]}`
  }
  const scp = SCP_LIKE.exec(url)
  if (scp && scp[1] !== undefined && !WINDOWS_DRIVE.test(scp[2]!)) return `***@${scp[2]}:${scp[3]}`
  return url
}

function trimRepoPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
}

export function repoIdentity(url: string): string {
  const scheme = SCHEME_URL.exec(url)
  if (scheme) {
    if (scheme[1]!.toLowerCase() === 'file') return `local:${scheme[2]}${scheme[3]}`
    const authority = scheme[2]!
    const host = authority.slice(authority.lastIndexOf('@') + 1)
    return `${host}/${trimRepoPath(scheme[3]!)}`
  }
  const scp = SCP_LIKE.exec(url)
  if (scp && !WINDOWS_DRIVE.test(scp[2]!)) return `${scp[2]}/${trimRepoPath(scp[3]!)}`
  return `local:${url}`
}

export function sameRepository(fetchUrl: string, pushUrls: readonly string[]): boolean {
  const fetched = repoIdentity(fetchUrl)
  return pushUrls.length > 0 && pushUrls.every((u) => repoIdentity(u) === fetched)
}

function lines(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
}

export function readPushUrls(projectRoot: string, remote: string, executor: GitExecutor): Read<string[]> {
  const r = executor(projectRoot, ['remote', 'get-url', '--push', '--all', remote])
  const urls = r.ok ? lines(r.stdout) : []
  return urls.length > 0
    ? { ok: true, value: urls }
    : { ok: false, reason: `git could not say where '${remote}' pushes (git remote get-url --push --all needs git 2.7 or newer)` }
}

export function readFetchUrl(projectRoot: string, remote: string, executor: GitExecutor): string | null {
  const r = executor(projectRoot, ['remote', 'get-url', remote])
  return r.ok ? (lines(r.stdout)[0] ?? null) : null
}

export function readPushOptions(projectRoot: string, executor: GitExecutor): Read<string[]> {
  const r = executor(projectRoot, ['config', '-z', '--get-all', 'push.pushOption'])
  if (!r.ok) return r.exitCode === 1 ? { ok: true, value: [] } : { ok: false, reason: 'git could not read push.pushOption' }
  const values = r.stdout.split('\0')
  if (values.at(-1) === '') values.pop()
  const reset = values.lastIndexOf('')
  return { ok: true, value: values.slice(reset + 1) }
}

const SKIPS_SUBMODULES = new Set(['no', 'false'])

export function readSubmoduleMode(projectRoot: string, executor: GitExecutor): SubmoduleMode {
  const push = executor(projectRoot, ['config', '--get', 'push.recurseSubmodules'])
  if (push.ok) {
    const value = push.stdout.trim().toLowerCase()
    return SKIPS_SUBMODULES.has(value) ? 'no' : 'check'
  }
  if (push.exitCode !== 1) return 'check'
  const recurse = executor(projectRoot, ['config', '--bool', '--get', 'submodule.recurse'])
  if (recurse.ok) return recurse.stdout.trim() === 'false' ? 'no' : 'check'
  return recurse.exitCode === 1 ? 'no' : 'check'
}
