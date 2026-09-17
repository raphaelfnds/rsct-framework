import { existsSync, readFileSync } from 'node:fs'
import { resolveAuditPath } from './audit-log.js'
import { decisionKey } from './comment-sweep/decision-key.js'
import { evaluateMcpHealth, type McpHealth } from './health.js'
import { tierRank, type FreeCommitBudget, type PhaseState } from './phase-scope.js'
import type { StagedStats } from './git.js'
import type { RsctConfig } from './project-root.js'
import type { FabricationSignal } from './dev-approval.js'

export const FREE_COMMIT_MAX_DEFAULT = 5
export const FREE_COMMIT_MAX_MIN = 1
export const FREE_COMMIT_MAX_MAX = 50
export const FREE_COMMIT_MAX_FILES_DEFAULT = 20
export const FREE_COMMIT_MAX_FILES_MIN = 1
export const FREE_COMMIT_MAX_FILES_MAX = 500
export const FREE_COMMIT_MAX_LINES_DEFAULT = 600
export const FREE_COMMIT_MAX_LINES_MIN = 1
export const FREE_COMMIT_MAX_LINES_MAX = 100_000

export function isFreeTier(tier: string | undefined | null): boolean {
  return tier === 'trivial' || tier === 'small'
}

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
  classifyEvidencePresent: boolean
  auditTierMax: string | null
  freeCommitsUsed: number
  auditLocked: boolean
  readable: boolean
  unverifiedDecisions: Set<string>
}

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
    unverifiedDecisions: new Set<string>(),
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
  const unverifiedDecisions = new Set<string>()

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
    } else if (
      event === 'review.unverified_decision' &&
      entry.answer === 'yes' &&
      typeof entry.path === 'string' &&
      typeof entry.blob === 'string'
    ) {
      unverifiedDecisions.add(decisionKey(entry.path, entry.blob))
    }
  }

  return { classifyEvidencePresent, auditTierMax, freeCommitsUsed, auditLocked, readable: true, unverifiedDecisions }
}

export interface ReserveFreeResult {
  nextBudget: FreeCommitBudget
  newlyLocked: boolean
  signals: FabricationSignal[]
}

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

  if (args.stats.files > args.limits.maxFiles || thisCommitLines > args.limits.maxLines) {
    signals.push('tier_volume_divergence')
    lockedReason = 'tier_divergence'
  }
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
  reason?: string
  lockedHint?: boolean
  installDriftSecurity?: boolean
  planSlug?: string
  tierMax?: string
}

export function evaluateFreeEligibility(args: {
  projectRoot: string
  config: RsctConfig | null
  now: Date
  state: PhaseState | null
  activePlanSlug: string | null
  installDriftSecurity?: boolean
  healthOverride?: McpHealth
}): FreeEligibility {
  const health =
    args.healthOverride ??
    evaluateMcpHealth(args.projectRoot, { now: args.now, config: args.config })
  if (!health.healthy) {
    return { eligible: false, reason: `mcp unhealthy: ${health.reasons.join(', ')}` }
  }

  if (args.installDriftSecurity === true) {
    return {
      eligible: false,
      reason: 'install drift at security tier — RSCT enforcement is not running in this project',
      installDriftSecurity: true,
    }
  }

  if (!args.activePlanSlug) {
    return { eligible: false, reason: 'no active plan' }
  }
  const planSlug = args.activePlanSlug

  const stateTierMax = args.state?.last_classify?.tier_max
  if (stateTierMax !== undefined && !isFreeTier(stateTierMax)) {
    return {
      eligible: false,
      reason: `tier_max '${stateTierMax}' is not in {trivial, small}`,
      planSlug,
      tierMax: stateTierMax,
    }
  }

  const ceiling = deriveAuditCeiling(args.projectRoot, args.config, planSlug)
  if (!ceiling.readable) {
    return { eligible: false, reason: 'audit ceiling unreadable' }
  }
  if (!ceiling.classifyEvidencePresent) {
    return { eligible: false, reason: 'no classify evidence in audit history' }
  }

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
