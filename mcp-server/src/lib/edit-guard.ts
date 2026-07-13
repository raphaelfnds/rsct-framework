import { matchesAnyGlob, readPhaseState } from './phase-scope.js'

/**
 * plan-lifecycle-v2 — Bloco 3.3: the decision layer behind the PreToolUse
 * Edit/Write guard. Given a resolved project root + the file being edited, it
 * returns allow|block. This is the MECHANICAL half of item 5 (D1) — it is what
 * a real block-capable hook consumes, distinct from the advisory
 * rsct_check_edit_scope query.
 *
 * FAIL-OPEN on machinery faults, FAIL-CLOSED on policy:
 *  - Not an RSCT project (no .rsct.json) ⇒ allow (unmanaged — trivial edits
 *    proceed).
 *  - phase-state unreadable/unparseable (EACCES/EIO/corrupt) ⇒ allow with
 *    `infra_error` — a broken read is an infra fault, never a policy block, so
 *    a genuinely broken guard can never brick editing.
 *  - context_stale set ⇒ BLOCK (the explicit re-bootstrap signal).
 *  - no active phase / empty scope ⇒ allow `unknown` (nothing to enforce).
 *  - in scope ⇒ allow; out of scope ⇒ BLOCK.
 *
 * HONEST BOUNDARY (do NOT overstate): this guards the four editor tools only.
 * The Bash tool is ungated, so a Bash-mediated edit — or Bash-deleting
 * .rsct.json / phase-state.json — defeats it entirely (documented residual).
 * The matcher is a soft ceiling, not a tamper-proof lock. Never throws.
 */
export type EditGuardStatus =
  | 'in_scope'
  | 'out_of_scope'
  | 'unknown'
  | 'stale_context'
  | 'unmanaged'
  | 'infra_error'

export interface EditGuardResult {
  decision: 'allow' | 'block'
  status: EditGuardStatus
  reason: string
}

export function evaluateEditGuard(args: {
  projectRoot: string
  rsctInstalled: boolean
  filePath: string
}): EditGuardResult {
  try {
    if (!args.rsctInstalled) {
      return { decision: 'allow', status: 'unmanaged', reason: 'no .rsct.json — unmanaged project' }
    }
    const read = readPhaseState(args.projectRoot)
    // A read/parse fault (EACCES/EIO/corrupt) surfaces as parse_error here —
    // treat it as an INFRA fault and fail-OPEN (never block on a broken read).
    if (read.parse_error) {
      return { decision: 'allow', status: 'infra_error', reason: `phase-state unreadable: ${read.parse_error}` }
    }
    const state = read.state
    if (state?.context_stale) {
      return {
        decision: 'block',
        status: 'stale_context',
        reason: 'context is STALE (a plan closed / pivot) — run rsct_status + rsct_load_context before editing',
      }
    }
    const scopeGlobs = state?.scope_globs ?? []
    if (!read.exists || state === null || scopeGlobs.length === 0) {
      return { decision: 'allow', status: 'unknown', reason: 'no active phase scope to enforce' }
    }
    const match = matchesAnyGlob(args.filePath, scopeGlobs, args.projectRoot)
    if (match.matched) {
      return { decision: 'allow', status: 'in_scope', reason: `in scope via '${match.matched_glob}'` }
    }
    return {
      decision: 'block',
      status: 'out_of_scope',
      reason: `'${args.filePath}' is OUTSIDE the active spec scope — expand scope_globs (with dev approval) or re-plan`,
    }
  } catch (err) {
    // Any unexpected machinery fault ⇒ fail-OPEN so a broken guard never bricks editing.
    return {
      decision: 'allow',
      status: 'infra_error',
      reason: `edit-guard fault: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
