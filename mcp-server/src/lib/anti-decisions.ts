import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AntiDecisionEntry {
  id: string
  title: string
  excerpt: string
  related?: string[]
  captured?: string
}

export interface AntiDecisionsSnapshot {
  exists: boolean
  path: string | null
  entries: AntiDecisionEntry[]
}

/**
 * Parse `documentation/knowledge/anti-decisions.md` extracting `### AD-NNN —
 * <title>` entries.
 *
 * Same line-scan strategy as `lib/decisions.ts`: an entry's body runs from
 * its heading until the next H3 / H2 / `---` / end-of-file. The parser is
 * deliberately tolerant of the canonical template's variations and skips
 * the `<TODO: ...>` placeholder line that ships in the template.
 *
 * Anti-decisions are the corpus consumed by `rsct_check_premise` to surface
 * "we already tried that" signals — read by the check-premise tool alongside
 * `lib/decisions.ts` ADRs/premises.
 */
export function readAntiDecisions(projectRoot: string): AntiDecisionsSnapshot {
  const path = join(
    projectRoot,
    'documentation',
    'knowledge',
    'anti-decisions.md',
  )
  if (!existsSync(path)) {
    return { exists: false, path: null, entries: [] }
  }

  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return { exists: true, path, entries: [] }
  }

  return { exists: true, path, entries: extractAntiDecisions(body) }
}

const AD_HEADING = /^###\s+(AD-\d+)\s+[—-]\s+(.+?)\s*$/

interface PendingEntry {
  id: string
  title: string
  bodyLines: string[]
}

export function extractAntiDecisions(body: string): AntiDecisionEntry[] {
  const lines = body.split('\n')
  const out: AntiDecisionEntry[] = []
  let current: PendingEntry | null = null

  const flush = (): void => {
    if (!current) return
    out.push(buildEntry(current.id, current.title, current.bodyLines.join('\n')))
    current = null
  }

  for (const line of lines) {
    const adMatch = line.match(AD_HEADING)
    if (adMatch?.[1] && adMatch[2]) {
      flush()
      current = { id: adMatch[1], title: adMatch[2].trim(), bodyLines: [] }
      continue
    }
    if (current && (/^##\s/.test(line) || /^###\s/.test(line) || /^---\s*$/.test(line))) {
      flush()
      continue
    }
    if (current) current.bodyLines.push(line)
  }

  flush()
  return out
}

function buildEntry(id: string, title: string, section: string): AntiDecisionEntry {
  const entry: AntiDecisionEntry = {
    id,
    title,
    excerpt: extractExcerpt(section),
  }
  const related = extractRelated(section)
  if (related.length > 0) entry.related = related
  const captured = extractCaptured(section)
  if (captured) entry.captured = captured
  return entry
}

function extractExcerpt(section: string): string {
  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('<!--') &&
        !line.startsWith('<TODO:') &&
        !line.startsWith('```'),
    )
  const first = lines.slice(0, 4).join(' ')
  return first.length > 320 ? `${first.slice(0, 317)}...` : first
}

function extractRelated(section: string): string[] {
  const match = section.match(/^\s*-\s*\*\*Related:?\*\*:?\s*(.+?)\s*$/im)
  if (!match?.[1]) return []
  return match[1]
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function extractCaptured(section: string): string | undefined {
  const match = section.match(/^\s*-\s*\*\*Captured:?\*\*:?\s*(\d{4}-\d{2}-\d{2})/im)
  return match?.[1]
}
