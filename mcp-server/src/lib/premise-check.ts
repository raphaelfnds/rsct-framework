import type { DecisionEntry } from './decisions.js'
import type { AntiDecisionEntry } from './anti-decisions.js'

const STOPWORDS = new Set<string>([
  // English filler
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'should',
  'would',
  'could',
  'will',
  'have',
  'has',
  'had',
  'are',
  'was',
  'were',
  'use',
  'using',
  'want',
  'need',
  'needs',
  'add',
  'change',
  'make',
  'does',
  'into',
  'from',
  'about',
  'over',
  'under',
  'when',
  'while',
  'than',
  'then',
  // pt-BR filler
  'que',
  'para',
  'pelo',
  'pela',
  'usar',
  'usamos',
  'fazer',
  'mudar',
  'adicionar',
  'precisa',
  'quero',
  'queremos',
  'sobre',
  'como',
  'entre',
  'porque',
])

const NEGATION_PATTERNS: readonly RegExp[] = [
  /\brolled[- ]?back\b/i,
  /\bsuperseded\b/i,
  /\bdeprecated\b/i,
  /\bdo[ -]?not\b/i,
  /\brejected\b/i,
  /\banti[- ]?pattern\b/i,
  /\bnever\b/i,
  /\bblock(ed|s)?\b/i,
  /\bavoid(ed)?\b/i,
  /\bbanned\b/i,
  /\brevogad[oa]\b/i,
  /\bnão usar\b/i,
] as const

export interface PremiseMatch {
  entry: DecisionEntry
  score: number
  shared_tokens: string[]
  negation_signal: boolean
}

export interface AntiDecisionMatch {
  entry: AntiDecisionEntry
  score: number
  shared_tokens: string[]
}

export type PremiseRecommendation = 'proceed' | 'conflict' | 'requires_revision'

export interface PremiseCheckResult {
  recommendation: PremiseRecommendation
  matches: PremiseMatch[]
  anti_decision_matches: AntiDecisionMatch[]
  scanned: number
  scanned_anti_decisions: number
  reason: string
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9áàâãéêíîóôõúüç_-]+/i)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

const MIN_SCORE = 2

export function checkPremise(
  claim: string,
  entries: DecisionEntry[],
  antiDecisions: AntiDecisionEntry[] = [],
): PremiseCheckResult {
  const claimTokens = new Set(tokenize(claim))
  const matches: PremiseMatch[] = []

  for (const entry of entries) {
    const match = scoreEntry(claimTokens, entry)
    if (match) matches.push(match)
  }

  matches.sort((a, b) => b.score - a.score)

  const antiMatches: AntiDecisionMatch[] = []
  for (const entry of antiDecisions) {
    const match = scoreAntiDecision(claimTokens, entry)
    if (match) antiMatches.push(match)
  }
  antiMatches.sort((a, b) => b.score - a.score)

  return {
    recommendation: recommend(matches, antiMatches),
    matches,
    anti_decision_matches: antiMatches,
    scanned: entries.length,
    scanned_anti_decisions: antiDecisions.length,
    reason: explain(matches, antiMatches, entries.length, antiDecisions.length),
  }
}

function scoreEntry(
  claimTokens: Set<string>,
  entry: DecisionEntry,
): PremiseMatch | null {
  const entryText = `${entry.title} ${entry.excerpt}`
  const entryTokens = new Set(tokenize(entryText))
  const shared: string[] = []
  for (const t of claimTokens) {
    if (entryTokens.has(t)) shared.push(t)
  }
  if (shared.length < MIN_SCORE) return null

  const negation = NEGATION_PATTERNS.some((re) => re.test(entryText))
  return {
    entry,
    score: shared.length,
    shared_tokens: shared.sort(),
    negation_signal: negation,
  }
}

function scoreAntiDecision(
  claimTokens: Set<string>,
  entry: AntiDecisionEntry,
): AntiDecisionMatch | null {
  const entryText = `${entry.title} ${entry.excerpt}`
  const entryTokens = new Set(tokenize(entryText))
  const shared: string[] = []
  for (const t of claimTokens) {
    if (entryTokens.has(t)) shared.push(t)
  }
  if (shared.length < MIN_SCORE) return null
  return { entry, score: shared.length, shared_tokens: shared.sort() }
}

function recommend(
  matches: PremiseMatch[],
  antiMatches: AntiDecisionMatch[],
): PremiseRecommendation {
  if (antiMatches.length > 0) return 'conflict'
  if (matches.length === 0) return 'proceed'
  if (matches.some((m) => m.negation_signal)) return 'conflict'
  if (matches.some((m) => m.entry.kind === 'premise')) return 'requires_revision'
  if (matches.some((m) => m.entry.status === 'superseded' || m.entry.status === 'deprecated')) {
    return 'requires_revision'
  }
  return 'requires_revision'
}

function explain(
  matches: PremiseMatch[],
  antiMatches: AntiDecisionMatch[],
  scanned: number,
  scannedAnti: number,
): string {
  if (antiMatches.length > 0) {
    const top = antiMatches[0]
    if (top) {
      return `Matched anti-decision ${top.entry.id} ('${top.entry.title}') — the team explicitly abandoned this approach. Read the full entry (anti-decisions.md) and either align the claim with the documented "do not revisit unless" conditions or surface an explicit override request to the dev.`
    }
  }
  if (matches.length === 0) {
    const corpusNote =
      scannedAnti > 0
        ? ` (Also cross-checked ${scannedAnti} anti-decision entries.)`
        : ''
    return `No decisions among ${scanned} scanned share ≥${MIN_SCORE} significant tokens with the claim.${corpusNote} Proceed, but still check premises if the claim names a regulatory or financial concept.`
  }
  const premiseHit = matches.find((m) => m.entry.kind === 'premise')
  const negationHit = matches.find((m) => m.negation_signal)
  if (negationHit) {
    return `Matched decision ${negationHit.entry.id} ('${negationHit.entry.title}') contains a negation/rollback signal — claim likely revisits an explicitly rejected path. Read the full entry before proceeding.`
  }
  if (premiseHit) {
    return `Matched firm premise ${premiseHit.entry.id} ('${premiseHit.entry.title}'). Firm premises are non-negotiable — claim must align or explicitly call out a premise waiver.`
  }
  return `Matched ${matches.length} decision(s); top hit ${matches[0]?.entry.id} ('${matches[0]?.entry.title}'). Review before committing the direction.`
}
