import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendAuditEntry } from '../../src/lib/audit-log.js'
import { DIALOG_LIST_SHOWN } from '../../src/lib/gate-exceptions.js'
import { defaultGitExecutor } from '../../src/lib/git.js'
import {
  baselineEntry,
  checkGitPrograms,
  isProgramKey,
  localPathRemote,
  programsDialogLines,
  programsStillSame,
  readGitPrograms,
} from '../../src/lib/git-programs.js'
import { helperUrl } from '../../src/lib/git-url.js'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rsct-gp-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function repo(name = 'r'): string {
  const dir = join(base, name)
  mkdirSync(dir)
  git(dir, 'init', '-q')
  return dir
}

function hook(dir: string, name: string, body = 'echo hi'): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function labels(root: string, push?: { urls: readonly string[] }): string[] {
  const read = readGitPrograms(root, defaultGitExecutor, push)
  if (!read.ok) throw new Error(read.reason)
  return read.entries.map((e) => e.label)
}

function check(root: string) {
  const c = checkGitPrograms(root, defaultGitExecutor)
  if (!c.ok) throw new Error(c.reason)
  return c
}

describe('git-programs — hooks', () => {
  it('lists every file in the hooks folder except .sample files, a Windows .exe hook included', () => {
    const r = repo()
    hook(join(r, '.git', 'hooks'), 'pre-commit')
    hook(join(r, '.git', 'hooks'), 'post-commit.exe')
    hook(join(r, '.git', 'hooks'), 'pre-push.sample')
    const shown = labels(r)
    expect(shown.some((l) => l.includes('"pre-commit"'))).toBe(true)
    expect(shown.some((l) => l.includes('"post-commit.exe"'))).toBe(true)
    expect(shown.some((l) => l.includes('.sample'))).toBe(false)
  })

  it('follows a relative core.hooksPath to the folder git runs hooks from', () => {
    const r = repo()
    hook(join(r, '.git', 'hooks'), 'pre-commit', 'echo old')
    hook(join(r, '.husky'), 'commit-msg')
    git(r, 'config', 'core.hooksPath', '.husky')
    const shown = labels(r)
    expect(shown.some((l) => l.includes('.husky/commit-msg'))).toBe(true)
    expect(shown.some((l) => l.includes('"pre-commit"'))).toBe(false)
  })

  it('lists nothing for a hooks path that is a file, a missing folder or a folder of folders', () => {
    const r = repo()
    git(r, 'config', 'core.hooksPath', 'not-a-folder')
    expect(labels(r)).toEqual([])
    writeFileSync(join(r, 'not-a-folder'), 'x')
    expect(labels(r)).toEqual([])
    rmSync(join(r, 'not-a-folder'))
    mkdirSync(join(r, 'not-a-folder', 'pre-commit'), { recursive: true })
    expect(labels(r)).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses when the hooks folder cannot be listed, instead of reporting nothing', () => {
    const r = repo()
    const dir = join(r, 'locked-hooks')
    hook(dir, 'pre-commit')
    git(r, 'config', 'core.hooksPath', 'locked-hooks')
    chmodSync(dir, 0o000)
    try {
      expect(readGitPrograms(r, defaultGitExecutor).ok).toBe(false)
    } finally {
      chmodSync(dir, 0o755)
    }
  })
})

