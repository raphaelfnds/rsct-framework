import { isNewer } from './update-check.js'

/**
 * Install-drift notice: is the project's recorded RSCT version older than the
 * running `rsct-mcp` binary? A project's `.rsct.json` `rsct_version` is the
 * product/release version stamped at install time; the binary's
 * `RSCT_MCP_VERSION` moves when the framework is updated. When the binary is
 * strictly newer, the project's installed rules/prompts/markers are behind the
 * framework and a `/rsct-setup` re-run applies the current version.
 *
 * This is a LOCAL comparison — no network, no consent, no cache. It is
 * deliberately separate from `update-check.ts` (which checks the binary against
 * the latest GitHub release and is opt-in / network-gated): mixing an always-on
 * local compare into that module would break its "no network/writes before
 * consent" invariant. The two are complementary and independent axes.
 *
 * Always fail-safe and SUGGEST-ONLY: a null/absent/unparseable `rsct_version`,
 * an equal version, or a project NEWER than the binary all yield `{hint:null}`.
 * `isNewer` returns false on anything it can't parse, so a malformed value never
 * produces a false "update available".
 */
export function getInstallDriftNotice(
  projectVersion: string | null | undefined,
  mcpVersion: string,
): { hint: string | null } {
  if (!projectVersion) return { hint: null }
  if (!isNewer(mcpVersion, projectVersion)) return { hint: null }
  // Strip a hand-edited leading `v` in the DISPLAY text (the compare in isNewer
  // already normalizes it). `.rsct.json` `rsct_version` is schema-typed as a
  // free string, so `"v2.0.0"` is possible — avoid rendering "vv2.0.0".
  const p = projectVersion.replace(/^v/, '')
  const m = mcpVersion.replace(/^v/, '')
  return {
    hint:
      `This project was set up with RSCT v${p}; the installed rsct-mcp is v${m}. ` +
      `Re-run /rsct-setup to apply the current version's rules/prompts to this project. (suggestion only)`,
  }
}
