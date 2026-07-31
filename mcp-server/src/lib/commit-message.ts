import type { RsctConfig } from './project-root.js'

/**
 * Commit-message shape guard (issue #20). Everything else about a commit is
 * gated — authorization, branch protection, the secrets scan, the contract
 * surface — except its message, which was the one part left entirely to agent
 * judgement. Agent judgement defaults to exhaustive: bodies re-narrated the diff
 * file by file, so `git log` stopped being scannable and the message aged badly.
 *
 * Length only. No opinion on Conventional Commits, subject grammar or trailers.
 */

export const COMMIT_MESSAGE_MAX_LINES_DEFAULT = 15
const MIN_LIMIT = 1
/** Wide on purpose — the guard exists to catch runaway prose, not to be tuned. */
const MAX_LIMIT = 500

/**
 * Non-empty lines in a message. Blank lines are NOT counted, so paragraph
 * spacing is never penalized — the limit is about content, not layout. Line
 * endings are NORMALIZED, not stripped, so a message counts the same on every
 * OS (CLAUDE.md anti-pattern #4): deleting every `\r` instead would collapse
 * CR-separated text into a single line and let it slip under the cap.
 */
export function countNonEmptyLines(message: string): number {
  return message
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim().length > 0).length
}

/**
 * Effective limit: `.rsct.json` `commit_message_max_lines`, else the default.
 * The value is clamped rather than validated in the schema — the HIGH-4 posture
 * nulls the ENTIRE config on an out-of-bounds bounded field, which would be a
 * wildly disproportionate outcome for a cosmetic cap.
 */
export function resolveCommitMessageMaxLines(config: RsctConfig | null | undefined): number {
  const v = config?.commit_message_max_lines
  if (v === undefined || !Number.isFinite(v)) return COMMIT_MESSAGE_MAX_LINES_DEFAULT
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(v)))
}

export interface CommitMessageCheck {
  ok: boolean
  lines: number
  limit: number
  /** Populated only when `ok` is false. Self-describing on purpose. */
  reason: string | null
}

/**
 * The hint has to carry the whole rule: the `rules/` prose explaining this never
 * reaches an already-installed project, because `/rsct-setup` does not overwrite
 * existing rules content. So a dev meeting this rejection for the first time
 * learns the limit, their actual count and the config key from the message.
 */
export function checkCommitMessage(
  message: string,
  config: RsctConfig | null | undefined,
): CommitMessageCheck {
  const limit = resolveCommitMessageMaxLines(config)
  const lines = countNonEmptyLines(message)
  if (lines <= limit) return { ok: true, lines, limit, reason: null }
  return {
    ok: false,
    lines,
    limit,
    reason:
      `commit message has ${lines} non-empty lines; the limit is ${limit}. ` +
      `Say what changed and why — the diff already shows the file-by-file detail. ` +
      `Blank lines are not counted. Raise the cap with "commit_message_max_lines" in .rsct.json if this project wants longer messages.`,
  }
}
