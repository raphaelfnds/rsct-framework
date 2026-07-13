import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  progressHasOpenItems,
  progressCompletionState,
  findPlanByBranch,
} from '../../src/lib/plan.js'
import {
  stampPlanDisposition,
  readPlanDisposition,
  readPhaseState,
} from '../../src/lib/phase-scope.js'
import { evaluatePreMergeAck } from '../../src/lib/pre-merge-ack.js'

let tmpRoot: string
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-plc-'))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeProgress(slug: string, body: string): void {
  writeFileSync(join(tmpRoot, `progress_${slug}.md`), body, 'utf8')
}
function writePlan(slug: string, branch: string): void {
  writeFileSync(join(tmpRoot, `plan_${slug}.md`), `# Plan\n\n| Branch | ${branch} |\n| Status | in progress |\n`)
}

describe('lib/plan — progress checkbox scanning', () => {
  it('detects open items', () => {
    writeProgress('p', '- [ ] todo\n- [x] done\n')
    expect(progressHasOpenItems(tmpRoot, 'p')).toBe(true)
  })
  it('returns false when all items are closed', () => {
    writeProgress('p', '- [x] a\n- [x] b\n')
    expect(progressHasOpenItems(tmpRoot, 'p')).toBe(false)
  })
  it('ignores `- [ ]` inside fenced code blocks', () => {
    writeProgress('p', '```\n- [ ] example in a code fence\n```\n- [x] real done\n')
    expect(progressHasOpenItems(tmpRoot, 'p')).toBe(false)
  })
  it('is CRLF-tolerant and matches indented / *,+ markers', () => {
    writeProgress('p', '  * [ ] indented star open\r\n+ [x] plus done\r\n')
    expect(progressHasOpenItems(tmpRoot, 'p')).toBe(true)
  })
  it('missing file ⇒ no open items (lenient, for the LIGHT gate)', () => {
    expect(progressHasOpenItems(tmpRoot, 'nope')).toBe(false)
  })
})

describe('lib/plan — progressCompletionState (fail-closed evidence)', () => {
  it('no_file when absent', () => {
    expect(progressCompletionState(tmpRoot, 'x')).toBe('no_file')
  })
  it('no_checkboxes when the file has none', () => {
    writeProgress('x', '# Progress\n\nsome prose, no checkboxes\n')
    expect(progressCompletionState(tmpRoot, 'x')).toBe('no_checkboxes')
  })
  it('has_open when any open', () => {
    writeProgress('x', '- [x] a\n- [ ] b\n')
    expect(progressCompletionState(tmpRoot, 'x')).toBe('has_open')
  })
  it('all_closed only with ≥1 closed and zero open', () => {
    writeProgress('x', '- [x] a\n- [x] b\n')
    expect(progressCompletionState(tmpRoot, 'x')).toBe('all_closed')
  })
})

describe('lib/plan — findPlanByBranch (HOLE A: branch, not mtime)', () => {
  it('resolves the plan whose Branch metadata matches', () => {
    writePlan('a', 'feat/a')
    writePlan('b', 'feat/b')
    expect(findPlanByBranch(tmpRoot, 'feat/b')?.slug).toBe('b')
    expect(findPlanByBranch(tmpRoot, 'feat/a')?.slug).toBe('a')
  })
  it('returns null when no plan is tied to the branch', () => {
    writePlan('a', 'feat/a')
    expect(findPlanByBranch(tmpRoot, 'feat/zzz')).toBeNull()
  })
})

describe('lib/phase-scope — plan disposition (stamp-once + slug read guard)', () => {
  it('records and reads back a disposition for the matching slug', () => {
    const r = stampPlanDisposition(tmpRoot, { plan_slug: 'a', decision: 'delete', decided_at: '2026-07-11T00:00:00Z' })
    expect(r.ok).toBe(true)
    const state = readPhaseState(tmpRoot).state
    expect(readPlanDisposition(state, 'a')?.decision).toBe('delete')
  })
  it('READ guard: a disposition for plan A never applies to plan B', () => {
    stampPlanDisposition(tmpRoot, { plan_slug: 'a', decision: 'delete', decided_at: '2026-07-11T00:00:00Z' })
    const state = readPhaseState(tmpRoot).state
    expect(readPlanDisposition(state, 'b')).toBeNull()
  })
  it('re-stamping for a different slug replaces (no carry-over)', () => {
    stampPlanDisposition(tmpRoot, { plan_slug: 'a', decision: 'delete', decided_at: '2026-07-11T00:00:00Z' })
    stampPlanDisposition(tmpRoot, { plan_slug: 'b', decision: 'keep', decided_at: '2026-07-11T01:00:00Z' })
    const state = readPhaseState(tmpRoot).state
    expect(readPlanDisposition(state, 'a')).toBeNull()
    expect(readPlanDisposition(state, 'b')?.decision).toBe('keep')
  })
})

describe('lib/pre-merge-ack — LIGHT plan_complete cross-check (pure)', () => {
  const fullAck = { plan_complete: true, adr_confirmed: true, issues_resolved: true, note: 'ADR-1; issue #2 closed' }
  it('passes when plan_complete attested and progress has no open items', () => {
    expect(evaluatePreMergeAck(fullAck, false).ok).toBe(true)
  })
  it('rejects when plan_complete attested but progress still has open items', () => {
    const d = evaluatePreMergeAck(fullAck, true)
    expect(d.ok).toBe(false)
    if (!d.ok && d.kind === 'pre_merge_ack_incomplete') {
      expect(d.failing.some((f) => f.startsWith('plan_complete'))).toBe(true)
    }
  })
  it('undefined progress flag ⇒ pre-v2 behavior (no cross-check)', () => {
    expect(evaluatePreMergeAck(fullAck).ok).toBe(true)
  })
})
