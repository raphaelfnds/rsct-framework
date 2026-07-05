import { describe, it, expect } from 'vitest'
import { resolve, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { statusHandler, type StatusOutput } from '../../src/tools/status.js'
import { RSCT_MCP_VERSION } from '../../src/lib/version.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')

describe('rsct_status', () => {
  it('reports rsct_installed=true and reads .rsct.json on an rsct project', async () => {
    const out = (await statusHandler({ project_root: SAMPLE_RSCT })) as StatusOutput

    expect(out.rsct_installed).toBe(true)
    expect(out.project.app_name).toBe('sample-app')
    expect(out.project.org_slug).toBe('sample-org')
    expect(out.project.rsct_version).toBe('1.0.0')
    expect(out.project.protected_branches).toEqual(['main', 'test'])
    expect(out.project.test_framework).toBe('JUnit 5')
    expect(out.mcp_server.name).toBe('rsct-mcp')
  })

  it('reports rsct_installed=false and surfaces a setup hint when no .rsct.json', async () => {
    const out = (await statusHandler({ project_root: NO_RSCT })) as StatusOutput

    expect(out.rsct_installed).toBe(false)
    expect(out.project.app_name).toBeNull()
    expect(out.project.protected_branches).toEqual([])
    expect(out.hints.some((h) => h.includes('/rsct-setup'))).toBe(true)
  })

  it('always includes mcp_server metadata', async () => {
    const out = (await statusHandler({})) as StatusOutput
    expect(out.mcp_server).toEqual({
      name: 'rsct-mcp',
      version: RSCT_MCP_VERSION,
    })
  })

  it('rejects unknown input keys (zod strict)', async () => {
    await expect(statusHandler({ unknown_key: 'x' })).rejects.toThrow()
  })

  // T4: rsct_status surfaces the opt-in update hint when the ~/.rsct cache says a
  // newer release exists. We point HOME at a seeded temp dir (getUpdateNotice reads
  // $HOME/.rsct/update-check.json) and restore it after.
  it('surfaces an update hint when consent+cache show a newer release (and not otherwise)', async () => {
    const origHome = process.env.HOME
    const h = mkdtempSync(join(tmpdir(), 'rsct-status-upd-'))
    try {
      // No consent yet → no update hint.
      process.env.HOME = h
      const before = (await statusHandler({ project_root: SAMPLE_RSCT })) as StatusOutput
      expect(before.hints.some((x) => /newer RSCT release/.test(x))).toBe(false)

      // Consent + a fresh cache with a newer tag → hint appears.
      const maj = Number(RSCT_MCP_VERSION.split('.')[0])
      mkdirSync(join(h, '.rsct'), { recursive: true })
      writeFileSync(
        join(h, '.rsct', 'update-check.json'),
        JSON.stringify({ consent: 'yes', latest_tag: `v${maj + 1}.0.0`, last_checked: new Date().toISOString() }),
      )
      const after = (await statusHandler({ project_root: SAMPLE_RSCT })) as StatusOutput
      expect(after.hints.some((x) => /newer RSCT release/.test(x))).toBe(true)
    } finally {
      if (origHome === undefined) delete process.env.HOME
      else process.env.HOME = origHome
      rmSync(h, { recursive: true, force: true })
    }
  })

  // T3: status always reports a worktree block; a plain fixture (or subdir of
  // the main worktree) is NOT a linked worktree, so no linked-worktree hint.
  it('includes a worktree block and emits no linked-worktree hint outside one', async () => {
    const out = (await statusHandler({ project_root: SAMPLE_RSCT })) as StatusOutput
    expect(out.worktree).toBeDefined()
    expect(out.worktree.is_worktree).toBe(false)
    expect(out.hints.some((h) => h.includes('linked git worktree'))).toBe(false)
  })

  // Install-drift: local compare of project rsct_version vs the running binary.
  const DRIFT = /was set up with RSCT v/

  it('surfaces an install-drift hint when the project version is behind the binary', async () => {
    // SAMPLE_RSCT is stamped rsct_version "1.0.0" < the running RSCT_MCP_VERSION.
    const out = (await statusHandler({ project_root: SAMPLE_RSCT })) as StatusOutput
    expect(out.hints.some((h) => DRIFT.test(h))).toBe(true)
  })

  it('does NOT surface an install-drift hint when not an rsct project', async () => {
    const out = (await statusHandler({ project_root: NO_RSCT })) as StatusOutput
    expect(out.hints.some((h) => DRIFT.test(h))).toBe(false)
  })

  it('does NOT surface an install-drift hint when the project version equals the binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsct-drift-eq-'))
    try {
      writeFileSync(
        join(dir, '.rsct.json'),
        JSON.stringify({ rsct_version: RSCT_MCP_VERSION, app: { name: 'a', org: 'o' } }),
      )
      const out = (await statusHandler({ project_root: dir })) as StatusOutput
      expect(out.rsct_installed).toBe(true) // guard: the negative isn't masked by a rejected config
      expect(out.hints.some((h) => DRIFT.test(h))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does NOT surface an install-drift hint when the project version is newer than the binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsct-drift-new-'))
    try {
      writeFileSync(
        join(dir, '.rsct.json'),
        JSON.stringify({ rsct_version: '999.0.0', app: { name: 'a', org: 'o' } }),
      )
      const out = (await statusHandler({ project_root: dir })) as StatusOutput
      expect(out.rsct_installed).toBe(true) // guard: the negative isn't masked by a rejected config
      expect(out.hints.some((h) => DRIFT.test(h))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
