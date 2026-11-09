import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { requestMergeHandler, type RequestMergeOutput } from '../../src/tools/request-merge.js'
import { requestRebaseHandler, type RequestRebaseOutput } from '../../src/tools/request-rebase.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { defaultGitExecutor } from '../../src/lib/git.js'

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
const ACK = { plan_complete: true, adr_confirmed: true, issues_resolved: true, hygiene_swept: true, note: 'swept for the gate tests' }

let root: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commitFile(name: string, text: string, message: string): string {
  writeFileSync(join(root, name), text)
  git('add', name)
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}

let stamp = 0
function approval(extra: Record<string, unknown> = {}): Record<string, unknown> {
  stamp += 1
  return { timestamp: new Date(NOW.getTime() - stamp * 1000).toISOString(), action_scope: 'merge:test', reason: 'integration for the gate tests', ...extra }
}

function dialogs(answer: DialogResult['response'] = 'yes', onShow?: () => void) {
  const seen: DialogOptions[] = []
  return { seen, fn: async (o: DialogOptions): Promise<DialogResult> => { seen.push(o); onShow?.(); return { response: answer, channel: 'windows' } } }
}

async function merge(input: Record<string, unknown>, answer: DialogResult['response'] = 'yes', onShow?: () => void) {
  const d = dialogs(answer, onShow)
  const out = (await requestMergeHandler({ project_root: root, pre_merge_ack: { ...ACK, files_swept: swept() }, ...input }, { promptFn: d.fn, now: NOW })) as RequestMergeOutput
  return { out, seen: d.seen, text: d.seen[0]?.message ?? '' }
}

async function rebase(input: Record<string, unknown>, answer: DialogResult['response'] = 'yes') {
  const d = dialogs(answer)
  const out = (await requestRebaseHandler({ project_root: root, pre_merge_ack: { ...ACK, files_swept: swept() }, ...input }, { promptFn: d.fn, now: NOW })) as RequestRebaseOutput
  return { out, seen: d.seen, text: d.seen[0]?.message ?? '' }
}

function swept(): string[] {
  return ['s.env', 'b.txt', 'c.txt', 'm.txt', 'hook.env', 'other.txt']
}

function footerAt(text: string): number {
  const at = text.indexOf('\nRepository: ')
  expect(at, 'the dialog carries the framework footer').toBeGreaterThan(0)
  return at
}

function hook(name: string, body: string): void {
  const dir = join(root, '.git', 'test-hooks')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
  if (process.platform !== 'win32') execFileSync('chmod', ['+x', join(dir, name)])
  git('config', 'core.hooksPath', '.git/test-hooks')
}

