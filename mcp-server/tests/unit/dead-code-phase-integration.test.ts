import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { stampLedger, sweepEntry } from '../../src/lib/comment-sweep/review.js'

import { phaseReviewCompleteHandler, type PhaseReviewCompleteOutput } from '../../src/tools/phase-review-complete.js'
import { requestCommitHandler, type RequestCommitOutput } from '../../src/tools/request-commit.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { commitAll, git, initSweepRepo } from '../sweep-repo.js'

let root: string
let tick = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-dc-integ-'))
  initSweepRepo(root)
  write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
  write('README.md', 'fixture\n')
  commitAll(root, 'init')
  git(root, 'checkout', '-q', '-b', 'feat/dead')
})

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

function write(rel: string, content: string): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.rsct', 'phase-state.json'), 'utf8')) as Record<string, unknown>
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
    reason: `dead code integration approval ${tick} for ${scope}`,
  }
}

function prompts(): { fn: (o: DialogOptions) => Promise<DialogResult>; seen: DialogOptions[] } {
  const seen: DialogOptions[] = []
  return {
    seen,
    fn: async (o) => {
      seen.push(o)
      return { response: 'yes', channel: 'windows' }
    },
  }
}

function openReview(): void {
  mkdirSync(join(root, '.rsct'), { recursive: true })
  const statePath = join(root, '.rsct', 'phase-state.json')
  const prev = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as object) : {}
  writeFileSync(statePath, JSON.stringify({ ...prev, phase: 'review', spec_slug: 'feat-dead' }))
}

async function completeReview(extra: Record<string, unknown> = {}): Promise<PhaseReviewCompleteOutput> {
  openReview()
  const p = prompts()
  return phaseReviewCompleteHandler(
    { project_root: root, spec_ref: 'feat-dead', dev_approval: approval('review_complete:spec_ref=feat-dead'), ...extra },
    { promptFn: p.fn },
  )
}

async function commit(): Promise<RequestCommitOutput> {
  const p = prompts()
  return requestCommitHandler(
    { project_root: root, message: 'feat: dead code test', dev_approval: approval('commit:feat/dead:dead') },
    { promptFn: p.fn },
  )
}

const LIVE_PAIR = {
  'src/a.ts': 'export function used(): void {}\n',
  'src/b.ts': "import { used } from './a.js'\nexport const run = (): void => used()\n",
}

function writeLivePair(): void {
  for (const [path, body] of Object.entries(LIVE_PAIR)) write(path, body)
}

describe('rsct_phase_review_complete — dead code, through the tool', () => {
  it('rejects a touched file carrying a dead symbol, before any dialog', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    const out = await completeReview()
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('dead_code_remaining')
    expect(out.pending_dead_code?.map((p) => p.name)).toEqual(['rotting'])
  })

  it('completes once the symbol is gone', async () => {
    writeLivePair()
    const out = await completeReview()
    expect(out.status).toBe('completed')
  })

  it('completes when the developer keeps it, and records the keep in phase-state', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    const first = await completeReview()
    const pending = first.pending_dead_code?.[0]
    expect(pending).toBeDefined()

    const out = await completeReview({
      dead_code_keeps: [
        {
          path: pending!.path,
          name: pending!.name,
          declaration_sha256: pending!.declaration_sha256,
          note: 'kept: it fails the build when the schema drifts',
        },
      ],
    })
    expect(out.status).toBe('completed')
    const keeps = readState().dead_code_keeps as Array<Record<string, unknown>>
    expect(keeps).toHaveLength(1)
    expect(keeps[0]?.name).toBe('rotting')
    expect(keeps[0]?.spec_ref).toBe('feat-dead')
  })

  it('refuses a malformed keep rather than throwing', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    const out = await completeReview({ dead_code_keeps: [{ path: 'src/a.ts', name: 'rotting' }] })
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('sweep_input_invalid')
  })
})

describe('rsct_request_commit — dead code, through the tool', () => {
  it('re-derives the verdict instead of trusting the ledger, so a forged stamp does not pass', async () => {
    writeLivePair()
    const reviewed = await completeReview()
    expect(reviewed.status).toBe('completed')

    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    git(root, 'add', '-A')

    const statePath = join(root, '.rsct', 'phase-state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
    const blob = execFileSync('git', ['rev-parse', ':0:src/a.ts'], { cwd: root, encoding: 'utf8' }).trim()
    state.review_sweep = stampLedger(
      state.review_sweep,
      [{ path: 'src/a.ts', entry: sweepEntry(blob, 'clean', [], 'forged', 'feat-dead', new Date().toISOString()) }],
      null,
    )
    writeFileSync(statePath, JSON.stringify(state))

    const out = await commit()
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('dead_code_staged')
    expect(out.reason).toContain('src/a.ts:rotting')
  })

  it('refuses BEFORE authorization, so a rejected commit never spends an approval', async () => {
    writeLivePair()
    const reviewed = await completeReview()
    expect(reviewed.status).toBe('completed')

    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    git(root, 'add', '-A')
    const statePath = join(root, '.rsct', 'phase-state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
    const blob = execFileSync('git', ['rev-parse', ':0:src/a.ts'], { cwd: root, encoding: 'utf8' }).trim()
    state.review_sweep = stampLedger(
      state.review_sweep,
      [{ path: 'src/a.ts', entry: sweepEntry(blob, 'clean', [], 'forged', 'feat-dead', new Date().toISOString()) }],
      null,
    )
    writeFileSync(statePath, JSON.stringify(state))

    const out = await commit()
    expect(out.reject_kind).toBe('dead_code_staged')
    const rejection = auditEvents()
      .filter((e) => e.reject_kind === 'dead_code_staged')
      .at(-1)
    expect(rejection?.stage).toBe('before_authorization')
  })

  it('commits what a REVIEW cleared', async () => {
    writeLivePair()
    const reviewed = await completeReview()
    expect(reviewed.status).toBe('completed')
    git(root, 'add', '-A')
    const out = await commit()
    expect(out.status).toBe('committed')
  })

  it('commits a symbol the REVIEW recorded the developer keeping', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    const first = await completeReview()
    const pending = first.pending_dead_code?.[0]
    const reviewed = await completeReview({
      dead_code_keeps: [
        {
          path: pending!.path,
          name: pending!.name,
          declaration_sha256: pending!.declaration_sha256,
          note: 'kept on purpose for the next caller',
        },
      ],
    })
    expect(reviewed.status).toBe('completed')
    git(root, 'add', '-A')
    const out = await commit()
    expect(out.status).toBe('committed')
  })
})
