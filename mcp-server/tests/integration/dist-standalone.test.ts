import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Self-contained dist guard (block feat/dist-self-contained). The built
// `dist/index.js` MUST run with NO `node_modules` available — the runtime deps
// (@modelcontextprotocol/sdk, pino, zod) are bundled in via tsup `noExternal`.
// We copy the built bundle into a temp dir OUTSIDE the repo (so Node cannot
// resolve the repo's node_modules from there) and drive a real MCP handshake.
// If anyone drops `noExternal`, the bundle reverts to importing those deps and
// this test fails with a module-resolution error — exactly the 2026-06-22
// "no mcp__rsct__* tools" incident, now caught in CI.

const DIST = resolve(__dirname, '..', '..', 'dist', 'index.js')

const HANDSHAKE = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
  '',
].join('\n')

function runStandalone(): { stdout: string; stderr: string } {
  // Build first (CI does `npm run build` before tests); fail loud if missing
  // rather than silently passing on a stale/absent bundle.
  if (!existsSync(DIST)) {
    throw new Error(`dist/index.js not found at ${DIST} — run \`npm run build\` before this test`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'rsct-standalone-'))
  try {
    const standalone = join(dir, 'index.js')
    copyFileSync(DIST, standalone)
    // spawnSync captures BOTH streams regardless of exit code (the stdio server
    // exits 0 when stdin EOFs; execFileSync would then return only stdout).
    const r = spawnSync('node', [standalone], {
      input: HANDSHAKE,
      cwd: dir, // outside the repo → no node_modules up the tree
      env: { ...process.env, RSCT_PROJECT_ROOT: dir },
      encoding: 'utf8',
      timeout: 20_000,
    })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('dist is self-contained (runs with no node_modules)', () => {
  it('boots and lists tools from a temp dir outside the repo', () => {
    const { stdout, stderr } = runStandalone()
    // No module-resolution / dynamic-require failure (the regression signature).
    expect(stderr, stderr).not.toMatch(/Cannot find package|ERR_MODULE_NOT_FOUND|Dynamic require of/)
    // The server logged readiness on stderr (pino → fd 2).
    expect(stderr).toMatch(/rsct-mcp ready/)
    // tools/list returned the full tool set.
    const tools = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .find((m) => m && m.id === 2)?.result?.tools
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThanOrEqual(29)
  }, 30_000)
})
