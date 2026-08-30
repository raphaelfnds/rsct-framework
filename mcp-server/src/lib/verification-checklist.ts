import { basename } from 'node:path'

import { readDecisions } from './decisions.js'
import { readAntiDecisions } from './anti-decisions.js'
import { corpusMiss, type CorpusMiss } from './corpus-health.js'
import { readKnowledgeIndex } from './knowledge.js'
import {
  readArchitectureOverview,
  readArchitectureModules,
} from './architecture.js'
import { checkPremise } from './premise-check.js'
import { makeIdGenerator, type FindingEvidence, type FindingSeverity } from './findings.js'
import type { DiscoveredImporter as DiscoveredImporterRef } from './reverse-dep-walk.js'
import {
  affectedConsumers,
  contractsTouchingPaths,
  EMPTY_CONTRACT_GRAPH,
  type ContractGraph,
} from './contracts.js'

export type FindingCategory = 'gap' | 'breakage' | 'redundancy' | 'forgotten'

/**
 * Suggested severity that the V phase complete tool surfaces to the dev. The
 * dev's final action lives in the `findings_actions[]` input of
 * `rsct_phase_verification_complete` — these are recommendations, not gates.
 *
 * Re-exported from `lib/findings.ts` rather than redeclared (#19), so this
 * module's consumers keep importing it from here and the value list has exactly
 * one home. See that module for why severity and action stay two names.
 */
export type { FindingSeverity } from './findings.js'

export interface VerificationFinding {
  id: string
  category: FindingCategory
  severity: FindingSeverity
  title: string
  detail: string
  affected_paths: string[]
  source: string
  /**
   * #75. How this finding is known. The V phase has no agent-declared findings
   * channel — `phaseVerificationStartInputSchema` is `.strict()` with no
   * `findings` field, so everything here is machine-produced — which means the
   * framework must classify its OWN findings or the class covers half the record.
   *
   * Derived from `source` by {@link evidenceForSource}, a static table authored
   * once in this file and reviewed in a diff. That is what makes
   * `also_explained_by` honest on this side: it is written by a person, checked
   * by a reviewer, and cannot be produced under queue pressure by an agent that
   * wants to move on.
   */
  evidence: FindingEvidence
}

/** What the emission sites build. Evidence is added centrally — see below. */
type RawFinding = Omit<VerificationFinding, 'evidence'>

/**
 * `source` → evidence class. TOTAL by construction: the `default` arm returns the
 * WEAKEST class, so a source literal added years from now degrades safely instead
 * of inheriting whatever row sat next to it. That is the same door policy the
 * rest of the design runs on — absent or unrecognised is never fact.
 *
 * Matched by PREFIX for `knowledge-category:`, which is interpolated per category
 * (`verification-checklist.ts` builds `knowledge-category:${cat}`); an equality
 * table would miss every one of them.
 *
 * `tests/unit/verification-evidence.test.ts` asserts no source the checklist can
 * actually emit reaches the `default` arm, so drift is named on the day it lands.
 * The type of `source` is deliberately left as `string` rather than narrowed to a
 * union — that is a retype with ripple through every `VerificationFinding`
 * consumer, and it is not riding along on this feature.
 */
export function evidenceForSource(f: RawFinding): FindingEvidence {
  if (f.source === 'reverse-dep-walk') {
    return {
      kind: 'measured',
      command: 'reverse-dep walk over declared_paths (lib/reverse-dep-walk.ts)',
      output_excerpt: f.title,
      also_explained_by:
        'The importers may already tolerate the change — this walk reads import EDGES, not semantics. A dynamic, aliased or generated import is invisible to it, so an absent edge is not an absent dependency, and a present one is not a break.',
    }
  }
  if (f.source === 'impact-doc') {
    return {
      kind: 'reported',
      // affected_paths[1] is the doc; [0] is the declared path that matched it.
      source: f.affected_paths[1] ?? 'documentation/impact/',
      verified_against: 'working_tree',
    }
  }
  if (f.source === 'architecture-overview') {
    return {
      kind: 'reported',
      source: 'documentation/architecture.md',
      verified_against: 'working_tree',
    }
  }
  if (f.source === 'contract-surface') {
    return {
      kind: 'measured',
      command: 'contractsTouchingPaths(readContracts(universeRoot), app, declared_paths)',
      output_excerpt: f.title,
      also_explained_by:
        'The consumers may not exercise the part of the surface that changed — a contract records a GLOB, not a call graph. And a consumer missing from contracts.json is invisible here, because that file is hand-written and no installer maintains it.',
    }
  }
  if (f.source === 'premise-check') {
    return {
      kind: 'hypothesis',
      how_to_falsify:
        'Open the referenced entry. The matcher scores SHARED TOKENS over title+excerpt, so if the shared words are generic domain nouns rather than the terms carrying the claim, this is vocabulary coincidence and the finding is false. Two shared tokens is enough to match.',
    }
  }
  if (f.source === 'basename-overlap') {
    return {
      kind: 'hypothesis',
      how_to_falsify:
        'Open the overlapping files. A shared basename is not duplication — parallel layers (a model and its controller, a port and its adapter) routinely share one.',
    }
  }
  if (f.source.startsWith('knowledge-category:')) {
    return {
      kind: 'hypothesis',
      how_to_falsify:
        'This is a PROMPT, not an observation: the checklist saw that the category exists, never that the spec ignored it. If the spec already covers it, the finding is answered by saying so.',
    }
  }
  // Weakest class, and it names the literal so the exhaustiveness test can report
  // WHICH source drifted rather than only that one did.
  //
  // DO NOT DELETE as redundant now that `RawFinding` makes classification total.
  // That totality covers EMISSION — a site cannot build a finding without going
  // through this function. It does NOT cover this function's own input: `source`
  // is a `string`, so a literal added by a future emission site lands here with no
  // type error. (The same split is why `coerceEvidence` keeps its own fallback for
  // stored values.) Removing either one trades a loud degrade for a silent gap.
  return {
    kind: 'hypothesis',
    how_to_falsify: `Unclassified checklist source '${f.source}' — no evidence class is recorded for it, so it is treated as a guess. Add a row to evidenceForSource().`,
    degraded: true,
    degraded_from: `unknown_source:${f.source}`,
  }
}

