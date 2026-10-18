import { appendAuditEntry } from './audit-log.js'
import type { RsctAuditConfig } from './project-root.js'
import { getInstallDriftNotice } from './version-drift.js'
import { RSCT_MCP_VERSION } from './version.js'

export interface InstallAdvisory {
  hint: string | null
  dialogLine: string | null
  isSecurity: boolean
}

const NONE: InstallAdvisory = { hint: null, dialogLine: null, isSecurity: false }

export function evaluateInstallAdvisory(args: {
  projectRoot: string
  rsctInstalled: boolean
  projectVersion: string | null | undefined
  auditConfig: RsctAuditConfig | undefined
  tool: string
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
      ...(drift.hooks_disabled && { hooks_disabled: drift.hooks_disabled }),
    },
    args.auditConfig,
  )

  return {
    hint: drift.hint,
    dialogLine: '⚠ RSCT enforcement is NOT running in this project (see hints).',
    isSecurity: true,
  }
}
