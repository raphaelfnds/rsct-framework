import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { stampLedger, sweepEntry } from '../../src/lib/comment-sweep/review.js'
import { setDeadCodeAnalysisHookForTests } from '../../src/lib/dead-code/review-gate.js'

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
  'src/main.ts': "import { run } from './b.js'\nrun()\n",
}

function writeLivePair(): void {
  for (const [path, body] of Object.entries(LIVE_PAIR)) write(path, body)
}

describe('rsct_phase_review_complete — dead code, through the tool', () => {
  it('rejects a touched file carrying a dead symbol, before any dialog', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    const p = prompts()
    const out = await completeReview({}, p)
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('dead_code_remaining')
    expect(out.pending_dead_code?.map((s) => s.name)).toEqual(['rotting'])
    expect(p.seen).toHaveLength(0)
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
    write('src/b.ts', "import { used } from './a.js'\nexport const run = (): void => {\n  used()\n  used()\n}\n")
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
    git(root, 'config', 'core.hooksPath', '.no-hooks')
    write('README.md', 'fixture changed\n')
    git(root, 'add', 'README.md')
    const next = await commit()
    expect(next.status).toBe('rejected')
    expect(next.reject_kind).toBe('review_drift')
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

  it('passes the dead-code hints through to a successful commit', async () => {
    writeLivePair()
    write('tool.py', 'def run():\n    return 1\n')
    expect((await completeReview()).status).toBe('completed')
    git(root, 'add', '-A')
    const out = await commit()
    expect(out.status).toBe('committed')
    expect(out.hints.some((h) => h.startsWith('Dead-code scan: not checked'))).toBe(true)
  })
})

describe('the wiring of keeps through the REVIEW', () => {
  it('names dead code as the reason a keep-only REVIEW forces the dialog', async () => {
    trustReviews()
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    const out = await keepRotting(prompts('no-channel'))
    expect(out.reject_kind).toBe('force_dialog_no_channel')
    expect(out.reason).toContain('dead code')
  })

  it('does not honour a keep stored in phase-state without its audit line', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    const first = await completeReview()
    const pending = first.pending_dead_code?.[0]
    if (!pending) throw new Error('expected a pending symbol')
    const statePath = join(root, '.rsct', 'phase-state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
    state.dead_code_keeps = [{ path: pending.path, name: pending.name, declaration_sha256: pending.declaration_sha256, note: 'forged', spec_ref: 'x', at: new Date().toISOString() }]
    writeFileSync(statePath, JSON.stringify(state))
    const out = await completeReview()
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('dead_code_remaining')
  })

  it('does not ask again for a keep it already recorded', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    const first = await completeReview()
    const pending = first.pending_dead_code?.[0]
    if (!pending) throw new Error('expected a pending symbol')
    const keeps = [{ path: pending.path, name: pending.name, declaration_sha256: pending.declaration_sha256, note: 'kept' }]
    expect((await completeReview({ dead_code_keeps: keeps })).status).toBe('completed')
    trustReviews()
    const again = await completeReview({ dead_code_keeps: keeps }, prompts('no-channel'))
    expect(again.status).toBe('completed')
    expect(again.channel).toBe('trust')
  })

  it('prunes a keep whose file left the repository, and drops the empty list', async () => {
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function rotting(): void {}\n')
    expect((await keepRotting()).status).toBe('completed')
    git(root, 'add', '-A')
    expect((await commit()).status).toBe('committed')
    rmSync(join(root, 'src', 'a.ts'))
    write('src/b.ts', 'export const run = (): void => undefined\n')
    expect((await completeReview()).status).toBe('completed')
    git(root, 'add', '-A')
    expect((await commit()).status).toBe('committed')
    expect(readState().dead_code_keeps).toBeDefined()
    expect((await completeReview()).status).toBe('completed')
    expect(readState().dead_code_keeps).toBeUndefined()
  })

  it('keeps a keep granted on a file not yet added to git', async () => {
    writeLivePair()
    write('src/new.ts', "export function keptHelper(): void {}\nexport {}\n")
    write('src/main.ts', "import { run } from './b.js'\nimport './new.js'\nrun()\n")
    const first = await completeReview()
    const pending = first.pending_dead_code?.find((s) => s.name === 'keptHelper')
    if (!pending) throw new Error(`expected keptHelper pending, got ${JSON.stringify(first.reject_kind)}`)
    const keeps = [{ path: pending.path, name: pending.name, declaration_sha256: pending.declaration_sha256, note: 'next caller lands soon' }]
    expect((await completeReview({ dead_code_keeps: keeps })).status).toBe('completed')
    expect((await completeReview()).status).toBe('completed')
    expect((readState().dead_code_keeps as unknown[] | undefined)?.length).toBe(1)
    git(root, 'add', '-A')
    expect((await commit()).status).toBe('committed')
  })

  it('writes every kept symbol to the report the dialog points to, beyond the ten it lists', async () => {
    writeLivePair()
    const names = Array.from({ length: 12 }, (_, i) => `rotting${i}`)
    write('src/a.ts', `export function used(): void {}\n${names.map((n) => `export function ${n}(): void {}\n`).join('')}`)
    const first = await completeReview()
    const keeps = (first.pending_dead_code ?? []).map((s) => ({ path: s.path, name: s.name, declaration_sha256: s.declaration_sha256, note: 'kept' }))
    expect(keeps).toHaveLength(12)
    const p = prompts('yes')
    const out = await completeReview({ dead_code_keeps: keeps }, p)
    expect(out.status).toBe('completed')
    const reportPath = out.comment_sweep?.report_path
    if (!reportPath) throw new Error('expected a report')
    const shown = p.seen.map((o) => `${o.message}\n${o.detail ?? ''}`).join('\n')
    expect(shown).toContain(reportPath)
    const report = readFileSync(join(root, reportPath), 'utf8')
    for (const name of names) expect(report).toContain(`src/a.ts:${name}`)
  })
})