/**
 * Structurally identical to `DiscoveredImporter` in `lib/reverse-dep-walk.ts`,
 * which is what actually flows in here — the two were declared separately and
 * stayed in sync by luck (#10). Aliased rather than deleted so existing importers
 * keep their path; `reverse-dep-walk` is the producer and therefore the owner.
 */
export type { DiscoveredImporter as DiscoveredImporterRef } from './reverse-dep-walk.js'

export interface ChecklistInput {
  projectRoot: string
  declaredPaths: string[]
  discoveredImporters: DiscoveredImporterRef[]
  specClaims?: string[]
  specTier?: 'trivial' | 'small' | 'standard' | 'complex'
  existingProjectFiles?: string[]
  /**
   * #75 Part B. The org contract graph, read by the caller (which holds the
   * config `detectTopology` needs). Injected rather than read here so this module
   * keeps taking a project root and nothing else, and so a test can hand it a
   * graph without a universe on disk.
   *
   * Omitted or empty is a NO-OP, not a failure — see `contract_graph` in the stats.
   */
  contractGraph?: ContractGraph
  /** This project's app name, the producer side of a contract. */
  appName?: string | null
  /** Whether a universe root resolved at all — distinguishes two of the no-op states. */
  universeLinked?: boolean
}

export interface ChecklistStats {
  categories_run: FindingCategory[]
  knowledge_categories_present: string[]
  knowledge_categories_missing: string[]
  decisions_scanned: number
  anti_decisions_scanned: number
  impact_docs_consulted: number
  architecture_overview_present: boolean
  /**
   * #75 Part B. Why the contract check did or did not produce anything. FOUR
   * no-op states, reported rather than hidden:
   *
   *  - `no_universe`    — the project is not linked to an org universe
   *  - `no_manifest`    — linked, but no readable `contracts.json`. This is the
   *                       DEFAULT state of every universe: the file is
   *                       hand-written and no installer creates it.
   *  - `degraded`       — present but oversize / unreadable / malformed
   *  - `available`      — a real graph was consulted
   *  - `not_run`        — the tier skipped the checklist entirely
   */
  contract_graph: 'no_universe' | 'no_manifest' | 'degraded' | 'available' | 'not_run'
  contracts_scanned: number
}

export interface ChecklistResult {
  findings: VerificationFinding[]
  stats: ChecklistStats
  hints: string[]
}

/**
 * Exported for the #75 exhaustiveness test, which derives its expected
 * `knowledge-category:*` source set from these keys rather than hand-listing
 * them — a hand-written list goes stale the day a category is added, silently.
 */
