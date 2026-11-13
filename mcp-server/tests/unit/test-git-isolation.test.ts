import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { TEST_GIT_CONFIG_FIXTURE, TEST_XDG_CONFIG_HOME } from '../setup.js'

function globalEntries(): string[] {
  return execFileSync('git', ['config', '--global', '--list'], { encoding: 'utf8', env: process.env })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .sort()
}

describe('the suite reads its own git config, never the developer\'s', () => {
  it('git --global resolves to the committed fixture, with exactly its entries', () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(TEST_GIT_CONFIG_FIXTURE)
    expect(globalEntries()).toEqual([
      ...(process.platform === 'win32' ? ['core.autocrlf=true'] : []),
      'user.email=rsct-test@example.invalid',
      'user.name=rsct-test',
    ])
  })

  it('the system git config is not read, so the machine\'s Git install adds nothing', () => {
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1')
    const norm = (p: string): string => {
      const unquoted = p.replace(/^file:"(.*)"$/, (_, inner: string) => `file:${inner.replace(/\\\\/g, '\\')}`)
      const flat = unquoted.replace(/\\/g, '/')
      return process.platform === 'win32' ? flat.toLowerCase() : flat
    }
    const all = execFileSync('git', ['config', '--show-origin', '--list'], { encoding: 'utf8', env: process.env, cwd: tmpdir() })
    const origins = [...new Set(all.split('\n').filter((l) => l.length > 0).map((l) => norm(l.split('\t')[0]!)))]
    expect(origins).toEqual([`file:${norm(TEST_GIT_CONFIG_FIXTURE)}`])
  })

  it('the XDG config folder git reads does not exist, so no XDG git config or attributes apply', () => {
    expect(process.env.XDG_CONFIG_HOME).toBe(TEST_XDG_CONFIG_HOME)
    expect(existsSync(TEST_XDG_CONFIG_HOME)).toBe(false)
  })
})
