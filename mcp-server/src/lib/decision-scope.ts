import { relative } from 'node:path'

import { extractAntiDecisions, readAntiDecisions, type AntiDecisionEntry, type AntiDecisionsSnapshot } from './anti-decisions.js'
import type { AppliesTo } from './applies-to.js'
import { openSweepRepo, readFilesUnderPrefix, readHeadFile, readTouchedPaths, type SweepRepo } from './comment-sweep/git-reads.js'
import { extractDecisions, readDecisions, type DecisionEntry, type DecisionsSnapshot } from './decisions.js'
import { specLabel } from './dialog-text.js'
import { DIALOG_LIST_SHOWN, writeListReport } from './gate-exceptions.js'
import { matchesAnyGlob, toPosix } from './phase-scope.js'
import { DEFAULT_EXCLUDE_GLOBS, walkFiles } from './reverse-dep-walk.js'

export const DECISIONS_FILE = 'documentation/decisions.md'

export const ANTI_DECISIONS_FILE = 'documentation/knowledge/anti-decisions.md'

const DETAIL_LINES_SHOWN = 20

const ISSUES_SHOWN = 10

export interface BoundDecision {
  key: string
  label: string
  title: string
  file: string
  globs: string[]
  added_since_head: boolean
}

export type HeadSide = 'read' | 'unreadable' | 'no_commit' | 'no_git' | 'not_read'

export interface BoundCorpus {
  entries: BoundDecision[]
  line_issues: string[]
  head: HeadSide
  head_notes: string[]
}

export interface DecisionHit {
  entry: BoundDecision
  path: string
  glob: string
}

interface SideEntry {
  key: string
  label: string
  title: string
  file: string
  appliesTo: AppliesTo | undefined
}

function decisionSide(parsed: { premises: readonly DecisionEntry[]; adrs: readonly DecisionEntry[] }): SideEntry[] {
  return [...parsed.premises, ...parsed.adrs].map((entry) => ({
    key: `${DECISIONS_FILE}\0${entry.id}`,
    label: entry.kind === 'premise' ? `premise ${entry.id}` : entry.id,
    title: entry.title,
    file: DECISIONS_FILE,
    appliesTo: entry.applies_to,
  }))
}

function antiSide(entries: readonly AntiDecisionEntry[]): SideEntry[] {
  return entries.map((entry) => ({
    key: `${ANTI_DECISIONS_FILE}\0${entry.id}`,
    label: entry.id,
    title: entry.title,
    file: ANTI_DECISIONS_FILE,
    appliesTo: entry.applies_to,
  }))
}

function merge(working: readonly SideEntry[], head: readonly SideEntry[], side: HeadSide, headNotes: string[]): BoundCorpus {
  const headKeys = new Set(head.map((entry) => entry.key))
  const byKey = new Map<string, BoundDecision>()
  const issues = new Set<string>()
  for (const entry of [...working, ...head]) {
    if (entry.appliesTo === undefined) continue
    for (const rejected of entry.appliesTo.rejected) issues.add(`${entry.label}: ${specLabel(rejected, 120)} is not used`)
    for (const value of entry.appliesTo.unbound) {
      issues.add(`${entry.label}: "${specLabel(value, 80)}" is not a comma-separated list of paths, so the line binds nothing`)
    }
    if (entry.appliesTo.globs.length === 0) continue
    const known = byKey.get(entry.key)
    if (known !== undefined) {
      for (const glob of entry.appliesTo.globs) if (!known.globs.includes(glob)) known.globs.push(glob)
      continue
    }
    byKey.set(entry.key, {
      key: entry.key,
      label: entry.label,
      title: entry.title,
      file: entry.file,
      globs: [...entry.appliesTo.globs],
      added_since_head: side === 'read' && !headKeys.has(entry.key),
    })
  }
  return { entries: [...byKey.values()], line_issues: [...issues], head: side, head_notes: headNotes }
}

export function boundDecisionsInFile(snapshot: DecisionsSnapshot): BoundCorpus {
  return merge(decisionSide(snapshot), [], 'not_read', [])
}

