import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { collectAppliesTo, type AppliesTo } from './applies-to.js'
import { isRegularFileMode, readBlobTexts, readHeadFolder, type SweepRepo } from './comment-sweep/git-reads.js'
import { appliesToLineIssues, declaredCandidates, unmatchedGlobs, type HeadSide, type ScopeContext } from './decision-scope.js'
import { specLabel } from './dialog-text.js'
import { globToRegex, toPosix } from './phase-scope.js'

const IMPACT_DIR = 'documentation/impact'

const ISSUES_SHOWN = 10

export interface ImpactDoc {
  path: string
  name: string
  globs: string[]
  in_working_tree: boolean
  at_head: boolean
  working_unreadable: boolean
  added_since_head: boolean
  changed_since_head: boolean
}

export interface ImpactCorpus {
  docs: ImpactDoc[]
  line_issues: string[]
  head: HeadSide
  head_notes: string[]
  working_listing_failed: boolean
}

export interface ImpactMatch {
  path: string
  via: string
}

export interface ImpactHit {
  doc: ImpactDoc
  matches: ImpactMatch[]
  total: number
}

const IMPACT_MATCHES_KEPT = 20

const STYLED_NEAR_MISS = /applies[\s_-]*to\s*(?::|\*\*|__)/i

interface SideDoc {
  path: string
  name: string
  text: string | null
  appliesTo: AppliesTo | undefined
}

function isImpactDocName(name: string): boolean {
  return /\.md$/i.test(name) && !/^README\.md$/i.test(name)
}

function sideDoc(fileName: string, text: string | null): SideDoc {
  const appliesTo = text === null ? undefined : collectAppliesTo(text)
  return {
    path: `${IMPACT_DIR}/${fileName}`,
    name: fileName.replace(/\.md$/i, ''),
    text,
    appliesTo: appliesTo === undefined ? undefined : { ...appliesTo, unread: appliesTo.unread.filter((line) => STYLED_NEAR_MISS.test(line)) },
  }
}

function workingSide(projectRoot: string): { docs: SideDoc[]; failed: boolean } {
  const dir = join(projectRoot, IMPACT_DIR)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { docs: [], failed: code !== 'ENOENT' && code !== 'ENOTDIR' }
  }
  const docs: SideDoc[] = []
  for (const entry of entries) {
    if (!isImpactDocName(entry.name) || entry.isDirectory()) continue
    let text: string | null
    try {
      text = readFileSync(join(dir, entry.name), 'utf8')
    } catch {
      text = null
    }
    docs.push(sideDoc(entry.name, text))
  }
  return { docs, failed: false }
}

function headSide(repo: SweepRepo | null): { side: HeadSide; docs: SideDoc[]; notes: string[] } {
  if (repo === null) return { side: 'no_git', docs: [], notes: [] }
  if (repo.headCommit === null) return { side: 'no_commit', docs: [], notes: [] }
  const folder = readHeadFolder(repo, `${repo.prefix}${IMPACT_DIR}`)
  if (folder.state === 'failed') return { side: 'unreadable', docs: [], notes: [IMPACT_DIR] }
  if (folder.state === 'missing') return { side: 'read', docs: [], notes: [] }
  const wanted = folder.entries.filter((entry) => isImpactDocName(entry.name) && entry.type !== 'tree')
  const regular = wanted.filter((entry) => entry.type === 'blob' && isRegularFileMode(entry.mode))
  const notes = wanted.filter((entry) => !regular.includes(entry)).map((entry) => `${IMPACT_DIR}/${entry.name}`)
  const blobs = regular.length > 0 ? readBlobTexts(repo, regular.map((entry) => entry.id)) : { texts: new Map<string, string>(), failed: new Set<string>() }
  if (blobs === null) return { side: 'unreadable', docs: [], notes: [IMPACT_DIR] }
  const docs: SideDoc[] = []
  for (const entry of regular) {
    const text = blobs.texts.get(entry.id)
    if (text === undefined) notes.push(`${IMPACT_DIR}/${entry.name}`)
    else docs.push(sideDoc(entry.name, text))
  }
  return { side: notes.length > 0 ? 'unreadable' : 'read', docs, notes }
}

export function readImpactCorpus(projectRoot: string, repo: SweepRepo | null): ImpactCorpus {
  const working = workingSide(projectRoot)
  const head = headSide(repo)
  const issues = new Set<string>()
  const byPath = new Map<string, ImpactDoc>()
  const key = (path: string): string => path.normalize('NFC')
  for (const doc of working.docs) {
    for (const issue of appliesToLineIssues(doc.path, doc.appliesTo)) issues.add(issue)
    byPath.set(key(doc.path), {
      path: doc.path,
      name: doc.name,
      globs: [...(doc.appliesTo?.globs ?? [])],
      in_working_tree: true,
      at_head: false,
      working_unreadable: doc.text === null,
      added_since_head: head.side === 'read',
      changed_since_head: false,
    })
  }
  for (const doc of head.docs) {
    for (const issue of appliesToLineIssues(doc.path, doc.appliesTo)) issues.add(issue)
    const headGlobs = doc.appliesTo?.globs ?? []
    const known = byPath.get(key(doc.path))
    if (known === undefined) {
      byPath.set(key(doc.path), {
        path: doc.path,
        name: doc.name,
        globs: [...headGlobs],
        in_working_tree: false,
        at_head: true,
        working_unreadable: working.failed,
        added_since_head: false,
        changed_since_head: false,
      })
      continue
    }
    known.at_head = true
    known.added_since_head = false
    known.changed_since_head = !known.working_unreadable && headGlobs.some((glob) => !known.globs.includes(glob))
    for (const glob of headGlobs) if (!known.globs.includes(glob)) known.globs.push(glob)
  }
  const docs = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { docs, line_issues: [...issues], head: head.side, head_notes: head.notes, working_listing_failed: working.failed }
}

