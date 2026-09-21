import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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

interface Prompts {
  fn: (o: DialogOptions) => Promise<DialogResult>
  seen: DialogOptions[]
}

function prompts(response: DialogResult['response'] = 'yes', onShow?: () => void): Prompts {
  const seen: DialogOptions[] = []
  return {
    seen,
    fn: async (o) => {
      seen.push(o)
      onShow?.()
      return { response, channel: response === 'no-channel' ? 'none' : 'windows' }
    },
  }
}

function openReview(): void {
  mkdirSync(join(root, '.rsct'), { recursive: true })
  const statePath = join(root, '.rsct', 'phase-state.json')
  const prev = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as object) : {}
  writeFileSync(statePath, JSON.stringify({ ...prev, phase: 'review', spec_slug: 'feat-dead' }))
}

async function completeReview(extra: Record<string, unknown> = {}, p: Prompts = prompts()): Promise<PhaseReviewCompleteOutput> {
  openReview()
  return phaseReviewCompleteHandler(
    { project_root: root, spec_ref: 'feat-dead', dev_approval: approval('review_complete:spec_ref=feat-dead'), ...extra },
    { promptFn: p.fn },
  )
}

async function commit(p: Prompts = prompts()): Promise<RequestCommitOutput> {
  return requestCommitHandler(
    { project_root: root, message: 'feat: dead code test', dev_approval: approval('commit:feat/dead:dead') },
    { promptFn: p.fn },
  )
}

function trustReviews(): void {
  write(
    '.rsct.json',
    JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, approval_modes: { trust_allowed_for: ['rsct_phase_review_complete'] } }),
  )
}

function installHook(body: string): void {
  mkdirSync(join(root, 'hooks'), { recursive: true })
  const hook = join(root, 'hooks', 'pre-commit')
  writeFileSync(hook, `#!/bin/sh\n${body}`)
  chmodSync(hook, 0o755)
  git(root, 'config', 'core.hooksPath', 'hooks')
}

function forgeLedgerFor(path: string): void {
  const statePath = join(root, '.rsct', 'phase-state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
  const blob = execFileSync('git', ['rev-parse', `:0:${path}`], { cwd: root, encoding: 'utf8' }).trim()
  state.review_sweep = stampLedger(
    state.review_sweep,
    [{ path, entry: sweepEntry(blob, 'clean', [], 'forged', 'feat-dead', new Date().toISOString()) }],
    null,
  )
  writeFileSync(statePath, JSON.stringify(state))
}

async function keepRotting(p: Prompts = prompts()): Promise<PhaseReviewCompleteOutput> {
  const first = await completeReview()
  const pending = first.pending_dead_code?.find((s) => s.name === 'rotting')
  if (!pending) throw new Error(`expected rotting to be pending, got ${JSON.stringify(first.reject_kind)}`)
  return completeReview(
    { dead_code_keeps: [{ path: pending.path, name: pending.name, declaration_sha256: pending.declaration_sha256, note: 'kept: guards the schema' }] },
    p,
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

describe('a keep is the developer decision, never the agent claim', () => {
  it('forces the developer dialog even when the REVIEW is trust-allowed', async () => {
    trustReviews()
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    const refused = await keepRotting(prompts('no-channel'))
    expect(refused.status).toBe('rejected')
    expect(refused.reject_kind).toBe('force_dialog_no_channel')
  })

  it('does not force a dialog on a trust-allowed REVIEW that keeps nothing', async () => {
    trustReviews()
    writeLivePair()
    const out = await completeReview({}, prompts('no-channel'))
    expect(out.status).toBe('completed')
    expect(out.channel).toBe('trust')
  })

  it('shows the kept symbol and the reason in the dialog', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    const p = prompts('yes')
    const out = await keepRotting(p)
    expect(out.status).toBe('completed')
    const shown = p.seen.map((o) => `${o.message}\n${o.detail ?? ''}`).join('\n')
    expect(shown).toContain('src/a.ts:rotting')
    expect(shown).toContain('kept: guards the schema')
  })

  it('writes the decision to the audit log', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    expect((await keepRotting()).status).toBe('completed')
    const kept = auditEvents().filter((e) => e.event === 'review.dead_code_kept')
    expect(kept.map((e) => [e.path, e.name])).toEqual([['src/a.ts', 'rotting']])
  })

  it('does not record a keep when the developer says no', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    const out = await keepRotting(prompts('no'))
    expect(out.status).toBe('rejected')
    expect(auditEvents().some((e) => e.event === 'review.dead_code_kept')).toBe(false)
    expect(readState().dead_code_keeps).toBeUndefined()
  })

  it('refuses the commit once the audit line behind a keep is gone, even with the keep still in phase-state', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    expect((await keepRotting()).status).toBe('completed')
    const auditPath = join(root, '.rsct', 'audit.log')
    const lines = readFileSync(auditPath, 'utf8').split('\n').filter((l) => l.length > 0 && !l.includes('review.dead_code_kept'))
    writeFileSync(auditPath, `${lines.join('\n')}\n`)
    expect(readState().dead_code_keeps).toBeDefined()
    git(root, 'add', '-A')
    const out = await commit()
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('dead_code_staged')
  })

  it('honours a recorded keep on the next REVIEW without asking again', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    expect((await keepRotting()).status).toBe('completed')
    write('src/b.ts', "import { used } from './a.js'\nexport const run = (): void => used()\nexport const again = (): void => used()\n")
    trustReviews()
    const out = await completeReview({}, prompts('no-channel'))
    expect(out.status).toBe('completed')
    expect(out.channel).toBe('trust')
  })

  it('lists what public_api exempted and forces the dialog for it', async () => {
    write(
      '.rsct.json',
      JSON.stringify({
        rsct_version: '1.0.0',
        app: { name: 'a', org: 'o' },
        public_api: ['src/a.ts'],
        approval_modes: { trust_allowed_for: ['rsct_phase_review_complete'] },
      }),
    )
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function exposed(): void {}\n')
    const refused = await completeReview({}, prompts('no-channel'))
    expect(refused.reject_kind).toBe('force_dialog_no_channel')
    const p = prompts('yes')
    const out = await completeReview({}, p)
    expect(out.status).toBe('completed')
    const shown = p.seen.map((o) => `${o.message}\n${o.detail ?? ''}`).join('\n')
    expect(shown).toContain('src/a.ts:exposed')
  })
})