describe('a public_api the developer approved is not asked again', () => {
  function configWith(publicApi: string[]): void {
    write(
      '.rsct.json',
      JSON.stringify({
        rsct_version: '1.0.0',
        app: { name: 'a', org: 'o' },
        public_api: publicApi,
        approval_modes: { trust_allowed_for: ['rsct_phase_review_complete'] },
      }),
    )
  }

  it('asks once, then lets a trusted REVIEW pass, and asks again once the list changes', async () => {
    configWith(['src/a.ts'])
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function exposed(): void {}\n')
    expect((await completeReview({}, prompts('yes'))).status).toBe('completed')
    const again = await completeReview({}, prompts('no-channel'))
    expect(again.status).toBe('completed')
    expect(again.channel).toBe('trust')
    configWith(['src/a.ts', 'src/b.ts'])
    const changed = await completeReview({}, prompts('no-channel'))
    expect(changed.reject_kind).toBe('force_dialog_no_channel')
  })

  it('asks again for an export that joins the list, and for one whose declaration changes', async () => {
    configWith(['src/a.ts'])
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function exposed(): void {}\n')
    expect((await completeReview({}, prompts('yes'))).status).toBe('completed')
    write('src/a.ts', 'export function used(): void {}\nexport function exposed(): void {}\nexport function exposedTwo(): void {}\n')
    const added = await completeReview({}, prompts('no-channel'))
    expect(added.reject_kind).toBe('force_dialog_no_channel')
    expect((await completeReview({}, prompts('yes'))).status).toBe('completed')
    write('src/a.ts', 'export function used(): void {}\nexport function exposed(): number { return 1 }\nexport function exposedTwo(): void {}\n')
    const rewritten = await completeReview({}, prompts('no-channel'))
    expect(rewritten.reject_kind).toBe('force_dialog_no_channel')
  })

  it('records one approval line per export, naming the list it was given for', async () => {
    configWith(['src/a.ts'])
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function exposed(): void {}\n')
    expect((await completeReview({}, prompts('yes'))).status).toBe('completed')
    const approvals = auditEvents().filter((e) => e.event === 'review.public_api_approved')
    expect(approvals.map((e) => e.name)).toEqual(['exposed'])
    expect(approvals[0]?.public_api).toEqual(['src/a.ts'])
    expect(approvals[0]?.public_api_sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('a vendored file the developer exempts is not judged for dead code', () => {
  it('completes the REVIEW and commits it', async () => {
    writeLivePair()
    write('vendor/lib.js', 'export function unusedVendored() {}\n')
    write('src/main.ts', "import { run } from './b.js'\nimport '../vendor/lib.js'\nrun()\n")
    const out = await completeReview({ exempt_files: [{ path: 'vendor/lib.js', reason: 'vendored' }] })
    expect(out.status).toBe('completed')
    git(root, 'add', '-A')
    expect((await commit()).status).toBe('committed')
  })
})

describe('what the tools hand back about dead code', () => {
  const ROTTING = 'export function used(): void {}\nexport function rotting(): void {}\n'

  async function stagedDeadAfterForgedLedger(): Promise<RequestCommitOutput> {
    writeLivePair()
    expect((await completeReview()).status).toBe('completed')
    write('src/a.ts', ROTTING)
    git(root, 'add', '-A')
    forgeLedgerFor('src/a.ts')
    return commit()
  }

  it('hands the removal instruction back with a dead-code rejection', async () => {
    writeLivePair()
    write('src/a.ts', ROTTING)
    expect((await completeReview()).hints.some((h) => h.startsWith('Remove each one'))).toBe(true)
  })

  it('writes every export public_api exempted into the report', async () => {
    write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, public_api: ['src/a.ts'] }))
    writeLivePair()
    write('src/a.ts', 'export function used(): void {}\nexport function exposed(): void {}\n')
    const reportPath = (await completeReview()).comment_sweep?.report_path ?? ''
    expect(readFileSync(join(root, reportPath), 'utf8')).toContain('src/a.ts:exposed')
  })

  it('writes no file sections into a report forced only by a keep', async () => {
    writeLivePair()
    write('src/a.ts', ROTTING)
    const reportPath = (await keepRotting()).comment_sweep?.report_path ?? ''
    expect(readFileSync(join(root, reportPath), 'utf8')).not.toMatch(/^## src\//m)
  })

  it('records the developer reason in the keep audit line', async () => {
    writeLivePair()
    write('src/a.ts', ROTTING)
    await keepRotting()
    expect(auditEvents().find((e) => e.event === 'review.dead_code_kept')?.note).toBe('kept: guards the schema')
  })

  it('refuses a keep with an empty reason', async () => {
    writeLivePair()
    write('src/a.ts', ROTTING)
    const pending = (await completeReview()).pending_dead_code?.[0]
    const out = await completeReview({
      dead_code_keeps: [{ path: pending?.path, name: pending?.name, declaration_sha256: pending?.declaration_sha256, note: '' }],
    })
    expect(out.reject_kind).toBe('sweep_input_invalid')
  })

  it('refuses a keep whose sha is not a sha256', async () => {
    writeLivePair()
    write('src/a.ts', ROTTING)
    const out = await completeReview({ dead_code_keeps: [{ path: 'src/a.ts', name: 'rotting', declaration_sha256: 'abc', note: 'n' }] })
    expect(out.reject_kind).toBe('sweep_input_invalid')
  })

  it('counts the dead symbols in the rejection audit line', async () => {
    writeLivePair()
    write('src/a.ts', ROTTING)
    await completeReview()
    expect(auditEvents().filter((e) => e.reject_kind === 'dead_code_remaining').at(-1)?.dead_symbols).toBe(1)
  })

  it('hands the REVIEW instruction back with a staged rejection', async () => {
    const out = await stagedDeadAfterForgedLedger()
    expect(out.hints.some((h) => h.includes('rsct_phase_review_start'))).toBe(true)
  })

  it('names the refused paths in the rejection audit line', async () => {
    await stagedDeadAfterForgedLedger()
    expect(auditEvents().filter((e) => e.reject_kind === 'dead_code_staged').at(-1)?.paths).toEqual(['src/a.ts'])
  })

  it('does not judge a hook rewrite of a file the developer exempted', async () => {
    writeLivePair()
    write('vendor/lib.js', 'export function unusedVendored() {}\n')
    write('src/main.ts', "import { run } from './b.js'\nimport '../vendor/lib.js'\nrun()\n")
    expect((await completeReview({ exempt_files: [{ path: 'vendor/lib.js', reason: 'vendored' }] })).status).toBe('completed')
    git(root, 'add', '-A')
    installHook('printf "export function unusedVendored() {}\\n\\n" > vendor/lib.js\ngit add vendor/lib.js\n')
    expect((await commit()).status).toBe('committed')
  })
})

describe('the commit fails closed when the check after the commit cannot run', () => {
  afterEach(() => setDeadCodeAnalysisHookForTests(null))

  it('records the drift, spends the approval and writes the audit line', async () => {
    writeLivePair()
    expect((await completeReview()).status).toBe('completed')
    git(root, 'add', '-A')
    installHook("printf \"export function used(): void {}\\n\\n\" > src/a.ts\ngit add src/a.ts\n")
    let calls = 0
    setDeadCodeAnalysisHookForTests(() => {
      calls += 1
      if (calls >= 2) throw new RangeError('boom after the commit')
    })
    const out = await commit()
    expect(calls).toBe(2)
    expect(out.status).toBe('committed_with_drift')
    expect(out.anti_replay_persisted).toBe(true)
    expect((readState().review_drift as { paths: string[] } | undefined)?.paths).toContain('src/a.ts')
    expect(auditEvents().some((e) => e.event === 'request_commit.committed')).toBe(true)
  })
})
