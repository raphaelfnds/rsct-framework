import { describe, it, expect } from 'vitest'
import type { GitExecResult, GitExecutor } from '../../src/lib/git.js'
import { maskUrl, readPushOptions, readPushUrls, readSubmoduleMode, repoIdentity, sameRepository } from '../../src/lib/push-target.js'

const ok = (stdout: string): GitExecResult => ({ ok: true, stdout, stderr: '', exitCode: 0 })
const fail = (exitCode: number): GitExecResult => ({ ok: false, stdout: '', stderr: '', exitCode })

function exec(answers: Record<string, GitExecResult>): GitExecutor {
  return (_root, args) => answers[args.join(' ')] ?? fail(1)
}

describe('maskUrl', () => {
  it('masks every userinfo form and stops at the host', () => {
    expect(maskUrl('https://user:pass@example.invalid/o/r.git')).toBe('https://***@example.invalid/o/r.git')
    expect(maskUrl('https://ghp_TOKEN@example.invalid/o/r.git')).toBe('https://***@example.invalid/o/r.git')
    expect(maskUrl('ssh://tok@host/p@x.git')).toBe('ssh://***@host/p@x.git')
    expect(maskUrl('git@github.com:o/r.git')).toBe('***@github.com:o/r.git')
  })

  it('leaves URLs with no userinfo and local paths as they are', () => {
    expect(maskUrl('https://example.invalid/o/r.git')).toBe('https://example.invalid/o/r.git')
    expect(maskUrl('C:/work/remote.git')).toBe('C:/work/remote.git')
    expect(maskUrl('../remote.git')).toBe('../remote.git')
  })
})

describe('sameRepository', () => {
  it('treats the https and ssh forms of one repository as the same', () => {
    expect(sameRepository('https://github.com/o/r.git', ['git@github.com:o/r.git'])).toBe(true)
    expect(sameRepository('https://github.com/o/r', ['ssh://git@github.com/o/r.git/'])).toBe(true)
  })

  it('treats another host, path, explicit port or letter case as another repository', () => {
    expect(sameRepository('https://github.com/o/r.git', ['git@gitlab.com:o/r.git'])).toBe(false)
    expect(sameRepository('https://github.com/o/r.git', ['git@github.com:o/fork.git'])).toBe(false)
    expect(sameRepository('https://github.com/o/r.git', ['ssh://git@github.com:2222/o/r.git'])).toBe(false)
    expect(sameRepository('https://github.com/o/r.git', ['git@github.com:O/R.git'])).toBe(false)
  })

  it('keeps an absolute scp-style path apart from a home-relative one', () => {
    expect(sameRepository('git@host.example:o/r.git', ['git@host.example:/o/r.git'])).toBe(false)
    expect(sameRepository('git@host.example:/o/r.git', ['ssh://git@host.example/o/r.git'])).toBe(false)
    expect(sameRepository('git@host.example:/o/r.git', ['git@host.example:/o/r'])).toBe(true)
  })

  it('needs every push URL to match, and compares local paths as typed', () => {
    expect(sameRepository('https://github.com/o/r.git', ['git@github.com:o/r.git', 'https://example.invalid/o/r.git'])).toBe(false)
    expect(sameRepository('https://github.com/o/r.git', [])).toBe(false)
    expect(sameRepository('../remote.git', ['../remote.git'])).toBe(true)
    expect(sameRepository('C:/work/remote.git', ['C:/work/other.git'])).toBe(false)
    expect(repoIdentity('C:/work/remote.git')).toBe('local:C:/work/remote.git')
  })
})

describe('push reads', () => {
  it('reads every push URL and refuses when git reports none', () => {
    expect(readPushUrls('/x', 'origin', exec({ 'remote get-url --push --all origin': ok('a.git\nb.git\n') }))).toEqual({ ok: true, value: ['a.git', 'b.git'] })
    expect(readPushUrls('/x', 'origin', exec({})).ok).toBe(false)
  })

  it('keeps only the push options after the last empty value, and none when the key is absent', () => {
    expect(readPushOptions('/x', exec({ 'config -z --get-all push.pushOption': ok('a\0\0b\0') }))).toEqual({ ok: true, value: ['b'] })
    expect(readPushOptions('/x', exec({ 'config -z --get-all push.pushOption': ok('a\0b\0') }))).toEqual({ ok: true, value: ['a', 'b'] })
    expect(readPushOptions('/x', exec({}))).toEqual({ ok: true, value: [] })
    expect(readPushOptions('/x', () => fail(128)).ok).toBe(false)
  })

  it('checks submodules whenever the config would push or check them, and when it cannot tell', () => {
    const mode = (answers: Record<string, GitExecResult>) => readSubmoduleMode('/x', exec(answers))
    expect(mode({ 'config --get push.recurseSubmodules': ok('on-demand\n') })).toBe('check')
    expect(mode({ 'config --get push.recurseSubmodules': ok('only\n') })).toBe('check')
    expect(mode({ 'config --get push.recurseSubmodules': ok('check\n') })).toBe('check')
    expect(mode({ 'config --get push.recurseSubmodules': ok('no\n') })).toBe('no')
    expect(mode({ 'config --bool --get submodule.recurse': ok('true\n') })).toBe('check')
    expect(mode({ 'config --bool --get submodule.recurse': ok('false\n') })).toBe('no')
    expect(mode({})).toBe('no')
    expect(readSubmoduleMode('/x', () => fail(128))).toBe('check')
  })
})
