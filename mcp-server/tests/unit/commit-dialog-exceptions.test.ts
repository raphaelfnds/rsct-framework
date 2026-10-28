import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { requestCommitHandler, type RequestCommitOutput } from '../../src/tools/request-commit.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

const GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const SECRET_VALUE = 'sk-AAAAAAAAAAAAAAAAAAAAAAAA'

let root: string
let stamp = 0

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(branch = 'feat/x'): void {
  git('init', '-q')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 't')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'readme.txt'), 'hello\n')
  git('add', 'readme.txt')
  git('commit', '-q', '-m', 'init')
  git('switch', '-q', '-c', branch)
}

function approval(extra: Record<string, unknown> = {}): Record<string, unknown> {
  stamp++
  return { timestamp: new Date(Date.now() - 15_000).toISOString(), action_scope: `commit:${stamp}`, reason: `change ${stamp}`, ...extra }
}

async function commit(
  devApproval: Record<string, unknown>,
  onDialog: (opts: DialogOptions) => void = () => {},
): Promise<{ out: RequestCommitOutput; dialogs: string[] }> {
  const dialogs: string[] = []
  const out = (await requestCommitHandler(
    { project_root: root, message: 'feat: change', dev_approval: devApproval },
    {
      now: new Date(),
      promptFn: async (opts: DialogOptions): Promise<DialogResult> => {
        dialogs.push(opts.message)
        onDialog(opts)
        return { response: 'yes', channel: 'windows' }
      },
    },
  )) as RequestCommitOutput
  return { out, dialogs }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-dialog-'))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!GIT)('the commit dialog shows every exception it is asked to approve', () => {
  it('lists the secret finding and the agent reason, never the value', async () => {
    initRepo()
    writeFileSync(join(root, 'app.env'), `API_KEY=${SECRET_VALUE}\n`)
    git('add', 'app.env')
    const { out, dialogs } = await commit(approval({ override_secrets_check: { reason: 'fixture value, not a real key' } }))
    expect(out.status).toBe('committed')
    expect(dialogs).toHaveLength(1)
    const text = dialogs[0]!
    expect(text).toContain('⚠ The secrets scan found 1 line(s) that look like a credential')
    expect(text).toContain('• "app.env":1 — value-shape')
    expect(text).not.toContain(SECRET_VALUE)
    const reasonAt = text.indexOf(`Agent's reason for the secret findings: "fixture value, not a real key"`)
    expect(reasonAt).toBeGreaterThan(text.indexOf('Folder: ') > -1 ? text.indexOf('Folder: ') : text.indexOf('Repository: '))
    expect(reasonAt).toBeLessThan(text.indexOf('Commit message:'))
  })

  it('refuses a secret with no exception before any dialog opens', async () => {
    initRepo()
    writeFileSync(join(root, 'app.env'), `API_KEY=${SECRET_VALUE}\n`)
    git('add', 'app.env')
    const { out, dialogs } = await commit(approval())
    expect(out.reject_kind).toBe('secrets')
    expect(dialogs).toEqual([])
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('refuses a protected branch with no exception before any dialog, and shows it when asked', async () => {
    initRepo('main')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const refused = await commit(approval())
    expect(refused.out.reject_kind).toBe('protected_branch')
    expect(refused.dialogs).toEqual([])
    const allowed = await commit(approval({ override_protected_branch: { reason: 'solo maintainer flow' } }))
    expect(allowed.out.status).toBe('committed')
    expect(allowed.dialogs[0]).toContain(`⚠ 'main' is a protected branch: committing here needs your exception.`)
    expect(allowed.dialogs[0]).toContain(`Agent's reason for the protected branch: "solo maintainer flow"`)
  })

  it('cuts a long list in the dialog and writes the full list to a report', async () => {
    initRepo()
    writeFileSync(join(root, 'many.env'), Array.from({ length: 12 }, (_, i) => `token.${i}=v${i}`).join('\n') + '\n')
    git('add', 'many.env')
    const { out, dialogs } = await commit(approval({ override_secrets_check: { reason: 'fixtures' } }))
    expect(out.status).toBe('committed')
    expect(dialogs[0]).toContain('… and 2 more')
    const report = /Full list: (\.rsct\/reports\/commit-secrets-[0-9a-f]{16}\.md)/.exec(dialogs[0]!)?.[1]
    expect(report).toBeDefined()
    expect(readFileSync(join(root, report!), 'utf8').match(/^- "many\.env":/gm)).toHaveLength(12)
  })

  it('shows nothing extra when there is nothing to approve beyond the commit', async () => {
    initRepo()
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { dialogs } = await commit(approval())
    expect(dialogs[0]).not.toContain('⚠')
    expect(dialogs[0]).not.toContain("Agent's reason")
  })
})

describe.skipIf(!GIT)('the commit is exactly what the developer approved', () => {
  it('refuses when something is staged while the dialog is open', async () => {
    initRepo()
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval(), () => {
      writeFileSync(join(root, 'late.env'), `API_KEY=${SECRET_VALUE}\n`)
      git('add', 'late.env')
    })
    expect(out.reject_kind).toBe('staged_changed')
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('refuses when HEAD moves while the dialog is open', async () => {
    initRepo()
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval(), () => {
      git('commit', '-q', '--allow-empty', '-m', 'sneaked in')
    })
    expect(out.reject_kind).toBe('staged_changed')
  })

  it('reports a hook that adds a file to the commit, and locks the next commit until a REVIEW', async () => {
    initRepo()
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test-app', org: 'test-org' } }))
    writeFileSync(join(root, 'late.env'), `API_KEY=${SECRET_VALUE}\n`)
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\ngit add -f late.env\n')
    chmodSync(hook, 0o755)
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const first = await commit(approval())
    expect(first.out.status).toBe('committed_with_drift')
    expect(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['b.txt', 'late.env'])
    expect(first.out.hints.some((h) => h.includes('late.env changed after the approval, with 1 secret finding(s)'))).toBe(true)
    const audit = readdirSync(join(root, '.rsct')).includes('audit.log') ? readFileSync(join(root, '.rsct', 'audit.log'), 'utf8') : ''
    expect(audit).toContain('"event":"request_commit.tree_drift"')

    rmSync(hook)
    writeFileSync(join(root, 'c.txt'), 'c\n')
    git('add', 'c.txt')
    const second = await commit(approval())
    expect(second.out.reject_kind).toBe('review_drift')
    expect(second.dialogs).toEqual([])
  })

  it('reports a hook that adds a file with no secret in it too', async () => {
    initRepo()
    writeFileSync(join(root, 'extra.txt'), 'nothing secret\n')
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\ngit add -f extra.txt\n')
    chmodSync(hook, 0o755)
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval())
    expect(out.status).toBe('committed_with_drift')
    expect(out.hints.some((h) => h.includes('extra.txt changed after the approval') && !h.includes('secret finding'))).toBe(true)
  })

  it('accepts a hook that changes nothing', async () => {
    initRepo()
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    chmodSync(hook, 0o755)
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval())
    expect(out.status).toBe('committed')
  })
})
