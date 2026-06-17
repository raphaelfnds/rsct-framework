import { basename } from 'node:path'

import { readDecisions } from './decisions.js'
import { readAntiDecisions } from './anti-decisions.js'
import { readKnowledgeIndex } from './knowledge.js'
import {
  readArchitectureOverview,
  readArchitectureModules,
} from './architecture.js'
import { checkPremise } from './premise-check.js'

export type FindingCategory = 'gap' | 'breakage' | 'redundancy' | 'forgotten'

/**
 * Suggested severity that the V phase complete tool surfaces to the dev.
 * The dev's final action lives in the `findings_actions[]` input of
 * `rsct_phase_verification_complete` — these are recommendations, not gates.
 *
 * Severity ladder (high → low):
 *  - block             — V phase complete cannot proceed without dev action
 *  - address-now       — strong recommendation to handle before code-phase
 *  - capture-as-issue  — track separately so it does not block this task
 *  - defer             — record only; revisit at retrospective / next phase
 *  - accept            — finding acknowledged, no action needed
 */
export type FindingSeverity =
  | 'block'
  | 'address-now'
  | 'capture-as-issue'
  | 'defer'
  | 'accept'

export interface VerificationFinding {
  id: string
  category: FindingCategory
  severity: FindingSeverity
  title: string
  detail: string
  affected_paths: string[]
  source: string
}

export interface DiscoveredImporterRef {
  file: string
  depth: number
  via_paths: string[]
}

export interface ChecklistInput {
  projectRoot: string
  declaredPaths: string[]
  discoveredImporters: DiscoveredImporterRef[]
  specClaims?: string[]
  specTier?: 'trivial' | 'small' | 'standard' | 'complex'
  existingProjectFiles?: string[]
}

export interface ChecklistStats {
  categories_run: FindingCategory[]
  knowledge_categories_present: string[]
  knowledge_categories_missing: string[]
  decisions_scanned: number
  anti_decisions_scanned: number
  impact_docs_consulted: number
  architecture_overview_present: boolean
}

export interface ChecklistResult {
  findings: VerificationFinding[]
  stats: ChecklistStats
  hints: string[]
}

const CATEGORY_PROMPTS: Record<string, string> = {
  'business-rules':
    'Did the spec consider business-rules.md? Check for invariants or compliance constraints.',
  'anti-decisions':
    'Did the spec consult anti-decisions.md? Avoid re-trying abandoned paths.',
  'cost-constraints':
    'Did the spec consider cost impact ($/month, infra footprint, free-tier limits)?',
  'vendor-relationships':
    'Does the spec lock into or depend on a vendor? Cross-check vendor-relationships.md.',
  'incident-log':
    'Are there past incidents touching this area? Check incident-log.md before proceeding.',
  'stakeholder-map':
    'Did the spec inform the right stakeholders? Check stakeholder-map.md.',
  'team-capabilities':
    'Does the team currently have the capability to maintain this? Check team-capabilities.md.',
  'workflow-rituals':
    'Does the change require updating a workflow ritual? Check workflow-rituals.md.',
  'domain-edge-cases':
    'Did the spec cover known domain edge cases? Check domain-edge-cases.md.',
  'business-glossary':
    'Does the spec use established terminology from business-glossary.md?',
}

const COMMON_BASENAMES = new Set([
  'index',
  'utils',
  'util',
  'helpers',
  'helper',
  'types',
  'common',
  'main',
])

function makeIdGenerator(): (cat: FindingCategory) => string {
  let counter = 0
  return (cat) => `v-${cat}-${++counter}`
}

function stripExt(p: string): string {
  return basename(p).replace(/\.[^.]+$/, '')
}