export const CATEGORY_PROMPTS: Record<string, string> = {
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

function stripExt(p: string): string {
  return basename(p).replace(/\.[^.]+$/, '')
}

export function runVerificationChecklist(
  input: ChecklistInput,
): ChecklistResult {
  const findings: RawFinding[] = []
  const hints: string[] = []
  // `v-` prefix: V-phase ids must stay distinguishable from REVIEW-phase ones in
  // a shared audit trail, since findings_actions[] references them by hand.
  const nextId = makeIdGenerator('v')

  const stats: ChecklistStats = {
    categories_run: [],
    knowledge_categories_present: [],
    knowledge_categories_missing: [],
    decisions_scanned: 0,
    anti_decisions_scanned: 0,
    impact_docs_consulted: 0,
    architecture_overview_present: false,
    contract_graph: 'not_run',
    contracts_scanned: 0,
  }

  if (input.specTier === 'trivial' || input.specTier === 'small') {
    hints.push(
      `spec_tier=${input.specTier} — verification checklist skipped per tier table.`,
    )
    // Nothing was raised, so nothing needs classifying — and returning `findings`
    // here would leak the unclassified RawFinding[] out of the one door that adds
    // the class. Empty literal keeps that door the only way out.
    return { findings: [], stats, hints }
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

  // #58 — "no findings against the available corpus" is only true if the corpus was
  // actually readable. A file that exists but could not be read, or that carries ids
  // nothing parsed, must not be counted as an empty-but-fine corpus: this checklist
  // is what closes the V phase, so a clean pass over an unread file is the same
  // silent zero #49 and #58 exist to remove — one phase later, and more expensive.
  const corpusUnread: string[] = []
  const describeMiss = (file: string, miss: CorpusMiss): void => {
    if (miss === 'unreadable') corpusUnread.push(`${file} (exists, unreadable)`)
    else if (miss === 'ids-unparsed') corpusUnread.push(`${file} (mentions ids, none parsed)`)
  }
  describeMiss(
    'documentation/decisions.md',
    corpusMiss({
      read_error: decisions.read_error,
      has_ids: decisions.has_decision_ids,
      parsed_count: decisions.premises.length + decisions.adrs.length,
    }),
  )
  describeMiss(
    'documentation/knowledge/anti-decisions.md',
    corpusMiss({
      read_error: antiDecisions.read_error,
      has_ids: antiDecisions.has_entry_ids,
      parsed_count: antiDecisions.entries.length,
    }),
  )
  if (corpusUnread.length > 0) {
    hints.push(
      `⚠ Part of the verification corpus was NOT read: ${corpusUnread.join('; ')}. Treat the scanned counts as UNKNOWN rather than as "nothing recorded", and repair the file before relying on this checklist.`,
    )
  }

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

  // #75 Part B. Graph-backed adjacency: does this change touch a surface another
  // app declares a dependency on? Answered MECHANICALLY, from a manifest, instead
  // of trusting an assertion that it was checked — which is the whole point.
  //
  // No dependency on #54: `contractsTouchingPaths` returns this shape in-process
  // today. What #54 would add is persistence and a queryable tool, neither of
  // which this needs.
  //
  // FOUR no-op states, each recorded rather than hidden. The second one is the
  // common case, not an edge: `contracts.json` is hand-written and no installer
  // creates it, so an empty graph is the DEFAULT state of every universe.
  const graph = input.contractGraph ?? EMPTY_CONTRACT_GRAPH
  if (!input.universeLinked) stats.contract_graph = 'no_universe'
  else if (graph.available) stats.contract_graph = 'available'
  else if (graph.note !== null) stats.contract_graph = 'degraded'
  else stats.contract_graph = 'no_manifest'
  stats.contracts_scanned = graph.contracts.length

  if (graph.available) {
    const touched = contractsTouchingPaths(graph, input.appName ?? null, input.declaredPaths)
    for (const contract of touched) {
      const consumers = affectedConsumers([contract])
      // A contract with no consumers gates nothing — reporting it would charge a
      // mandatory action for a dependency nobody declared.
      if (consumers.length === 0) continue
      findings.push({
        id: nextId('breakage'),
        category: 'breakage',
        severity: 'address-now',
        title: `Contract '${contract.id}' surface touched — ${consumers.length} consumer(s) declared`,
        detail: `Declared paths match the surface of contract '${contract.id}', which ${consumers.join(', ')} depend${consumers.length === 1 ? 's' : ''} on. Surface globs: ${contract.surface.join(', ')}.${contract.description ? ` ${contract.description}` : ''}`,
        affected_paths: [...input.declaredPaths],
        source: 'contract-surface',
      })
    }
  } else if (input.universeLinked && stats.contract_graph === 'degraded') {
    hints.push(
      `⚠ contract graph unavailable (${graph.note}) — the adjacency check did not run. This is a coverage GAP, not a clean pass.`,
    )
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
    } else if (corpusUnread.length === 0) {
      // Only claim a clean pass when every corpus file was actually read — the
      // warning above already says what happened when one was not.
      hints.push(
        'Verification checklist found no findings to surface against the available corpus.',
      )
    }
  }

  // #75. The ONE place a checklist finding acquires its class. Assigning here
  // rather than at the eight emission sites is what makes the table total: a new
  // site cannot forget to classify, because the type it builds has no such field.
  const classified: VerificationFinding[] = findings.map((f) => ({
    ...f,
    evidence: evidenceForSource(f),
  }))

  return { findings: classified, stats, hints }
}
