import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gateRequest } from '../../src/lib/request-gate.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let root: string
const NOW = new Date('2026-11-08T12:00:00.000Z')
const TS = '2026-11-08T11:59:50.000Z'
const MESSAGE = 'Approve the thing?\n\nRepository: x'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-fab-'))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

async function shown(toolName: string, approval: Record<string, unknown>, approvalModes?: Record<string, unknown>): Promise<string> {
  const seen: DialogOptions[] = []
  await gateRequest({
    toolName,
    approval,
    dialog: { title: 't', message: MESSAGE },
    projectRoot: root,
    forceDialog: true,
    ...(approvalModes !== undefined && { approvalModes }),
    promptFn: async (o): Promise<DialogResult> => { seen.push(o); return { response: 'no', channel: 'windows' } },
    now: NOW,
  })
  return seen[0]!.message
}

describe('the dialog says when an approval looks auto-generated, and why', () => {
  it('leaves the message alone when nothing looks generated', async () => {
    expect(await shown('rsct_request_push', { timestamp: TS, action_scope: 'push:feat/x', reason: 'push the finished feature' })).toBe(MESSAGE)
  })

  it('puts one plain line at the top for a short reason', async () => {
    const text = await shown('rsct_request_push', { timestamp: TS, action_scope: 'push:feat/x', reason: 'ok' })
    expect(text.split('\n')[0]).toBe('⚠ This approval looks auto-generated: its reason is under 10 characters.')
    expect(text.endsWith(MESSAGE)).toBe(true)
  })

  it('names the expected scope at the top and the agent scope after everything else', async () => {
    const text = await shown('rsct_request_rebase', { timestamp: TS, action_scope: 'merge:feat/x', reason: 'rebase the finished feature' })
    expect(text.split('\n')[0]).toBe("⚠ This approval looks auto-generated: its action_scope does not start with 'rebase:' or 'squash:'.")
    expect(text.endsWith('\n\nAgent\'s action_scope: "merge:feat/x"')).toBe(true)
  })

  it('accepts both scope tokens of a rebase and the code_start token', async () => {
    for (const scope of ['rebase:feat/x', 'squash:feat/x']) {
      expect(await shown('rsct_request_rebase', { timestamp: TS, action_scope: scope, reason: 'rebase the finished feature' })).toBe(MESSAGE)
    }
    expect(await shown('rsct_phase_code_start', { timestamp: TS, action_scope: 'code_start:bypass', reason: 'skip V on the developer request' })).toBe(MESSAGE)
    expect((await shown('rsct_phase_code_start', { timestamp: TS, action_scope: 'bypass', reason: 'skip V on the developer request' })).split('\n')[0]).toContain("'code_start:'")
  })

  it('uses the configured threshold for an approval that came too fast', async () => {
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(join(root, '.rsct', 'approvals-seen.json'), JSON.stringify({ version: 1, entries: [{ action_scope: 'push:a', timestamp: '2026-11-08T11:00:00.000Z', consumed_at: '2026-11-08T11:59:59.500Z' }] }))
    const text = await shown('rsct_request_push', { timestamp: TS, action_scope: 'push:feat/x', reason: 'push the finished feature' }, { fabrication_signal_threshold_ms: 2000 })
    expect(text.split('\n')[0]).toBe('⚠ This approval looks auto-generated: it came less than 2000 ms after the previous approval was used.')
  })
})
