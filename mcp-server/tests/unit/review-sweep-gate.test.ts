import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { phaseReviewCompleteHandler, type PhaseReviewCompleteOutput } from '../../src/tools/phase-review-complete.js'
import { requestCommitHandler, type RequestCommitOutput } from '../../src/tools/request-commit.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { commitAll, git, initSweepRepo } from '../sweep-repo.js'

let root: string
let tick = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-sweep-gate-'))
  initSweepRepo(root)
  write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, sql_dialect: 'postgresql' }))
  write('README.md', 'fixture\n')
  commitAll(root, 'init')
  git(root, 'checkout', '-q', '-b', 'feat/sweep')
})

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

function write(rel: string, content: string): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, rel), 'utf8')) as Record<string, unknown>
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
    reason: `sweep gate test approval number ${tick} for ${scope}`,
  }
}

interface Prompts {
  fn: (o: DialogOptions) => Promise<DialogResult>
  seen: DialogOptions[]
}

function prompts(...answers: Array<DialogResult['response']>): Prompts {
  const seen: DialogOptions[] = []
  return {
    seen,
    fn: async (o) => {
      seen.push(o)
      const response = answers[seen.length - 1] ?? 'yes'
      return { response, channel: response === 'no-channel' ? 'none' : 'windows' }
    },
  }
}

function openReview(): void {
  mkdirSync(join(root, '.rsct'), { recursive: true })
  const statePath = join(root, '.rsct', 'phase-state.json')
  const prev = existsSync(statePath) ? readJson('.rsct/phase-state.json') : {}
  writeFileSync(statePath, JSON.stringify({ ...prev, phase: 'review', spec_slug: 'feat-sweep' }))
}

async function completeReview(extra: Record<string, unknown> = {}, p: Prompts = prompts()): Promise<PhaseReviewCompleteOutput> {
  openReview()
  return phaseReviewCompleteHandler(
    { project_root: root, spec_ref: 'feat-sweep', dev_approval: approval('review_complete:spec_ref=feat-sweep'), ...extra },
    { promptFn: p.fn },
  )
}

async function commit(p: Prompts = prompts()): Promise<RequestCommitOutput> {
  return requestCommitHandler(
    { project_root: root, message: 'feat: sweep test', dev_approval: approval('commit:feat/sweep:sweep') },
    { promptFn: p.fn },
  )
}

