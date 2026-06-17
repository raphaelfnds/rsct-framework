import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DevApprovalSchema,
  validateDevApproval,
  recordConsumedApproval,
} from '../../src/lib/dev-approval.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-approval-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

const FIXED_NOW = new Date('2026-06-03T12:00:00.000Z')
const VALID_TS = '2026-06-03T11:59:30.000Z' // 30s before FIXED_NOW

function validApproval(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: VALID_TS,
    action_scope: 'commit:feat/foo:abc1234',
    reason: 'commit checkpoint for F2.5.0 lib foundation',
    ...overrides,
  }
}

describe('lib/dev-approval — schema', () => {
  it('rejects unknown keys (zod strict)', () => {
    const parsed = DevApprovalSchema.safeParse({
      timestamp: VALID_TS,
      action_scope: 'a',
      reason: 'r',
      bogus: 'no',
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts override blocks with reason', () => {
    const parsed = DevApprovalSchema.safeParse({
      timestamp: VALID_TS,
      action_scope: 'a',
      reason: 'r',
      override_protected_branch: { reason: 'release branch fix' },
      override_secrets_check: { reason: 'fixture sample value, not a real secret' },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects override blocks with empty reason', () => {
    const parsed = DevApprovalSchema.safeParse({
      timestamp: VALID_TS,
      action_scope: 'a',
      reason: 'r',
      override_protected_branch: { reason: '' },
    })
    expect(parsed.success).toBe(false)
  })
})

describe('lib/dev-approval — validateDevApproval', () => {
  it('rejects when schema is invalid (missing required field)', () => {
    const result = validateDevApproval(
      { timestamp: VALID_TS, action_scope: 'a' },
      { projectRoot: tmpRoot, now: FIXED_NOW },
    )
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') {
      expect(result.reason).toContain('reason')
    }
  })

  it('returns valid + no signals for a clean fresh approval', () => {
    const result = validateDevApproval(validApproval(), {
      projectRoot: tmpRoot,
      now: FIXED_NOW,
    })

    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).toEqual([])
      expect(result.must_force_dialog).toBe(false)
      expect(result.approval.action_scope).toBe('commit:feat/foo:abc1234')
    }
  })

  it('rejects when timestamp is older than the configured skew window', () => {
    const old = new Date(FIXED_NOW.getTime() - 300_000).toISOString() // 300s old, exceeds 180s default
    const result = validateDevApproval(validApproval({ timestamp: old }), {
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      // default skew = 180s
    })
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') {
      expect(result.reason).toContain('older than 180s')
    }
  })

  it('rejects when timestamp is more than skew seconds in the future', () => {
    const future = new Date(FIXED_NOW.getTime() + 300_000).toISOString() // 300s ahead, exceeds 180s default
    const result = validateDevApproval(validApproval({ timestamp: future }), {
      projectRoot: tmpRoot,
      now: FIXED_NOW,
    })
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') {
      expect(result.reason).toContain('future')
    }
  })

  it('honors a custom timestamp_skew_seconds from approval_modes', () => {
    const old = new Date(FIXED_NOW.getTime() - 90_000).toISOString() // 90s old
    const result = validateDevApproval(validApproval({ timestamp: old }), {
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      approvalModes: { timestamp_skew_seconds: 120 },
    })
    expect(result.status).toBe('valid')
  })

  it('rejects a reused (action_scope, timestamp) pair (INV-2 anti-reuse)', () => {
    const approval = validApproval()
    // Pre-seed the store with this exact pair as already consumed.
    const earlier = new Date(FIXED_NOW.getTime() - 10_000)
    const recordResult = recordConsumedApproval(approval, {
      projectRoot: tmpRoot,
      now: earlier,
    })
    expect(recordResult.ok).toBe(true)

    const result = validateDevApproval(approval, {
      projectRoot: tmpRoot,
      now: FIXED_NOW,
    })
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') {
      expect(result.reason).toContain('reused')
    }
  })

  it('elevates (must_force_dialog=true) when reason is too short (INV-2.2)', () => {
    const result = validateDevApproval(validApproval({ reason: 'ok' }), {
      projectRoot: tmpRoot,
      now: FIXED_NOW,
    })
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).toContain('reason_too_short')
      expect(result.must_force_dialog).toBe(true)
    }
  })

  it('elevates with implausibly_fast when consumed_at gap < fabrication threshold', () => {
    // Seed a prior consumption 100ms before FIXED_NOW (below default 500ms threshold).
    const priorApproval = validApproval({
      action_scope: 'previous:foo:abc',
      timestamp: VALID_TS,
    })
    const veryRecent = new Date(FIXED_NOW.getTime() - 100)
    recordConsumedApproval(priorApproval, { projectRoot: tmpRoot, now: veryRecent })

    const result = validateDevApproval(
      validApproval({ action_scope: 'commit:feat/foo:def5678' }),
      { projectRoot: tmpRoot, now: FIXED_NOW },
    )
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).toContain('implausibly_fast')
      expect(result.must_force_dialog).toBe(true)
    }
  })

  it('elevates with approvals_store_corrupt when the store file is malformed JSON', () => {
    // Write a corrupt approvals-seen.json
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct', 'approvals-seen.json'), '{not valid json', 'utf8')

    const result = validateDevApproval(validApproval(), {
      projectRoot: tmpRoot,
      now: FIXED_NOW,
    })

    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).toContain('approvals_store_corrupt')
      expect(result.must_force_dialog).toBe(true)
    }
  })

  it('rejects an unparseable timestamp string', () => {
    const result = validateDevApproval(validApproval({ timestamp: 'not-a-date' }), {
      projectRoot: tmpRoot,
      now: FIXED_NOW,
    })
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') {
      expect(result.reason).toContain('parseable')
    }
  })
})

