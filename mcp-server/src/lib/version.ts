/**
 * Single source of truth for the rsct-mcp server version.
 *
 * Bumped per release; imported by `src/index.ts` (boot log), `src/tools/status.ts`
 * (status output), and `src/tools/load-context.ts` (load-context output). Adding
 * a new consumer? Import from here — do NOT duplicate the literal, or the next
 * bump will desync (the post-v0.3.0 bump caught load-context.ts out of sync;
 * post-v0.4.0 caught status.ts).
 *
 * MUST stay in lockstep with `mcp-server/package.json` `"version"`. CAP-15
 * (v0.7.0) caught these drifted: this file was at 0.6.7 while package.json
 * was still at 0.2.1, so `npm install -g rsct-mcp` reported "up to date"
 * against the stale package version even after the binary changed. Bump
 * BOTH on every release, or `npm install -g` will silently skip the new
 * binary.
 */
export const RSCT_MCP_VERSION = '1.1.0'
