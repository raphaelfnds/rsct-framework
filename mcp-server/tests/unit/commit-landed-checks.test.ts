import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { requestCommitHandler, type RequestCommitOutput } from '../../src/tools/request-commit.js'
import type { DialogResult } from '../../src/lib/os-dialog.js'

const GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const SECRET = 'API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA'
let root: string
let stamp = 0

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function hook(body: string): void {
  const path = join(root, '.git', 'hooks', 'pre-commit')
  writeFileSync(path, `#!/bin/sh\n${body}`)
  chmodSync(path, 0o755)
}

async function commit(): Promise<RequestCommitOutput> {
  stamp++
  return (await requestCommitHandler(
    { project_root: root, message: 'docs: change', dev_approval: { timestamp: new Date(Date.now() - 15_000).toISOString(), action_scope: `commit:${stamp}`, reason: `change ${stamp} for the test` } },
    { now: new Date(), promptFn: async (): Promise<DialogResult> => ({ response: 'yes', channel: 'windows' }) },
  )) as RequestCommitOutput
}

function drift(): { paths: string[]; secrets?: string[] } | undefined {
  const path = join(root, '.rsct', 'phase-state.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { review_drift?: { paths: string[]; secrets?: string[] } }).review_drift : undefined
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-landed-'))
  git('init', '-q', '--template=')
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 't')
  git('config', 'core.autocrlf', 'false')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '.git/hooks')
  writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 't', org: 't' } }))
  writeFileSync(join(root, '.gitignore'), '.rsct/\n.rsct.json\n')
  writeFileSync(join(root, 'readme.txt'), 'hello\n')
  git('add', '.gitignore', 'readme.txt')
  git('commit', '-q', '-m', 'init')
  git('switch', '-q', '-C', 'feat/x')
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe.skipIf(!GIT)('the REVIEW sweep of a commit reads the tree recorded for the approval, not the live index', () => {
  it('refuses as staged_changed when the index is swapped after the tree is recorded', async () => {
    writeFileSync(join(root, 'a.ts'), 'const a = 1\nconsole.log(a)\n')
    git('add', 'a.ts')
    const blob = git('rev-parse', ':a.ts')
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(
      join(root, '.rsct', 'phase-state.json'),
      JSON.stringify({ review_sweep: { 'a.ts': [{ blob, verdict: 'clean', migrations: [], channel: 'windows', spec_ref: 'x', at: new Date().toISOString() }] } }),
    )
    stamp++
    const out = (await requestCommitHandler(
      { project_root: root, message: 'feat: a', dev_approval: { timestamp: new Date(Date.now() - 15_000).toISOString(), action_scope: `commit:${stamp}`, reason: 'commit the reviewed file' } },
      {
        now: new Date(),
        promptFn: async (): Promise<DialogResult> => ({ response: 'yes', channel: 'windows' }),
        afterStagedStateRecorded: () => {
          writeFileSync(join(root, 'a.ts'), '// unreviewed\nconst a = 1\nconsole.log(a)\n')
          git('add', 'a.ts')
        },
      },
    )) as RequestCommitOutput
    expect(out.reject_kind).toBe('staged_changed')
    expect(git('log', '-1', '--format=%s')).toBe('init')
  })

  it('judges the paths of the recorded tree, not a file added to the index after it', async () => {
    writeFileSync(join(root, 'a.ts'), 'const a = 1\nconsole.log(a)\n')
    git('add', 'a.ts')
    const blob = git('rev-parse', ':a.ts')
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(
      join(root, '.rsct', 'phase-state.json'),
      JSON.stringify({ review_sweep: { 'a.ts': [{ blob, verdict: 'clean', migrations: [], channel: 'windows', spec_ref: 'x', at: new Date().toISOString() }] } }),
    )
    stamp++
    const out = (await requestCommitHandler(
      { project_root: root, message: 'feat: a', dev_approval: { timestamp: new Date(Date.now() - 15_000).toISOString(), action_scope: `commit:${stamp}`, reason: 'commit the reviewed file' } },
      {
        now: new Date(),
        promptFn: async (): Promise<DialogResult> => ({ response: 'yes', channel: 'windows' }),
        afterStagedStateRecorded: () => {
          writeFileSync(join(root, 'b.ts'), 'const b = 2\nconsole.log(b)\n')
          git('add', 'b.ts')
        },
      },
    )) as RequestCommitOutput
    expect(out.reject_kind).toBe('staged_changed')
  })
})

describe.skipIf(!GIT)('a commit that lands while git commit fails gets the after-commit checks', () => {
  it('arms review_drift with the unreviewed code and the secret a hook commit landed', async () => {
    writeFileSync(join(root, 'hook.env'), `${SECRET}\n`)
    writeFileSync(join(root, 'evil.ts'), 'export const evil = 1\n')
    hook('git add -f hook.env evil.ts\ngit commit -q --no-verify -m sneaked\n')
    writeFileSync(join(root, 'notes.txt'), 'notes\n')
    git('add', 'notes.txt')
    const out = await commit()
    expect(out.status).toBe('mutation_failed')
    expect(git('log', '-1', '--format=%s')).toBe('sneaked')
    const lock = drift()
    expect(lock?.paths.sort()).toEqual(['evil.ts', 'hook.env'])
    expect(lock?.secrets?.[0]).toContain('"hook.env":1 — value-shape')
    expect(out.hints.some((h) => h.includes('1 secret finding(s) no dialog showed') && h.includes('review_drift is armed'))).toBe(true)
    expect(readFileSync(join(root, '.rsct', 'audit.log'), 'utf8')).toContain('"event":"request_commit.landed_drift"')
  })

  it('arms nothing when what landed is only what the developer approved', async () => {
    hook('git commit -q --no-verify -m sneaked\n')
    writeFileSync(join(root, 'notes.txt'), 'notes\n')
    git('add', 'notes.txt')
    const out = await commit()
    expect(out.status).toBe('mutation_failed')
    expect(drift()).toBeUndefined()
  })

  it('does not arm the lock for a secret the developer approved in the dialog', async () => {
    hook('git commit -q --no-verify -m sneaked\n')
    writeFileSync(join(root, 'fixture.env'), `${SECRET}\n`)
    git('add', 'fixture.env')
    stamp++
    const out = (await requestCommitHandler(
      {
        project_root: root,
        message: 'test: fixture',
        dev_approval: { timestamp: new Date(Date.now() - 15_000).toISOString(), action_scope: `commit:${stamp}`, reason: 'a fixture key for the test', override_secrets_check: { reason: 'fake key used by the tests' } },
      },
      { now: new Date(), promptFn: async (): Promise<DialogResult> => ({ response: 'yes', channel: 'windows' }) },
    )) as RequestCommitOutput
    expect(out.status).toBe('mutation_failed')
    expect(git('log', '-1', '--format=%s')).toBe('sneaked')
    expect(drift()).toBeUndefined()
  })

  it('scans the approved branch, not the branch a hook switched to', async () => {
    git('switch', '-q', '-c', 'other')
    writeFileSync(join(root, 'other.env'), `${SECRET}\n`)
    git('add', 'other.env')
    git('commit', '-q', '-m', 'secret elsewhere')
    git('switch', '-q', 'feat/x')
    hook('git commit -q --no-verify -m sneaked\ngit switch -q -f other\n')
    writeFileSync(join(root, 'notes.txt'), 'notes\n')
    git('add', 'notes.txt')
    const out = await commit()
    expect(out.status).toBe('mutation_failed')
    expect(drift()?.secrets ?? []).toEqual([])
  })
})
