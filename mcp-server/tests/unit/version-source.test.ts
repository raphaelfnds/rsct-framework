import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RSCT_MCP_VERSION } from '../../src/lib/version.js'

// Issue #7 / PH-6 — single-source-of-truth invariant. `/VERSION` (repo root) is the
// ONE hand-edited product version; version.ts + package.json are DERIVED mirrors
// (synced by scripts/sync-version.mjs). This test pins the three in lockstep, so a
// bump that edits /VERSION without running `npm run sync-version` fails in CI on
// every OS — the belt to install.sh's two-axis-report suspenders.
//
// Path note (V-P0, asymmetric): from mcp-server/tests/unit/ the repo root is THREE
// levels up (unit -> tests -> mcp-server -> root); package.json is TWO up (mcp-server).
const VERSION_FILE = readFileSync(resolve(__dirname, '..', '..', '..', 'VERSION'), 'utf8')
  .replace(/\r/g, '')
  .trim()
const PKG = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
) as { version: string }

describe('version single-source (issue #7 / PH-6)', () => {
  it('/VERSION is a plain X.Y.Z product version', () => {
    expect(VERSION_FILE).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('version.ts RSCT_MCP_VERSION mirrors /VERSION', () => {
    expect(RSCT_MCP_VERSION).toBe(VERSION_FILE)
  })

  it('package.json version mirrors /VERSION', () => {
    expect(PKG.version).toBe(VERSION_FILE)
  })
})