export function readBoundCorpus(
  projectRoot: string,
  options: { repo?: SweepRepo | null; decisions?: DecisionsSnapshot; antiDecisions?: AntiDecisionsSnapshot } = {},
): BoundCorpus {
  const decisions = options.decisions ?? readDecisions(projectRoot)
  const antiDecisions = options.antiDecisions ?? readAntiDecisions(projectRoot)
  const working = [...decisionSide(decisions), ...antiSide(antiDecisions.entries)]
  const repo = options.repo !== undefined ? options.repo : openSweepRepo(projectRoot)
  if (repo === null) return merge(working, [], 'no_git', [])
  if (repo.headCommit === null) return merge(working, [], 'no_commit', [])
  const head: SideEntry[] = []
  const notes: string[] = []
  const decisionsAtHead = readHeadFile(repo, `${repo.prefix}${DECISIONS_FILE}`)
  if (decisionsAtHead.state === 'present') head.push(...decisionSide(extractDecisions(decisionsAtHead.text)))
  if (decisionsAtHead.state === 'failed') notes.push(DECISIONS_FILE)
  const antiAtHead = readHeadFile(repo, `${repo.prefix}${ANTI_DECISIONS_FILE}`)
  if (antiAtHead.state === 'present') head.push(...antiSide(extractAntiDecisions(antiAtHead.text)))
  if (antiAtHead.state === 'failed') notes.push(ANTI_DECISIONS_FILE)
  return merge(working, head, notes.length > 0 ? 'unreadable' : 'read', notes)
}

export function listProjectFiles(projectRoot: string, repo: SweepRepo | null): string[] | null {
  if (repo !== null) return readFilesUnderPrefix(repo)
  return walkFiles(projectRoot, ['**'], DEFAULT_EXCLUDE_GLOBS).map((abs) => toPosix(relative(projectRoot, abs)))
}

export function declaredCandidates(declared: readonly string[], files: readonly string[]): string[] {
  const out = new Set<string>()
  for (const raw of declared) {
    let path = toPosix(raw).replace(/\/+$/, '')
    while (path.startsWith('./')) path = path.slice(2)
    if (path === '..' || path.startsWith('../') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) continue
    if (path === '' || path === '.') {
      for (const file of files) out.add(file)
      continue
    }
    out.add(path)
    out.add(`${path}/`)
    const glob = /[*?]/.test(path)
    for (const file of files) {
      if (file === path || file.startsWith(`${path}/`) || (glob && matchesAnyGlob(file, [path]).matched)) out.add(file)
    }
  }
  return [...out]
}

export function decisionsCovering(entries: readonly BoundDecision[], paths: readonly string[]): DecisionHit[] {
  const hits: DecisionHit[] = []
  for (const entry of entries) {
    for (const path of paths) {
      const match = matchesAnyGlob(path, entry.globs)
      if (match.matched) {
        hits.push({ entry, path, glob: match.matched_glob ?? '' })
        break
      }
    }
  }
  return hits
}

