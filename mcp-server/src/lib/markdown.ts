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

function makeExcerpt(body: string): string {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('<!--'))
  const first = lines.slice(0, 3).join(' ')
  return first.length > 280 ? `${first.slice(0, 277)}...` : first
}
