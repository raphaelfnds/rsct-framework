import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ensureParentDir } from './io-utils.js'
import { anchorFor, protectRelocatedState } from './repo-anchor.js'
import { decideAuditPath } from './audit-log.js'
import type { RsctApprovalModes, RsctAuditConfig } from './project-root.js'

const APPROVAL_CONSUMED_EVENT = 'approval.consumed'

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
  | 'approvals_store_absent'
  | 'scope_mismatch'
  | 'burst_pattern'

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
  toolName?: string
  auditConfig?: RsctAuditConfig | undefined
}

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
  return join(anchorFor(projectRoot).root, APPROVALS_STORE_RELATIVE)
}

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

  const audit = consumedInAudit(options.projectRoot, options.auditConfig, approval)

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
  auditConfig?: RsctAuditConfig | undefined
}

export type RecordResult =
  | { ok: true; path: string }
  | { ok: false; path: string; error: string }

export function recordConsumedApproval(
  approval: DevApproval,
  options: RecordOptions,
): RecordResult {
  const path = resolveStorePath(options.projectRoot)
  const now = options.now ?? new Date()

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
    protectRelocatedState(options.projectRoot)
  } catch {
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
    protectRelocatedState(options.projectRoot)
    return { ok: true, path }
  } catch (err) {
    return {
      ok: false,
      path,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
