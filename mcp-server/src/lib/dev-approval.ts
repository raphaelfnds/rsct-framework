import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ensureParentDir } from './io-utils.js'
import type { RsctApprovalModes } from './project-root.js'

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

function resolveStorePath(projectRoot: string): string {
  return join(projectRoot, APPROVALS_STORE_RELATIVE)
}

function loadStore(projectRoot: string): { store: ApprovalsStore; corrupt: boolean } {
  const path = resolveStorePath(projectRoot)
  if (!existsSync(path)) {
    return { store: { version: 1, entries: [] }, corrupt: false }
  }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as ApprovalsStore).entries)
    ) {
      return { store: { version: 1, entries: [] }, corrupt: true }
    }
    return { store: parsed as ApprovalsStore, corrupt: false }
  } catch {
    return { store: { version: 1, entries: [] }, corrupt: true }
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

  const { store, corrupt } = loadStore(options.projectRoot)
  const signals: FabricationSignal[] = []
  if (corrupt) signals.push('approvals_store_corrupt')

  const reused = store.entries.some(
    (e) => e.action_scope === approval.action_scope && e.timestamp === approval.timestamp,
  )
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
