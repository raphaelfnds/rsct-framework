import { existsSync, readFileSync } from 'node:fs'
import { resolveAuditPath } from './audit-log.js'
import { evaluateMcpHealth, type McpHealth } from './health.js'
import { tierRank, type FreeCommitBudget, type PhaseState } from './phase-scope.js'
import type { StagedStats } from './git.js'
import type { RsctConfig } from './project-root.js'
import type { FabricationSignal } from './dev-approval.js'

/**
 * plan-lifecycle-v2 — Bloco 1: the dialog-free "free commit" lane for
 * trivial/small tasks. This module is the mechanical spine of that lane:
 *
 *  - {@link deriveAuditCeiling} re-derives the tier ratchet and the per-plan
 *    free-commit count from the append-only `.rsct/audit.log` — the AUDIT-side
 *    anchor. This is what makes a `phase-state.json` wipe fail-CLOSED: even if
 *    the STATE-side budget is deleted, the ceiling is reconstructed from a
 *    store the single-file wipe did not touch. (Its residual — a
 *    truncate-and-rewrite forge of the gitignored log — is the accepted Fork
 *    1/A limit; there is no privilege boundary between mcp-server and a
 *    same-user agent, so this raises the attack cost rather than closing it.)
 *  - {@link reserveFreeBudget} is the pure debit-first budget update.
 *  - {@link evaluateFreeEligibility} is the ALL-must-hold gate the commit
 *    handler consults; any failure degrades to the strict token/§C path.
 */

export const FREE_COMMIT_MAX_DEFAULT = 5
export const FREE_COMMIT_MAX_MIN = 1
export const FREE_COMMIT_MAX_MAX = 50
export const FREE_COMMIT_MAX_FILES_DEFAULT = 20
export const FREE_COMMIT_MAX_FILES_MIN = 1
export const FREE_COMMIT_MAX_FILES_MAX = 500
export const FREE_COMMIT_MAX_LINES_DEFAULT = 600
export const FREE_COMMIT_MAX_LINES_MIN = 1
export const FREE_COMMIT_MAX_LINES_MAX = 100_000

/** The ONLY tiers that qualify for the dialog-free lane (D3, explicit membership). */
export function isFreeTier(tier: string | undefined | null): boolean {
  return tier === 'trivial' || tier === 'small'
}

/**
 * Return the higher-ranked of two tiers (the ratchet combinator). `undefined`
 * inputs are ignored; returns `undefined` only when BOTH are absent. Uses
 * `tierRank` so an unknown string never out-ranks a known tier.
 */
export function higherTier(
  a: string | undefined | null,
  b: string | undefined | null,
): string | undefined {
  const av = a ?? undefined
  const bv = b ?? undefined
  if (av === undefined) return bv
  if (bv === undefined) return av
  return tierRank(av) >= tierRank(bv) ? av : bv
}

export interface FreeBudgetLimits {
  maxCommits: number
  maxFiles: number
  maxLines: number
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return def
  return Math.min(max, Math.max(min, Math.trunc(v)))
}

/** Resolve free-lane limits: config > built-in default, each clamped to bounds. */
export function resolveFreeBudgetLimits(config: RsctConfig | null): FreeBudgetLimits {
  const m = config?.approval_modes
  return {
    maxCommits: clampInt(m?.free_commit_max, FREE_COMMIT_MAX_DEFAULT, FREE_COMMIT_MAX_MIN, FREE_COMMIT_MAX_MAX),
    maxFiles: clampInt(
      m?.free_commit_max_files,
      FREE_COMMIT_MAX_FILES_DEFAULT,
      FREE_COMMIT_MAX_FILES_MIN,
      FREE_COMMIT_MAX_FILES_MAX,
    ),
    maxLines: clampInt(
      m?.free_commit_max_lines,
      FREE_COMMIT_MAX_LINES_DEFAULT,
      FREE_COMMIT_MAX_LINES_MIN,
      FREE_COMMIT_MAX_LINES_MAX,
    ),
  }
}

export interface AuditCeiling {
  /** At least one `classify.verdict` event exists in the log (PRESENCE required — absence ⇒ ineligible). */
  classifyEvidencePresent: boolean
  /** Tier ratchet reconstructed as max over historical `classify.verdict` tiers. */
  auditTierMax: string | null
  /** Cumulative `free_commit.committed` count for `planSlug` across the WHOLE log. */
  freeCommitsUsed: number
  /** Any `free_commit.locked` event for `planSlug`. */
  auditLocked: boolean
  /** False ⇒ the log could not be read ⇒ callers MUST fail-closed. */
  readable: boolean
}

