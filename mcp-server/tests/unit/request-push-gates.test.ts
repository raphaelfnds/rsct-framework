import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { requestPushHandler, type RequestPushInternal, type RequestPushOutput } from '../../src/tools/request-push.js'
import { defaultGitExecutor, type GitExecutor } from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

const GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const SECRET = 'API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA'
const NOW = new Date('2026-11-08T12:00:00.000Z')

let base: string
let work: string
let remote: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commitFile(name: string, text: string, message: string): string {
  writeFileSync(join(work, name), text)
  git(work, 'add', name)
  git(work, 'commit', '-q', '-m', message)
  return git(work, 'rev-parse', 'HEAD')
}

function bare(name: string): string {
  const path = join(base, name)
  git(base, 'init', '-q', '--bare', path)
  return path
}

function addRemoteByConfig(name: string, url: string): void {
  git(work, 'config', `remote.${name}.url`, url)
  git(work, 'config', `remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`)
}

function remoteHas(path: string, ref: string): boolean {
  try {
    git(path, 'rev-parse', '--verify', '-q', ref)
    return true
  } catch {
    return false
  }
}

let stamp = 0
function approval(extra: Record<string, unknown> = {}): Record<string, unknown> {
  stamp += 1
  return { timestamp: new Date(NOW.getTime() - stamp * 1000).toISOString(), action_scope: 'push:test', reason: 'push for the gate tests', ...extra }
}

const ACK = { plan_complete: true, adr_confirmed: true, issues_resolved: true, hygiene_swept: true, note: 'swept for the gate tests' }

function dialogs(answer: DialogResult['response'] = 'yes'): { fn: (o: DialogOptions) => Promise<DialogResult>; seen: DialogOptions[] } {
  const seen: DialogOptions[] = []
  return { seen, fn: async (o) => { seen.push(o); return { response: answer, channel: 'windows' } } }
}

async function push(input: Record<string, unknown>, extra: RequestPushInternal = {}, answer: DialogResult['response'] = 'yes') {
  const d = dialogs(answer)
  const out = (await requestPushHandler({ project_root: work, ...input }, { promptFn: d.fn, now: NOW, ...extra })) as RequestPushOutput
  return { out, seen: d.seen, text: d.seen[0]?.message ?? '' }
}

function footerAt(text: string): number {
  const at = text.indexOf('\nRepository: ')
  expect(at, 'the dialog carries the framework footer').toBeGreaterThan(0)
  return at
}

