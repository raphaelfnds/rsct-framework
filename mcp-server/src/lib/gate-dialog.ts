import { anchorFor, repositoryDialogLine } from './repo-anchor.js'
import { decideAuditPath, type AuditPathUnusable } from './audit-log.js'
import { DIALOG_UNCUT, specLabel } from './dialog-text.js'
import {
  effectiveProtectedList,
  narrowedProtectionNotice,
  type BranchProtectionConfig,
} from './branch-protection.js'
import type { RsctAuditConfig } from './project-root.js'

export function gateDialogFooter(
  projectRoot: string,
  config?: BranchProtectionConfig,
): string {
  const notice = config === undefined ? '' : narrowedProtectionNotice(effectiveProtectedList(config))
  return `\n\n${repositoryDialogLine(projectRoot)}${notice ? `\n${specLabel(notice, DIALOG_UNCUT)}` : ''}`
}

export function anchorHints(
  projectRoot: string,
  auditConfig?: RsctAuditConfig,
): string[] {
  const hints: string[] = []
  const anchor = anchorFor(projectRoot)
  if (anchor.detail !== null && anchor.status !== 'not-applicable') {
    hints.push(`ℹ ${anchor.detail}`)
  }
  const decision = decideAuditPath(projectRoot, auditConfig)
  if (decision.escaped !== null) {
    hints.push(
      `⚠ .rsct.json audit.path ("${decision.escaped.replace(/\\/g, '/')}") resolves OUTSIDE ` +
        `the project and was ignored — the audit log stays at ` +
        `${decision.path.replace(/\\/g, '/')}. An audit log outside the repository can be ` +
        `swapped for a blank one without touching the project.`,
    )
  }
  if (decision.unusable !== null) {
    hints.push(
      `⚠ .rsct.json audit.path (${JSON.stringify(decision.unusable.path)}) ${UNUSABLE_AUDIT_PATH[decision.unusable.reason]} ` +
        `and was ignored — the audit log stays at ${decision.path.replace(/\\/g, '/')}.`,
    )
  }
  return hints
}

const UNUSABLE_AUDIT_PATH: Record<AuditPathUnusable, string> = {
  stream: 'names a stream inside a file, which no file listing or editor shows,',
  name: 'holds a character or a name RSCT does not accept for the audit log (a control character, or on Windows < > " | ? *, a reserved device name such as NUL, or a name ending in a dot or a space),',
  not_a_file: 'names a folder, or a path through a file, where no log can be written,',
}
