import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  phaseAbandonHandler,
  type PhaseAbandonOutput,
} from '../../src/tools/phase-abandon.js'
import { checkEditScopeHandler } from '../../src/tools/check-edit-scope.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-pa-'))
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({
      rsct_version: '1.0.0',
      app: { name: 'test', org: 'test' },
    }),
    'utf8',
  )
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const FIXED_NOW = new Date('2026-06-07T18:00:00.000Z')
const VALID_TS = '2026-06-07T17:59:45.000Z'

function approval(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: VALID_TS,
    action_scope: 'phase_abandon:spec_ref=feat-foo',
    reason: 'pivoting away from this approach after research',
    ...overrides,
  }
}

function alwaysYes(): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}

function dialog(r: DialogResult) {
  return async () => r
}

function writePhaseState(state: Record<string, unknown>): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(
    join(tmpRoot, '.rsct/phase-state.json'),
    JSON.stringify(state),
    'utf8',
  )
}

describe('rsct_phase_abandon — no active phase', () => {
  it('returns no_active_phase when phase-state.json absent', async () => {
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'task was cancelled by stakeholder',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('no_active_phase')
    expect(r.abandoned_phase).toBeNull()
  })

  it('returns no_active_phase when phase-state present but no phase field', async () => {
    writePhaseState({ spec_slug: 'something' })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'task was cancelled by stakeholder',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('no_active_phase')
  })
})

describe('rsct_phase_abandon — §C-gated path', () => {
  it('rejects with dialog_no when dev declines', async () => {
    writePhaseState({ phase: 'research', spec_slug: 'feat-foo' })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'changed approach to a refactor instead',
        dev_approval: approval(),
      },
      {
        now: FIXED_NOW,
        promptFn: dialog({ response: 'no', channel: 'windows' }),
      },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('rejected')
    expect(r.reject_kind).toBe('dialog_no')
    // Phase still present
    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBe('research')
  })

  it('clears the active phase + spec_slug on approved abandon', async () => {
    writePhaseState({
      phase: 'spec',
      spec_slug: 'feat-aborted',
      started_at: '2026-06-07T15:00:00.000Z',
    })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'requirements changed before code phase started',
        dev_approval: approval({
          action_scope: 'phase_abandon:spec_ref=feat-aborted',
        }),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('abandoned')
    expect(r.abandoned_phase).toBe('spec')
    expect(r.abandoned_spec_slug).toBe('feat-aborted')

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBeUndefined()
    expect(state.spec_slug).toBeUndefined()
    expect(state.started_at).toBeUndefined()
  })

  it('clears the verification block when abandoning verification phase', async () => {
    writePhaseState({
      phase: 'verification',
      spec_slug: 'feat-v',
      verification: {
        spec_ref: 'feat-v',
        spec_tier: 'standard',
        findings: [{ id: 'v-1' }],
        started_at: '2026-06-07T16:00:00.000Z',
      },
    })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'verification revealed blocker, restarting spec',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('abandoned')
    expect(r.abandoned_verification_block_present).toBe(true)
    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.verification).toBeUndefined()
  })

  it('emits phase_abandon.complete audit with the reason', async () => {
    writePhaseState({ phase: 'code', spec_slug: 'feat-x' })
    await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'spec was wrong, restarting from research',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )
    const lines = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const completed = lines.find((l) => l.event === 'phase_abandon.complete')
    expect(completed).toBeDefined()
    expect(completed.abandoned_phase).toBe('code')
    expect(completed.reason).toBe('spec was wrong, restarting from research')
  })
})

