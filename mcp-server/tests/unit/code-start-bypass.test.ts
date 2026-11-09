import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { phaseCodeStartHandler } from '../../src/tools/phase-code-start.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let root: string
const NOW = new Date('2026-11-08T12:00:00.000Z')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-cs-bypass-'))
  writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 't', org: 't' } }))
  writePlan('p')
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

function writePlan(slug: string): void {
  writeFileSync(join(root, `plan_${slug}.md`), '| Status | in-progress |\n')
  writeFileSync(join(root, `progress_${slug}.md`), '# progress\n')
}

function writeState(state: Record<string, unknown>): void {
  mkdirSync(join(root, '.rsct'), { recursive: true })
  writeFileSync(join(root, '.rsct', 'phase-state.json'), JSON.stringify(state))
}

let stamp = 0
function approval(): Record<string, unknown> {
  stamp += 1
  return { timestamp: new Date(NOW.getTime() - stamp * 1000).toISOString(), action_scope: 'code_start:bypass', reason: 'the developer asked to skip it here' }
}

function dialogs(answer: DialogResult['response'] = 'yes') {
  const seen: DialogOptions[] = []
  return { seen, fn: async (o: DialogOptions): Promise<DialogResult> => { seen.push(o); return { response: answer, channel: 'windows' } } }
}

function footerAt(text: string): number {
  const at = text.search(/\n(?:Repository|Folder): /)
  expect(at, 'the dialog carries the framework footer').toBeGreaterThan(0)
  return at
}

const base = { get project_root(): string { return root }, spec_ref: 'spec_x.md', spec_tier: 'standard', plan_slug: 'p' }

describe('the code_start bypass dialog shows the real state of each bypass and the agent reason after the footer', () => {
  it('names a V that was started and not completed', async () => {
    writeState({ verification: { spec_ref: 'spec_x.md', started_at: NOW.toISOString() } })
    const d = dialogs('no')
    await phaseCodeStartHandler({ ...base, override_verification_skip: true, dev_approval: approval() }, { promptFn: d.fn, now: NOW })
    const text = d.seen[0]!.message
    expect(text).toContain("• skip the verification (V) phase — now: V for this spec was started and not completed")
    expect(text.indexOf('Agent\'s reason: "the developer asked to skip it here"')).toBeGreaterThan(footerAt(text))
  })

  it('says when a bypass is not needed', async () => {
    writeState({ verification: { spec_ref: 'spec_x.md', started_at: NOW.toISOString(), completed_at: '2026-11-08T11:00:00.000Z' } })
    const d = dialogs('no')
    await phaseCodeStartHandler({ ...base, override_verification_skip: true, override_plan_tracking: true, dev_approval: approval() }, { promptFn: d.fn, now: NOW })
    expect(d.seen[0]!.message).toContain('— now: V completed at 2026-11-08T11:00:00.000Z — not needed')
    expect(d.seen[0]!.message).toContain('— now: the plan files are present — not needed')
  })

  it('names the recorded tier for a downgrade, and a missing plan file', async () => {
    writeState({ last_classify: { tier_max: 'complex', classified_at: '2026-11-08T10:00:00.000Z' } })
    const d = dialogs('no')
    await phaseCodeStartHandler(
      { ...base, plan_slug: 'gone', override_classify_downgrade: true, override_plan_tracking: true, override_verification_skip: true, dev_approval: approval() },
      { promptFn: d.fn, now: NOW },
    )
    const text = d.seen[0]!.message
    expect(text).toContain("— now: recorded tier_max 'complex' (classified at 2026-11-08T10:00:00.000Z); asked 'standard'")
    expect(text).toContain('— now: the plan file is missing')
  })
})

describe('the code_start approval is used once, and only when the start succeeds', () => {
  it('refuses the same approval on a second start', async () => {
    const a = approval()
    const first = await phaseCodeStartHandler({ ...base, override_verification_skip: true, dev_approval: a }, { promptFn: dialogs().fn, now: NOW })
    expect(first.status).toBe('started')
    expect('anti_replay_persisted' in first && first.anti_replay_persisted).toBe(true)
    const again = await phaseCodeStartHandler({ ...base, override_verification_skip: true, dev_approval: a }, { promptFn: dialogs().fn, now: NOW })
    expect([again.status, 'reject_kind' in again ? again.reject_kind : null]).toEqual(['bypass_gate_rejected', 'reused'])
  })

  it('keeps the approval when the developer says No, so the same one can be asked again', async () => {
    const a = approval()
    const declined = await phaseCodeStartHandler({ ...base, override_verification_skip: true, dev_approval: a }, { promptFn: dialogs('no').fn, now: NOW })
    expect(declined.status).toBe('bypass_gate_rejected')
    const d = dialogs()
    const retry = await phaseCodeStartHandler({ ...base, override_verification_skip: true, dev_approval: a }, { promptFn: d.fn, now: NOW })
    expect([retry.status, d.seen.length]).toEqual(['started', 1])
  })

  it('keeps the approval when a gate refuses the start after the developer said Yes', async () => {
    writeState({ verification: { spec_ref: 'spec_x.md', started_at: NOW.toISOString() } })
    const a = approval()
    const refused = await phaseCodeStartHandler({ ...base, override_verification_skip: true, dev_approval: a }, { promptFn: dialogs().fn, now: NOW })
    expect(refused.status).toBe('verification_gate_rejected')
    const d = dialogs('no')
    const again = await phaseCodeStartHandler({ ...base, override_verification_skip: true, dev_approval: a }, { promptFn: d.fn, now: NOW })
    expect([d.seen.length, 'reject_kind' in again ? again.reject_kind : null]).toEqual([1, 'dialog_no'])
  })

  it('keeps the approval when the start itself is refused after the dialog', async () => {
    writeState({ phase: 'test', spec_slug: 'other' })
    const a = approval()
    const refused = await phaseCodeStartHandler({ ...base, override_verification_skip: true, dev_approval: a }, { promptFn: dialogs().fn, now: NOW })
    expect(refused.status).toBe('phase_already_active')
    const d = dialogs('no')
    const again = await phaseCodeStartHandler({ ...base, override_verification_skip: true, dev_approval: a }, { promptFn: d.fn, now: NOW })
    expect([d.seen.length, 'reject_kind' in again ? again.reject_kind : null]).toEqual([1, 'dialog_no'])
  })

  it('records the approval once when one call shows the bypass and the run-alone dialogs', async () => {
    const a = approval()
    const d = dialogs()
    const first = await phaseCodeStartHandler({ ...base, override_verification_skip: true, run_alone: true, dev_approval: a }, { promptFn: d.fn, now: NOW })
    expect([first.status, d.seen.length]).toEqual(['started', 2])
  })

  it('says so when the approval could not be recorded', async () => {
    const out = await phaseCodeStartHandler(
      { ...base, override_verification_skip: true, dev_approval: approval() },
      { promptFn: dialogs().fn, now: NOW, approvalRecorder: () => ({ ok: false, path: 'x', error: 'disk full' }) },
    )
    expect(out.status).toBe('started')
    expect('anti_replay_error' in out && out.anti_replay_error).toBe('disk full')
    expect(out.hints.some((h) => h.includes('could not record this approval as used: disk full'))).toBe(true)
  })

  it('records nothing for a start that needed no dialog', async () => {
    const out = await phaseCodeStartHandler({ ...base, override_plan_tracking: false }, { promptFn: dialogs().fn, now: NOW, approvalRecorder: () => { throw new Error('must not record') } })
    expect(out.status).toBe('verification_gate_rejected')
  })
})
