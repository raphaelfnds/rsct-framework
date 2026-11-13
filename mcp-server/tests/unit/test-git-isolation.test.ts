import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
    expect(globalEntries()).toEqual(['user.email=rsct-test@example.invalid', 'user.name=rsct-test'])
  })

  it('the XDG config folder git reads does not exist, so no XDG git config or attributes apply', () => {
    expect(process.env.XDG_CONFIG_HOME).toBe(TEST_XDG_CONFIG_HOME)
    expect(existsSync(TEST_XDG_CONFIG_HOME)).toBe(false)
  })
})