beforeEach(() => {
  stamp = 0
  root = mkdtempSync(join(tmpdir(), 'rsct-merge-gates-'))
  git('init', '-q', '--template=')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 't')
  git('config', 'core.autocrlf', 'false')
  git('config', 'commit.gpgsign', 'false')
  git('symbolic-ref', 'HEAD', 'refs/heads/integ')
  writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 't', org: 't' }, protected_branches: ['main'] }))
  writeFileSync(join(root, '.gitignore'), '.rsct/\n.rsct.json\n')
  commitFile('readme.txt', 'hello\n', 'init')
  git('checkout', '-q', '-b', 'feat/x')
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe.skipIf(!GIT)('rsct_request_merge scans what it brings and shows every exception', () => {
  it('refuses a secret the source brings, with no dialog, and lists it with the reason when overridden', async () => {
    const added = commitFile('s.env', `${SECRET}\n`, 'secret')
    git('checkout', '-q', 'integ')
    const refused = await merge({ source_branch: 'feat/x', dev_approval: approval() })
    expect([refused.out.reject_kind, refused.seen.length]).toEqual(['secrets', 0])

    const { out, text } = await merge({ source_branch: 'feat/x', dev_approval: approval({ override_secrets_check: { reason: 'fixture key' } }) })
    expect(out.status).toBe('merged')
    expect(out.secrets_check.after_merge, 'what the dialog showed does not arm the lock').toEqual([])
    expect(existsSync(join(root, '.rsct', 'phase-state.json'))).toBe(false)
    expect(text).toContain(`Source commit: ${added.slice(0, 12)}`)
    expect(text).toContain(`"s.env":1 — value-shape (commit ${added.slice(0, 12)})`)
    expect(text.indexOf('Agent\'s reason for the secret findings: "fixture key"')).toBeGreaterThan(footerAt(text))
    expect(text.indexOf('pre_merge_ack: plan_complete yes'), 'present').toBeGreaterThanOrEqual(0)
    expect(text.indexOf('pre_merge_ack: plan_complete yes')).toBeLessThan(footerAt(text))
    expect(text.indexOf('Agent\'s pre_merge_ack note: "swept for the gate tests"')).toBeGreaterThan(footerAt(text))
  })

  it('refuses a protected target and unrelated histories without the override, before any dialog', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git('checkout', '-q', '-b', 'main', 'integ')
    const target = await merge({ source_branch: 'feat/x', dev_approval: approval() })
    expect([target.out.reject_kind, target.seen.length]).toEqual(['protected_branch', 0])

    git('checkout', '-q', 'integ')
    const unrelated = await merge({ source_branch: 'feat/x', allow_unrelated_histories: true, dev_approval: approval() })
    expect([unrelated.out.reject_kind, unrelated.seen.length]).toEqual(['unrelated_histories_without_override', 0])

    const shown = await merge({ source_branch: 'feat/x', allow_unrelated_histories: true, dev_approval: approval({ override_protected_branch: { reason: 'history import' } }) }, 'no')
    expect(shown.text).toContain('⚠ --allow-unrelated-histories joins two histories with no common commit; it needs your exception.')
    expect(shown.text.indexOf('Agent\'s reason for the unrelated histories: "history import"')).toBeGreaterThan(footerAt(shown.text))
  })

  it('refuses while review_drift is armed, and on a detached HEAD, before any dialog', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git('checkout', '-q', 'integ')
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(join(root, '.rsct', 'phase-state.json'), JSON.stringify({ review_drift: { sha: 'a'.repeat(40), paths: ['x.ts'], at: NOW.toISOString() } }))
    const drift = await merge({ source_branch: 'feat/x', dev_approval: approval() })
    expect([drift.out.reject_kind, drift.seen.length]).toEqual(['review_drift', 0])
    rmSync(join(root, '.rsct', 'phase-state.json'))

    git('checkout', '-q', '--detach', 'integ')
    const detached = await merge({ source_branch: 'feat/x', dev_approval: approval() })
    expect([detached.out.reject_kind, detached.seen.length]).toEqual(['detached_head', 0])
  })

  it('refuses when the source moves after the dialog, and merges nothing', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git('checkout', '-q', 'integ')
    const head = git('rev-parse', 'HEAD')
    const { out } = await merge({ source_branch: 'feat/x', dev_approval: approval() }, 'yes', () => {
      git('update-ref', 'refs/heads/feat/x', execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-p', 'feat/x', '-m', 'moved'], { cwd: root, encoding: 'utf8' }).trim())
    })
    expect(out.reject_kind).toBe('source_moved')
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(out.anti_replay_persisted).toBeNull()
  })

  it('refuses when HEAD moves to another branch while the dialog is open, and merges nothing there', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git('checkout', '-q', '-b', 'main', 'integ')
    git('checkout', '-q', 'integ')
    const mainBefore = git('rev-parse', 'main')
    const { out } = await merge({ source_branch: 'feat/x', dev_approval: approval() }, 'yes', () => git('checkout', '-q', 'main'))
    expect(out.reject_kind).toBe('target_moved')
    expect(git('rev-parse', 'main')).toBe(mainBefore)
  })

  it('refuses before the dialog when HEAD moves between the checks and the pin', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git('checkout', '-q', '-b', 'main', 'integ')
    git('checkout', '-q', 'integ')
    const mainBefore = git('rev-parse', 'main')
    for (const run of ['merge', 'rebase'] as const) {
      let moved = false
      const executor = (r: string, args: string[]) => {
        if (!moved && args[0] === 'rev-parse' && args[3]?.endsWith('^{commit}')) {
          moved = true
          git('checkout', '-q', 'main')
        }
        return defaultGitExecutor(r, args)
      }
      const d = dialogs()
      const input = { project_root: root, pre_merge_ack: { ...ACK, files_swept: swept() }, dev_approval: approval() }
      const out =
        run === 'merge'
          ? ((await requestMergeHandler({ ...input, source_branch: 'feat/x' }, { promptFn: d.fn, now: NOW, gitExecutor: executor })) as RequestMergeOutput)
          : ((await requestRebaseHandler({ ...input, ref: 'feat/x' }, { promptFn: d.fn, now: NOW, gitExecutor: executor })) as RequestRebaseOutput)
      expect([run, out.reject_kind, d.seen.length]).toEqual([run, 'target_moved', 0])
      expect(git('rev-parse', 'main')).toBe(mainBefore)
      git('checkout', '-q', 'integ')
    }
  })

  it('merges the pinned commit, with the merge message naming the branch', async () => {
    commitFile('b.txt', 'b\n', 'work')
    const source = git('rev-parse', 'HEAD')
    git('checkout', '-q', 'integ')
    const d = dialogs()
    const sent: string[][] = []
    const out = (await requestMergeHandler(
      { project_root: root, source_branch: 'feat/x', pre_merge_ack: { ...ACK, files_swept: swept() }, dev_approval: approval() },
      {
        promptFn: d.fn,
        now: NOW,
        gitExecutor: (r, args) => {
          if (args[0] === 'merge') sent.push(args)
          return defaultGitExecutor(r, args)
        },
      },
    )) as RequestMergeOutput
    expect(out.status).toBe('merged')
    expect(sent.at(-1)?.at(-1)).toBe(source)
    expect(git('log', '-1', '--format=%s')).toBe("Merge branch 'feat/x' into integ")
  })

  it('arms review_drift when a post-merge hook lands a secret the dialog did not show', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git('checkout', '-q', 'integ')
    hook('post-merge', `printf '%s\\n' '${SECRET}' > hook.env && git add hook.env && git commit -q -m hook`)
    const { out } = await merge({ source_branch: 'feat/x', dev_approval: approval() })
    expect(out.status).toBe('merged')
    expect(out.secrets_check.after_merge.map((f) => f.file)).toEqual(['hook.env'])
    const state = JSON.parse(readFileSync(join(root, '.rsct', 'phase-state.json'), 'utf8')) as { review_drift?: { paths: string[]; secrets?: string[] } }
    expect(state.review_drift?.paths).toEqual(['hook.env'])
    expect(state.review_drift?.secrets?.[0]).toContain('"hook.env":1 — value-shape')
  })
})

