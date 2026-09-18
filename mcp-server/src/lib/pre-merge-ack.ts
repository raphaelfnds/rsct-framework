
import { z } from 'zod'
import type { RangePathsResult } from './git.js'

export const preMergeAckSchema = z
  .object({
    plan_complete: z.boolean().optional(),
    adr_confirmed: z.boolean().optional(),
    issues_resolved: z.boolean().optional(),
    hygiene_swept: z.boolean().optional(),
    files_swept: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .strict()

export type PreMergeAck = z.infer<typeof preMergeAckSchema>

export const preMergeAckJsonSchema = {
  type: 'object' as const,
  properties: {
    plan_complete: { type: 'boolean' as const },
    adr_confirmed: { type: 'boolean' as const },
    issues_resolved: { type: 'boolean' as const },
    hygiene_swept: { type: 'boolean' as const },
    files_swept: { type: 'array' as const, items: { type: 'string' as const } },
    note: { type: 'string' as const },
  },
  additionalProperties: false as const,
  description:
    'Pre-integration hygiene checklist (self-attested). Required for a merge and a ' +
    'rebase/squash, and for a push to a protected branch. Set plan_complete/' +
    'adr_confirmed/issues_resolved/hygiene_swept true only after confirming each with ' +
    'the dev; when adr_confirmed, issues_resolved or hygiene_swept is true, `note` must ' +
    'state what (e.g. "ADR-012 recorded; issue #7 closed; swept 4 files"). ' +
    'files_swept lists every path this integration carries that you swept for dead code ' +
    '(comments are enforced at every commit by the REVIEW sweep) — obtain it from `git diff --name-only <base>...<head>`. A ' +
    'carried path missing from it rejects regardless of the booleans. This checks ' +
    'COVERAGE (the carried paths were claimed as swept), never that a sweep happened.',
}

export type PreMergeAckDecision =
  | { ok: true }
  | { ok: false; kind: 'pre_merge_ack_missing' }
  | {
      ok: false
      kind: 'pre_merge_ack_incomplete'
      failing: string[]
      unswept?: string[]
    }

export const PRE_MERGE_ACK_ITEMS = [
  'plan_complete',
  'adr_confirmed',
  'issues_resolved',
  'hygiene_swept',
] as const

export const MAX_UNSWEPT_LISTED = 10

export const MAX_FILES_SWEPT = 2000

function normalizeSweptPath(p: string): string {
  let s = p.trim().replace(/\\/g, '/').normalize('NFC')
  while (s.startsWith('./')) s = s.slice(2)
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

export interface PreMergeAckContext {
  progressHasOpenItems?: boolean | undefined
  carriedPaths?: string[] | null | undefined
}

export function evaluatePreMergeAck(
  ack: PreMergeAck | undefined,
  context: PreMergeAckContext = {},
): PreMergeAckDecision {
  if (ack === undefined) return { ok: false, kind: 'pre_merge_ack_missing' }
  const { progressHasOpenItems, carriedPaths } = context

  const failing: string[] = []
  if (ack.plan_complete !== true) failing.push('plan_complete')
  else if (progressHasOpenItems === true) {
    failing.push('plan_complete (progress_<slug>.md still has open `- [ ]` items)')
  }
  if (ack.adr_confirmed !== true) failing.push('adr_confirmed')
  if (ack.issues_resolved !== true) failing.push('issues_resolved')
  if (ack.hygiene_swept !== true) failing.push('hygiene_swept')

  const attestedPositive =
    ack.adr_confirmed === true || ack.issues_resolved === true || ack.hygiene_swept === true
  const noteBlank = typeof ack.note !== 'string' || ack.note.trim() === ''
  if (attestedPositive && noteBlank) {
    failing.push(
      'note (required when adr_confirmed, issues_resolved or hygiene_swept is true)',
    )
  }

  const sweptDeclared = ack.files_swept ?? []
  if (sweptDeclared.length > MAX_FILES_SWEPT) {
    failing.push(
      `files_swept (${sweptDeclared.length} entries exceeds the ${MAX_FILES_SWEPT} cap)`,
    )
  }

  let unswept: string[] | undefined
  if (Array.isArray(carriedPaths) && carriedPaths.length > 0) {
    const swept = new Set(sweptDeclared.map(normalizeSweptPath))
    const missing = carriedPaths
      .map(normalizeSweptPath)
      .filter((p) => p.length > 0 && !swept.has(p))
    if (missing.length > 0) {
      unswept = missing
      const shown = missing.slice(0, MAX_UNSWEPT_LISTED).join(', ')
      const rest = missing.length - Math.min(missing.length, MAX_UNSWEPT_LISTED)
      failing.push(
        `files_swept (${missing.length} path(s) this integration carries were not ` +
          `attested: ${shown}${rest > 0 ? `, and ${rest} more` : ''})`,
      )
    }
  }

  if (failing.length === 0) return { ok: true }
  return {
    ok: false,
    kind: 'pre_merge_ack_incomplete',
    failing,
    ...(unswept !== undefined && { unswept }),
  }
}

export type PathCrossCheck = 'enforced' | 'empty_range' | 'degraded' | 'rejected_revision'

export function describeCrossCheck(range: RangePathsResult): PathCrossCheck {
  if (range.status === 'unsafe_revision') return 'rejected_revision'
  if (range.status === 'unavailable') return 'degraded'
  return range.paths.length > 0 ? 'enforced' : 'empty_range'
}

export function crossCheckBlockedReason(range: RangePathsResult, op: string): string {
  if (range.status === 'unsafe_revision') {
    return (
      `refusing to ${op}: ${JSON.stringify(range.revision)} is not a safe revision — a value ` +
      "starting with '-' is read by git as an OPTION, not a name. No OS dialog was shown."
    )
  }
  return (
    `refusing to ${op}: the paths this integration carries could not be read from git, so the ` +
    'pre_merge_ack coverage check cannot run. This fails CLOSED because the mutation can ' +
    'succeed where the read cannot — an unrelated-histories merge, or a rebase onto an ' +
    'unrelated ref, would otherwise skip the check entirely. Fetch the refs involved (or fix ' +
    'the ref name) and retry. No OS dialog was shown — nothing ran.'
  )
}

export function preMergeAckHint(decision: {
  kind: 'pre_merge_ack_missing' | 'pre_merge_ack_incomplete'
  failing?: string[]
}): string {
  if (decision.kind === 'pre_merge_ack_missing') {
    return (
      'Pre-integration hygiene checklist (pre_merge_ack) is required before this ' +
      'integration. Supply pre_merge_ack: { plan_complete, adr_confirmed, ' +
      'issues_resolved, hygiene_swept, files_swept } — set each boolean true ONLY ' +
      'after confirming it with the dev (they are self-attestations, not ' +
      'machine-checked). When adr_confirmed, issues_resolved or hygiene_swept is ' +
      'true, add a non-empty `note` stating WHAT (e.g. "ADR-012 recorded; issue #7 ' +
      'closed; swept 4 files"). files_swept must list every path this integration ' +
      'carries that you swept for dead code — get it from ' +
      '`git diff --name-only <base>...<head>`. No OS dialog was shown — nothing ran.'
    )
  }
  return (
    'Pre-integration hygiene checklist (pre_merge_ack) is incomplete — you ' +
    `declared/omitted: ${(decision.failing ?? []).join(', ')}. Resolve each item ` +
    '(finish the work, record pending ADRs via §H, close associated issues, sweep ' +
    'the carried files for dead code) and re-attest. Booleans ' +
    'you mark false mean "not ready" and are honored as a stop. Paths are compared ' +
    'case-sensitively after normalizing separators and Unicode form, so copy them ' +
    'back exactly as listed.'
  )
}
