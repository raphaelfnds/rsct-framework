/**
 * The separator between an entry id and its title in a knowledge-file heading —
 * `### ADR-001 — Title`, `### AD-003: Title`, `## #1 – Title`. Shared by
 * `lib/decisions.ts` and `lib/anti-decisions.ts` so the two parsers cannot drift
 * apart. They did, and that divergence was issue #58: the anti-decisions regex was
 * still the pre-#49 one, character for character, months after the sibling was
 * widened.
 *
 * Two details are load-bearing:
 *
 *   * **The ASCII hyphen stays LAST in the class.** A `-` between two other members
 *     is a RANGE, so `[—-–:]` is the reversed range U+2014 → U+2013 — a
 *     `SyntaxError` at module load that takes down every tool importing the parser.
 *     Last position is the only one where `-` is unambiguously literal; the em/en
 *     adjacency in `[—–:-]` is harmless.
 *   * **`\s*` BEFORE the separator** is what makes `### ADR-001: Title` parse at
 *     all — the colon form carries no leading space. The `\s+` after stays
 *     required, so a hyphenated word cannot be mistaken for a separator.
 */
export const ENTRY_HEADING_SEPARATOR = String.raw`\s*[—–:-]\s+`

export interface MarkdownSection {
  level: number
  heading: string
  body: string
  excerpt: string
}

/**
 * Split a markdown document into sections by `##` and `###` headings.
 * Content above the first such heading is discarded (treated as
 * pre-section preamble). Robust to EOF — uses a line-by-line scan,
 * not a regex with end-of-input anchors that JS doesn't support.
 */
export function parseSections(body: string): MarkdownSection[] {
  const lines = body.split('\n')
  const out: MarkdownSection[] = []
  let current: { level: number; heading: string; bodyLines: string[] } | null = null

  const flush = () => {
    if (!current) return
    const sectionBody = current.bodyLines.join('\n').trim()
    out.push({
      level: current.level,
      heading: current.heading,
      body: sectionBody,
      excerpt: makeExcerpt(sectionBody),
    })
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,3})\s+(.+?)\s*$/)
    if (headingMatch?.[1] && headingMatch[2]) {
      flush()
      current = {
        level: headingMatch[1].length,
        heading: headingMatch[2].trim(),
        bodyLines: [],
      }
    } else if (current) {
      current.bodyLines.push(line)
    }
  }
  flush()
  return out
}

/**
 * Case-insensitive substring filter over heading + body (#10).
 *
 * Was written verbatim twice — `tools/get-knowledge.ts` and
 * `tools/get-universe.ts` — differing only in the section type. Generic over any
 * shape carrying `heading` + `body`, so both call sites keep their own types
 * without the function needing to know about either.
 *
 * An absent query returns the input untouched: "no filter" and "filter that
 * matches everything" are the same answer, and the identity path avoids
 * lowercasing every body for nothing.
 */
export function filterSectionsByQuery<T extends { heading: string; body: string }>(
  sections: T[],
  query: string | undefined,
): T[] {
  if (!query) return sections
  const needle = query.toLowerCase()
  return sections.filter(
    (s) =>
      s.heading.toLowerCase().includes(needle) || s.body.toLowerCase().includes(needle),
  )
}

export interface ExcerptOptions {
  /** Lines joined into the excerpt. Default 3. */
  maxLines?: number
  /** Hard cap on the result, ellipsis included. Default 280. */
  maxChars?: number
  /** Extra per-line rejection on top of blank lines and HTML comments. */
  skipLine?: (line: string) => boolean
}

/**
 * First few meaningful lines of a markdown section, flattened and truncated.
 *
 * Parameterised in #10 to collapse three near-identical copies (here,
 * `decisions.ts`, `anti-decisions.ts`). The defaults are this module's original
 * behaviour; the two callers that differed pass their own values rather than
 * having the difference flattened away.
 *
 * `anti-decisions` genuinely wants 4 lines / 320 chars — those entries carry a
 * rationale that a 3-line window cuts mid-sentence — so that divergence is
 * PRESERVED as configuration, not "fixed" into uniformity.
 */
export function makeExcerpt(body: string, opts: ExcerptOptions = {}): string {
  const maxLines = opts.maxLines ?? 3
  const maxChars = opts.maxChars ?? 280
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith('<!--') && !(opts.skipLine?.(line) ?? false),
    )
  const first = lines.slice(0, maxLines).join(' ')
  return first.length > maxChars ? `${first.slice(0, maxChars - 3)}...` : first
}
