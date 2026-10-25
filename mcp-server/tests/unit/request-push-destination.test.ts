import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestPushHandler, type RequestPushOutput } from '../../src/tools/request-push.js'
import { defaultPushProbe, parsePushPorcelain, probeEnv } from '../../src/lib/push-probe.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let base: string
let work: string
let remote: string

const FIXED_NOW = new Date('2026-06-03T12:00:00.000Z')
const approval = (extra: Record<string, unknown> = {}) => ({
  timestamp: '2026-06-03T11:59:45.000Z',
  action_scope: 'push:main:abc1234',
  reason: 'push checkpoint for the destination tests',
  ...extra,
})
const override = () => approval({ override_protected_branch: { reason: 'release push in the destination tests' } })
const ack = (files_swept?: string[]) => ({
  plan_complete: true,
  adr_confirmed: true,
  issues_resolved: true,
  hygiene_swept: true,
  note: 'plan done, ADRs recorded, issues closed, files swept (destination tests)',
  ...(files_swept !== undefined && { files_swept }),
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function dialogs(): { fn: (o: DialogOptions) => Promise<DialogResult>; seen: DialogOptions[] } {
  const seen: DialogOptions[] = []
  return { seen, fn: async (o) => { seen.push(o); return { response: 'yes', channel: 'windows' } } }
}

function writeConfig(protectedBranches: string[]): void {
  writeFileSync(join(work, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, protected_branches: protectedBranches }))
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rsct-push-dest-'))
  remote = join(base, 'remote.git')
  git(base, 'init', '-q', '--bare', remote)
  work = join(base, 'work')
  mkdirSync(work)
  git(work, 'init', '-q')
  git(work, 'config', 'user.email', 't@test.invalid')
  git(work, 'config', 'user.name', 't')
  git(work, 'config', 'commit.gpgsign', 'false')
  git(work, 'config', 'core.hooksPath', '.no-hooks')
  git(work, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(work, '.gitignore'), '.rsct/\n.rsct.json\n')
  writeFileSync(join(work, 'a.ts'), 'export const a = 1\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'one')
  git(work, 'remote', 'add', 'origin', remote)
})

afterEach(() => {
  if (existsSync(base)) rmSync(base, { recursive: true, force: true })
})

const remoteRef = (ref: string): string | null => {
  try {
    return git(remote, 'rev-parse', '--verify', '-q', ref)
  } catch {
    return null
  }
}

describe('rsct_request_push — the destination is the one checked and shown', () => {
  it('a push mapping in the repository config cannot send the push to another branch', async () => {
    writeConfig(['main'])
    git(work, 'push', '-q', 'origin', 'main')
    const mainBefore = remoteRef('refs/heads/main')
    git(work, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(work, 'b.ts'), 'export const b = 2\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'two')
    git(work, 'config', 'remote.origin.push', 'refs/heads/feature:refs/heads/main')
    const out = (await requestPushHandler(
      { project_root: work, branch: 'feature', dev_approval: approval() },
      { promptFn: dialogs().fn, now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.status).toBe('pushed')
    expect(remoteRef('refs/heads/main')).toBe(mainBefore)
    expect(remoteRef('refs/heads/feature')).toBe(git(work, 'rev-parse', 'feature'))
  }, 60_000)

  it('the dialog names the commit that is pushed, and that commit is the one that lands', async () => {
    writeConfig(['release'])
    const d = dialogs()
    const sha = git(work, 'rev-parse', 'main')
    const out = (await requestPushHandler(
      { project_root: work, branch: 'main', dev_approval: approval() },
      { promptFn: d.fn, now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.status).toBe('pushed')
    expect(d.seen[0]!.message).toContain(`Commit: ${sha.slice(0, 12)}`)
    expect(remoteRef('refs/heads/main')).toBe(sha)
  }, 60_000)
})

describe('rsct_request_push — the first push of a protected branch checks the whole tree', () => {
  it('an empty remote: every file must be attested in files_swept, before any dialog', async () => {
    writeConfig(['main'])
    writeFileSync(join(work, 'b.ts'), 'export const b = 2\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'two')
    const d = dialogs()
    const out = (await requestPushHandler(
      { project_root: work, branch: 'main', dev_approval: override(), pre_merge_ack: ack([]) },
      { promptFn: d.fn, now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(out.reason).toContain('a.ts')
    expect(out.reason).toContain('b.ts')
    expect(d.seen).toHaveLength(0)
    expect(remoteRef('refs/heads/main')).toBeNull()

    const ok = (await requestPushHandler(
      { project_root: work, branch: 'main', dev_approval: override(), pre_merge_ack: ack(['.gitignore', 'a.ts', 'b.ts']) },
      { promptFn: dialogs().fn, now: FIXED_NOW },
    )) as RequestPushOutput
    expect(ok.status).toBe('pushed')
    expect(remoteRef('refs/heads/main')).toBe(git(work, 'rev-parse', 'main'))
  }, 60_000)

  it('a local branch named like the remote-tracking ref does not hide what the push carries', async () => {
    writeConfig(['main'])
    git(work, 'push', '-q', 'origin', 'main')
    git(work, 'fetch', '-q', 'origin')
    writeFileSync(join(work, 'c.ts'), 'export const c = 3\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'three')
    git(work, 'branch', 'origin/main', 'main')
    const out = (await requestPushHandler(
      { project_root: work, branch: 'main', dev_approval: override(), pre_merge_ack: ack([]) },
      { promptFn: dialogs().fn, now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.reject_kind).toBe('pre_merge_ack_incomplete')
    expect(out.reason).toContain('c.ts')
  }, 60_000)

  it('when nothing can tell what the push carries, the developer reads it in the dialog', async () => {
    writeConfig(['main'])
    const d = dialogs()
    const out = (await requestPushHandler(
      { project_root: work, branch: 'main', dev_approval: override(), pre_merge_ack: ack() },
      { promptFn: d.fn, now: FIXED_NOW, pushProbe: () => ({ status: 'unavailable' }) },
    )) as RequestPushOutput
    expect(out.status).toBe('pushed')
    const lines = d.seen[0]!.message.split('\n')
    const warning = lines.findIndex((l) => l.startsWith('⚠ files_swept NOT checked'))
    expect(warning).toBeGreaterThan(0)
    expect(lines[warning]).toContain("If the remote has no 'main' yet, this push carries the whole branch.")
    expect(out.hints.some((h) => h.includes('DEGRADED'))).toBe(true)
  }, 60_000)

  it('when the remote answered but the carried files cannot be read, the push is refused before any dialog', async () => {
    writeConfig(['main'])
    const d = dialogs()
    const out = (await requestPushHandler(
      { project_root: work, branch: 'main', dev_approval: override(), pre_merge_ack: ack(['.gitignore', 'a.ts']) },
      { promptFn: d.fn, now: FIXED_NOW, treeReader: () => ({ status: 'unavailable' }) },
    )) as RequestPushOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('hygiene_range_unreadable')
    expect(out.reason).toMatch(/^refusing to push: the paths this integration carries could not be read/)
    expect(d.seen).toHaveLength(0)
    expect(remoteRef('refs/heads/main')).toBeNull()
  }, 60_000)

  it('a push the remote already has carries nothing, also with no remote-tracking ref', async () => {
    writeConfig(['main'])
    git(work, 'push', '-q', 'origin', 'main')
    git(work, 'update-ref', '-d', 'refs/remotes/origin/main')
    const out = (await requestPushHandler(
      { project_root: work, branch: 'main', dev_approval: override(), pre_merge_ack: ack([]) },
      { promptFn: dialogs().fn, now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.status).toBe('pushed')
    expect(out.hints.some((h) => h.includes('DEGRADED'))).toBe(false)
  }, 60_000)

  it('a non-protected push never asks for files_swept, also on an empty remote', async () => {
    writeConfig(['release'])
    const d = dialogs()
    const probe = { calls: 0 }
    const out = (await requestPushHandler(
      { project_root: work, branch: 'main', dev_approval: approval() },
      { promptFn: d.fn, now: FIXED_NOW, pushProbe: () => { probe.calls++; return { status: 'unavailable' } } },
    )) as RequestPushOutput
    expect(out.status).toBe('pushed')
    expect(d.seen[0]!.message).not.toContain('files_swept')
    expect(probe.calls).toBe(0)
  }, 60_000)

  it('pushes the branch tip, not a tag that shares the branch name', async () => {
    writeConfig(['release'])
    writeFileSync(join(work, 'b.ts'), 'export const b = 2\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-qm', 'two')
    const tip = git(work, 'rev-parse', 'main')
    git(work, 'tag', 'main', 'HEAD~1')
    const out = (await requestPushHandler(
      { project_root: work, branch: 'main', dev_approval: approval() },
      { promptFn: dialogs().fn, now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.status).toBe('pushed')
    expect(remoteRef('refs/heads/main')).toBe(tip)
    expect(remoteRef('refs/tags/main')).toBeNull()
  }, 60_000)

  it('refuses a first publication larger than the coverage cap, by hand', async () => {
    writeConfig(['main'])
    const paths = Array.from({ length: 2001 }, (_, i) => `src/f${i}.ts`)
    const d = dialogs()
    const out = (await requestPushHandler(
      { project_root: work, branch: 'main', dev_approval: override(), pre_merge_ack: ack([]) },
      {
        promptFn: d.fn,
        now: FIXED_NOW,
        pushProbe: () => ({ status: 'parsed', refs: [{ url: remote, flag: '*', to: 'refs/heads/main', old: null, next: null }] }),
        treeReader: () => ({ status: 'ok', paths }),
      },
    )) as RequestPushOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('hygiene_range_unreadable')
    expect(out.reason).toMatch(/the developer pushes by hand/)
    expect(d.seen).toHaveLength(0)
  }, 60_000)

  it('a protected delete does not claim it carries the whole branch', async () => {
    writeConfig(['main'])
    git(work, 'push', '-q', 'origin', 'main')
    const d = dialogs()
    const out = (await requestPushHandler(
      { project_root: work, branch: ':main', dev_approval: override(), pre_merge_ack: ack() },
      { promptFn: d.fn, now: FIXED_NOW },
    )) as RequestPushOutput
    expect(out.status).toBe('pushed')
    const warn = d.seen[0]!.message.split('\n').find((l) => l.startsWith('⚠ files_swept NOT checked'))
    expect(warn).toBeDefined()
    expect(warn).not.toContain('whole branch')
  }, 60_000)
})

describe('push probe — an incomplete dry run is not read as complete', () => {
  it('treats a parsed rejection (exit 1) as the answer but a git error (exit 128) as unavailable', () => {
    git(work, 'push', '-q', 'origin', 'main')
    const good = defaultPushProbe(work, 'origin', `main:refs/heads/main`)
    expect(good.status).toBe('parsed')
    const bad = defaultPushProbe(work, 'no-such-remote-here', `main:refs/heads/x`)
    expect(bad.status).toBe('unavailable')
  }, 60_000)

  it('is unavailable when one push URL printed a block but another made git fail', () => {
    git(work, 'push', '-q', 'origin', 'main')
    git(work, 'remote', 'set-url', '--add', '--push', 'origin', remote)
    git(work, 'remote', 'set-url', '--add', '--push', 'origin', join(base, 'missing.git'))
    const out = defaultPushProbe(work, 'origin', 'main:refs/heads/main')
    expect(out.status).toBe('unavailable')
  }, 60_000)

  it('merges one To-block per push URL and drops up-to-date and deleted lines', () => {
    const out = parsePushPorcelain(
      'To https://a.example/r.git\n' +
        ` \trefs/heads/main:refs/heads/main\t${'a'.repeat(7)}..${'b'.repeat(7)}\n` +
        'To https://b.example/r.git\n' +
        '=\trefs/heads/main:refs/heads/main\t[up to date]\n',
    )
    expect(out.status === 'parsed' && out.refs.map((r) => r.url)).toEqual(['https://a.example/r.git', 'https://b.example/r.git'])
    expect(out.status === 'parsed' && out.refs[1]!.flag).toBe('=')
  })
})

describe('push probe — reading the dry-run answer', () => {
  it('reads every summary form, keeps one block per push URL, and takes the URL as written', () => {
    const out = [
      'To C:\\repos\\my remote.git',
      '*\trefs/heads/new:refs/heads/new\t[new branch]',
      ' \trefs/heads/main:refs/heads/main\tabc1234..def5678',
      '+\trefs/heads/x:refs/heads/x\t1111111...2222222 (forced update)',
      '=\trefs/heads/same:refs/heads/same\t[up to date]',
      '!\trefs/heads/old:refs/heads/old\t[rejected] (non-fast-forward)',
      'Done',
      'To file:///srv/mirror.git',
      '*\trefs/heads/new:refs/heads/new\t[new branch]',
      'Done',
    ].join('\r\n')
    const r = parsePushPorcelain(out)
    expect(r.status).toBe('parsed')
    if (r.status !== 'parsed') return
    expect(r.refs.map((x) => [x.url, x.flag, x.to, x.old, x.next])).toEqual([
      ['C:\\repos\\my remote.git', '*', 'refs/heads/new', null, null],
      ['C:\\repos\\my remote.git', ' ', 'refs/heads/main', 'abc1234', 'def5678'],
      ['C:\\repos\\my remote.git', '+', 'refs/heads/x', '1111111', '2222222'],
      ['C:\\repos\\my remote.git', '=', 'refs/heads/same', null, null],
      ['C:\\repos\\my remote.git', '!', 'refs/heads/old', null, null],
      ['file:///srv/mirror.git', '*', 'refs/heads/new', null, null],
    ])
  })

  it('an answer with no ref line is unavailable', () => {
    expect(parsePushPorcelain('').status).toBe('unavailable')
    expect(parsePushPorcelain('To origin\nDone\n').status).toBe('unavailable')
    expect(parsePushPorcelain('fatal: could not read from remote repository\n').status).toBe('unavailable')
  })

  it('runs with no way to prompt for credentials', () => {
    const env = probeEnv({ PATH: 'p', GIT_ASKPASS: '/usr/bin/x', SSH_ASKPASS: '/usr/bin/y' })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
    expect(env.SSH_ASKPASS_REQUIRE).toBe('never')
    expect(env.GIT_ASKPASS).toBeUndefined()
    expect(env.SSH_ASKPASS).toBeUndefined()
    expect(env.PATH).toBe('p')
  })
})
