import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluateEditGuard } from '../../src/lib/edit-guard.js'
import { decide } from '../../src/scripts/edit-scope-guard.js'
import { checkEditScopeHandler } from '../../src/tools/check-edit-scope.js'
import {
  stampContextStale,
  readContextStale,
  stampBootstrapMarker,
  readPhaseState,
} from '../../src/lib/phase-scope.js'

let tmpRoot: string
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-guard-'))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeState(state: Record<string, unknown>): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(join(tmpRoot, '.rsct', 'phase-state.json'), JSON.stringify(state, null, 2))
}

describe('lib/edit-guard — evaluateEditGuard', () => {
  it('allows an unmanaged project (no .rsct.json)', () => {
    const r = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: false, filePath: 'x.ts' })
    expect(r.decision).toBe('allow')
    expect(r.status).toBe('unmanaged')
  })

  it('BLOCKS when context_stale is set', () => {
    writeState({ context_stale: { since: '2026-07-11T00:00:00Z', reason: 'plan_closed' } })
    const r = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'src/a.ts' })
    expect(r.decision).toBe('block')
    expect(r.status).toBe('stale_context')
  })

  it('allows when there is no active phase scope (unknown)', () => {
    const r = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'src/a.ts' })
    expect(r.decision).toBe('allow')
    expect(r.status).toBe('unknown')
  })

  it('allows an in-scope edit and BLOCKS an out-of-scope one', () => {
    writeState({ scope_globs: ['src/**'] })
    expect(evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'src/a.ts' }).decision).toBe('allow')
    const out = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'other/b.ts' })
    expect(out.decision).toBe('block')
    expect(out.status).toBe('out_of_scope')
  })

  it('FAILS OPEN (infra_error) on a corrupt phase-state', () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct', 'phase-state.json'), '{ corrupt')
    const r = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'src/a.ts' })
    expect(r.decision).toBe('allow')
    expect(r.status).toBe('infra_error')
  })
})

describe('scripts/edit-scope-guard — decide (exit 2 only for a real block)', () => {
  function payload(filePath: string): string {
    return JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath }, cwd: tmpRoot })
  }
  const env = () => ({ CLAUDE_PROJECT_DIR: tmpRoot }) as NodeJS.ProcessEnv

  it('exits 0 on empty stdin', () => {
    expect(decide('', env(), tmpRoot).exitCode).toBe(0)
  })
  it('exits 0 on malformed stdin', () => {
    expect(decide('not json', env(), tmpRoot).exitCode).toBe(0)
  })
  it('exits 0 when there is no file_path', () => {
    expect(decide(JSON.stringify({ tool_input: {} }), env(), tmpRoot).exitCode).toBe(0)
  })
  it('exits 2 (deny) when context is stale', () => {
    writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    writeState({ context_stale: { since: '2026-07-11T00:00:00Z', reason: 'plan_closed' } })
    const d = decide(payload('src/a.ts'), env(), tmpRoot)
    expect(d.exitCode).toBe(2)
    expect(d.message).toMatch(/stale_context/)
  })
  it('exits 0 (allow) for an in-scope edit', () => {
    writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    writeState({ scope_globs: ['src/**'] })
    expect(decide(payload('src/a.ts'), env(), tmpRoot).exitCode).toBe(0)
  })
  it('handles a NotebookEdit payload (notebook_path)', () => {
    writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    writeState({ context_stale: { since: '2026-07-11T00:00:00Z', reason: 'pivot' } })
    const d = decide(JSON.stringify({ tool_input: { notebook_path: 'nb.ipynb' }, cwd: tmpRoot }), env(), tmpRoot)
    expect(d.exitCode).toBe(2)
  })
})

describe('tools/check-edit-scope — stale_context status', () => {
  it('returns stale_context (before the empty-scope short-circuit) via override', async () => {
    const out = await checkEditScopeHandler({
      project_root: tmpRoot,
      file_path: 'src/a.ts',
      phase_state_override: { context_stale: { since: '2026-07-11T00:00:00Z', reason: 'plan_closed' } },
    })
    expect(out.status).toBe('stale_context')
    expect(out.hints.some((h) => /STALE/.test(h))).toBe(true)
  })
})

describe('lib/phase-scope — context_stale flag lifecycle (D4)', () => {
  it('stampContextStale sets it and readContextStale reads it back', () => {
    stampContextStale(tmpRoot, 'plan_closed', new Date('2026-07-11T00:00:00Z'))
    expect(readContextStale(readPhaseState(tmpRoot).state)?.reason).toBe('plan_closed')
  })
  it('rsct_status-style stamp (no clearStale) does NOT clear it', () => {
    stampContextStale(tmpRoot, 'plan_closed', new Date('2026-07-11T00:00:00Z'))
    stampBootstrapMarker(tmpRoot, { now: new Date('2026-07-11T01:00:00Z') }) // no clearStale
    expect(readContextStale(readPhaseState(tmpRoot).state)).not.toBeNull()
  })
  it('load_context-style stamp (clearStale:true) clears it', () => {
    stampContextStale(tmpRoot, 'plan_closed', new Date('2026-07-11T00:00:00Z'))
    stampBootstrapMarker(tmpRoot, { now: new Date('2026-07-11T01:00:00Z'), clearStale: true })
    expect(readContextStale(readPhaseState(tmpRoot).state)).toBeNull()
  })
})
