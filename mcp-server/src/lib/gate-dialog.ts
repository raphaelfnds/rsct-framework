import { anchorFor, repositoryDialogLine } from './repo-anchor.js'
import { decideAuditPath } from './audit-log.js'
import {
  effectiveProtectedList,
  narrowedProtectionNotice,
  type BranchProtectionConfig,
} from './branch-protection.js'
import type { RsctAuditConfig } from './project-root.js'

/**
 * #92 defects A + F — what every §C dialog owes the developer, in one place.
 *
 * Two facts, and neither was on any dialog before this. MEASURED across
 * `request-commit.ts:418-421`, `request-push.ts:488-497`,
 * `request-merge.ts:363-371`, `plan-authorize.ts:162-163` and
 * `request-rebase.ts:234-235`: every message named a branch, a commit message
 * or refs, and NONE named the repository.
 *
 * That absence is what carried the crafted-root findings past the human. In the
 * measured `plan_authorize` probe the developer read *"Authorize batch commits
 * for this plan on 'main'?"* — true, complete and useless, because `main` IS
 * the real branch: git had walked up to the real repository while every anchor
 * stayed in the crafted directory. Naming the target is what makes the sentence
 * decidable.
 *
 * Pass `config` only from tools that actually gate on branch protection; the
 * narrowing notice is noise on a tool that does not.
 */
export function gateDialogFooter(
  projectRoot: string,
  config?: BranchProtectionConfig,
): string {
  const notice = config === undefined ? '' : narrowedProtectionNotice(effectiveProtectedList(config))
  return `\n\n${repositoryDialogLine(projectRoot)}${notice ? `\n${notice}` : ''}`
}

/**
 * The same facts for the tool's OUTPUT, because the dialog is not always there.
 *
 * `gateRequest` falls back to the `trust` channel when no dialog channel exists
 * (headless, CI), and on that path {@link gateDialogFooter} is never rendered.
 * A relocation that is only announced in a dialog is therefore invisible
 * exactly where nobody is watching — so it rides `hints[]` as well.
 *
 * Relocation is reported, never refused: D1. It is the fix, not the fault, and
 * refusing would break the monorepo-package and nested-project setups measured
 * legitimate in R-6.
 */
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
  return hints
}
