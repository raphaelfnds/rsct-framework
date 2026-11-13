import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendAuditEntry } from '../../src/lib/audit-log.js'
import { DIALOG_LIST_SHOWN } from '../../src/lib/gate-exceptions.js'
import { defaultGitExecutor } from '../../src/lib/git.js'
import {
  baselineEntry,
  checkGitPrograms,
  helperUrl,
  isProgramKey,
  localPathRemote,
  programsDialogLines,
  programsStillSame,
  readGitPrograms,
} from '../../src/lib/git-programs.js'

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