beforeEach(() => {
  stamp = 0
  base = mkdtempSync(join(tmpdir(), 'rsct-push-gates-'))
  work = join(base, 'work')
  mkdirSync(work)
  remote = bare('remote.git')
  git(work, 'init', '-q', '--template=')
  git(work, 'config', 'user.email', 't@example.invalid')
  git(work, 'config', 'user.name', 't')
  git(work, 'config', 'core.autocrlf', 'false')
  git(work, 'config', 'commit.gpgsign', 'false')
  git(work, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(work, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 't', org: 't' } }))
  writeFileSync(join(work, '.gitignore'), '.rsct/\n.rsct.json\n')
  commitFile('readme.txt', 'hello\n', 'init')
  git(work, 'remote', 'add', 'origin', remote)
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'checkout', '-q', '-b', 'feat/x')
})
afterEach(() => {
  if (existsSync(base)) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe.skipIf(!GIT)('rsct_request_push scans every commit it sends, before any dialog', () => {
  it('refuses a secret with no override and shows no dialog', async () => {
    commitFile('s.env', `${SECRET}\n`, 'secret')
    const { out, seen } = await push({ branch: 'feat/x', dev_approval: approval() })
    expect([out.status, out.reject_kind]).toEqual(['rejected', 'secrets'])
    expect(out.secrets_check.findings.map((f) => f.file)).toEqual(['s.env'])
    expect(seen).toHaveLength(0)
    expect(remoteHas(remote, 'refs/heads/feat/x')).toBe(false)
  })

  it('refuses a secret that a later commit removed, because the history still carries it', async () => {
    const added = commitFile('s.env', `${SECRET}\n`, 'secret')
    commitFile('s.env', 'clean\n', 'remove it')
    const { out } = await push({ branch: 'feat/x', dev_approval: approval() })
    expect(out.reject_kind).toBe('secrets')
    expect(out.secrets_check.findings.map((f) => f.commit)).toEqual([added])
    expect(out.secrets_check.commits_scanned).toBe(2)
  })

  it('lists the finding and the commit in the dialog and the reason after the footer, then pushes', async () => {
    const added = commitFile('s.env', `${SECRET}\n`, 'secret')
    const { out, text } = await push({ branch: 'feat/x', dev_approval: approval({ override_secrets_check: { reason: 'a test fixture key' } }) })
    expect(out.status).toBe('pushed')
    expect(text).toContain(`"s.env":1 — value-shape (commit ${added.slice(0, 12)})`)
    expect(text).not.toContain('sk-AAAA')
    expect(text.indexOf('Agent\'s reason for the secret findings: "a test fixture key"')).toBeGreaterThan(footerAt(text))
    expect(out.secrets_check.override_used).toBe(true)
    expect(remoteHas(remote, 'refs/heads/feat/x')).toBe(true)
  })

  it('skips commits the remote already has through its tracking refs', async () => {
    git(work, 'checkout', '-q', 'main')
    commitFile('old.env', `${SECRET}\n`, 'published before')
    git(work, 'push', '-q', 'origin', 'main')
    git(work, 'checkout', '-q', '-b', 'feat/y')
    commitFile('b.txt', 'b\n', 'clean work')
    const { out, text } = await push({ branch: 'feat/y', dev_approval: approval() })
    expect(out.status).toBe('pushed')
    expect(out.secrets_check.commits_scanned).toBe(1)
    expect(text).toContain('Secrets scan: 1 commit(s) read, nothing found.')
  })

  it('reads the whole history when the push URL is another repository than the fetch URL', async () => {
    git(work, 'checkout', '-q', 'main')
    commitFile('old.env', `${SECRET}\n`, 'published before')
    git(work, 'push', '-q', 'origin', 'main')
    git(work, 'checkout', '-q', '-b', 'feat/y')
    commitFile('b.txt', 'b\n', 'clean work')
    const fork = bare('fork.git')
    git(work, 'config', 'remote.origin.pushurl', fork)
    const { out } = await push({ branch: 'feat/y', dev_approval: approval() })
    expect(out.reject_kind).toBe('secrets')
    expect(out.secrets_check.findings.map((f) => f.file)).toEqual(['old.env'])
  })

  it('asks the remote nothing before the dialog when the push URL is another repository', async () => {
    git(work, 'checkout', '-q', 'main')
    commitFile('old.env', `${SECRET}\n`, 'published before')
    git(work, 'push', '-q', 'origin', 'main')
    git(work, 'checkout', '-q', '-b', 'feat/y')
    commitFile('b.txt', 'b\n', 'clean work')
    git(work, 'config', 'remote.origin.pushurl', bare('fork.git'))
    let probes = 0
    const { out } = await push({ branch: 'feat/y', dev_approval: approval() }, { pushProbe: () => { probes++; return { status: 'unavailable' } } })
    expect([out.reject_kind, probes]).toEqual(['secrets', 0])
  })

  it('does not skip tracking refs when another remote is named after this one plus a slash', async () => {
    git(work, 'checkout', '-q', '-b', 'hidden', 'main')
    commitFile('hidden.env', `${SECRET}\n`, 'never on origin')
    addRemoteByConfig('origin/mirror', bare('mirror.git'))
    git(work, 'push', '-q', 'origin/mirror', 'hidden')
    expect(git(work, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/mirror/hidden'), 'control: the mirror ref sits under refs/remotes/origin/').toMatch(/^[0-9a-f]{40}$/)
    git(work, 'checkout', '-q', '-b', 'feat/z')
    commitFile('b.txt', 'b\n', 'work')
    const { out } = await push({ branch: 'feat/z', dev_approval: approval() })
    expect(out.reject_kind).toBe('secrets')
    expect(out.secrets_check.findings.map((f) => f.file)).toEqual(['hidden.env'])
  })

  it('also treats a remote whose name differs only in letter case as another one', async () => {
    git(work, 'checkout', '-q', '-b', 'hidden', 'main')
    commitFile('hidden.env', `${SECRET}\n`, 'never on origin')
    addRemoteByConfig('Origin/mirror', bare('mirror2.git'))
    git(work, 'push', '-q', 'Origin/mirror', 'hidden')
    git(work, 'checkout', '-q', '-b', 'feat/z')
    commitFile('b.txt', 'b\n', 'work')
    const { out } = await push({ branch: 'feat/z', dev_approval: approval() })
    expect(out.reject_kind).toBe('secrets')
  })

  it('names the commit an annotated tag points at, not the tag object', async () => {
    const head = commitFile('b.txt', 'b\n', 'work')
    git(work, 'tag', '-a', 'v1', '-m', 'v1')
    const { text } = await push({ branch: 'refs/tags/v1', dev_approval: approval() }, {}, 'no')
    expect(text).toContain(`Commit: ${head.slice(0, 12)}`)
  })

  it('says so when where the remote pushes changed while git pushed', async () => {
    commitFile('b.txt', 'b\n', 'work')
    const executor: GitExecutor = (r, args) => {
      const out = defaultGitExecutor(r, args)
      if (args.includes('push') && args.includes('--no-follow-tags')) git(work, 'config', 'remote.origin.pushurl', bare('later.git'))
      return out
    }
    const { out } = await push({ branch: 'feat/x', dev_approval: approval() }, { gitExecutor: executor })
    expect(out.status).toBe('pushed')
    expect(out.hints.some((h) => h.startsWith("⚠ where 'origin' pushes changed while git pushed"))).toBe(true)
  })

  it('refuses before the dialog a push whose source is not a commit', async () => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: work, input: `${SECRET}\n`, encoding: 'utf8' }).trim()
    git(work, 'tag', 'leak', blob)
    const { out, seen } = await push({ branch: 'refs/tags/leak', dev_approval: approval() })
    expect([out.reject_kind, seen.length]).toEqual(['secrets_unreadable', 0])
    expect(remoteHas(remote, 'refs/tags/leak')).toBe(false)
  })

  it('refuses when the push URL changes while the dialog is open', async () => {
    commitFile('b.txt', 'b\n', 'work')
    const elsewhere = bare('elsewhere.git')
    const d = dialogs()
    const out = (await requestPushHandler(
      { project_root: work, branch: 'feat/x', dev_approval: approval() },
      {
        now: NOW,
        promptFn: async (o) => {
          git(work, 'config', 'remote.origin.pushurl', elsewhere)
          return d.fn(o)
        },
      },
    )) as RequestPushOutput
    expect(out.reject_kind).toBe('push_url_changed')
    expect(remoteHas(elsewhere, 'refs/heads/feat/x')).toBe(false)
    expect(out.anti_replay_persisted).toBeNull()
  })

  it('fails closed when the scan cannot finish', async () => {
    commitFile('b.txt', 'b\n', 'work')
    const { out, seen } = await push({ branch: 'feat/x', dev_approval: approval() }, { commitScanner: async () => ({ ok: false, reason: 'timed out' }) })
    expect(out.reject_kind).toBe('secrets_unreadable')
    expect(seen).toHaveLength(0)
  })
})

describe.skipIf(!GIT)('rsct_request_push shows where the push goes and what it sends', () => {
  it('lists every push URL and pushes to all of them', async () => {
    commitFile('b.txt', 'b\n', 'work')
    const second = bare('second.git')
    git(work, 'config', '--add', 'remote.origin.pushurl', remote)
    git(work, 'config', '--add', 'remote.origin.pushurl', second)
    const { out, text } = await push({ branch: 'feat/x', dev_approval: approval() })
    expect(out.status).toBe('pushed')
    expect(text).toContain('Push URL (2):')
    expect(text).toMatch(/• .*remote\.git\n• .*second\.git/)
    expect(remoteHas(remote, 'refs/heads/feat/x')).toBe(true)
    expect(remoteHas(second, 'refs/heads/feat/x')).toBe(true)
    expect(out.push_urls).toHaveLength(2)
  })

  it('lists every push URL and every push option in full, however many there are', async () => {
    commitFile('b.txt', 'b\n', 'work')
    const urls = Array.from({ length: 7 }, (_, i) => bare(`u${i}.git`))
    for (const u of urls) git(work, 'config', '--add', 'remote.origin.pushurl', u)
    const long = `opt-${'x'.repeat(150)}`
    for (let i = 0; i < 12; i++) git(work, 'config', '--add', 'push.pushOption', i === 3 ? long : `opt${i}`)
    const { text } = await push({ branch: 'feat/x', dev_approval: approval() }, {}, 'no')
    expect(text).toContain('Push URL (7):')
    for (const u of urls) expect(text).toContain(u.replace(/^.*[\\/]/, ''))
    expect(text).toContain('Push option sent (12):')
    expect(text).toContain(`• ${long}`)
    expect(text).toContain('• opt11')
  })

  it('masks the credentials of a push URL in the dialog and the audit log', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git(work, 'config', 'remote.origin.pushurl', 'https://ghp_TOKEN123@example.invalid/o/r.git')
    const { out, text } = await push({ branch: 'feat/x', dev_approval: approval() }, {}, 'no')
    expect(out.reject_kind).toBe('dialog_no')
    expect(text).toContain('Push URL: https://***@example.invalid/o/r.git')
    expect(text).not.toContain('ghp_TOKEN123')
    expect(readFileSync(join(work, '.rsct', 'audit.log'), 'utf8')).not.toContain('ghp_TOKEN123')
  })

  it('words a force push and a delete as such', async () => {
    commitFile('b.txt', 'b\n', 'work')
    const forced = await push({ branch: '+feat/x', dev_approval: approval() }, {}, 'no')
    expect(forced.text).toContain("⚠ FORCE: replaces 'refs/heads/feat/x' on the remote")
    git(work, 'push', '-q', 'origin', 'feat/x')
    const deleted = await push({ branch: ':feat/x', dev_approval: approval() }, {}, 'no')
    expect(deleted.text).toContain("⚠ DELETE: removes 'refs/heads/feat/x' from the remote.")
    expect(deleted.text).not.toContain('Secrets scan')
  })

  it('sends exactly the push options the dialog lists, after the last reset', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git(remote, 'config', 'receive.advertisePushOptions', 'true')
    const log = join(base, 'options.log')
    writeFileSync(join(remote, 'hooks', 'pre-receive'), `#!/bin/sh\necho "count=$GIT_PUSH_OPTION_COUNT first=$GIT_PUSH_OPTION_0" >> "${log.replace(/\\/g, '/')}"\n`)
    if (process.platform !== 'win32') execFileSync('chmod', ['+x', join(remote, 'hooks', 'pre-receive')])
    git(work, 'config', '--add', 'push.pushOption', 'dropped')
    git(work, 'config', '--add', 'push.pushOption', '')
    git(work, 'config', '--add', 'push.pushOption', 'ci.skip')
    const { out, text } = await push({ branch: 'feat/x', dev_approval: approval() })
    expect(out.status).toBe('pushed')
    expect(text).toContain('Push option sent: ci.skip')
    expect(text).not.toContain('dropped')
    expect(readFileSync(log, 'utf8').trim()).toBe('count=1 first=ci.skip')
  })

  it('checks submodules, and says so, when the config would push them', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git(work, 'config', 'push.recurseSubmodules', 'on-demand')
    const sent: string[][] = []
    const recording: GitExecutor = (root, args) => {
      if (args.includes('push')) sent.push(args)
      return defaultGitExecutor(root, args)
    }
    const { out, text } = await push({ branch: 'feat/x', dev_approval: approval() }, { gitExecutor: recording })
    expect(out.status).toBe('pushed')
    expect(text).toContain('Submodules: checked, never pushed.')
    expect(sent.at(-1)).toContain('--recurse-submodules=check')

    git(work, 'config', 'push.recurseSubmodules', 'no')
    commitFile('c.txt', 'c\n', 'more')
    const plain = await push({ branch: 'feat/x', dev_approval: approval() }, { gitExecutor: recording })
    expect(plain.text).not.toContain('Submodules')
    expect(sent.at(-1)).toContain('--recurse-submodules=no')
  })

  it('does not send tags push.followTags would add', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git(work, 'tag', '-a', 'v9', '-m', 'v9')
    git(work, 'config', 'push.followTags', 'true')
    const { out } = await push({ branch: 'feat/x', dev_approval: approval() })
    expect(out.status).toBe('pushed')
    expect(remoteHas(remote, 'refs/tags/v9')).toBe(false)
  })
})