// #53: `phase-abandon.ts` used to write `const newState: PhaseState = {}` — a full
// replace, and the ONLY non-read-modify-write writer in the tree. It now writes an
// ALLOWLIST copy (PHASE_STATE_PRESERVED_ON_ABANDON). The tests below pin the rule in
// both directions, because a preserve-list that only ever gains keys is how a live
// batch token would survive an abandon with the suite still green.
//
// Every one of them asserts `status === 'abandoned'` AND a control clear first: a
// rejected gate returns at phase-abandon.ts:155-186 WITHOUT writing, so a fixture that
// silently fails the §C gate makes every "this key survived" assertion pass for the
// wrong reason — including under its own mutation.
describe('rsct_phase_abandon — the preserve-list (#53)', () => {
  const STAMP = '2026-06-07T14:00:00.000Z'

  /** The phase_abandon.complete entry from the audit log. */
  const completeAudit = (): Record<string, unknown> =>
    readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === 'phase_abandon.complete')!

  it('preserves bootstrap_at — the §0 session marker, not state of the work', async () => {
    // Mutation: remove 'bootstrap_at' from PHASE_STATE_PRESERVED_ON_ABANDON.
    writePhaseState({
      phase: 'code',
      spec_slug: 'feat-x',
      bootstrap_at: STAMP,
    })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'pivoting after the research phase',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('abandoned')

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBeUndefined() // control: the write really happened
    // toBe, not toBeDefined: nothing in phase-abandon re-stamps, so the exact
    // value is free to assert and it guards a future writer that does.
    expect(state.bootstrap_at).toBe(STAMP)

    // The audit says what survived. Mutation: compute preserved_keys from the
    // constant instead of from the state actually written, or drop the field.
    expect(completeAudit().preserved_keys).toEqual(['bootstrap_at'])
  })

  it('clears every key that describes the abandoned work', async () => {
    // Mutation: add any of these to PHASE_STATE_PRESERVED_ON_ABANDON.
    // Four of them (plan_authorization, free_commit_budget, review, disposition)
    // are documented "wiped by phase_abandon" in lib/phase-scope; the rest had no
    // assertion at all before #53 — 4 of 13 keys were covered.
    writePhaseState({
      phase: 'code',
      spec_slug: 'feat-x',
      scope_globs: ['src/**'],
      started_at: '2026-06-07T15:00:00.000Z',
      plan_authorization: {
        plan_slug: 'feat-x',
        branch: 'feat/x',
        covers: ['commit'],
        authorized_at: '2026-06-07T16:00:00.000Z',
        expires_at: '2026-06-07T20:00:00.000Z',
        max_actions: 5,
        actions_used: 1,
        approval_ref: { action_scope: 'plan_authorize:feat-x', timestamp: VALID_TS },
      },
      free_commit_budget: {
        plan_slug: 'feat-x',
        files_touched_paths: ['src/a.ts'],
        commits_used: 2,
        lines_changed: 40,
        locked: false,
      },
      last_classify: {
        tier: 'standard',
        tier_max: 'standard',
        classified_at: '2026-06-07T15:30:00.000Z',
      },
      disposition: {
        plan_slug: 'feat-x',
        decision: 'keep',
        decided_at: '2026-06-07T15:40:00.000Z',
      },
      review: { spec_ref: 'feat-x', decision: 'yes' },
      review_findings: {
        spec_ref: 'feat-x',
        run_id: 'r-1',
        findings: [{ id: 'f-1' }],
        declared_at: '2026-06-07T15:50:00.000Z',
      },
    })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'spec was wrong, restarting from research',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('abandoned')

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    for (const key of [
      'phase',
      'spec_slug',
      'scope_globs',
      'started_at',
      'plan_authorization',
      'free_commit_budget',
      'last_classify',
      'disposition',
      'review',
      'review_findings',
    ]) {
      expect(state[key], `${key} must not survive an abandon`).toBeUndefined()
    }
    expect(completeAudit().preserved_keys).toEqual([])
  })

  it('drops a key the preserve-list does not name — allowlist, never wipe-list', async () => {
    // Mutation: rewrite preserveAcrossAbandon as `{...state}` minus a wipe-list.
    // Then a PhaseState key added later leaks through by default, which is exactly
    // how a forgotten `plan_authorization` would keep a live §C token alive.
    writePhaseState({
      phase: 'code',
      spec_slug: 'feat-x',
      future_key_not_yet_invented: { some: 'value' },
    })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'abandoning to test the allowlist shape',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('abandoned')

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBeUndefined()
    expect(state.future_key_not_yet_invented).toBeUndefined()
    // Nothing was preserved here, so the hint must not say anything was.
    // Mutation: make the "session markers preserved" clause unconditional — it
    // then asserts preservation on the common case, a phase abandoned with no
    // bootstrap marker and no re-bootstrap flag.
    expect(r.hints.some((h) => h.includes('session markers preserved'))).toBe(false)
  })

  it('no longer claims "State cleared" when a session marker survived', async () => {
    // Mutation: restore the old sentence. The hint is what the agent reads back.
    writePhaseState({ phase: 'code', spec_slug: 'feat-x', bootstrap_at: STAMP })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'checking the hint text after an abandon',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('abandoned')
    // Asserts what the hint RENDERS (preservedKeys), not the absence of the old
    // sentence: a negative on deleted wording goes red the day someone writes
    // "State cleared." in a correct implementation, and stays green under any
    // reworded-but-broken one. Restoring the old hint drops this clause, so this
    // positive assertion catches it anyway.
    expect(
      r.hints.some((h) => h.includes('session markers preserved (bootstrap_at)')),
    ).toBe(true)
  })
})

