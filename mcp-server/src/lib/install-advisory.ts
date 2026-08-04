import { appendAuditEntry } from './audit-log.js'
import type { RsctAuditConfig } from './project-root.js'
import { getInstallDriftNotice } from './version-drift.js'
import { RSCT_MCP_VERSION } from './version.js'

/**
 * The security-tier install-drift advisory, in the one shape every §C-gated
 * mutating tool needs (#25).
 *
 * #16 surfaced this warning in `rsct_status`, `rsct_load_context` and
 * `rsct_request_commit`. Two gaps remained, and both are about REACH rather than
 * enforcement:
 *
 *  - It never entered the **OS dialog** — the one out-of-band channel the agent
 *    cannot rewrite or summarize away. It rode `hints[]`, which the agent relays
 *    at its discretion.
 *  - `rsct_request_push` and `rsct_request_merge` did not carry it at all, even
 *    though `rules/C-reauthorize.md` singles those two out as needing fresh
 *    per-action approval precisely because they are outward-facing and hard to
 *    reverse. Degraded enforcement matters MORE there, and that is exactly where
 *    the warning was silent.
 *
 * Centralised here rather than copied into each tool: three inline copies of a
 * severity check, an audit payload and a message string is how they drift, and
 * this one is a security claim.
 *
 * Never blocks. Never throws — a drift check that could fail a push would be a
 * worse bug than the drift it reports.
 */

export interface InstallAdvisory {
  /** Prepend to `hints[]`. Null when there is nothing to say. */
  hint: string | null
  /**
   * One short line for the §C dialog, or null. Deliberately terse: the dialog is
   * a decision surface, not a report, and a wall of text there trains the dev to
   * dismiss it unread.
   */
  dialogLine: string | null
  /** True when enforcement is provably not running. */
  isSecurity: boolean
}

const NONE: InstallAdvisory = { hint: null, dialogLine: null, isSecurity: false }

/**
 * Evaluate the advisory and record it. The audit entry is written HERE, at
 * evaluation time, because it records that a mutation was ATTEMPTED under a
 * degraded enforcement surface — which is the fact worth reconstructing later,
 * whether or not the attempt went on to succeed.
 */
export function evaluateInstallAdvisory(args: {
  projectRoot: string
  rsctInstalled: boolean
  projectVersion: string | null | undefined
  auditConfig: RsctAuditConfig | undefined
  /** MCP tool name, for the audit payload. */
  tool: string
  /** Test seam. */
  auditWriter?: typeof appendAuditEntry
}): InstallAdvisory {
  if (!args.rsctInstalled) return NONE

  const drift = getInstallDriftNotice({
    projectRoot: args.projectRoot,
    projectVersion: args.projectVersion ?? null,
    mcpVersion: RSCT_MCP_VERSION,
  })
  if (drift.severity !== 'security' || !drift.hint) return NONE

  const appendAudit = args.auditWriter ?? appendAuditEntry
  appendAudit(
    args.projectRoot,
    {
      event: 'install.drift_detected',
      tool: args.tool,
      project_version: args.projectVersion ?? null,
      mcp_version: RSCT_MCP_VERSION,
      severity: drift.severity,
      affected_components: drift.affected_components,
    },
    args.auditConfig,
  )

  return {
    hint: drift.hint,
    dialogLine: '⚠ RSCT enforcement is NOT running in this project (see hints).',
    isSecurity: true,
  }
}
