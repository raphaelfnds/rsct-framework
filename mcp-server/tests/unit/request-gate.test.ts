import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gateRequest } from '../../src/lib/request-gate.js'
import { recordConsumedApproval } from '../../src/lib/dev-approval.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-gate-'))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const FIXED_NOW = new Date('2026-06-03T12:00:00.000Z')
const VALID_TS = '2026-06-03T11:59:45.000Z'

function approval(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: VALID_TS,
    action_scope: 'commit:feat/foo:abc',
    reason: 'commit checkpoint for unit test coverage',
    ...overrides,
  }
}

function dialogReturning(r: DialogResult): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => r
}

const NEVER_CALLED_DIALOG = async (): Promise<DialogResult> => {
  throw new Error('dialog should not have been invoked')
}

const DIALOG_OPTS: DialogOptions = { title: 't', message: 'm' }

describe('gateRequest — validate-stage rejections', () => {
  it('rejects with reject_kind=schema when dev_approval is malformed', async () => {
    const r = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: { only: 'one field' },
      dialog: DIALOG_OPTS,
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      promptFn: NEVER_CALLED_DIALOG,
    })
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') expect(r.reject_kind).toBe('schema')
  })

  it('rejects with reject_kind=reused when the (scope, ts) pair was already consumed', async () => {
    const a = approval()
    recordConsumedApproval(a, { projectRoot: tmpRoot, now: new Date(FIXED_NOW.getTime() - 10_000) })
    const r = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: a,
      dialog: DIALOG_OPTS,
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      promptFn: NEVER_CALLED_DIALOG,
    })
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') expect(r.reject_kind).toBe('reused')
  })

  it('rejects with reject_kind=expired when the timestamp is outside the skew window', async () => {
    const r = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: approval({ timestamp: '2026-06-03T11:50:00.000Z' }), // 10 min old
      dialog: DIALOG_OPTS,
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      promptFn: NEVER_CALLED_DIALOG,
    })
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') expect(r.reject_kind).toBe('expired')
  })
})

describe('gateRequest — dialog stage (no fabrication signals)', () => {
  it('approves with the dialog channel on yes', async () => {
    const r = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: approval(),
      dialog: DIALOG_OPTS,
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      promptFn: dialogReturning({ response: 'yes', channel: 'windows' }),
    })
    expect(r.status).toBe('approved')
    if (r.status === 'approved') {
      expect(r.channel).toBe('windows')
      expect(r.fabrication_signals).toEqual([])
    }
  })

  it('rejects with reject_kind=dialog_no on no', async () => {
    const r = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: approval(),
      dialog: DIALOG_OPTS,
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      promptFn: dialogReturning({ response: 'no', channel: 'windows' }),
    })
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') expect(r.reject_kind).toBe('dialog_no')
  })

  it('falls back to trust path when dialog returns no-channel and tool is allow-listed', async () => {
    const r = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: approval(),
      dialog: DIALOG_OPTS,
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      approvalModes: { trust_allowed_for: ['rsct_request_commit'] },
      promptFn: dialogReturning({ response: 'no-channel', channel: 'none' }),
    })
    expect(r.status).toBe('approved')
    if (r.status === 'approved') expect(r.channel).toBe('trust')
  })

  it('rejects with reject_kind=no_channel when no dialog and tool not allow-listed', async () => {
    const r = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: approval(),
      dialog: DIALOG_OPTS,
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      promptFn: dialogReturning({ response: 'no-channel', channel: 'none' }),
    })
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') expect(r.reject_kind).toBe('no_channel')
  })
})

describe('gateRequest — forced dialog (fabrication signals)', () => {
  it('approves only on yes; trust list does not bypass forced dialog', async () => {
    // reason_too_short triggers must_force_dialog
    const r = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: approval({ reason: 'ok' }),
      dialog: DIALOG_OPTS,
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      approvalModes: { trust_allowed_for: ['rsct_request_commit'] },
      promptFn: dialogReturning({ response: 'yes', channel: 'macos' }),
    })
    expect(r.status).toBe('approved')
    if (r.status === 'approved') {
      expect(r.channel).toBe('macos')
      expect(r.fabrication_signals).toContain('reason_too_short')
    }
  })

  it('rejects with force_dialog_no_channel when fabrication signals fire and no dialog exists', async () => {
    const r = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: approval({ reason: 'ok' }),
      dialog: DIALOG_OPTS,
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      approvalModes: { trust_allowed_for: ['rsct_request_commit'] },
      promptFn: dialogReturning({ response: 'no-channel', channel: 'none' }),
    })
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') {
      expect(r.reject_kind).toBe('force_dialog_no_channel')
      expect(r.reason).toContain('trust_allowed_for is ignored')
    }
  })

  it('rejects with dialog_no on no even when forced (no fallback)', async () => {
    const r = await gateRequest({
      toolName: 'rsct_request_commit',
      approval: approval({ reason: 'ok' }),
      dialog: DIALOG_OPTS,
      projectRoot: tmpRoot,
      now: FIXED_NOW,
      promptFn: dialogReturning({ response: 'no', channel: 'windows' }),
    })
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') expect(r.reject_kind).toBe('dialog_no')
  })
})