// #53: the bypass this fix exists to close, pinned end-to-end.
//
// Note the fixture shape. `context_stale` is armed by completePhaseGeneric, whose
// SAME write deletes `phase` (lib/phase-machine.ts) — and phaseAbandonHandler
// early-returns `no_active_phase` without writing when `phase` is absent. Seeded with
// context_stale alone, the abandon is a no-op, the flag survives trivially, and this
// test would pass with or without the preserve-list. The flag only reaches a wipe
// after a phase_*_start re-arms `phase` while carrying it forward, which is what
// `{phase, spec_slug, context_stale}` reproduces.
describe('rsct_phase_abandon — the context_stale bypass is closed (#53)', () => {
  it('leaves a blocked agent still blocked: abandon is not a re-load', async () => {
    // Mutation: remove 'context_stale' from PHASE_STATE_PRESERVED_ON_ABANDON.
    // The post-abandon state then has no scope_globs either, so check_edit_scope
    // falls to 'unknown' (check-edit-scope.ts:139-140) and the edit is let through.
    writePhaseState({
      phase: 'code',
      spec_slug: 'feat-x',
      scope_globs: ['src/**'],
      context_stale: { since: '2026-06-07T12:00:00.000Z', reason: 'plan_closed' },
    })
    const r = (await phaseAbandonHandler(
      {
        project_root: tmpRoot,
        reason: 'abandoning the phase while a re-bootstrap is owed',
        dev_approval: approval(),
      },
      { now: FIXED_NOW, promptFn: alwaysYes() },
    )) as PhaseAbandonOutput
    expect(r.status).toBe('abandoned')

    const state = JSON.parse(
      readFileSync(join(tmpRoot, '.rsct/phase-state.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(state.phase).toBeUndefined() // control: the write really happened
    expect(state.context_stale).toBeDefined()

    // Read from DISK — no phase_state_override, or this would prove nothing about
    // what the abandon actually wrote.
    const scope = await checkEditScopeHandler({
      project_root: tmpRoot,
      file_path: join(tmpRoot, 'src', 'a.ts'),
    })
    expect(scope.status).toBe('stale_context')
    expect(r.hints.some((h) => h.includes('PRESERVED across this abandon'))).toBe(true)
  })
})

describe('rsct_phase_abandon — input validation', () => {
  it('rejects reason < 10 chars', async () => {
    await expect(
      phaseAbandonHandler({
        project_root: tmpRoot,
        reason: 'short',
        dev_approval: approval(),
      }),
    ).rejects.toThrow()
  })

  it('rejects missing reason', async () => {
    await expect(
      phaseAbandonHandler({
        project_root: tmpRoot,
        dev_approval: approval(),
      }),
    ).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      phaseAbandonHandler({
        project_root: tmpRoot,
        reason: 'a long enough reason here',
        dev_approval: approval(),
        bogus: 'x',
      }),
    ).rejects.toThrow()
  })
})
