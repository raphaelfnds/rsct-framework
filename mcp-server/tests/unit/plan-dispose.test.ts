import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  planDisposeHandler,
  type PlanDisposeOutput,
} from '../../src/tools/plan-dispose.js'
import { readPhaseState, readPlanDisposition } from '../../src/lib/phase-scope.js'

let tmpRoot: string
const NOW = new Date('2026-07-11T12:00:00.000Z')

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-disp-'))
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }),
    'utf8',
  )
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

describe('rsct_plan_dispose', () => {
  it("records a 'delete' disposition and advises cleanup when progress is all-closed", async () => {
    writeFileSync(join(tmpRoot, 'plan_p.md'), '# p')
    writeFileSync(join(tmpRoot, 'progress_p.md'), '- [x] done\n')
    const out = (await planDisposeHandler(
      { project_root: tmpRoot, plan_slug: 'p', decision: 'delete' },
      { now: NOW },
    )) as PlanDisposeOutput

    expect(out.status).toBe('recorded')
    expect(out.decision).toBe('delete')
    expect(out.can_suggest_delete).toBe(true)
    expect(out.artifacts.map((a) => a.name).sort()).toEqual(['plan_p.md', 'progress_p.md'])
    // recorded once, slug-guarded
    const disp = readPlanDisposition(readPhaseState(tmpRoot).state, 'p')
    expect(disp?.decision).toBe('delete')
    expect(readPlanDisposition(readPhaseState(tmpRoot).state, 'other')).toBeNull()
  })

  it("warns when 'delete' is requested but the plan is NOT confirmed complete", async () => {
    writeFileSync(join(tmpRoot, 'plan_p.md'), '# p')
    writeFileSync(join(tmpRoot, 'progress_p.md'), '- [ ] still open\n')
    const out = (await planDisposeHandler(
      { project_root: tmpRoot, plan_slug: 'p', decision: 'delete' },
      { now: NOW },
    )) as PlanDisposeOutput

    expect(out.status).toBe('recorded')
    expect(out.can_suggest_delete).toBe(false)
    expect(out.hints[0]).toMatch(/NOT confirmed complete/)
  })

  it("records 'keep' and retains artifacts", async () => {
    writeFileSync(join(tmpRoot, 'plan_p.md'), '# p')
    const out = (await planDisposeHandler(
      { project_root: tmpRoot, plan_slug: 'p', decision: 'keep' },
      { now: NOW },
    )) as PlanDisposeOutput

    expect(out.decision).toBe('keep')
    expect(out.hints[0]).toMatch(/keep.*recorded/i)
  })

  it('never performs a filesystem deletion (advisory-only)', async () => {
    writeFileSync(join(tmpRoot, 'plan_p.md'), '# p')
    writeFileSync(join(tmpRoot, 'progress_p.md'), '- [x] done\n')
    await planDisposeHandler(
      { project_root: tmpRoot, plan_slug: 'p', decision: 'delete' },
      { now: NOW },
    )
    // Fork 2/A: the files must still be there — nothing is auto-deleted.
    expect(existsSync(join(tmpRoot, 'plan_p.md'))).toBe(true)
    expect(existsSync(join(tmpRoot, 'progress_p.md'))).toBe(true)
  })
})
