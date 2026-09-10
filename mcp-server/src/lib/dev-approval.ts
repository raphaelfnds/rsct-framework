import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ensureParentDir } from './io-utils.js'
import { anchorFor } from './repo-anchor.js'
import { decideAuditPath } from './audit-log.js'
import type { RsctApprovalModes, RsctAuditConfig } from './project-root.js'

/**
 * The audit event that records a consumed approval. Written beside the store,
 * read back as the other half of the anti-reuse union.
 *
 * `reason` is deliberately NOT recorded: the store already omits it, it is free
 * developer text, and the audit log must not carry free-form payload that may
 * contain secrets.
 */
const APPROVAL_CONSUMED_EVENT = 'approval.consumed'

/**
 * Schema for the `dev_approval` payload required by every §C-gated tool
 * (INV-2/2.1/2.2). Strict: unknown keys are rejected so a fabricated
 * payload with extra "trust" markers cannot smuggle through.
 *
 * Optional override blocks (INV-9) carry a `reason` field that lands in
 * the audit log so any rule waiver is always attributable.
 */
export const DevApprovalSchema = z
  .object({
    timestamp: z.string().min(1, 'timestamp required'),
    action_scope: z.string().min(1, 'action_scope required'),
    reason: z.string().min(1, 'reason required'),
    override_protected_branch: z
      .object({ reason: z.string().min(1, 'override reason required') })
      .strict()
      .optional(),
    override_secrets_check: z
      .object({ reason: z.string().min(1, 'override reason required') })
      .strict()
      .optional(),
    // T2/INV-7: waive the contract-surface block (multi-repo mode). Parallel to
    // the other overrides — the token path carries none, so under a plan token a
    // surface-touching commit is a hard block until a per-action dev_approval.
    override_contract_surface: z
      .object({ reason: z.string().min(1, 'override reason required') })
      .strict()
      .optional(),
  })
  .strict()

export type DevApproval = z.infer<typeof DevApprovalSchema>

export type FabricationSignal =
  | 'reason_too_short'
  | 'implausibly_fast'
  | 'approvals_store_corrupt'
  /**
   * #92 — the anti-reuse store is ABSENT. A corrupt store already raised a
   * signal; an absent one raised nothing, and MEASURED, `loadStore` reports
   * `corrupt: false` for a missing file. So `rm .rsct/approvals-seen.json` was
   * indistinguishable from a fresh project. It stays a signal rather than a
   * rejection because a genuinely fresh project has no store either — the
   * audit half of the union is what actually catches the replay.
   */
  | 'approvals_store_absent'
  | 'scope_mismatch'
  | 'burst_pattern'
  // plan-lifecycle-v2 (Bloco 1.3): the declared task tier is trivial/small but
  // the real staged volume of a free commit exceeds the free-lane caps. Emitted
  // by the commit handler (NOT the gate — the free/token paths never call
  // validateDevApproval), and it locks the free budget rather than rejecting.
  | 'tier_volume_divergence'

export type ValidateResult =
  | {
      status: 'rejected'
      reason: string
      fabrication_signals: FabricationSignal[]
    }
  | {
      status: 'valid'
      approval: DevApproval
      fabrication_signals: FabricationSignal[]
      must_force_dialog: boolean
    }

export interface ValidateOptions {
  projectRoot: string
  approvalModes?: RsctApprovalModes
  now?: Date
  /**
   * Optional name of the §C-gated tool invoking validation. When set, the
   * `scope_mismatch` signal fires if `action_scope` does not start with
   * the expected token for that tool (see {@link EXPECTED_SCOPE_TOKEN}).
   * Forwarded automatically by {@link gateRequest}.
   */
  toolName?: string
  /**
   * `.rsct.json` `audit` block, so the audit half of the anti-reuse union reads
   * the same file the consumption was written to. Omitting it is safe but
   * narrower: a project that configured `audit.path` would have its consumption
   * records written and read at the default location instead, which keeps the
   * two halves consistent with each other while splitting them from the rest of
   * the log. Every gated call site forwards it.
   */
  auditConfig?: RsctAuditConfig | undefined
}

/**
 * Per-tool prefix that `dev_approval.action_scope` must start with
 * (token before the first ':'). Used by `scope_mismatch` detection.
 * Tools not in this map skip the check.
 */
