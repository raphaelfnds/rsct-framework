import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeExcerpt } from './markdown.js'

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
   * #49 — true when the file exists and holds more than whitespace. Callers use
   * `exists && has_content && no entries` to detect the silent-zero case: a file
   * that plainly has content but yielded nothing the parser recognised. That
   * combination has to be REPORTED; returning a clean zero reads as "this project
   * has no decisions", which is how dozens of real ADRs stayed invisible.
   */
  has_content: boolean
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
    return { exists: false, path: null, premises: [], adrs: [], has_content: false }
  }

  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return { exists: true, path, premises: [], adrs: [], has_content: false }
  }

  const { premises, adrs } = extractDecisions(body)
  return { exists: true, path, premises, adrs, has_content: body.trim().length > 0 }
}

// #49 — accept every heading shape a real decisions.md is written in, not only the
// one §H prescribes. A file using `##`, a colon, or an en dash parsed to zero
// entries and reported it as a clean zero.
//
// Two details are load-bearing:
//   * the ASCII hyphen stays LAST in the class. `[—–:-]` is a literal
//     set; writing the en dash immediately after the em dash would form a reversed
//     range (U+2014 → U+2013) and throw at module load, taking down every tool that
//     imports this file.
//   * `\s*` BEFORE the separator is what makes `### ADR-001: Title` parse at all —
//     the colon form carries no leading space. `\s+` after stays required, so a
//     hyphenated word cannot be mistaken for a separator.
//
// The section terminator below is deliberately NOT relaxed: both heading branches
// `continue`, so a matched `##` entry never reaches it and cannot terminate itself.
// Dropping `^##\s` there would instead stop a trailing `## Out of scope` from
// closing the last entry in any file written without `---` separators.
const HEADING_SEPARATOR = String.raw`\s*[—–:-]\s+`
const PREMISE_HEADING = new RegExp(
  String.raw`^#{2,3}\s+#(\d+)` + HEADING_SEPARATOR + String.raw`(.+?)\s*$`,
)
const ADR_HEADING = new RegExp(
  String.raw`^#{2,3}\s+(ADR-\d+)` + HEADING_SEPARATOR + String.raw`(.+?)\s*$`,
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