describe('rsct_phase_review_complete — comment sweep', () => {
  it('rejects a touched file that still has a comment, before any dialog', async () => {
    write('src/a.ts', 'export const a = 1 // leftover\n')
    const p = prompts()
    const out = await completeReview({}, p)
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('comments_remaining')
    expect(p.seen).toHaveLength(0)
    expect(out.comment_sweep?.files[0]?.comments[0]?.body).toBe('leftover')
  })

  it('demands a disposition for every removed comment and returns them pending', async () => {
    write('src/a.ts', '// the retry budget is 3 because the upstream API throttles at 4\nexport const a = 1\n')
    commitAll(root, 'with comment')
    write('src/a.ts', 'export const a = 1\n')
    const p = prompts()
    const out = await completeReview({}, p)
    expect(out.reject_kind).toBe('dispositions_missing')
    expect(p.seen).toHaveLength(0)
    expect(out.pending_dispositions).toEqual([
      expect.objectContaining({ path: 'src/a.ts', head_line: 1, body: 'the retry budget is 3 because the upstream API throttles at 4' }),
    ])
  })

  it('a discarded comment forces the dialog, lists it, writes the report and stamps the ledger', async () => {
    write('src/a.ts', '// increments a\nexport const a = 1\n')
    commitAll(root, 'with comment')
    write('src/a.ts', 'export const a = 1\n')
    const pending = await completeReview()
    const id = pending.pending_dispositions![0]!.comment_id
    const p = prompts('no-channel')
    const trustConfig = { rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, approval_modes: { trust_allowed_for: ['rsct_phase_review_complete'] } }
    write('.rsct.json', JSON.stringify(trustConfig))
    const refused = await completeReview({ comment_dispositions: [{ comment_id: id, action: 'discarded' }] }, p)
    expect(refused.status).toBe('rejected')
    expect(refused.reject_kind).toBe('force_dialog_no_channel')

    const ok = prompts('yes')
    const out = await completeReview({ comment_dispositions: [{ comment_id: id, action: 'discarded' }] }, ok)
    expect(out.status).toBe('completed')
    expect(ok.seen).toHaveLength(1)
    expect(ok.seen[0]!.message).toContain('Comments removed: 1 (migrated 0, discarded 1)')
    expect(ok.seen[0]!.message).toContain('src/a.ts:1')
    expect(existsSync(join(root, out.comment_sweep!.report_path!))).toBe(true)
    const ledger = readJson('.rsct/phase-state.json').review_sweep as Record<string, Array<Record<string, unknown>>>
    expect(ledger['src/a.ts']![0]).toMatchObject({ verdict: 'clean', blob: git(root, 'hash-object', 'src/a.ts').trim() })
  })

  it('a migrated comment must appear in the lines added to the destination', async () => {
    const fact = 'the retry budget is 3 because the upstream API throttles at 4'
    write('docs/decisions.md', `# Decisions\n\n${fact}\n`)
    write('src/a.ts', `// ${fact}\nexport const a = 1\n`)
    commitAll(root, 'fact already in docs')
    write('src/a.ts', 'export const a = 1\n')
    const id = (await completeReview()).pending_dispositions![0]!.comment_id
    const stale = await completeReview({ comment_dispositions: [{ comment_id: id, action: 'migrated', destination: 'docs/decisions.md' }] })
    expect(stale.reject_kind).toBe('migration_missing')

    write('docs/decisions.md', `# Decisions\n\n${fact}\n\n## New\n\n${fact}\n`)
    const out = await completeReview({ comment_dispositions: [{ comment_id: id, action: 'migrated', destination: 'docs/decisions.md' }] })
    expect(out.status).toBe('completed')
    expect(out.comment_sweep?.migrated).toBe(1)
  })

  it('refuses a migration that is too short to verify, an unknown id and a duplicate', async () => {
    write('src/a.ts', '// short\nexport const a = 1\n')
    commitAll(root, 'with comment')
    write('src/a.ts', 'export const a = 1\n')
    const id = (await completeReview()).pending_dispositions![0]!.comment_id
    write('docs/decisions.md', 'short\n')
    expect((await completeReview({ comment_dispositions: [{ comment_id: id, action: 'migrated', destination: 'docs/decisions.md' }] })).reject_kind).toBe('migration_missing')
    expect((await completeReview({ comment_dispositions: [{ comment_id: 'nope', action: 'discarded' }] })).reject_kind).toBe('disposition_unknown')
    expect(
      (await completeReview({ comment_dispositions: [{ comment_id: id, action: 'discarded' }, { comment_id: id, action: 'discarded' }] })).reject_kind,
    ).toBe('disposition_duplicate')
    expect((await completeReview({ comment_dispositions: [{ comment_id: id, action: 'maybe' }] })).reject_kind).toBe('sweep_input_invalid')
  })

  it('a rename that strips comments, and a deleted file, still owe dispositions', async () => {
    write('src/a.ts', '// alpha note\nexport const a = 1\n')
    write('src/gone.ts', '// gone note\nexport const g = 1\n')
    commitAll(root, 'two files')
    git(root, 'mv', 'src/a.ts', 'src/b.ts')
    write('src/b.ts', 'export const a = 1\n')
    unlinkSync(join(root, 'src/gone.ts'))
    const out = await completeReview()
    expect(out.reject_kind).toBe('dispositions_missing')
    expect(out.pending_dispositions!.map((d) => d.path).sort()).toEqual(['src/a.ts', 'src/gone.ts'])
  })

  it('unverified files go to a developer-only dialog: no rejects, closed rejects, yes stamps', async () => {
    write('tool.go', 'package main // go comment\n')
    const no = await completeReview({}, prompts('no'))
    expect(no.reject_kind).toBe('unverified_declined')
    expect(auditEvents().some((e) => e.event === 'review.unverified_decision' && e.answer === 'no')).toBe(true)
    const closed = await completeReview({}, prompts('no-channel'))
    expect(closed.reject_kind).toBe('unverified_undecided')
    const yes = prompts('yes', 'yes')
    const out = await completeReview({}, yes)
    expect(out.status).toBe('completed')
    expect(yes.seen[0]!.message).toContain('tool.go — unsupported_language')
    const ledger = readJson('.rsct/phase-state.json').review_sweep as Record<string, Array<Record<string, unknown>>>
    expect(ledger['tool.go']![0]!.verdict).toBe('unverified_authorized')
    expect(auditEvents().some((e) => e.event === 'review.unverified_decision' && e.answer === 'yes' && e.path === 'tool.go')).toBe(true)
  })

  it('exempt_files send a generated file with comments to the unverified dialog', async () => {
    write('gen/client.ts', '// generated by a tool\nexport const c = 1\n')
    const out = await completeReview({ exempt_files: [{ path: 'gen/client.ts', reason: 'generated' }] }, prompts('yes', 'yes'))
    expect(out.status).toBe('completed')
    expect(out.comment_sweep?.unverified).toEqual(['gen/client.ts'])
  })

  it('does not stamp a file that changed while the dialog was open', async () => {
    write('src/a.ts', 'export const a = 1\n')
    const p: Prompts = {
      seen: [],
      fn: async (o) => {
        p.seen.push(o)
        write('src/a.ts', 'export const a = 2\n')
        return { response: 'yes', channel: 'windows' }
      },
    }
    const out = await completeReview({}, p)
    expect(out.status).toBe('completed')
    expect(out.comment_sweep?.changed_during_dialog).toEqual(['src/a.ts'])
    expect(readJson('.rsct/phase-state.json').review_sweep).toEqual({})
  })

  it('rejects outside a git repository', async () => {
    rmSync(join(root, '.git'), { recursive: true, force: true })
    const out = await completeReview()
    expect(out.reject_kind).toBe('not_git_repo')
  })
})