function stripExtension(path: string): string {
  return basename(toPosix(path)).replace(/\.[^.]+$/, '')
}

function impactDocsCovering(docs: readonly ImpactDoc[], declared: readonly string[], candidates: readonly string[]): ImpactHit[] {
  const hits: ImpactHit[] = []
  for (const doc of docs) {
    const matches: ImpactMatch[] = []
    const seen = new Set<string>()
    const add = (match: ImpactMatch): void => {
      seen.add(match.path)
      if (matches.length < IMPACT_MATCHES_KEPT) matches.push(match)
    }
    for (const path of declared) {
      if (stripExtension(path) !== doc.name || seen.has(path)) continue
      add({ path, via: 'the same file name' })
    }
    const matchers = doc.globs.map((glob) => ({ glob, matcher: globToRegex(glob) }))
    for (const candidate of candidates) {
      const path = candidate.length > 1 ? candidate.replace(/\/$/, '') : candidate
      if (seen.has(path)) continue
      const match = matchers.find((m) => m.matcher.test(candidate))
      if (match === undefined) continue
      add({ path, via: `"Applies to" ${match.glob}` })
    }
    if (seen.size > 0) hits.push({ doc, matches, total: seen.size })
  }
  return hits
}

export function impactMark(doc: ImpactDoc): string {
  if (doc.working_unreadable) return ' (unreadable in the working tree)'
  if (!doc.in_working_tree) return ' (deleted in the working tree)'
  if (doc.added_since_head) return ' (added since HEAD)'
  if (doc.changed_since_head) return ' (line removed or changed since HEAD)'
  return ''
}

export function impactMatchLines(hit: ImpactHit): string {
  const lines = hit.matches.map((match) => `- ${specLabel(match.path, 200)} (${specLabel(match.via, 140)})`)
  if (hit.total > hit.matches.length) lines.push(`... and ${hit.total - hit.matches.length} more`)
  return lines.join('\n')
}

function impactHints(corpus: ImpactCorpus, files: readonly string[] | null): string[] {
  const hints: string[] = []
  const entries = corpus.docs.map((doc) => ({ label: doc.path, globs: doc.globs }))
  const lines = [...(files === null ? [] : unmatchedGlobs({ entries }, files)), ...corpus.line_issues]
  if (lines.length > 0) {
    const shown = lines.slice(0, ISSUES_SHOWN).join('; ')
    const more = lines.length > ISSUES_SHOWN ? ` … and ${lines.length - ISSUES_SHOWN} more` : ''
    hints.push(
      `"Applies to" problems in ${IMPACT_DIR} (${lines.length}): ${shown}${more}. A refused glob, or one that matches no file, is not used; the impact doc is still matched by its file name.`,
    )
  }
  if (files === null && corpus.docs.some((doc) => doc.globs.length > 0)) {
    hints.push(`The project file list could not be read: the "Applies to" globs of ${IMPACT_DIR} were not checked against files, and declared folders were not expanded.`)
  }
  if (corpus.head === 'unreadable') {
    hints.push(`⚠ ${corpus.head_notes.join(' and ')} could not be read at HEAD: those impact docs come from the working tree only.`)
  }
  const unreadable = corpus.docs.filter((doc) => doc.working_unreadable && doc.in_working_tree).map((doc) => doc.path)
  if (unreadable.length > 0) {
    hints.push(`⚠ ${unreadable.join(' and ')} could not be read in the working tree: ${unreadable.length === 1 ? 'its' : 'their'} "Applies to" line comes from HEAD only.`)
  }
  if (corpus.working_listing_failed) {
    hints.push(`⚠ ${IMPACT_DIR} could not be listed in the working tree: the impact docs come from HEAD only.`)
  }
  return hints
}

export interface ImpactCoverage {
  hits: ImpactHit[]
  hints: string[]
  consulted: number
  head_commit: string | null
}

export function declaredImpactCoverage(projectRoot: string, declared: readonly string[], context: ScopeContext): ImpactCoverage {
  const corpus = readImpactCorpus(projectRoot, context.repo)
  const bound = corpus.docs.some((doc) => doc.globs.length > 0)
  const files = bound ? context.files() : []
  const hits = impactDocsCovering(corpus.docs, declared, bound ? declaredCandidates(declared, files ?? []) : [])
  return {
    hits,
    hints: impactHints(corpus, bound ? files : []),
    consulted: corpus.docs.length,
    head_commit: corpus.head === 'read' || corpus.head === 'unreadable' ? context.repo?.headCommit ?? null : null,
  }
}