describe('lib/dev-approval — recordConsumedApproval', () => {
  it('atomically writes the approvals-seen.json store and appends entries', () => {
    const a = validApproval({ action_scope: 'a:1' })
    const b = validApproval({ action_scope: 'b:2' })

    const r1 = recordConsumedApproval(a, { projectRoot: tmpRoot, now: FIXED_NOW })
    const r2 = recordConsumedApproval(b, {
      projectRoot: tmpRoot,
      now: new Date(FIXED_NOW.getTime() + 1000),
    })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    const path = join(tmpRoot, '.rsct', 'approvals-seen.json')
    expect(existsSync(path)).toBe(true)
    const store = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      entries: Array<{ action_scope: string }>
    }
    expect(store.version).toBe(1)
    expect(store.entries.length).toBe(2)
    expect(store.entries[0]?.action_scope).toBe('a:1')
    expect(store.entries[1]?.action_scope).toBe('b:2')
  })

  it('returns { ok: false } when the parent path is a file (graceful failure)', () => {
    const blockingFile = join(tmpRoot, '.rsct')
    writeFileSync(blockingFile, 'not-a-dir', 'utf8')

    const result = recordConsumedApproval(validApproval(), {
      projectRoot: tmpRoot,
      now: FIXED_NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(typeof result.error).toBe('string')
    }
  })
})

