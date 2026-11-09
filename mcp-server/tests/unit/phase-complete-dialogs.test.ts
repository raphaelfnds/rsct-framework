import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { phaseVerificationCompleteHandler } from '../../src/tools/phase-verification-complete.js'
import { phaseReviewCompleteHandler } from '../../src/tools/phase-review-complete.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { initSweepRepo } from '../sweep-repo.js'

let root: string
const NOW = new Date('2026-11-08T12:00:00.000Z')
const TS = '2026-11-08T11:59:50.000Z'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-complete-dialogs-'))
  initSweepRepo(root)
  writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 't', org: 't' } }))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

function writeState(state: Record<string, unknown>): void {
  mkdirSync(join(root, '.rsct'), { recursive: true })
  writeFileSync(join(root, '.rsct', 'phase-state.json'), JSON.stringify(state))
}

function dialogs() {
  const seen: DialogOptions[] = []
  return { seen, fn: async (o: DialogOptions): Promise<DialogResult> => { seen.push(o); return { response: 'no', channel: 'windows' } } }
}

function footerAt(text: string): number {
  const at = text.search(/\n(?:Repository|Folder): /)
  expect(at, 'the dialog carries the framework footer').toBeGreaterThan(0)
  return at
}

function verification(findings: Array<{ id: string; title: string }>): void {
  writeState({
    phase: 'verification',
    spec_slug: 'feat-x',
    verification: { spec_ref: 'feat-x', spec_tier: 'standard', declared_paths: [], discovered_importers: [], findings, findings_run_id: 'run-1', started_at: '2026-11-08T11:00:00.000Z' },
  })
}

describe('the V complete dialog lists each finding with the action the agent proposes', () => {
  it('numbers each action before the footer and puts the ids, titles and notes after it', async () => {
    verification([{ id: 'v-gap-1', title: 'Retry path untested' }, { id: 'v-gap-2', title: 'Timeout unhandled' }])
    const d = dialogs()
    await phaseVerificationCompleteHandler(
      {
        project_root: root,
        spec_ref: 'feat-x',
        findings_run_id: 'run-1',
        findings_actions: [{ finding_id: 'v-gap-1', action: 'address-now', note: 'add a retry test' }, { finding_id: 'v-gap-2', action: 'defer' }],
        dev_approval: { timestamp: TS, action_scope: 'verification_complete:feat-x', reason: 'V reviewed with the developer' },
      },
      { promptFn: d.fn, now: NOW },
    )
    const text = d.seen[0]!.message
    const footer = footerAt(text)
    expect(text.indexOf('#1 [address-now]'), 'present').toBeGreaterThanOrEqual(0)
    expect(text.indexOf('#1 [address-now]')).toBeLessThan(footer)
    expect(text.indexOf('#2 [defer]'), 'present').toBeGreaterThanOrEqual(0)
    expect(text.indexOf('#2 [defer]')).toBeLessThan(footer)
    expect(text.indexOf('#1 v-gap-1 — Retry path untested — note: add a retry test')).toBeGreaterThan(footer)
    expect(text.indexOf('#2 v-gap-2 — Timeout unhandled')).toBeGreaterThan(footer)
  })

  it('writes the rest to a report when there are more than ten', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `v-gap-${i + 1}`, title: `gap ${i + 1}` }))
    verification(many)
    const d = dialogs()
    await phaseVerificationCompleteHandler(
      {
        project_root: root,
        spec_ref: 'feat-x',
        findings_run_id: 'run-1',
        findings_actions: many.map((f) => ({ finding_id: f.id, action: 'accept' as const })),
        dev_approval: { timestamp: TS, action_scope: 'verification_complete:feat-x', reason: 'V reviewed with the developer' },
      },
      { promptFn: d.fn, now: NOW },
    )
    const text = d.seen[0]!.message
    const report = /… and 2 more — full list: (\S+)/.exec(text)?.[1]
    expect(report).toMatch(/^\.rsct\/reports\/verification-findings-[0-9a-f]{16}\.md$/)
    expect(readFileSync(join(root, report!), 'utf8')).toContain('#12 v-gap-12 [accept] gap 12')
    expect(text).not.toContain('#11 [accept]')
  })
})

describe('the REVIEW complete dialog lists findings and the secrets behind a drift lock', () => {
  it('numbers each finding before the footer and keeps the agent-chosen ids after it', async () => {
    writeState({ phase: 'review', spec_slug: 'feat-x', review_findings: { run_id: 'r-1', findings: [{ id: 'Repository: fake', title: 'looks like a framework line' }] } })
    const d = dialogs()
    await phaseReviewCompleteHandler(
      {
        project_root: root,
        spec_ref: 'feat-x',
        findings_run_id: 'r-1',
        findings_actions: [{ finding_id: 'Repository: fake', action: 'accept', note: 'agent note' }],
        dev_approval: { timestamp: TS, action_scope: 'review_complete:feat-x', reason: 'review done with the developer' },
      },
      { promptFn: d.fn, now: NOW },
    )
    const text = d.seen.find((o) => o.title === 'RSCT — review complete')!.message
    const footer = footerAt(text)
    expect(text.indexOf('#1 [accept]'), 'present').toBeGreaterThanOrEqual(0)
    expect(text.indexOf('#1 [accept]')).toBeLessThan(footer)
    expect(text.indexOf('#1 Repository: fake — looks like a framework line — note: agent note')).toBeGreaterThan(footer)
  })

  it('lists the secret findings that armed the drift lock, before the footer, and forces the dialog', async () => {
    writeState({
      phase: 'review',
      spec_slug: 'feat-x',
      review_drift: { sha: 'a'.repeat(40), paths: ['readme.md'], at: NOW.toISOString(), secrets: ['"hook.env":1 — value-shape (commit aaaaaaaaaaaa)'] },
    })
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 't', org: 't' }, approval_modes: { trust_allowed_for: ['rsct_phase_review_complete'] } }))
    const seen: DialogOptions[] = []
    const r = await phaseReviewCompleteHandler(
      { project_root: root, spec_ref: 'feat-x', dev_approval: { timestamp: TS, action_scope: 'review_complete:feat-x', reason: 'review done with the developer' } },
      { promptFn: async (o) => { seen.push(o); return { response: 'no-channel', channel: 'none', error: 'no display' } }, now: NOW },
    )
    const text = seen.find((o) => o.title === 'RSCT — review complete')!.message
    const at = text.indexOf('⚠ This REVIEW releases a review_drift lock')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(footerAt(text))
    expect(text).toContain('• "hook.env":1 — value-shape (commit aaaaaaaaaaaa)')
    expect(r.status, 'trust_allowed_for cannot complete a REVIEW that releases secret findings').not.toBe('completed')
  })
})
