import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface InfrastructureEntry {
  id: string
  name: string
  fields: Record<string, string>
  raw_body: string
}

export interface InfrastructureSnapshot {
  exists: boolean
  path: string | null
  entries: InfrastructureEntry[]
}

/**
 * Parse `documentation/infrastructure.md` extracting `### INFRA-NNN — Name`
 * entries and the `- **Field:**` bullets within each. Multi-line values
 * (sub-bullets) are concatenated into the parent field with newlines.
 */
export function readInfrastructure(projectRoot: string): InfrastructureSnapshot {
  const path = join(projectRoot, 'documentation', 'infrastructure.md')
  if (!existsSync(path)) return { exists: false, path: null, entries: [] }

  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return { exists: true, path, entries: [] }
  }

  return { exists: true, path, entries: extractEntries(body) }
}

const HEADING_REGEX = /^###\s+(INFRA-\d+)\s+[—-]\s+(.+?)\s*$/
const FIELD_REGEX = /^\s*-\s+\*\*([^*]+?)\*\*\s*:?\s*(.*)$/
const CONTINUATION_REGEX = /^\s{2,}-\s+(.+)$/

function extractEntries(body: string): InfrastructureEntry[] {
  const lines = body.split('\n')
  const out: InfrastructureEntry[] = []
  let current: {
    id: string
    name: string
    bodyLines: string[]
    fields: Record<string, string>
    lastField: string | null
  } | null = null

  const flush = () => {
    if (!current) return
    out.push({
      id: current.id,
      name: current.name,
      fields: current.fields,
      raw_body: current.bodyLines.join('\n').trim(),
    })
  }

  for (const line of lines) {
    const heading = line.match(HEADING_REGEX)
    if (heading?.[1] && heading[2]) {
      flush()
      current = {
        id: heading[1],
        name: heading[2].trim(),
        bodyLines: [],
        fields: {},
        lastField: null,
      }
      continue
    }

    if (!current) continue

    // Stop accumulating into the entry when a new H2/H3 (non-INFRA) starts.
    if (/^##?\s/.test(line) && !heading) {
      flush()
      current = null
      continue
    }

    current.bodyLines.push(line)

    const fieldMatch = line.match(FIELD_REGEX)
    if (fieldMatch?.[1]) {
      const label = fieldMatch[1].trim().replace(/:$/, '').trim()
      const value = (fieldMatch[2] ?? '').trim()
      current.fields[label] = value
      current.lastField = label
      continue
    }

    const continuation = line.match(CONTINUATION_REGEX)
    if (continuation?.[1] && current.lastField) {
      const prev = current.fields[current.lastField] ?? ''
      const joined = prev.length > 0 ? `${prev}\n${continuation[1].trim()}` : continuation[1].trim()
      current.fields[current.lastField] = joined
    }
  }

  flush()
  return out
}