const EXPECTED_SCOPE_TOKEN: Record<string, string> = {
  rsct_request_commit: 'commit',
  rsct_request_push: 'push',
  rsct_request_merge: 'merge',
  rsct_phase_verification_complete: 'verification_complete',
  rsct_phase_research_complete: 'research_complete',
  rsct_phase_spec_complete: 'spec_complete',
  rsct_phase_code_complete: 'code_complete',
  rsct_phase_review_complete: 'review_complete',
  rsct_phase_test_complete: 'test_complete',
  rsct_phase_abandon: 'phase_abandon',
  rsct_capture_issue: 'capture_issue',
  rsct_plan_authorize: 'plan_authorize',
}

const BURST_WINDOW_MS = 10000
const BURST_THRESHOLD_PRIOR = 3

// Default raised from 60s in M2 gate run: observed 78-155s latency between
// timestamp capture (via Bash tool) and tool execution in AI-driven flows
// where each step triggers a Claude Code permission prompt. 180s accommodates
// the common AI roundtrip while still bounding replay risk to a single
// short-duration approval window. Projects can override via
// `.rsct.json` `approval_modes.timestamp_skew_seconds`.
const DEFAULT_SKEW_SECONDS = 180
const DEFAULT_FABRICATION_THRESHOLD_MS = 500
const MIN_REASON_LENGTH = 10

const APPROVALS_STORE_RELATIVE = '.rsct/approvals-seen.json'

interface StoredEntry {
  action_scope: string
  timestamp: string
  consumed_at: string
}

interface ApprovalsStore {
  version: 1
  entries: StoredEntry[]
}

/**
 * #92 — the anti-reuse store follows the REPOSITORY, not the declared root.
 *
 * MEASURED before the change: the identical `dev_approval` payload was rejected
 * as reused at the real root and accepted as valid at a crafted subdirectory of
 * the same repository — and on a host with no dialog channel it was then
 * approved via `channel: 'trust'` with no fabrication signals. INV-2, "one
 * approval, one action", was not durable, because the store that proves an
 * approval was spent lived inside the thing being relocated.
 */
function resolveStorePath(projectRoot: string): string {
  return join(anchorFor(projectRoot).root, APPROVALS_STORE_RELATIVE)
}

/**
 * The audit half of the anti-reuse check.
 *
 * The store alone cannot answer "was this approval already spent": MEASURED,
 * `loadStore` returns an empty store for an ABSENT file with `corrupt: false`,
 * so `rm .rsct/approvals-seen.json` is indistinguishable from a fresh project.
 * The log is append-only and now repository-bound, so a consumption recorded
 * there survives deleting the store.
 *
 * An idea that looked obvious and was REFUTED before this was written: deriving
 * this from the existing log as-is. No audit event carried `action_scope` or
 * `timestamp` — they appeared only in tool descriptions and one warning string —
 * so there was nothing to cross-check against. Recording them is the addition
 * that makes the union possible, not a free ride.
 */
function consumedInAudit(
  projectRoot: string,
  auditConfig: RsctAuditConfig | undefined,
  approval: { action_scope: string; timestamp: string },
): { thisApproval: boolean; anyEverRecorded: boolean } {
  let anyEverRecorded = false
  try {
    const path = decideAuditPath(projectRoot, auditConfig).path
    if (!existsSync(path)) return { thisApproval: false, anyEverRecorded }
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      // A cheap pre-filter: the overwhelming majority of lines are not approval
      // records, and this scan runs on the validation path of every gated tool.
      if (!trimmed.includes(APPROVAL_CONSUMED_EVENT)) continue
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>
        if (entry['event'] !== APPROVAL_CONSUMED_EVENT) continue
        anyEverRecorded = true
        if (
          entry['action_scope'] === approval.action_scope &&
          entry['approval_timestamp'] === approval.timestamp
        ) {
          return { thisApproval: true, anyEverRecorded: true }
        }
      } catch {
        continue
      }
    }
  } catch {
    // Unreadable log ⇒ the store is the only witness. Returning false here is
    // the same posture the store's own absence takes; it never invents a reuse.
  }
  return { thisApproval: false, anyEverRecorded }
}