describe('lib/dev-approval — scope_mismatch (INV-2.2)', () => {
  it('fires when toolName=rsct_request_commit but action_scope starts with push:', () => {
    const result = validateDevApproval(
      validApproval({ action_scope: 'push:origin:main' }),
      {
        projectRoot: tmpRoot,
        now: FIXED_NOW,
        toolName: 'rsct_request_commit',
      },
    )
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).toContain('scope_mismatch')
      expect(result.must_force_dialog).toBe(true)
    }
  })

  it('does NOT fire when toolName matches expected token', () => {
    const result = validateDevApproval(
      validApproval({ action_scope: 'commit:feat/foo:abc1234' }),
      {
        projectRoot: tmpRoot,
        now: FIXED_NOW,
        toolName: 'rsct_request_commit',
      },
    )
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).not.toContain('scope_mismatch')
    }
  })

  it('does NOT fire when toolName is not in the prefix registry', () => {
    const result = validateDevApproval(
      validApproval({ action_scope: 'arbitrary:anything' }),
      {
        projectRoot: tmpRoot,
        now: FIXED_NOW,
        toolName: 'some_other_tool',
      },
    )
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).not.toContain('scope_mismatch')
    }
  })

  it('does NOT fire when toolName is undefined (backward compat)', () => {
    const result = validateDevApproval(
      validApproval({ action_scope: 'completely_different:x' }),
      { projectRoot: tmpRoot, now: FIXED_NOW },
    )
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).not.toContain('scope_mismatch')
    }
  })

  it('fires for verification_complete tool when prefix is wrong', () => {
    const result = validateDevApproval(
      validApproval({ action_scope: 'commit:something' }),
      {
        projectRoot: tmpRoot,
        now: FIXED_NOW,
        toolName: 'rsct_phase_verification_complete',
      },
    )
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).toContain('scope_mismatch')
    }
  })
})

describe('lib/dev-approval — burst_pattern (INV-2.2)', () => {
  function seedStore(
    entries: Array<{ action_scope: string; consumed_at: string }>,
  ): void {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    const store = {
      version: 1,
      entries: entries.map((e) => ({
        action_scope: e.action_scope,
        timestamp: VALID_TS,
        consumed_at: e.consumed_at,
      })),
    }
    writeFileSync(
      join(tmpRoot, '.rsct', 'approvals-seen.json'),
      JSON.stringify(store),
      'utf8',
    )
  }

  it('does NOT fire with 0 prior approvals', () => {
    const result = validateDevApproval(validApproval(), {
      projectRoot: tmpRoot,
      now: FIXED_NOW,
    })
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).not.toContain('burst_pattern')
    }
  })

  it('does NOT fire with 2 recent approvals in the 10s window', () => {
    seedStore([
      {
        action_scope: 'a:1',
        consumed_at: new Date(FIXED_NOW.getTime() - 8000).toISOString(),
      },
      {
        action_scope: 'a:2',
        consumed_at: new Date(FIXED_NOW.getTime() - 5000).toISOString(),
      },
    ])
    const result = validateDevApproval(
      validApproval({ action_scope: 'a:3' }),
      { projectRoot: tmpRoot, now: FIXED_NOW },
    )
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).not.toContain('burst_pattern')
    }
  })

  it('fires with 3 recent approvals in the 10s window (this would be the 4th)', () => {
    seedStore([
      {
        action_scope: 'a:1',
        consumed_at: new Date(FIXED_NOW.getTime() - 9000).toISOString(),
      },
      {
        action_scope: 'a:2',
        consumed_at: new Date(FIXED_NOW.getTime() - 5000).toISOString(),
      },
      {
        action_scope: 'a:3',
        consumed_at: new Date(FIXED_NOW.getTime() - 1000).toISOString(),
      },
    ])
    const result = validateDevApproval(
      validApproval({ action_scope: 'a:4' }),
      { projectRoot: tmpRoot, now: FIXED_NOW },
    )
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).toContain('burst_pattern')
      expect(result.must_force_dialog).toBe(true)
    }
  })

  it('does NOT fire when older entries are outside the 10s window', () => {
    seedStore([
      {
        action_scope: 'a:1',
        consumed_at: new Date(FIXED_NOW.getTime() - 60000).toISOString(),
      },
      {
        action_scope: 'a:2',
        consumed_at: new Date(FIXED_NOW.getTime() - 30000).toISOString(),
      },
      {
        action_scope: 'a:3',
        consumed_at: new Date(FIXED_NOW.getTime() - 20000).toISOString(),
      },
    ])
    const result = validateDevApproval(
      validApproval({ action_scope: 'a:4' }),
      { projectRoot: tmpRoot, now: FIXED_NOW },
    )
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).not.toContain('burst_pattern')
    }
  })
})