export function runVerificationChecklist(
  input: ChecklistInput,
): ChecklistResult {
  const findings: VerificationFinding[] = []
  const hints: string[] = []
  const nextId = makeIdGenerator()

  const stats: ChecklistStats = {
    categories_run: [],
    knowledge_categories_present: [],
    knowledge_categories_missing: [],
    decisions_scanned: 0,
    anti_decisions_scanned: 0,
    impact_docs_consulted: 0,
    architecture_overview_present: false,
  }

  if (input.specTier === 'trivial' || input.specTier === 'small') {
    hints.push(
      `spec_tier=${input.specTier} — verification checklist skipped per tier table.`,
    )
    return { findings, stats, hints }
  }

  const decisions = readDecisions(input.projectRoot)
  const antiDecisions = readAntiDecisions(input.projectRoot)
  const knowledge = readKnowledgeIndex(input.projectRoot)
  const architecture = readArchitectureOverview(input.projectRoot)
  const impactModules = readArchitectureModules(input.projectRoot, 'impact')

  stats.decisions_scanned = decisions.premises.length + decisions.adrs.length
  stats.anti_decisions_scanned = antiDecisions.entries.length
  stats.knowledge_categories_present = [...knowledge.categories_present]
  stats.knowledge_categories_missing = [...knowledge.categories_missing]
  stats.architecture_overview_present = architecture.exists
  stats.impact_docs_consulted = impactModules.files.length

  stats.categories_run.push('gap')
  if (input.specClaims && input.specClaims.length > 0) {
    const corpus = [...decisions.premises, ...decisions.adrs]
    for (const claim of input.specClaims) {
      const result = checkPremise(claim, corpus, antiDecisions.entries)
      const antiHit = result.anti_decision_matches[0]
      if (antiHit) {
        findings.push({
          id: nextId('gap'),
          category: 'gap',
          severity: 'block',
          title: `Anti-decision hit: ${antiHit.entry.id} — ${antiHit.entry.title}`,
          detail: `Claim "${claim}" overlaps an anti-decision. Read ${antiHit.entry.id} before proceeding; require a revisit_reason if the dev wants to retry.`,
          affected_paths: [...input.declaredPaths],
          source: 'premise-check',
        })
        continue
      }
      const topMatch = result.matches[0]
      if (result.recommendation === 'conflict' && topMatch) {
        findings.push({
          id: nextId('gap'),
          category: 'gap',
          severity: 'address-now',
          title: `Conflict with ${topMatch.entry.id}: ${topMatch.entry.title}`,
          detail: `Claim "${claim}" matches a decision with rollback/rejection language. Surface ${topMatch.entry.id} to the dev and confirm the revisit is intentional.`,
          affected_paths: [...input.declaredPaths],
          source: 'premise-check',
        })
      } else if (result.recommendation === 'requires_revision' && topMatch) {
        findings.push({
          id: nextId('gap'),
          category: 'gap',
          severity: 'address-now',
          title: `Requires revision: matches ${topMatch.entry.id}`,
          detail: `Claim "${claim}" shares vocabulary with ${topMatch.entry.id} (${topMatch.entry.title}). Read the entry and align the claim or surface an explicit override.`,
          affected_paths: [...input.declaredPaths],
          source: 'premise-check',
        })
      }
    }
  } else if (decisions.exists || antiDecisions.exists) {
    hints.push(
      'No specClaims provided — premise check skipped. Pass specClaims[] extracted from the spec to enable the gap category.',
    )
  }

  stats.categories_run.push('breakage')
  if (input.discoveredImporters.length > 0) {
    const grouped = new Map<string, DiscoveredImporterRef[]>()
    for (const imp of input.discoveredImporters) {
      const seed = imp.via_paths[0] ?? '<unknown-seed>'
      let list = grouped.get(seed)
      if (!list) {
        list = []
        grouped.set(seed, list)
      }
      list.push(imp)
    }
    for (const [seed, importers] of grouped) {
      const directCount = importers.filter((i) => i.depth === 1).length
      const transCount = importers.length - directCount
      const severity: FindingSeverity =
        directCount > 5
          ? 'address-now'
          : directCount > 0
            ? 'capture-as-issue'
            : 'defer'
      const head = importers
        .slice(0, 10)
        .map((i) => `  - ${i.file} (depth ${i.depth})`)
        .join('\n')
      const overflow =
        importers.length > 10
          ? `\n  ... and ${importers.length - 10} more`
          : ''
      findings.push({
        id: nextId('breakage'),
        category: 'breakage',
        severity,
        title: `Edits to ${seed} affect ${importers.length} importer(s) (${directCount} direct, ${transCount} transitive)`,
        detail: `Reverse-dep walk surfaced these files as candidates for breakage when ${seed} changes:\n${head}${overflow}`,
        affected_paths: [seed, ...importers.map((i) => i.file)],
        source: 'reverse-dep-walk',
      })
    }
  }

  for (const declaredPath of input.declaredPaths) {
    const guess = stripExt(declaredPath)
    const impactDoc = impactModules.files.find((f) => f.name === guess)
    if (impactDoc) {
      findings.push({
        id: nextId('breakage'),
        category: 'breakage',
        severity: 'address-now',
        title: `Impact doc exists for ${guess}`,
        detail: `documentation/impact/${guess}.md exists. Read it for non-obvious couplings and pre-merge checklists before editing ${declaredPath}.`,
        affected_paths: [declaredPath, impactDoc.path],
        source: 'impact-doc',
      })
    }
  }

  stats.categories_run.push('redundancy')
  if (input.existingProjectFiles && input.existingProjectFiles.length > 0) {
    const declaredSet = new Set(input.declaredPaths)
    for (const declaredPath of input.declaredPaths) {
      const moduleName = stripExt(declaredPath)
      if (moduleName.length < 4) continue
      if (COMMON_BASENAMES.has(moduleName)) continue
      const overlaps = input.existingProjectFiles.filter((f) => {
        if (declaredSet.has(f)) return false
        return stripExt(f) === moduleName
      })
      if (overlaps.length > 0) {
        findings.push({
          id: nextId('redundancy'),
          category: 'redundancy',
          severity: 'capture-as-issue',
          title: `Possible redundancy: '${moduleName}' already in ${overlaps.length} other location(s)`,
          detail: `Declared path '${declaredPath}' has basename '${moduleName}', which already appears in: ${overlaps.slice(0, 5).join(', ')}${overlaps.length > 5 ? '...' : ''}. Consider whether the new file duplicates existing functionality.`,
          affected_paths: [declaredPath, ...overlaps],
          source: 'basename-overlap',
        })
      }
    }
  }

  stats.categories_run.push('forgotten')
  const tierMaxPrompts = input.specTier === 'complex' ? 10 : 5
  let promptedCount = 0
  for (const cat of knowledge.categories_present) {
    if (promptedCount >= tierMaxPrompts) break
    const prompt = CATEGORY_PROMPTS[cat]
    if (!prompt) continue
    findings.push({
      id: nextId('forgotten'),
      category: 'forgotten',
      severity: 'defer',
      title: `Checklist: ${cat}`,
      detail: prompt,
      affected_paths: [...input.declaredPaths],
      source: `knowledge-category:${cat}`,
    })
    promptedCount++
  }

  if (architecture.exists && architecture.sections.length > 0) {
    findings.push({
      id: nextId('forgotten'),
      category: 'forgotten',
      severity: 'defer',
      title: 'Checklist: architecture overview',
      detail: `documentation/architecture.md has ${architecture.sections.length} sections. Confirm the spec aligns with the documented architecture before code-phase.`,
      affected_paths: [...input.declaredPaths],
      source: 'architecture-overview',
    })
  }

  if (findings.length === 0) {
    if (
      !decisions.exists &&
      !antiDecisions.exists &&
      knowledge.categories_present.length === 0 &&
      !architecture.exists
    ) {
      hints.push(
        'Verification corpus is empty (no decisions.md, anti-decisions.md, knowledge categories, or architecture.md). Bootstrap via /rsct-setup so this checklist has signal to surface.',
      )
    } else {
      hints.push(
        'Verification checklist found no findings to surface against the available corpus.',
      )
    }
  }

  return { findings, stats, hints }
}
