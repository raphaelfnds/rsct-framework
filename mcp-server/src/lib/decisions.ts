import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    return { exists: false, path: null, premises: [], adrs: [] }
  }

  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return { exists: true, path, premises: [], adrs: [] }
  }

  const { premises, adrs } = extractDecisions(body)
  return { exists: true, path, premises, adrs }
}

const PREMISE_HEADING = /^###\s+#(\d+)\s+[—-]\s+(.+?)\s*$/
const ADR_HEADING = /^###\s+(ADR-\d+)\s+[—-]\s+(.+?)\s*$/

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

function extractExcerpt(section: string): string {
  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith('<!--') && !META_LINE_REGEX.test(line),
    )
  const first = lines.slice(0, 3).join(' ')
  return first.length > 280 ? `${first.slice(0, 277)}...` : first
}