describe.skipIf(!GIT)('rsct_request_rebase scans both sides since the merge base', () => {
  it('refuses a secret on the branch it rewrites, before any dialog', async () => {
    commitFile('s.env', `${SECRET}\n`, 'secret on the branch')
    git('checkout', '-q', 'integ')
    commitFile('m.txt', 'm\n', 'upstream')
    git('checkout', '-q', 'feat/x')
    const { out, seen } = await rebase({ ref: 'integ', dev_approval: approval() })
    expect([out.reject_kind, seen.length]).toEqual(['secrets', 0])
  })

  it('does not arm the lock for a finding the dialog showed, when the rebase rewrites its commit', async () => {
    commitFile('s.env', `${SECRET}\n`, 'secret on the branch')
    git('checkout', '-q', 'integ')
    commitFile('m.txt', 'm\n', 'upstream')
    git('checkout', '-q', 'feat/x')
    const { out } = await rebase({ ref: 'integ', dev_approval: approval({ override_secrets_check: { reason: 'fixture key on the branch' } }) })
    expect(out.status).toBe('rebased')
    expect(out.secrets_check.findings.map((f) => f.file)).toEqual(['s.env'])
    expect(out.secrets_check.after_rebase).toEqual([])
    expect(existsSync(join(root, '.rsct', 'phase-state.json'))).toBe(false)
  })

  it('refuses a secret the upstream brings, and shows the pinned commit and the reason when overridden', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git('checkout', '-q', 'integ')
    const upstream = commitFile('s.env', `${SECRET}\n`, 'secret upstream')
    git('checkout', '-q', 'feat/x')
    const refused = await rebase({ ref: 'integ', dev_approval: approval() })
    expect(refused.out.reject_kind).toBe('secrets')
    const { out, text } = await rebase({ ref: 'integ', dev_approval: approval({ override_secrets_check: { reason: 'upstream fixture' } }) })
    expect(out.status).toBe('rebased')
    expect(text).toContain(`Onto commit: ${upstream.slice(0, 12)}`)
    expect(text.indexOf('Agent\'s reason for the secret findings: "upstream fixture"')).toBeGreaterThan(footerAt(text))
  })

  it('refuses to rewrite a protected branch without the override, before any dialog', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git('checkout', '-q', '-b', 'main', 'integ')
    const { out, seen } = await rebase({ ref: 'feat/x', dev_approval: approval() })
    expect([out.reject_kind, seen.length]).toEqual(['protected_branch', 0])
  })

  it('refuses when HEAD moves while the rebase dialog is open', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git('checkout', '-q', 'integ')
    commitFile('m.txt', 'm\n', 'upstream')
    git('checkout', '-q', 'feat/x')
    const d = dialogs()
    const out = (await requestRebaseHandler(
      { project_root: root, ref: 'integ', pre_merge_ack: { ...ACK, files_swept: swept() }, dev_approval: approval() },
      { now: NOW, promptFn: async (o) => { git('checkout', '-q', 'integ'); return d.fn(o) } },
    )) as RequestRebaseOutput
    expect(out.reject_kind).toBe('target_moved')
  })

  it('refuses while review_drift is armed, before any dialog', async () => {
    commitFile('b.txt', 'b\n', 'work')
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(join(root, '.rsct', 'phase-state.json'), JSON.stringify({ review_drift: { sha: 'a'.repeat(40), paths: ['x.ts'], at: NOW.toISOString() } }))
    const { out, seen } = await rebase({ ref: 'integ', dev_approval: approval() })
    expect([out.reject_kind, seen.length]).toEqual(['review_drift', 0])
  })

  it('says the commit tool scans a squash, and scans nothing itself', async () => {
    commitFile('s.env', `${SECRET}\n`, 'secret on the branch')
    git('checkout', '-q', 'integ')
    const { out, text } = await rebase({ mode: 'squash', ref: 'feat/x', dev_approval: approval() })
    expect(out.status).toBe('squashed')
    expect(text).toContain('Secrets scan: the squashed change is scanned when rsct_request_commit commits it.')
  })

  it('arms review_drift when a hook lands a secret during the rebase', async () => {
    commitFile('b.txt', 'b\n', 'work')
    git('checkout', '-q', 'integ')
    commitFile('m.txt', 'm\n', 'upstream')
    git('checkout', '-q', 'feat/x')
    hook('post-rewrite', `printf '%s\\n' '${SECRET}' > hook.env && git add hook.env && git commit -q -m hook`)
    const { out } = await rebase({ ref: 'integ', dev_approval: approval() })
    expect(out.status).toBe('rebased')
    expect(out.secrets_check.after_rebase.map((f) => f.file)).toEqual(['hook.env'])
    const state = JSON.parse(readFileSync(join(root, '.rsct', 'phase-state.json'), 'utf8')) as { review_drift?: { paths: string[] } }
    expect(state.review_drift?.paths).toEqual(['hook.env'])
  })
})
