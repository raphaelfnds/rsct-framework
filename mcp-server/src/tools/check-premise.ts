import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readDecisions } from '../lib/decisions.js'
import { readAntiDecisions } from '../lib/anti-decisions.js'
import {
  checkPremise,
  type AntiDecisionMatch,
  type PremiseMatch,
  type PremiseRecommendation,
} from '../lib/premise-check.js'

const AGAINST = ['premises', 'adrs', 'both'] as const

export const checkPremiseInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    claim: z
      .string()
      .min(5)
      .describe(
        'A short proposal or design statement to vet against existing decisions (e.g., "use DynamoDB for orders" or "store session tokens in cookies").',
      ),
    against: z.enum(AGAINST).default('both'),
  })
  .strict()

export type CheckPremiseInput = z.infer<typeof checkPremiseInputSchema>

export interface CheckPremiseOutput {
  rsct_installed: boolean
  decisions_file: { exists: boolean; path: string | null }
  anti_decisions_file: { exists: boolean; path: string | null }
  claim: string
  against: (typeof AGAINST)[number]
  recommendation: PremiseRecommendation
  reason: string
  matches: PremiseMatch[]
  anti_decision_matches: AntiDecisionMatch[]
  scanned_decisions: number
  scanned_anti_decisions: number
  hints: string[]
}

export const checkPremiseTool: Tool = {
  name: 'rsct_check_premise',
  description:
    'Heuristic check of a proposed claim or design direction against documentation/decisions.md AND documentation/knowledge/anti-decisions.md. Tokenizes the claim, finds decisions sharing ≥2 significant tokens, then scores. Returns a recommendation: "proceed" (no overlap), "conflict" (matched an anti-decision OR a decision with negation/rollback language), or "requires_revision" (matched a firm premise or an active ADR — dev must read the entry). Anti-decision hits ALWAYS upgrade to conflict — the team explicitly abandoned that path. Use BEFORE proposing a non-trivial design choice so prior rejected and abandoned paths surface early.',
  inputSchema: {
    type: 'object',
    required: ['claim'],
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      claim: {
        type: 'string',
        minLength: 5,
        description:
          'Short proposal to check (e.g., "use DynamoDB for orders", "Istio sidecar for inter-service auth").',
      },
      against: {
        type: 'string',
        enum: [...AGAINST],
        default: 'both',
        description:
          'Restrict the scan to premises only, ADRs only, or both (default).',
      },
    },
    additionalProperties: false,
  },
}

export async function checkPremiseHandler(
  rawInput: unknown,
): Promise<CheckPremiseOutput> {
  const input = checkPremiseInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const snapshot = readDecisions(resolution.root)
  const antiSnapshot = readAntiDecisions(resolution.root)

  const subset = selectSubset(snapshot.premises, snapshot.adrs, input.against)
  const result = checkPremise(input.claim, subset, antiSnapshot.entries)

  return {
    rsct_installed: resolution.rsct_installed,
    decisions_file: { exists: snapshot.exists, path: snapshot.path },
    anti_decisions_file: {
      exists: antiSnapshot.exists,
      path: antiSnapshot.path,
    },
    claim: input.claim,
    against: input.against,
    recommendation: result.recommendation,
    reason: result.reason,
    matches: result.matches,
    anti_decision_matches: result.anti_decision_matches,
    scanned_decisions: result.scanned,
    scanned_anti_decisions: result.scanned_anti_decisions,
    hints: buildHints(
      resolution.rsct_installed,
      snapshot.exists,
      antiSnapshot.exists,
      result.recommendation,
      result.anti_decision_matches.length,
    ),
  }
}

function selectSubset<T>(
  premises: T[],
  adrs: T[],
  against: (typeof AGAINST)[number],
): T[] {
  if (against === 'premises') return premises
  if (against === 'adrs') return adrs
  return [...premises, ...adrs]
}

function buildHints(
  installed: boolean,
  decisionsExist: boolean,
  antiDecisionsExist: boolean,
  recommendation: PremiseRecommendation,
  antiMatchCount: number,
): string[] {
  const hints: string[] = []
  if (!installed) {
    hints.push(
      'Project is not rsct-managed — decisions.md likely absent. Run /rsct-setup before relying on this check.',
    )
    return hints
  }
  if (!decisionsExist) {
    hints.push(
      'documentation/decisions.md not found — zero corpus to check against; recommendation defaulted to "proceed" only because there is nothing to compare with.',
    )
  }
  if (!antiDecisionsExist) {
    hints.push(
      'documentation/knowledge/anti-decisions.md not found — abandoned-path cross-check skipped. Bootstrap via /rsct-setup so "we already tried that" signals surface earlier.',
    )
  }
  if (antiMatchCount > 0) {
    hints.push(
      'ANTI-DECISION hit: the claim shares vocabulary with one or more entries the team explicitly abandoned. Read anti-decisions.md AD-NNN before proceeding; if the dev wants to revisit, require a stated revisit_reason citing what changed since the abandonment.',
    )
  }
  if (recommendation === 'conflict' && antiMatchCount === 0) {
    hints.push(
      'CONFLICT signal: the matched decision contains rollback / rejection language. Surface the matched entry to the dev verbatim and ask whether the claim is intentionally revisiting it before proceeding.',
    )
  } else if (recommendation === 'requires_revision') {
    hints.push(
      'REVISION required: a relevant decision exists. Read the matched entries and either align the claim with them or surface an explicit override request to the dev.',
    )
  }
  return hints
}