describe('the commit gate re-checks at the last moment and after a hook', () => {
  it('catches a dead symbol staged while the approval dialog was open', async () => {
    writeLivePair()
    expect((await completeReview()).status).toBe('completed')
    git(root, 'add', '-A')
    const p = prompts('yes', () => {
      write('src/a.ts', 'export function used(): void {}\nexport function lateDead(): void {}\n')
      git(root, 'add', 'src/a.ts')
      forgeLedgerFor('src/a.ts')
    })
    const out = await commit(p)
    expect(p.seen.length).toBeGreaterThan(0)
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('dead_code_staged')
    const rejection = auditEvents()
      .filter((e) => e.reject_kind === 'dead_code_staged')
      .at(-1)
    expect(rejection?.stage).toBe('before_commit')
  })

  it('lands a pre-commit hook that adds a dead symbol as drift, and blocks the next commit', async () => {
    writeLivePair()
    expect((await completeReview()).status).toBe('completed')
    git(root, 'add', '-A')
    installHook(
      'printf "export function used(): void {}\\nexport function hookDead(): void {}\\n" > src/a.ts\ngit add src/a.ts\n',
    )
    const out = await commit()
    expect(out.status).toBe('committed_with_drift')
    const drift = readState().review_drift as { paths: string[] } | undefined
    expect(drift?.paths).toContain('src/a.ts')
  })

  it('does not claim a deleted file in another language went unchecked', async () => {
    write('tool.py', 'def run():\n    return 1\n')
    commitAll(root, 'python tool')
    unlinkSync(join(root, 'tool.py'))
    const out = await completeReview()
    expect(out.status).toBe('completed')
    expect(out.hints.join(' ')).not.toContain('tool.py')
  })

  it('says a touched file in another language was not checked', async () => {
    write('tool.py', 'def run():\n    return 1\n')
    const out = await completeReview()
    expect(out.status).toBe('completed')
    expect(out.hints.join(' ')).toContain('not checked in tool.py')
  })
})