function loadStore(projectRoot: string): {
  store: ApprovalsStore
  corrupt: boolean
  absent: boolean
} {
  const path = resolveStorePath(projectRoot)
  if (!existsSync(path)) {
    return { store: { version: 1, entries: [] }, corrupt: false, absent: true }
  }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as ApprovalsStore).entries)
    ) {
      return { store: { version: 1, entries: [] }, corrupt: true, absent: false }
    }
    return { store: parsed as ApprovalsStore, corrupt: false, absent: false }
  } catch {
    return { store: { version: 1, entries: [] }, corrupt: true, absent: false }
  }
}

function lastConsumedAt(store: ApprovalsStore): Date | null {
  let latest: Date | null = null
  for (const entry of store.entries) {
    const d = new Date(entry.consumed_at)
    if (Number.isNaN(d.getTime())) continue
    if (!latest || d > latest) latest = d
  }
  return latest
}

/**
 * Validate a raw `dev_approval` payload against the §C contract.
 *
 * Returns one of:
 *  - `{ status: 'rejected', reason, ... }`  — schema invalid, timestamp out of skew,
 *    or `(action_scope, timestamp)` reused from a prior consumption (INV-2).
 *  - `{ status: 'valid', must_force_dialog, fabrication_signals, ... }` — proceed.
 *    `must_force_dialog === true` when fabrication signals fired (INV-2.2): the
 *    caller MUST spawn the OS dialog even if `trust_allowed_for[]` would normally
 *    suppress it.
 *
 * Pure read: does NOT mutate the anti-reuse store. Callers register a successful
 * mutation via `recordConsumedApproval()` after the tool's side-effects land.
 */
export function validateDevApproval(
  raw: unknown,
  options: ValidateOptions,
): ValidateResult {
  const parsed = DevApprovalSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const reason = issue
      ? `dev_approval schema invalid at '${issue.path.join('.') || '(root)'}': ${issue.message}`
      : 'dev_approval schema invalid'
    return { status: 'rejected', reason, fabrication_signals: [] }
  }

  const approval = parsed.data
  const now = options.now ?? new Date()
  const skewSeconds =
    options.approvalModes?.timestamp_skew_seconds ?? DEFAULT_SKEW_SECONDS
  const fabricationThresholdMs =
    options.approvalModes?.fabrication_signal_threshold_ms ??
    DEFAULT_FABRICATION_THRESHOLD_MS

  const tsDate = new Date(approval.timestamp)
  if (Number.isNaN(tsDate.getTime())) {
    return {
      status: 'rejected',
      reason: `dev_approval.timestamp is not a parseable date: ${approval.timestamp}`,
      fabrication_signals: [],
    }
  }
  const diffMs = now.getTime() - tsDate.getTime()
  const skewMs = skewSeconds * 1000
  if (diffMs > skewMs) {
    return {
      status: 'rejected',
      reason: `dev_approval.timestamp is older than ${skewSeconds}s skew tolerance (diff=${Math.round(diffMs / 1000)}s)`,
      fabrication_signals: [],
    }
  }
  if (diffMs < -skewMs) {
    return {
      status: 'rejected',
      reason: `dev_approval.timestamp is more than ${skewSeconds}s in the future (diff=${Math.round(-diffMs / 1000)}s)`,
      fabrication_signals: [],
    }
  }

  const { store, corrupt, absent } = loadStore(options.projectRoot)
  const signals: FabricationSignal[] = []
  if (corrupt) signals.push('approvals_store_corrupt')

  // #92 — consumed is the UNION of the store and the append-only audit log.
  // Either witness alone is defeatable: the store by `rm`, and the log only by
  // an edit that the log's own append-only shape and its repository binding
  // make visible. A partial write failure therefore degrades to SAFE — one
  // witness marking the approval spent is enough.
  const audit = consumedInAudit(options.projectRoot, options.auditConfig, approval)

  // The store being ABSENT is only suspicious when the log proves this project
  // has consumed approvals before — that is a DELETED store, not a fresh one.
  // Raising it on absence alone was measured wrong: every genuinely new project
  // starts without the file, so the signal fired on the first approval of every
  // project and, because any signal forces the dialog, it broke the headless
  // `trust` fallback in CI. The union is what makes the distinction possible.
  if (absent && audit.anyEverRecorded) signals.push('approvals_store_absent')

  const reused =
    store.entries.some(
      (e) => e.action_scope === approval.action_scope && e.timestamp === approval.timestamp,
    ) || audit.thisApproval
  if (reused) {
    return {
      status: 'rejected',
      reason: `dev_approval reused (action_scope='${approval.action_scope}', timestamp='${approval.timestamp}')`,
      fabrication_signals: signals,
    }
  }

  if (approval.reason.trim().length < MIN_REASON_LENGTH) {
    signals.push('reason_too_short')
  }

  const lastConsumed = lastConsumedAt(store)
  if (lastConsumed) {
    const gapMs = now.getTime() - lastConsumed.getTime()
    if (gapMs >= 0 && gapMs < fabricationThresholdMs) {
      signals.push('implausibly_fast')
    }
  }

  if (detectScopeMismatch(approval.action_scope, options.toolName)) {
    signals.push('scope_mismatch')
  }

  if (detectBurstPattern(store, now)) {
    signals.push('burst_pattern')
  }

  return {
    status: 'valid',
    approval,
    fabrication_signals: signals,
    must_force_dialog: signals.length > 0,
  }
}

