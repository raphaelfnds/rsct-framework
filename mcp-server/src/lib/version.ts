/**
 * The rsct-mcp server version (CODE axis) — the bundled `RSCT_MCP_VERSION` literal
 * imported by `src/index.ts` (boot log), `src/tools/status.ts`, `src/tools/load-context.ts`,
 * and `src/tools/update-check.ts`. Adding a new consumer? Import from here — do NOT
 * duplicate the literal.
 *
 * NOT the single edit point (issue #7 / PH-6): the ONE hand-edited product version
 * lives in `/VERSION` at the repo root. This literal is a DERIVED mirror written by
 * `scripts/sync-version.mjs` (run `npm run sync-version` after editing `/VERSION`).
 * Do NOT hand-edit this value — it will drift from `/VERSION` (the CI parity test
 * `version-source.test.ts` and install.sh's two-axis report both catch that). MUST
 * stay in lockstep with `mcp-server/package.json` `"version"`, which sync-version
 * also updates via `npm version`. CAP-15 (v0.7.0) caught these drifted (0.6.7 vs
 * 0.2.1) → `npm install -g` reported "up to date" against a stale package.
 */
export const RSCT_MCP_VERSION = '2.0.0'