/**
 * Re-derive the anti-rollback ceiling from the append-only audit log.
 *
 * CRITICAL (Cluster A corr#1): `free_commit.committed` is counted CUMULATIVELY
 * across the ENTIRE log for `planSlug` — NEVER "since the last classify.verdict".
 * `rsct_classify_task` is ungated and unlimited, so treating a classify event as
 * a counting boundary would turn it into a counter-reset primitive. classify
 * events are used ONLY to establish evidence-presence and the tier ratchet.
 *
 * CRLF-tolerant per CLAUDE.md anti-pattern #4. Never throws.
 */
export function deriveAuditCeiling(
  projectRoot: string,
  config: RsctConfig | null,
  planSlug: string,
): AuditCeiling {
  const failClosed: AuditCeiling = {
    classifyEvidencePresent: false,
    auditTierMax: null,
    freeCommitsUsed: 0,
    auditLocked: false,
    readable: false,
  }
  const auditPath = resolveAuditPath(projectRoot, config?.audit)
  let raw: string
  try {
    if (!existsSync(auditPath)) return failClosed
    raw = readFileSync(auditPath, 'utf8')
  } catch {
    return failClosed
  }

  let classifyEvidencePresent = false
  let maxRank = -1
  let auditTierMax: string | null = null
  let freeCommitsUsed = 0
  let auditLocked = false

  for (const line of raw.split('\n')) {
    const clean = line.replace(/\r/g, '').trim()
    if (!clean) continue
    let entry: Record<string, unknown>
    try {
      const parsed = JSON.parse(clean) as unknown
      if (!parsed || typeof parsed !== 'object') continue
      entry = parsed as Record<string, unknown>
    } catch {
      continue
    }
    const event = entry.event
    if (event === 'classify.verdict' && typeof entry.tier === 'string') {
      classifyEvidencePresent = true
      const r = tierRank(entry.tier)
      if (r > maxRank) {
        maxRank = r
        auditTierMax = entry.tier
      }
    } else if (event === 'free_commit.committed' && entry.plan_slug === planSlug) {
      freeCommitsUsed += 1
    } else if (event === 'free_commit.locked' && entry.plan_slug === planSlug) {
      auditLocked = true
    }
  }

  return { classifyEvidencePresent, auditTierMax, freeCommitsUsed, auditLocked, readable: true }
}

export interface ReserveFreeResult {
  nextBudget: FreeCommitBudget
  /** True when THIS commit flipped the budget from unlocked to locked. */
  newlyLocked: boolean
  /** Fabrication signals to fold into the commit output (tier↔volume divergence). */
  signals: FabricationSignal[]
}

/**
 * Pure debit-first budget update. The caller persists `nextBudget` via
 * `writePhaseState` BEFORE `gitCommit` (so "can't record the spend" ⇒ "can't
 * spend"), and refunds by clearing/restoring on commit failure.
 *
 * A cap-tripping commit is NOT rejected here — the free lane never rejects on
 * volume, it only signals + LOCKS, and the NEXT commit is refused by
 * {@link evaluateFreeEligibility}. Divergence (this commit's real volume vs the
 * caps) emits `tier_volume_divergence` and locks with `tier_divergence`.
 */
export function reserveFreeBudget(args: {
  planSlug: string
  prev: FreeCommitBudget | undefined
  stats: StagedStats
  limits: FreeBudgetLimits
}): ReserveFreeResult {
  const prev =
    args.prev && args.prev.plan_slug === args.planSlug ? args.prev : undefined
  const wasLocked = prev?.locked ?? false

  const unionPaths = Array.from(
    new Set([...(prev?.files_touched_paths ?? []), ...args.stats.paths]),
  )
  const commitsUsed = (prev?.commits_used ?? 0) + 1
  const thisCommitLines = args.stats.insertions + args.stats.deletions
  const linesChanged = (prev?.lines_changed ?? 0) + thisCommitLines

  const signals: FabricationSignal[] = []
  let lockedReason: FreeCommitBudget['locked_reason'] | undefined

  // (1) tier↔volume divergence — THIS commit's real volume blows the caps.
  if (args.stats.files > args.limits.maxFiles || thisCommitLines > args.limits.maxLines) {
    signals.push('tier_volume_divergence')
    lockedReason = 'tier_divergence'
  }
  // (2) cumulative caps (commit count, then cumulative files/lines).
  if (lockedReason === undefined) {
    if (commitsUsed >= args.limits.maxCommits) {
      lockedReason = 'commit_cap'
    } else if (unionPaths.length > args.limits.maxFiles || linesChanged > args.limits.maxLines) {
      lockedReason = 'volume_cap'
    }
  }

  const locked = wasLocked || lockedReason !== undefined
  const nextBudget: FreeCommitBudget = {
    plan_slug: args.planSlug,
    files_touched_paths: unionPaths,
    commits_used: commitsUsed,
    lines_changed: linesChanged,
    locked,
  }
  const effectiveReason = lockedReason ?? prev?.locked_reason
  if (locked && effectiveReason !== undefined) nextBudget.locked_reason = effectiveReason

  return { nextBudget, newlyLocked: locked && !wasLocked, signals }
}

