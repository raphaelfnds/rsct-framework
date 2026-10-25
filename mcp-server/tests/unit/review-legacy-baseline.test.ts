import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { phaseReviewCompleteHandler, type PhaseReviewCompleteOutput } from '../../src/tools/phase-review-complete.js'
import { requestCommitHandler, type RequestCommitOutput } from '../../src/tools/request-commit.js'
import { countRepositoryCommits, readHeadBirth, type GitExecResult, type GitExecutor } from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { commitAll, git, initSweepRepo } from '../sweep-repo.js'

let root: string
let tick = 0

const LEGACY = { exempt_files: [{ path: 'src/legacy.ts', reason: 'legacy_baseline' }] }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-legacy-'))
  initSweepRepo(root)
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
  write('src/legacy.ts', '// written before the rule\nexport const a = 1 // and this one\n')
})

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

function write(rel: string, content: string): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function auditEvents(): Array<Record<string, unknown>> {
  const p = join(root, '.rsct', 'audit.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function approval(scope: string): Record<string, string> {
  tick++
  return {
    timestamp: new Date(Date.now() - 5_000 - tick).toISOString(),
    action_scope: scope,
    reason: `legacy baseline test approval number ${tick} for ${scope}`,
  }
}

function prompts(...answers: Array<DialogResult['response']>): { fn: (o: DialogOptions) => Promise<DialogResult>; seen: DialogOptions[] } {
  const seen: DialogOptions[] = []
  return {
    seen,
    fn: async (o) => {
      seen.push(o)
      return { response: answers[seen.length - 1] ?? 'yes', channel: 'windows' }
    },
  }
}

async function completeReview(extra: Record<string, unknown>, p = prompts()): Promise<PhaseReviewCompleteOutput> {
  mkdirSync(join(root, '.rsct'), { recursive: true })
  writeFileSync(join(root, '.rsct', 'phase-state.json'), JSON.stringify({ phase: 'review', spec_slug: 'first-publication' }))
  return phaseReviewCompleteHandler(
    { project_root: root, spec_ref: 'first-publication', dev_approval: approval('review_complete:spec_ref=first-publication'), ...extra },
    { promptFn: p.fn },
  )
}

async function commit(): Promise<RequestCommitOutput> {
  return requestCommitHandler(
    { project_root: root, message: 'feat: first publication', dev_approval: approval('commit:main:first') },
    { promptFn: prompts().fn },
  )
}

describe('legacy_baseline — comments that predate the rule, on the first commit of a branch', () => {
  it('goes to the developer dialog, which names the branch, the commit count and the comment counts', async () => {
    const p = prompts('yes', 'yes')
    const out = await completeReview(LEGACY, p)
    expect(out.status).toBe('completed')
    const message = p.seen[0]!.message
    expect(message).toContain("legacy_baseline (1 file(s)): the first commit of branch 'main', which has no commit yet.")
    expect(message).toContain('This repository has 0 commit(s) on its other refs.')
    expect(message).toContain('RSCT did NOT check that these comments predate the rule.')
    expect(message).toContain('src/legacy.ts — legacy_baseline, comments: 2 (')
    expect(message.indexOf('RSCT did NOT check')).toBeLessThan(message.indexOf("Spec: '"))
    expect(auditEvents().some((e) => e.event === 'review.unverified_decision' && e.reason === 'legacy_baseline' && e.answer === 'yes')).toBe(true)
    git(root, 'add', '-A')
    expect((await commit()).status).toBe('committed')
    expect(git(root, 'show', 'HEAD:src/legacy.ts')).toContain('written before the rule')
  })

  it('is refused before any dialog once the branch has a commit', async () => {
    write('README.md', 'first\n')
    git(root, 'add', 'README.md')
    git(root, 'commit', '-qm', 'first')
    const p = prompts()
    const out = await completeReview(LEGACY, p)
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('legacy_baseline_refused')
    expect(out.reason).toMatch(/only for the first commit of a branch/)
    expect(p.seen).toHaveLength(0)
  })

  it('stops counting at commit once the branch got a commit some other way', async () => {
    expect((await completeReview(LEGACY, prompts('yes', 'yes'))).status).toBe('completed')
    write('README.md', 'by hand\n')
    git(root, 'add', 'README.md')
    git(root, 'commit', '-qm', 'by hand')
    git(root, 'add', '-A')
    const out = await commit()
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('comments_present')
  })

  it('does not carry the same file version onto a branch that has commits', async () => {
    expect((await completeReview(LEGACY, prompts('yes', 'yes'))).status).toBe('completed')
    rmSync(join(root, 'src'), { recursive: true, force: true })
    write('README.md', 'base\n')
    commitAll(root, 'base')
    git(root, 'checkout', '-q', '-b', 'work')
    write('src/legacy.ts', '// written before the rule\nexport const a = 1 // and this one\n')
    git(root, 'add', 'src/legacy.ts')
    const out = await commit()
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('comments_present')
  })

  it('accepts the first commit of an orphan branch and shows how many commits the repository has', async () => {
    write('README.md', 'main\n')
    git(root, 'add', 'README.md')
    git(root, 'commit', '-qm', 'main')
    git(root, 'checkout', '-q', '--orphan', 'publish')
    const p = prompts('yes', 'yes')
    const out = await completeReview(LEGACY, p)
    expect(out.status).toBe('completed')
    expect(p.seen[0]!.message).toContain("the first commit of branch 'publish'")
    expect(p.seen[0]!.message).toContain('This repository has 1 commit(s) on its other refs.')
  })

  it('a declined dialog rejects the REVIEW and is recorded as a No', async () => {
    const out = await completeReview(LEGACY, prompts('no'))
    expect(out.reject_kind).toBe('unverified_declined')
    expect(auditEvents().some((e) => e.event === 'review.unverified_decision' && e.reason === 'legacy_baseline' && e.answer === 'no')).toBe(true)
  })
})

describe('readHeadBirth — a branch with no commit is told apart positively', () => {
  const run = (answers: Record<string, Partial<GitExecResult>>): GitExecutor => (_root, args) => {
    const a = answers[args[0]!] ?? {}
    return { ok: a.ok ?? false, stdout: a.stdout ?? '', stderr: '', exitCode: a.exitCode ?? 128 }
  }
  it('reads each git answer', () => {
    expect(readHeadBirth('.', run({ 'symbolic-ref': { ok: true, exitCode: 0, stdout: 'refs/heads/main\n' }, 'show-ref': { exitCode: 1 } }))).toEqual({ status: 'unborn', branch: 'main' })
    expect(readHeadBirth('.', run({ 'symbolic-ref': { ok: true, exitCode: 0, stdout: 'refs/heads/main\n' }, 'show-ref': { ok: true, exitCode: 0 } }))).toEqual({ status: 'born' })
    expect(readHeadBirth('.', run({ 'symbolic-ref': { exitCode: 1 } }))).toEqual({ status: 'born' })
    expect(readHeadBirth('.', run({ 'symbolic-ref': { exitCode: 128 } })).status).toBe('unknown')
    expect(readHeadBirth('.', run({ 'symbolic-ref': { ok: true, exitCode: 0, stdout: 'refs/remotes/origin/main\n' } })).status).toBe('unknown')
    expect(readHeadBirth('.', run({ 'symbolic-ref': { ok: true, exitCode: 0, stdout: 'refs/heads/main\n' }, 'show-ref': { exitCode: 128 } })).status).toBe('unknown')
  })
  it('counts commits, or says it cannot', () => {
    expect(countRepositoryCommits('.', run({ 'rev-list': { ok: true, exitCode: 0, stdout: '12\n' } }))).toBe(12)
    expect(countRepositoryCommits('.', run({ 'rev-list': { exitCode: 128 } }))).toBeNull()
    expect(countRepositoryCommits('.', run({ 'rev-list': { ok: true, exitCode: 0, stdout: 'x\n' } }))).toBeNull()
  })
})