function unmatchedGlobs(corpus: BoundCorpus, files: readonly string[]): string[] {
  const lines: string[] = []
  for (const entry of corpus.entries) {
    for (const glob of entry.globs) {
      if (files.some((file) => matchesAnyGlob(file, [glob]).matched)) continue
      const folder = glob.replace(/\/+$/, '')
      const names = !/[*?]/.test(glob) && files.some((file) => file.startsWith(`${folder}/`))
      lines.push(`${entry.label}: ${specLabel(glob, 120)} matches no file${names ? ` (it names a folder: ${specLabel(folder, 120)}/** covers the files in it)` : ''}`)
    }
  }
  return lines
}

export function appliesToHints(corpus: BoundCorpus, files: readonly string[] | null): string[] {
  const hints: string[] = []
  const lines = [...(files === null ? [] : unmatchedGlobs(corpus, files)), ...corpus.line_issues]
  if (lines.length > 0) {
    const shown = lines.slice(0, ISSUES_SHOWN).join('; ')
    const more = lines.length > ISSUES_SHOWN ? ` … and ${lines.length - ISSUES_SHOWN} more` : ''
    hints.push(
      `"Applies to" lines that bind nothing (${lines.length}): ${shown}${more}. Such a decision is listed for no change by path; it still applies everywhere, like a decision without the line.`,
    )
  }
  if (files === null && corpus.entries.length > 0) {
    hints.push('The project file list could not be read: the "Applies to" globs were not checked against files, and declared folders were not expanded.')
  }
  if (corpus.head === 'unreadable') {
    hints.push(`⚠ ${corpus.head_notes.join(' and ')} could not be read at HEAD: the decisions bound to paths come from the working tree only.`)
  }
  return hints
}

const LABEL_LIMIT = 40

function shortLabel(hit: DecisionHit): string {
  return specLabel(hit.entry.label, LABEL_LIMIT)
}

export function hitLabels(hits: readonly DecisionHit[]): string {
  const shown = hits.slice(0, DIALOG_LIST_SHOWN).map(shortLabel).join(', ')
  return hits.length > DIALOG_LIST_SHOWN ? `${shown} … and ${hits.length - DIALOG_LIST_SHOWN} more` : shown
}

export function hitDetailLines(hits: readonly DecisionHit[]): string {
  const lines = hits
    .slice(0, DETAIL_LINES_SHOWN)
    .map((hit) => `- ${shortLabel(hit)} — ${specLabel(hit.entry.title, 120)}: ${specLabel(hit.path, 200)} matches ${specLabel(hit.glob, 120)}`)
  if (hits.length > DETAIL_LINES_SHOWN) lines.push(`... and ${hits.length - DETAIL_LINES_SHOWN} more`)
  return lines.join('\n')
}

export interface DeclaredCoverage {
  hits: DecisionHit[]
  hints: string[]
}

export function declaredDecisionCoverage(
  projectRoot: string,
  declared: readonly string[],
  working: { decisions: DecisionsSnapshot; antiDecisions: AntiDecisionsSnapshot },
): DeclaredCoverage {
  const repo = openSweepRepo(projectRoot)
  const corpus = readBoundCorpus(projectRoot, { repo, ...working })
  if (corpus.entries.length === 0 && corpus.line_issues.length === 0 && corpus.head !== 'unreadable') return { hits: [], hints: [] }
  const files = listProjectFiles(projectRoot, repo)
  const hits = decisionsCovering(corpus.entries, declaredCandidates(declared, files ?? []))
  return { hits, hints: appliesToHints(corpus, files) }
}

export interface DecisionCoverage {
  ids: string[]
  added_since_head: string[]
  report: string | null
  facts: string[]
  agent: string[]
}

export function reviewDecisionCoverage(projectRoot: string, repo: SweepRepo): DecisionCoverage | null {
  const corpus = readBoundCorpus(projectRoot, { repo })
  if (corpus.entries.length === 0 && corpus.head !== 'unreadable') return null
  const facts: string[] = []
  if (corpus.head === 'unreadable') {
    facts.push(`⚠ ${corpus.head_notes.join(' and ')} could not be read at HEAD: the decisions below come from the working tree only, and none is marked as added since HEAD.`)
  }
  const touched = readTouchedPaths(repo)
  if (touched === null) {
    facts.push('⚠ The changed files could not be read, so the decisions whose "Applies to" line covers them are not listed.')
    return { ids: [], added_since_head: [], report: null, facts, agent: [] }
  }
  const paths = touched.filter((t) => t.path.startsWith(repo.prefix)).map((t) => t.path.slice(repo.prefix.length))
  const hits = decisionsCovering(corpus.entries, paths)
  const ids = hits.map((hit) => hit.entry.label)
  const added = hits.filter((hit) => hit.entry.added_since_head).map((hit) => hit.entry.label)
  if (hits.length === 0) return { ids, added_since_head: added, report: null, facts, agent: [] }
  const marked = (hit: DecisionHit): string => `${shortLabel(hit)}${hit.entry.added_since_head ? ' (added since HEAD)' : ''}`
  const report =
    hits.length > DIALOG_LIST_SHOWN
      ? writeListReport(
          projectRoot,
          'review',
          'decisions',
          'Decisions whose "Applies to" line covers the changed files',
          hits.map((hit) => `${marked(hit)} — ${hit.entry.title} — ${hit.path} matches ${hit.glob}`),
        )
      : null
  const shown = hits.slice(0, DIALOG_LIST_SHOWN)
  facts.push(`Decisions whose "Applies to" line covers the changed files (${hits.length}): ${shown.map(marked).join(', ')}`)
  if (shown.length < hits.length) facts.push(`… and ${hits.length - shown.length} more — full list: ${report ?? 'the report could not be written'}`)
  const agent = ['Titles of those decisions, from the decisions files:', ...shown.map((hit) => `${shortLabel(hit)} — ${specLabel(hit.entry.title, 80)}`)]
  return { ids, added_since_head: added, report, facts, agent }
}
