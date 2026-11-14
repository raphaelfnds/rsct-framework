import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ENTRY_HEADING_SEPARATOR, makeExcerpt } from './markdown.js'
import { isShippedPlaceholder, withoutShippedIdLines } from './placeholder-entries.js'

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
  has_entry_ids: boolean
  read_error: boolean
}

export function readAntiDecisions(projectRoot: string): AntiDecisionsSnapshot {
  const path = join(
    projectRoot,
    'documentation',
    'knowledge',
    'anti-decisions.md',
  )
  if (!existsSync(path)) {
    return { exists: false, path: null, entries: [], has_entry_ids: false, read_error: false }
  }

  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return { exists: true, path, entries: [], has_entry_ids: false, read_error: true }
  }

  const { entries, residue } = scanAntiDecisions(body)
  return {
    exists: true,
    path,
    entries,
    has_entry_ids: AD_ID_TOKEN.test(residue),
    read_error: false,
  }
}

const AD_ID_TOKEN = /\bAD-\d+\b/

const AD_HEADING = new RegExp(
  String.raw`^#{2,3}\s+(AD-\d+)` + ENTRY_HEADING_SEPARATOR + String.raw`(.+?)\s*$`,
)

interface PendingEntry {
  id: string
  title: string
  heading: string
  start: number
  bodyLines: string[]
}

export function extractAntiDecisions(body: string): AntiDecisionEntry[] {
  return scanAntiDecisions(body).entries
}

function scanAntiDecisions(body: string): { entries: AntiDecisionEntry[]; residue: string } {
  const lines = body.split('\n')
  const out: AntiDecisionEntry[] = []
  const kept: string[] = []
  let current: PendingEntry | null = null

  const flush = (): void => {
    if (!current) return
    if (isShippedPlaceholder(current.heading, current.bodyLines)) kept.length = current.start
    else out.push(buildEntry(current.id, current.title, current.bodyLines.join('\n')))
    current = null
  }

  for (const line of lines) {
    const adMatch = line.match(AD_HEADING)
    if (adMatch?.[1] && adMatch[2]) {
      flush()
      current = { id: adMatch[1], title: adMatch[2].trim(), heading: line, start: kept.length, bodyLines: [] }
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
  return { entries: out, residue: withoutShippedIdLines(kept) }
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
  return makeExcerpt(section, {
    maxLines: 4,
    maxChars: 320,
    skipLine: (line) => line.startsWith('<TODO:') || line.startsWith('```'),
  })
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