function detectScopeMismatch(
  actionScope: string,
  toolName: string | undefined,
): boolean {
  if (!toolName) return false
  const expected = EXPECTED_SCOPE_TOKEN[toolName]
  if (expected === undefined) return false
  const firstToken = actionScope.split(':')[0]
  return firstToken !== expected
}

function detectBurstPattern(store: ApprovalsStore, now: Date): boolean {
  const cutoff = now.getTime() - BURST_WINDOW_MS
  let recent = 0
  for (const entry of store.entries) {
    const t = new Date(entry.consumed_at).getTime()
    if (Number.isNaN(t)) continue
    if (t >= cutoff) {
      recent++
      if (recent >= BURST_THRESHOLD_PRIOR) return true
    }
  }
  return false
}

export interface RecordOptions {
  projectRoot: string
  now?: Date
  /** See {@link ValidateOptions.auditConfig} — the two must agree. */
  auditConfig?: RsctAuditConfig | undefined
}

export type RecordResult =
  | { ok: true; path: string }
  | { ok: false; path: string; error: string }

/**
 * Append a consumed approval to `.rsct/approvals-seen.json` via atomic
 * write (tmp-then-rename). Safe to call AFTER a §C-gated mutation has
 * landed, so a failed mutation doesn't burn the approval.
 *
 * Never throws — returns `{ ok: false }` on I/O failure so the caller
 * can surface the error to the dev without aborting the tool result.
 */
export function recordConsumedApproval(
  approval: DevApproval,
  options: RecordOptions,
): RecordResult {
  const path = resolveStorePath(options.projectRoot)
  const now = options.now ?? new Date()

  // The audit witness is written FIRST and independently of the store, so a
  // store failure cannot leave the approval unrecorded on both sides. Today a
  // failed store write only warns and the approval stays replayable "for a
  // short time" (request-commit.ts). With two witnesses that degrades to safe.
  // Placement is inherited, not chosen: `recordConsumedApproval` is called AFTER
  // the mutation lands so a failed mutation does not burn the approval, and the
  // audit line has to sit at the same point for the same reason.
  try {
    const auditPath = decideAuditPath(options.projectRoot, options.auditConfig).path
    ensureParentDir(auditPath)
    appendFileSync(
      auditPath,
      JSON.stringify({
        ts: now.toISOString(),
        event: APPROVAL_CONSUMED_EVENT,
        action_scope: approval.action_scope,
        approval_timestamp: approval.timestamp,
      }) + '\n',
      'utf8',
    )
  } catch {
    // The store below is the other witness; never block on this one.
  }

  try {
    ensureParentDir(path)
    const { store } = loadStore(options.projectRoot)
    store.entries.push({
      action_scope: approval.action_scope,
      timestamp: approval.timestamp,
      consumed_at: now.toISOString(),
    })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8' })
    renameSync(tmp, path)
    return { ok: true, path }
  } catch (err) {
    return {
      ok: false,
      path,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
