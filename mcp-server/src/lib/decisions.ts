import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ENTRY_HEADING_SEPARATOR, makeExcerpt } from './markdown.js'

export type DecisionStatus = 'active' | 'superseded' | 'deprecated'

export const DECISION_STATUSES: readonly DecisionStatus[] = [
  'active',
  'superseded',
  'deprecated',
] as const

export interface DecisionEntry {
  kind: 'premise' | 'adr'
  id: string
  title: string
  excerpt: string
  status?: DecisionStatus
  tags?: string[]
}

export interface DecisionsSnapshot {
  exists: boolean
  path: string | null
  premises: DecisionEntry[]
  adrs: DecisionEntry[]
  /**
   * #49 — the body contains at least one token SHAPED like a decision id
   * (`ADR-NNN` or `#N`). Combined with an empty result it identifies a parser
   * miss, which has to be REPORTED: a clean zero reads as "this project has no
   * decisions", and that is how dozens of real ADRs stayed invisible.
   *
   * Deliberately narrower than "the file is non-empty": a decisions.md holding
   * only section headings genuinely has no entries, and warning about it on every
   * bootstrap would train the reader to ignore the warning.
   */
  has_decision_ids: boolean
  /**
   * #49 — the file exists but could not be READ (a directory at that path,
   * mode 000, a Windows lock). Content is unknown, so this is the one case where
   * zero entries proves nothing at all — it must be reported, not returned as a
   * clean zero, which is the exact failure this field exists to close.
   */
  read_error: boolean
}

/**
 * Parse `documentation/decisions.md` extracting firm premises (#N) and
 * durable ADRs (ADR-NNN) as structured entries.
 *
 * The parser uses a line-by-line scan (not regex-with-end-anchor): an
 * entry's body runs from its heading until the next H3 / H2 / `---` /
 * end-of-file. This matches the canonical template shape but tolerates
 * variation, and is robust to EOF (a JS regex has no end-of-input
 * anchor — earlier versions used `\z` which silently parsed as literal
 * `z` and worked only by accident of fixture shape).
 */
export function readDecisions(projectRoot: string): DecisionsSnapshot {
  const path = join(projectRoot, 'documentation', 'decisions.md')
  if (!existsSync(path)) {
    return {
      exists: false,
      path: null,
      premises: [],
      adrs: [],
      has_decision_ids: false,
      read_error: false,
    }
  }

  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return {
      exists: true,
      path,
      premises: [],
      adrs: [],
      has_decision_ids: false,
      read_error: true,
    }
  }

  const { premises, adrs } = extractDecisions(body)
  return {
    exists: true,
    path,
    premises,
    adrs,
    has_decision_ids: DECISION_ID_TOKEN.test(body),
    read_error: false,
  }
}

/**
 * A token shaped like a decision id, anywhere in the body. Used only to tell
 * "nothing to find" apart from "found nothing" — never to parse.
 */
const DECISION_ID_TOKEN = /\bADR-\d+\b|(?:^|\s)#\d+\b/m

// #49 — accept every heading shape a real decisions.md is written in, not only the
// one §H prescribes. A file using `##`, a colon, or an en dash parsed to zero
// entries and reported it as a clean zero. The separator lives in `lib/markdown.ts`
// so this parser and the anti-decisions one cannot drift apart (#58); its two
// load-bearing details are documented there.
//
// The section terminator below is deliberately NOT relaxed: both heading branches
// `continue`, so a matched `##` entry never reaches it and cannot terminate itself.
// Dropping `^##\s` there would instead stop a trailing `## Out of scope` from
// closing the last entry in any file written without `---` separators.
const PREMISE_HEADING = new RegExp(
  String.raw`^#{2,3}\s+#(\d+)` + ENTRY_HEADING_SEPARATOR + String.raw`(.+?)\s*$`,
)
const ADR_HEADING = new RegExp(
  String.raw`^#{2,3}\s+(ADR-\d+)` + ENTRY_HEADING_SEPARATOR + String.raw`(.+?)\s*$`,
)

interface PendingEntry {
  kind: 'premise' | 'adr'
  id: string
  title: string
  bodyLines: string[]
}

export function extractDecisions(body: string): {
  premises: DecisionEntry[]
  adrs: DecisionEntry[]
} {
  const lines = body.split('\n')
  const premises: DecisionEntry[] = []
  const adrs: DecisionEntry[] = []
  let current: PendingEntry | null = null

  const flush = () => {
    if (!current) return
    const entry = buildEntry(
      current.kind,
      current.id,
      current.title,
      current.bodyLines.join('\n'),
    )
    if (current.kind === 'premise') premises.push(entry)
    else adrs.push(entry)
    current = null
  }

  for (const line of lines) {
    const premiseMatch = line.match(PREMISE_HEADING)
    if (premiseMatch?.[1] && premiseMatch[2]) {
      flush()
      current = {
        kind: 'premise',
        id: `#${premiseMatch[1]}`,
        title: premiseMatch[2].trim(),
        bodyLines: [],
      }
      continue
    }

    const adrMatch = line.match(ADR_HEADING)
    if (adrMatch?.[1] && adrMatch[2]) {
      flush()
      current = {
        kind: 'adr',
        id: adrMatch[1],
        title: adrMatch[2].trim(),
        bodyLines: [],
      }
      continue
    }

    if (current && (/^##\s/.test(line) || /^###\s/.test(line) || /^---\s*$/.test(line))) {
      flush()
      continue
    }

    if (current) current.bodyLines.push(line)
  }

  flush()
  return { premises, adrs }
}

function buildEntry(
  kind: 'premise' | 'adr',
  id: string,
  title: string,
  section: string,
): DecisionEntry {
  const meta = extractMeta(section)
  const entry: DecisionEntry = {
    kind,
    id,
    title,
    excerpt: extractExcerpt(section),
  }
  if (meta.status) entry.status = meta.status
  if (meta.tags && meta.tags.length > 0) entry.tags = meta.tags
  return entry
}

const META_LINE_REGEX = /^\s*\*\*(Status|Tags)\*\*\s*:/i

function extractMeta(section: string): { status?: DecisionStatus; tags?: string[] } {
  const out: { status?: DecisionStatus; tags?: string[] } = {}

  const statusMatch = section.match(/^\s*\*\*Status\*\*\s*:\s*([A-Za-z]+)\s*$/im)
  if (statusMatch?.[1]) {
    const value = statusMatch[1].toLowerCase()
    if ((DECISION_STATUSES as readonly string[]).includes(value)) {
      out.status = value as DecisionStatus
    }
  }

  const tagsMatch = section.match(/^\s*\*\*Tags\*\*\s*:\s*(.+?)\s*$/im)
  if (tagsMatch?.[1]) {
    const tags = tagsMatch[1]
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    if (tags.length > 0) out.tags = tags
  }

  return out
}

/** Defaults (3 lines / 280 chars) plus this module's meta-line filter. */
function extractExcerpt(section: string): string {
  return makeExcerpt(section, { skipLine: (line) => META_LINE_REGEX.test(line) })
}
