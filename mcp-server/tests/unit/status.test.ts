import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
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
})