describe('rsct_request_commit — REVIEW gate', () => {
  it('refuses staged code no review covers, before any dialog', async () => {
    write('src/a.ts', 'export const a = 1\n')
    git(root, 'add', 'src/a.ts')
    const p = prompts()
    const out = await commit(p)
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('review_missing')
    expect(p.seen).toHaveLength(0)
  })

  it('commits code stamped by a completed review, and refuses it once edited', async () => {
    write('src/a.ts', 'export const a = 1\n')
    expect((await completeReview()).status).toBe('completed')
    git(root, 'add', 'src/a.ts')
    expect((await commit()).status).toBe('committed')

    write('src/a.ts', 'export const a = 2\n')
    git(root, 'add', 'src/a.ts')
    expect((await commit()).reject_kind).toBe('review_missing')
  })

  it('a hand-forged clean ledger does not let comments through', async () => {
    write('src/a.ts', 'export const a = 1 // sneaky\n')
    git(root, 'add', 'src/a.ts')
    const blob = git(root, 'rev-parse', ':0:src/a.ts').trim()
    for (const verdict of ['clean', 'unverified_authorized']) {
      mkdirSync(join(root, '.rsct'), { recursive: true })
      writeFileSync(
        join(root, '.rsct', 'phase-state.json'),
        JSON.stringify({ review_sweep: { 'src/a.ts': [{ blob, verdict, migrations: [], channel: 'windows', spec_ref: 'x', at: 'now' }] } }),
      )
      expect((await commit()).reject_kind).toBe('comments_present')
    }
  })

  it('an unverified file needs both the ledger entry and the audit decision for that blob', async () => {
    write('tool.go', 'package main // go\n')
    expect((await completeReview({}, prompts('yes', 'yes'))).status).toBe('completed')
    git(root, 'add', 'tool.go')
    const log = join(root, '.rsct', 'audit.log')
    const saved = readFileSync(log, 'utf8')
    writeFileSync(log, saved.split('\n').filter((l) => !l.includes('review.unverified_decision')).join('\n'))
    expect((await commit()).reject_kind).toBe('review_missing')
    writeFileSync(log, saved)
    expect((await commit()).status).toBe('committed')
  })

  it('refuses when a migrated fact was reverted from its destination', async () => {
    const fact = 'the retry budget is 3 because the upstream API throttles at 4'
    write('src/a.ts', `// ${fact}\nexport const a = 1\n`)
    commitAll(root, 'with fact')
    write('src/a.ts', 'export const a = 1\n')
    write('docs/decisions.md', `# Decisions\n\n${fact}\n`)
    const id = (await completeReview()).pending_dispositions![0]!.comment_id
    expect((await completeReview({ comment_dispositions: [{ comment_id: id, action: 'migrated', destination: 'docs/decisions.md' }] })).status).toBe('completed')
    rmSync(join(root, 'docs'), { recursive: true, force: true })
    git(root, 'add', 'src/a.ts')
    expect((await commit()).reject_kind).toBe('migration_reverted')
  })

  it('leaves commits with no code file alone', async () => {
    write('NOTES.md', 'plain docs\n')
    git(root, 'add', 'NOTES.md')
    expect((await commit()).status).toBe('committed')
  })

  it('checks a staged rename', async () => {
    const body = Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i}`).join('\n')
    write('src/a.ts', `${body}\n`)
    expect((await completeReview()).status).toBe('completed')
    commitAll(root, 'reviewed a')
    git(root, 'mv', 'src/a.ts', 'src/renamed.ts')
    write('src/renamed.ts', `${body} // moved\n`)
    git(root, 'add', 'src/renamed.ts')
    expect(git(root, 'diff', '--cached', '--name-status', '-M')).toMatch(/^R\d+\s+src\/a\.ts\s+src\/renamed\.ts/m)
    expect((await commit()).reject_kind).toBe('comments_present')
  })

  it('a pre-commit hook that adds a comment lands as drift and blocks the next commit', async () => {
    write('src/a.ts', 'export const a = 1\n')
    expect((await completeReview()).status).toBe('completed')
    git(root, 'add', 'src/a.ts')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    const hook = join(root, 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nprintf "export const a = 1 // hook\\n" > src/a.ts\ngit add src/a.ts\n')
    chmodSync(hook, 0o755)
    git(root, 'config', 'core.hooksPath', 'hooks')
    const out = await commit()
    expect(out.status).toBe('committed_with_drift')
    expect(auditEvents().some((e) => e.event === 'review.commit_drift')).toBe(true)
    git(root, 'config', 'core.hooksPath', '.no-hooks')
    write('NOTES.md', 'docs only\n')
    git(root, 'add', 'NOTES.md')
    expect((await commit()).reject_kind).toBe('review_drift')
  })

  it('a hook that only reformats keeps the commit covered and re-stamps the new blob', async () => {
    write('src/a.ts', 'export const a = 1\n')
    expect((await completeReview()).status).toBe('completed')
    git(root, 'add', 'src/a.ts')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    const hook = join(root, 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nprintf "export const a  =  1\\n" > src/a.ts\ngit add src/a.ts\n')
    chmodSync(hook, 0o755)
    git(root, 'config', 'core.hooksPath', 'hooks')
    expect((await commit()).status).toBe('committed')
    const committedBlob = git(root, 'rev-parse', 'HEAD:src/a.ts').trim()
    const ledger = readJson('.rsct/phase-state.json').review_sweep as Record<string, Array<Record<string, unknown>>>
    expect(ledger['src/a.ts']![0]).toMatchObject({ blob: committedBlob, channel: 'hook_rewrite' })
    expect(auditEvents().some((e) => e.event === 'review.commit_hook_rewrite')).toBe(true)
  })

  it('a review covering the drifted paths clears the drift', async () => {
    write('src/a.ts', 'export const a = 1\n')
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(join(root, '.rsct', 'phase-state.json'), JSON.stringify({ review_drift: { sha: 'x', paths: ['src/a.ts'], at: 'now' } }))
    expect((await completeReview()).status).toBe('completed')
    expect(readJson('.rsct/phase-state.json').review_drift).toBeUndefined()
    git(root, 'add', 'src/a.ts')
    expect((await commit()).status).toBe('committed')
  })
})

describe('rsct_request_commit — REVIEW gate on the dialog-free lane', () => {
  it('the free lane cannot carry unreviewed code', async () => {
    write('plan_p.md', '# Plan p\n\n- **Branch:** feat/sweep\n- **Status:** in-progress\n')
    mkdirSync(join(root, '.rsct', 'scripts'), { recursive: true })
    writeFileSync(join(root, '.rsct', 'audit.log'), `${JSON.stringify({ event: 'classify.verdict', tier: 'small' })}\n`)
    writeFileSync(
      join(root, '.rsct', 'phase-state.json'),
      JSON.stringify({ last_classify: { tier: 'small', tier_max: 'small', classified_at: new Date().toISOString() } }),
    )
    write('src/a.ts', 'export const a = 1\n')
    git(root, 'add', 'src/a.ts')
    const p = prompts()
    const out = await requestCommitHandler({ project_root: root, message: 'free checkpoint' }, { promptFn: p.fn })
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('review_missing')
    expect(out.authorized_via).toBeNull()
    expect(p.seen).toHaveLength(0)
    expect(auditEvents().some((e) => e.event === 'free_commit.committed')).toBe(false)
  })
})