export interface FreeEligibility {
  eligible: boolean
  /** Diagnostic reason when not eligible. */
  reason?: string
  /** True when ineligibility is a budget LOCK/exhaustion (surface the re-classify/token hint). */
  lockedHint?: boolean
  planSlug?: string
  /** The effective (max of state+audit) tier_max the decision used. */
  tierMax?: string
}

/**
 * The ALL-must-hold gate for the free lane (Bloco 1.1). Every failure returns
 * `eligible:false` so the commit handler degrades to the token/§C path — this
 * function NEVER opens a gate, it only withholds a privilege.
 *
 * Anti-rollback: the effective tier_max and free-commit count are BOTH
 * `max(state, audit)`, so deleting/rewriting `phase-state.json` cannot lower
 * the tier below the audit history nor reset the count below the logged spend.
 * `classifyEvidencePresent` flips the sign of the missing-data case: ABSENCE of
 * evidence is no longer permissive — POSITIVE audit evidence is required.
 */
export function evaluateFreeEligibility(args: {
  projectRoot: string
  config: RsctConfig | null
  now: Date
  state: PhaseState | null
  activePlanSlug: string | null
  /** Test seam only — real callers omit this (health is computed from disk). */
  healthOverride?: McpHealth
}): FreeEligibility {
  // (1) Health — MCP layer must be trustworthy (fail-closed on any doubt).
  const health =
    args.healthOverride ??
    evaluateMcpHealth(args.projectRoot, { now: args.now, config: args.config })
  if (!health.healthy) {
    return { eligible: false, reason: `mcp unhealthy: ${health.reasons.join(', ')}` }
  }

  // (3) An active plan slug must resolve — never mint a null-keyed budget.
  if (!args.activePlanSlug) {
    return { eligible: false, reason: 'no active plan' }
  }
  const planSlug = args.activePlanSlug

  // Audit-derived anchor (fail-closed if unreadable).
  const ceiling = deriveAuditCeiling(args.projectRoot, args.config, planSlug)
  if (!ceiling.readable) {
    return { eligible: false, reason: 'audit ceiling unreadable' }
  }
  // Sign-flip: PRESENCE of classify evidence is required (absence ⇒ ineligible).
  if (!ceiling.classifyEvidencePresent) {
    return { eligible: false, reason: 'no classify evidence in audit history' }
  }

  // (2) tier_max present + membership, using max(state, audit).
  const stateTierMax = args.state?.last_classify?.tier_max
  const effTierMax = higherTier(stateTierMax, ceiling.auditTierMax)
  if (effTierMax === undefined) {
    return { eligible: false, reason: 'no tier_max' }
  }
  if (!isFreeTier(effTierMax)) {
    return {
      eligible: false,
      reason: `tier_max '${effTierMax}' is not in {trivial, small}`,
      planSlug,
      tierMax: effTierMax,
    }
  }

  // (4) Budget not locked / not exhausted, using max(state, audit).
  const stateBudget =
    args.state?.free_commit_budget && args.state.free_commit_budget.plan_slug === planSlug
      ? args.state.free_commit_budget
      : undefined
  const locked = (stateBudget?.locked ?? false) || ceiling.auditLocked
  if (locked) {
    return {
      eligible: false,
      reason: 'free budget locked for this plan',
      lockedHint: true,
      planSlug,
      tierMax: effTierMax,
    }
  }
  const effUsed = Math.max(stateBudget?.commits_used ?? 0, ceiling.freeCommitsUsed)
  const limits = resolveFreeBudgetLimits(args.config)
  if (effUsed >= limits.maxCommits) {
    return {
      eligible: false,
      reason: 'free commit budget exhausted',
      lockedHint: true,
      planSlug,
      tierMax: effTierMax,
    }
  }

  return { eligible: true, planSlug, tierMax: effTierMax }
}
