#!/usr/bin/env node
// Single-source version propagator (issue #7 / PH-6).
//
// `/VERSION` (repo root) is the ONE hand-edited product version. This script reads
// it and syncs the derived mirrors:
//   - mcp-server/src/lib/version.ts   (code axis — the bundled RSCT_MCP_VERSION)
//   - mcp-server/package.json + package-lock.json  (via `npm version`)
//
// Release flow: edit `/VERSION`, then `npm run sync-version` (from mcp-server/),
// then rebuild. NOT run in CI/tests — the parity test only READS these files.
//
// Cross-OS: pure Node (no `sed -i` BSD/GNU split); paths derived from this file's
// own URL (never process.cwd() — the repo root has no package.json); `npm version`
// keeps package.json + lock in lockstep with `--no-git-tag-version` (no tag/commit,
// honoring the "no tag until the release gate" constraint) + `--allow-same-version`
// (staying at the same version is a no-op, not an error).
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const mcpDir = fileURLToPath(new URL('../mcp-server', import.meta.url))
const versionPath = fileURLToPath(new URL('../VERSION', import.meta.url))
const vtsPath = fileURLToPath(new URL('../mcp-server/src/lib/version.ts', import.meta.url))

// 1. Read the single source (CRLF-safe + trim + plain-semver guard).
const version = readFileSync(versionPath, 'utf8').replace(/\r/g, '').trim()
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`sync-version: /VERSION is not a plain X.Y.Z version: '${version}'`)
  process.exit(1)
}

// 2. version.ts — replace ONLY the RSCT_MCP_VERSION literal (preserve the docstring).
// The whitespace-flexible regex is the single source of "is the literal here?" — the
// fail-loud guard reuses it (not a fixed-spacing substring), so a future reformat of
// version.ts can't cause a false "literal not found".
const VERSION_LITERAL = /(RSCT_MCP_VERSION\s*=\s*')[^']+(')/
const vts = readFileSync(vtsPath, 'utf8')
if (!VERSION_LITERAL.test(vts)) {
  console.error('sync-version: could not find the RSCT_MCP_VERSION literal in version.ts')
  process.exit(1)
}
const nextVts = vts.replace(VERSION_LITERAL, `$1${version}$2`)
if (nextVts !== vts) writeFileSync(vtsPath, nextVts)

// 3. package.json + package-lock.json — npm maintains both; no git tag/commit.
execSync(`npm version ${version} --no-git-tag-version --allow-same-version`, {
  cwd: mcpDir,
  stdio: 'inherit',
})

console.log(`sync-version: ${version} -> version.ts + package.json + package-lock.json`)