describe('git-programs — configuration', () => {
  it('reads section and key names case-folded', () => {
    expect(isProgramKey('Core.SshCommand', 'x', 'repository')).toBe(true)
    expect(isProgramKey('FILTER.lfs.Clean', 'cat', 'repository')).toBe(true)
    expect(isProgramKey('Credential.https://h.Helper', 'store', 'repository')).toBe(true)
  })

  it('lists keys that run a program and leaves the rest out', () => {
    const r = repo()
    git(r, 'config', 'core.sshCommand', 'my-ssh')
    git(r, 'config', 'filter.x.clean', 'cat')
    git(r, 'config', 'merge.y.driver', 'true')
    git(r, 'config', 'core.autocrlf', 'false')
    git(r, 'config', 'include.path', 'nothing.cfg')
    git(r, 'config', 'commit.gpgSign', 'false')
    const shown = labels(r).join('\n')
    expect(shown).toContain('core.sshcommand')
    expect(shown).toContain('filter.x.clean')
    expect(shown).toContain('merge.y.driver')
    expect(shown).not.toContain('autocrlf')
    expect(shown).not.toContain('include.path')
    expect(shown).not.toContain('gpgsign')
    git(r, 'config', 'commit.gpgSign', 'true')
    expect(labels(r).join('\n')).toContain('commit.gpgsign')
  })

  it('masks credentials in helper URLs and shell code in credential helpers', () => {
    const r = repo()
    git(r, 'config', 'remote.o.url', 'foo::https://user:tok123@host.invalid/x')
    git(r, 'config', 'credential.helper', '!f() { echo password=s3cret; }; f')
    const shown = labels(r).join('\n')
    expect(shown).toContain('remote.o.url')
    expect(shown).toContain('***@host.invalid')
    expect(shown).not.toContain('tok123')
    expect(shown).not.toContain('s3cret')
  })

  it('treats :: and schemes git does not handle itself as transport helpers', () => {
    expect(helperUrl('evil://host/x')).toBe(true)
    expect(helperUrl('foo::bar')).toBe(true)
    expect(helperUrl('https://host/x')).toBe(false)
    expect(helperUrl('git@host:o/r.git')).toBe(false)
    expect(helperUrl('ssh+git://host/x')).toBe(false)
  })
})

describe('git-programs — push', () => {
  it('names a local path remote and lists that repository\'s own hooks', () => {
    const bare = join(base, 'remote.git')
    mkdirSync(bare)
    git(bare, 'init', '-q', '--bare')
    hook(join(bare, 'hooks'), 'pre-receive')
    const r = repo()
    expect(localPathRemote(bare, r)).toBe(resolve(bare))
    expect(localPathRemote('host:path/r.git', r)).toBeNull()
    expect(localPathRemote('https://host/r.git', r)).toBeNull()
    expect(labels(r, { urls: [bare] }).some((l) => l.startsWith('local remote hook "pre-receive"'))).toBe(true)
  })

  it('lists a push URL run by a transport helper, and refuses a local path that does not exist', () => {
    const r = repo()
    expect(labels(r, { urls: ['evil://host/x'] }).some((l) => l.includes('transport helper'))).toBe(true)
    expect(labels(r, { urls: ['https://host.invalid/x.git'] })).toEqual([])
    expect(readGitPrograms(r, defaultGitExecutor, { urls: [join(base, 'gone.git')] }).ok).toBe(false)
  })
})

describe('git-programs — reading fails closed', () => {
  it('refuses a folder git cannot read as a repository', () => {
    const plain = join(base, 'plain')
    mkdirSync(plain)
    expect(readGitPrograms(plain, defaultGitExecutor).ok).toBe(false)
  })
})

describe('git-programs — baseline', () => {
  it('everything is new with no baseline; nothing after one is recorded; a changed hook is new again', () => {
    const r = repo()
    const path = hook(join(r, '.git', 'hooks'), 'pre-commit')
    const first = check(r)
    expect(first.baseline).toBeNull()
    expect(first.fresh).toHaveLength(1)
    appendAuditEntry(r, baselineEntry(first.read, first.baseline))
    expect(check(r).fresh).toEqual([])
    writeFileSync(path, '#!/bin/sh\necho changed\n')
    const third = check(r)
    expect(third.fresh).toHaveLength(1)
    expect(third.fresh[0]!.label).toContain('"pre-commit"')
  })

  it('a baseline recorded for another git folder does not count here', () => {
    const a = repo('a')
    const b = repo('b')
    hook(join(a, '.git', 'hooks'), 'pre-commit')
    hook(join(b, '.git', 'hooks'), 'pre-commit')
    const seenInA = check(a)
    appendAuditEntry(b, baselineEntry(seenInA.read, null))
    expect(check(b).fresh).toHaveLength(1)
  })

  it('keeps every other git folder\'s entry when it records its own', () => {
    const r = repo()
    hook(join(r, '.git', 'hooks'), 'pre-commit')
    const c = check(r)
    const other = new Map([['other-git-dir', new Set(['abc'])]])
    const entry = baselineEntry(c.read, other) as { scopes: Record<string, string[]> }
    expect(entry.scopes['other-git-dir']).toEqual(['abc'])
    expect(entry.scopes[c.read.scopeKey]).toHaveLength(1)
  })
})