describe.skipIf(!GIT)('rsct_request_push refuses before any dialog', () => {
  it('a protected destination without override_protected_branch', async () => {
    git(work, 'checkout', '-q', 'main')
    commitFile('b.txt', 'b\n', 'work')
    const { out, seen } = await push({ branch: 'main', dev_approval: approval(), pre_merge_ack: { ...ACK, files_swept: ['b.txt'] } })
    expect([out.reject_kind, seen.length]).toEqual(['protected_branch', 0])
  })

  it('shows the protected branch, the ack answers before the footer and the reasons after it', async () => {
    git(work, 'checkout', '-q', 'main')
    commitFile('b.txt', 'b\n', 'work')
    const { out, text } = await push(
      { branch: 'main', dev_approval: approval({ override_protected_branch: { reason: 'release merge' } }), pre_merge_ack: { ...ACK, files_swept: ['b.txt'] } },
      {},
      'no',
    )
    expect(out.reject_kind).toBe('dialog_no')
    const footer = footerAt(text)
    expect(text.indexOf("⚠ 'main' is a protected branch: pushing here needs your exception."), 'present').toBeGreaterThanOrEqual(0)
    expect(text.indexOf("⚠ 'main' is a protected branch: pushing here needs your exception.")).toBeLessThan(footer)
    expect(text.indexOf('pre_merge_ack: plan_complete yes · adr_confirmed yes · issues_resolved yes · hygiene_swept yes · files_swept 1 path(s)'), 'present').toBeGreaterThanOrEqual(0)
    expect(text.indexOf('pre_merge_ack: plan_complete yes · adr_confirmed yes · issues_resolved yes · hygiene_swept yes · files_swept 1 path(s)')).toBeLessThan(footer)
    expect(text.indexOf('Agent\'s reason for the protected branch: "release merge"')).toBeGreaterThan(footer)
    expect(text.indexOf('Agent\'s pre_merge_ack note: "swept for the gate tests"')).toBeGreaterThan(footer)
  })

  it('an armed review_drift lock', async () => {
    commitFile('b.txt', 'b\n', 'work')
    mkdirSync(join(work, '.rsct'), { recursive: true })
    writeFileSync(join(work, '.rsct', 'phase-state.json'), JSON.stringify({ review_drift: { sha: 'a'.repeat(40), paths: ['src/x.ts'], at: NOW.toISOString() } }))
    const { out, seen } = await push({ branch: 'feat/x', dev_approval: approval() })
    expect([out.reject_kind, seen.length]).toEqual(['review_drift', 0])
  })

  it('HEAD on no branch and no branch given', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git(work, 'checkout', '-q', '--detach', 'HEAD')
    const { out, seen } = await push({ dev_approval: approval() })
    expect([out.status, out.reject_kind, seen.length]).toEqual(['rejected', 'no_branch', 0])
  })

  it('a push URL git cannot report', async () => {
    commitFile('b.txt', 'b\n', 'work')
    const { out, seen } = await push(
      { branch: 'feat/x', dev_approval: approval() },
      { gitExecutor: (root, args) => (args[0] === 'remote' && args[1] === 'get-url' ? { ok: false, stdout: '', stderr: 'error', exitCode: 2 } : { ok: true, stdout: args[0] === 'remote' ? 'origin\n' : '', stderr: '', exitCode: 0 }) },
    )
    expect([out.reject_kind, seen.length]).toEqual(['push_url_unreadable', 0])
  })
})
