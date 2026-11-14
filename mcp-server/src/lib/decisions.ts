import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ENTRY_HEADING_SEPARATOR, makeExcerpt } from './markdown.js'
import { isShippedPlaceholder, withoutShippedIdLines } from './placeholder-entries.js'

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
  has_decision_ids: boolean
  read_error: boolean
}

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

  const { premises, adrs, residue } = scanDecisions(body)
  return {
    exists: true,
    path,
    premises,
    adrs,
    has_decision_ids: DECISION_ID_TOKEN.test(residue),
    read_error: false,
  }
}

const DECISION_ID_TOKEN = /\bADR-\d+\b|(?:^|\s)#\d+\b/m

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
  heading: string
  start: number
  bodyLines: string[]
}

export function extractDecisions(body: string): {
  premises: DecisionEntry[]
  adrs: DecisionEntry[]
} {
  const { premises, adrs } = scanDecisions(body)
  return { premises, adrs }
}

function scanDecisions(body: string): {
  premises: DecisionEntry[]
  adrs: DecisionEntry[]
  residue: string
} {
  const lines = body.split('\n')
  const premises: DecisionEntry[] = []
  const adrs: DecisionEntry[] = []
  const kept: string[] = []
  let current: PendingEntry | null = null

  const flush = () => {
    if (!current) return
    if (isShippedPlaceholder(current.heading, current.bodyLines)) {
      kept.length = current.start
    } else {
      const entry = buildEntry(
        current.kind,
        current.id,
        current.title,
        current.bodyLines.join('\n'),
      )
      if (current.kind === 'premise') premises.push(entry)
      else adrs.push(entry)
    }
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
        heading: line,
        start: kept.length,
        bodyLines: [],
      }
      kept.push(line)
      continue
    }

    const adrMatch = line.match(ADR_HEADING)
    if (adrMatch?.[1] && adrMatch[2]) {
      flush()
      current = {
        kind: 'adr',
        id: adrMatch[1],
        title: adrMatch[2].trim(),
        heading: line,
        start: kept.length,
        bodyLines: [],
      }
      kept.push(line)
      continue
    }

    if (current && (/^##\s/.test(line) || /^###\s/.test(line) || /^---\s*$/.test(line))) {
      flush()
      kept.push(line)
      continue
    }

    if (current) current.bodyLines.push(line)
    kept.push(line)
  }

  flush()
  return { premises, adrs, residue: withoutShippedIdLines(kept) }
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

function extractExcerpt(section: string): string {
  return makeExcerpt(section, { skipLine: (line) => META_LINE_REGEX.test(line) })
}
