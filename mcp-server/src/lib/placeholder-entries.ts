import { createHash } from 'node:crypto'

const SHIPPED_EXAMPLE_SHA256: ReadonlySet<string> = new Set([
  '70400ede1b967d7f1719af91db1d1247f4e5b839833c3b6b13a27691d4e07769',
])

const PLACEHOLDER = /^<[^<>]*>$/
const PLACEHOLDER_FIELD = /^(?:[-*]\s+)?\*\*[^*]+\*\*:?\s*<[^<>]*>$/
const STATUS_FIELD = /^\*\*Status\*\*:\s*[A-Za-z]+$/i

export function isShippedPlaceholder(heading: string, title: string, bodyLines: readonly string[]): boolean {
  const lines = [heading, ...bodyLines].map((line) => line.replace(/\r/g, ''))
  while (lines.length > 1 && lines[lines.length - 1]?.trim() === '') lines.pop()
  if (SHIPPED_EXAMPLE_SHA256.has(createHash('sha256').update(lines.join('\n')).digest('hex'))) return true
  return title.startsWith('<TODO:') && placeholderBody(lines.slice(1))
}

function placeholderBody(lines: readonly string[]): boolean {
  let inComment = false
  for (const raw of lines) {
    const line = raw.trim()
    if (inComment || line.startsWith('<!--')) {
      inComment = !line.includes('-->')
      continue
    }
    if (line === '' || PLACEHOLDER.test(line) || PLACEHOLDER_FIELD.test(line) || STATUS_FIELD.test(line)) continue
    return false
  }
  return true
}
