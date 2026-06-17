import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseSections, type MarkdownSection } from './markdown.js'

export const KNOWN_CATEGORIES = [
  'business-glossary',
  'business-rules',
  'anti-decisions',
  'incident-log',
  'stakeholder-map',
  'team-capabilities',
  'vendor-relationships',
  'cost-constraints',
  'workflow-rituals',
  'domain-edge-cases',
] as const

export type KnownCategory = (typeof KNOWN_CATEGORIES)[number]

export interface KnowledgeIndex {
  directory_exists: boolean
  directory_path: string | null
  categories_present: string[]
  categories_missing: KnownCategory[]
  has_readme: boolean
}

/**
 * List which `documentation/knowledge/*.md` files exist. Used by tools
 * to tell Claude what knowledge it can pull, and to flag missing
 * categories so the dev knows what to bootstrap.
 */
export function readKnowledgeIndex(projectRoot: string): KnowledgeIndex {
  const dir = join(projectRoot, 'documentation', 'knowledge')
  if (!existsSync(dir)) {
    return {
      directory_exists: false,
      directory_path: null,
      categories_present: [],
      categories_missing: [...KNOWN_CATEGORIES],
      has_readme: false,
    }
  }

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return {
      directory_exists: true,
      directory_path: dir,
      categories_present: [],
      categories_missing: [...KNOWN_CATEGORIES],
      has_readme: false,
    }
  }

  const mdFiles = entries
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''))

  const present = mdFiles.filter((name) => name !== 'README')
  const missing = KNOWN_CATEGORIES.filter((cat) => !present.includes(cat))

  return {
    directory_exists: true,
    directory_path: dir,
    categories_present: present,
    categories_missing: missing,
    has_readme: mdFiles.includes('README'),
  }
}

export type KnowledgeSection = MarkdownSection

export interface KnowledgeFile {
  exists: boolean
  path: string | null
  sections: KnowledgeSection[]
}

/**
 * Read `documentation/knowledge/<category>.md` and split it into sections by
 * `##` and `###` headings. Returns a structured list; callers apply filtering.
 * Always returns — missing file becomes `{exists: false, sections: []}`.
 */
export function readKnowledgeFile(
  projectRoot: string,
  category: string,
): KnowledgeFile {
  const path = join(projectRoot, 'documentation', 'knowledge', `${category}.md`)
  if (!existsSync(path)) {
    return { exists: false, path: null, sections: [] }
  }

  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return { exists: true, path, sections: [] }
  }

  return { exists: true, path, sections: parseSections(body) }
}