describe('git-programs — right before git runs', () => {
  it('a hook added after the list was read is reported as programs_moved', () => {
    const r = repo()
    const c = check(r)
    expect(programsStillSame(c, r, defaultGitExecutor)).toEqual({ ok: true })
    hook(join(r, '.git', 'hooks'), 'post-commit')
    const again = programsStillSame(c, r, defaultGitExecutor)
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.kind).toBe('programs_moved')
  })
})

describe('git-programs — dialog lines', () => {
  it('says nothing when git runs nothing', () => {
    const r = repo()
    const c = check(r)
    expect(programsDialogLines(r, 'commit', 'commit', c.read, c.fresh)).toEqual([])
  })

  it('puts new entries first, caps the list and names a report with the rest', () => {
    const r = repo()
    for (let i = 0; i < DIALOG_LIST_SHOWN + 2; i++) hook(join(r, '.git', 'hooks'), `h${String(i).padStart(2, '0')}`)
    const before = check(r)
    appendAuditEntry(r, baselineEntry(before.read, before.baseline))
    hook(join(r, '.git', 'hooks'), 'zz-new')
    const c = check(r)
    const lines = programsDialogLines(r, 'commit', 'commit', c.read, c.fresh)
    expect(lines[0]).toContain(`: ${DIALOG_LIST_SHOWN + 3} — 1 new or changed`)
    expect(lines[1]!.split('\n')[0]).toContain('NEW OR CHANGED: hook "zz-new"')
    expect(lines[1]!.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(DIALOG_LIST_SHOWN)
    const report = lines.find((l) => l.startsWith('Full list: '))!.slice('Full list: '.length)
    expect(existsSync(join(r, report))).toBe(true)
    expect(readFileSync(join(r, report), 'utf8')).toContain('h11')
  })
})

describe('git-programs — REVIEW round 1', () => {
  it.skipIf(process.platform === 'win32')('a hook made executable is new, since git starts running it', () => {
    const r = repo()
    const path = hook(join(r, '.git', 'hooks'), 'pre-commit')
    chmodSync(path, 0o644)
    const first = check(r)
    appendAuditEntry(r, baselineEntry(first.read, first.baseline))
    expect(check(r).fresh).toEqual([])
    chmodSync(path, 0o755)
    expect(check(r).fresh).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('lists a dangling hook link instead of refusing every call', () => {
    const r = repo()
    mkdirSync(join(r, '.git', 'hooks'), { recursive: true })
    symlinkSync(join(base, 'gone'), join(r, '.git', 'hooks', 'pre-commit'))
    expect(labels(r).some((l) => l.includes('a link to the missing'))).toBe(true)
  })

  it('reads the repository git would push to: ./sub with sub.git beside an empty sub folder', () => {
    const r = repo()
    mkdirSync(join(r, 'sub'))
    const bare = join(r, 'sub.git')
    mkdirSync(bare)
    git(bare, 'init', '-q', '--bare')
    hook(join(bare, 'hooks'), 'pre-receive')
    expect(labels(r, { urls: ['./sub'] }).some((l) => l.startsWith('local remote hook "pre-receive"'))).toBe(true)
  })

  it('expands ~ and reads a Windows drive-relative path as local, as git does', () => {
    const r = repo()
    expect(localPathRemote('~/evil.git', r, join(base, 'home'))).toBe(resolve(base, 'home', 'evil.git'))
    if (process.platform === 'win32') expect(localPathRemote('C:..\bare.git', r)).not.toBeNull()
  })

  it('a commit after a push does not make the local remote\'s entries new again', () => {
    const r = repo()
    hook(join(r, '.git', 'hooks'), 'pre-commit')
    const bare = join(base, 'remote.git')
    mkdirSync(bare)
    git(bare, 'init', '-q', '--bare')
    hook(join(bare, 'hooks'), 'pre-receive')
    const pushCheck = (): ReturnType<typeof check> => {
      const c = checkGitPrograms(r, defaultGitExecutor, undefined, { urls: [bare] })
      if (!c.ok) throw new Error(c.reason)
      return c
    }
    const firstPush = pushCheck()
    expect(firstPush.fresh.length).toBe(2)
    appendAuditEntry(r, baselineEntry(firstPush.read, firstPush.baseline))
    const commit = check(r)
    appendAuditEntry(r, baselineEntry(commit.read, commit.baseline))
    expect(pushCheck().fresh).toEqual([])
  })

  it('follows a gitfile of any name at the first spot git looks, not a clean decoy beside it (REVIEW round 2)', () => {
    const r = repo()
    const evil = join(base, 'evil.git')
    mkdirSync(evil)
    git(evil, 'init', '-q', '--bare')
    hook(join(evil, 'hooks'), 'pre-receive')
    const decoy = join(base, 'remote.git')
    mkdirSync(decoy)
    git(decoy, 'init', '-q', '--bare')
    writeFileSync(join(base, 'remote'), `gitdir: ${evil}\n`)
    expect(labels(r, { urls: [join(base, 'remote')] }).some((l) => l.startsWith('local remote hook "pre-receive"'))).toBe(true)
  })

  it('refuses a file at the first spot git looks that is not a gitfile, even with a repository beside it (REVIEW round 2)', () => {
    const r = repo()
    const decoy = join(base, 'remote.git')
    mkdirSync(decoy)
    git(decoy, 'init', '-q', '--bare')
    writeFileSync(join(base, 'remote'), 'not a gitfile\n')
    expect(readGitPrograms(r, defaultGitExecutor, { urls: [join(base, 'remote')] }).ok).toBe(false)
  })

  it("resolves a remote's relative core.hooksPath against its git folder, where push hooks run (REVIEW round 2)", () => {
    const r = repo()
    mkdirSync(join(r, 'myhooks'))
    const bare = join(base, 'rel.git')
    mkdirSync(bare)
    git(bare, 'init', '-q', '--bare')
    git(bare, 'config', 'core.hooksPath', 'myhooks')
    hook(join(bare, 'myhooks'), 'pre-receive')
    expect(labels(r, { urls: [bare] }).some((l) => l.includes('rel.git/myhooks/pre-receive'))).toBe(true)
  })

  it("refuses a push URL in another user's home or a relative file:// URL, which RSCT does not resolve (REVIEW round 2)", () => {
    const r = repo()
    mkdirSync(join(r, '~bob', 'x.git'), { recursive: true })
    git(join(r, '~bob', 'x.git'), 'init', '-q', '--bare')
    expect(readGitPrograms(r, defaultGitExecutor, { urls: ['~bob/x.git'] }).ok).toBe(false)
    expect(readGitPrograms(r, defaultGitExecutor, { urls: ['file://~bob/x.git'] }).ok).toBe(false)
    expect(readGitPrograms(r, defaultGitExecutor, { urls: ['file://../x.git'] }).ok).toBe(false)
  })

  it('masks every credential before the last @ of a URL', () => {
    const r = repo()
    git(r, 'config', 'remote.o.url', 'foo::https://user:p@ss@host.invalid/x')
    const shown = labels(r).join('\n')
    expect(shown).toContain('***@host.invalid')
    expect(shown).not.toContain('ss@host')
  })
})
