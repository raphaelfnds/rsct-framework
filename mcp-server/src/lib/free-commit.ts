import { existsSync, readFileSync } from 'node:fs'
import { resolveAuditPath } from './audit-log.js'
import { decisionKey } from './comment-sweep/decision-key.js'
import { tierRank } from './phase-scope.js'
import type { RsctConfig } from './project-root.js'

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

export interface AuditCeiling {
  classifyEvidencePresent: boolean
  auditTierMax: string | null
  unverifiedDecisions: Set<string>
  deadCodeKeepDecisions: Set<string>
  publicApiApprovals: Set<string>
}

export const DEAD_CODE_KEPT_EVENT = 'review.dead_code_kept'
export const PUBLIC_API_APPROVED_EVENT = 'review.public_api_approved'

export function deadCodeKeepKey(path: string, name: string, declarationSha256: string): string {
  return `${path}\u0000${name}\u0000${declarationSha256}`
}

export function publicApiApprovalKey(publicApiSha256: string, path: string, name: string, declarationSha256: string): string {
  return `${publicApiSha256}\u0000${path}\u0000${name}\u0000${declarationSha256}`
}

export function deriveAuditCeiling(
  projectRoot: string,
  config: RsctConfig | null,
): AuditCeiling {
  const failClosed: AuditCeiling = {
    classifyEvidencePresent: false,
    auditTierMax: null,
    unverifiedDecisions: new Set<string>(),
    deadCodeKeepDecisions: new Set<string>(),
    publicApiApprovals: new Set<string>(),
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
  const unverifiedDecisions = new Set<string>()
  const deadCodeKeepDecisions = new Set<string>()
  const publicApiApprovals = new Set<string>()

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
    } else if (
      event === 'review.unverified_decision' &&
      entry.answer === 'yes' &&
      typeof entry.path === 'string' &&
      typeof entry.blob === 'string'
    ) {
      unverifiedDecisions.add(decisionKey(entry.path, entry.blob))
    } else if (
      event === DEAD_CODE_KEPT_EVENT &&
      typeof entry.path === 'string' &&
      typeof entry.name === 'string' &&
      typeof entry.declaration_sha256 === 'string'
    ) {
      deadCodeKeepDecisions.add(deadCodeKeepKey(entry.path, entry.name, entry.declaration_sha256))
    } else if (
      event === PUBLIC_API_APPROVED_EVENT &&
      typeof entry.public_api_sha256 === 'string' &&
      typeof entry.path === 'string' &&
      typeof entry.name === 'string' &&
      typeof entry.declaration_sha256 === 'string'
    ) {
      publicApiApprovals.add(publicApiApprovalKey(entry.public_api_sha256, entry.path, entry.name, entry.declaration_sha256))
    }
  }

  return {
    classifyEvidencePresent,
    auditTierMax,
    unverifiedDecisions,
    deadCodeKeepDecisions,
    publicApiApprovals,
  }
}
