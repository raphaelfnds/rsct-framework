import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ENTRY_HEADING_SEPARATOR, makeExcerpt } from './markdown.js'

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
  /**
   * #58 — the body carries a token shaped like an entry id (`AD-NNN`). Together
   * with an empty result it identifies a parser miss, which has to be REPORTED.
   * Nothing upstream reads this file — `rsct_load_context` covers `decisions.md`
   * but not this one — so a clean zero here is the last word anyone gets.
   */
  has_entry_ids: boolean
  /**
   * #58 — the file exists but could not be READ (a directory at the path, mode
   * 000, a lock). Content is unknown, so zero entries proves nothing at all.
   */
  read_error: boolean
}

/**
 * Parse `documentation/knowledge/anti-decisions.md` extracting `AD-NNN` entries.
 *
 * Headings parse at `##` or `###` with any separator in
 * `ENTRY_HEADING_SEPARATOR`. §H prescribes one shape to WRITE —
 * `### AD-NNN — <title>` — and the reader tolerates the rest (#58); the
 * separator itself lives in `lib/markdown.ts` so this parser and
 * `lib/decisions.ts` cannot drift apart again.
 *
 * Same line-scan strategy as `lib/decisions.ts`: an entry's body runs from its
 * heading until the next H3 / H2 / `---` / end-of-file, and the `<TODO: ...>`
 * placeholder shipped in the template is skipped from the excerpt.
 *
 * One shape the terminator does not serve, stated rather than silently carried:
 * a `##`-level entry followed by `###` sub-headings closes at the first
 * sub-heading and drops the rest of its body, so `Related` / `Captured` go
 * unread. Both the template and §H prescribe bullet fields instead of
 * sub-headings, and `lib/decisions.ts` carries the identical exposure — closing
 * it needs a level-aware terminator, which is a separate change.
 *
 * The corpus is consumed by `rsct_check_premise` and by
 * `lib/verification-checklist.ts` to surface "we already tried that" signals.
 */
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

  return {
    exists: true,
    path,
    entries: extractAntiDecisions(body),
    has_entry_ids: AD_ID_TOKEN.test(body),
    read_error: false,
  }
}

/**
 * A token shaped like an entry id, anywhere in the body. Used only to tell
 * "nothing to find" apart from "found nothing" — never to parse. `\d+` and not
 * `\w+` on purpose: the template ships `AD-NNN` and `AD-XXX` placeholders, and
 * matching those would raise a parser-miss warning on a file that genuinely holds
 * no entries. It does not match `ADR-\d+` either — after `AD` comes `R`.
 */
const AD_ID_TOKEN = /\bAD-\d+\b/

const AD_HEADING = new RegExp(
  String.raw`^#{2,3}\s+(AD-\d+)` + ENTRY_HEADING_SEPARATOR + String.raw`(.+?)\s*$`,
)

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

/**
 * Wider window than the other two callers (4 lines / 320 chars) — deliberate,
 * and preserved as-is by #10 rather than normalised: an anti-decision carries a
 * rationale for why a path was abandoned, and a 3-line window cuts it
 * mid-sentence, which is exactly the sentence a reader needs.
 */
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
