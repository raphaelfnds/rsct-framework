import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { parseSections, type MarkdownSection } from './markdown.js'

// T1.c — org-scoped reads. T1.a/b made the universe resolvable + registrable;
// this module READS its org-level governance content (docs/governance/*.md +
// docs/INDEX.md) so rsct_status/rsct_load_context can surface a governance index
// and the rsct_get_universe tool can read the docs on demand. The universe layout
// is NOT the project layout — a universe has no documentation/{decisions,knowledge,
// architecture}; its authority lives under docs/governance/ (guaranteed by
// /rsct-init-universe). Everything here is FAIL-GRACEFUL: any error degrades to an
// empty result and NEVER throws into the bootstrap path.

/**
 * The canonical governance docs scaffolded by /rsct-init-universe. Used only for
 * tool descriptions and a "missing canonical doc" hint — NOT to gate reads: the
 * index is disk-driven (the actual *.md files are the truth), so an org that adds
 * custom governance docs still surfaces + reads them. (V FV3.)
 */
export const KNOWN_GOVERNANCE_DOCS = [
  'document-control',
  'canonical-sources-map',
  'dns-governance-survey',
  'lgpd-system-matrix',
  'naming-standards',
] as const

/** The lightweight governance index folded into the universe block (slugs only). */
export interface UniverseGovernanceIndex {
  /** docs/governance/ exists (dir-present). Distinct from dir-empty (docs:[]). */
  available: boolean
  /** Resolved governance dir, forward-slashed (transparency); null when absent. */
  governance_dir: string | null
  /** Governance doc slugs present on disk (sorted; excludes README). */
  docs: string[]
  /** docs/INDEX.md present at the universe root. */
  has_index: boolean
}

/** The empty governance index — reused as the none/degraded shape (V FV2). */
export const EMPTY_GOVERNANCE_INDEX: UniverseGovernanceIndex = {
  available: false,
  governance_dir: null,
  docs: [],
  has_index: false,
}

export interface UniverseDocFile {
  slug: string
  exists: boolean
  /** Path relative to the universe root, forward-slashed; null when missing. */
  path: string | null
  sections: MarkdownSection[]
}

/** Forward-slash a path for BSD/Win parity (same idiom as architecture.ts). */
function fwd(p: string): string {
  return p.split('\\').join('/')
}

/**
 * Reject a doc slug that could escape the governance dir. The slug is a public
 * tool input, so guard path traversal: no separators (`/` or `\` — rejected even
 * on POSIX as defense-in-depth), no `..`, no absolute path. (V FV6.)
 */
export function isSafeDocSlug(slug: unknown): slug is string {
  if (typeof slug !== 'string' || slug.length === 0) return false
  if (slug.includes('/') || slug.includes('\\')) return false
  if (slug.includes('..')) return false
  if (isAbsolute(slug)) return false
  return true
}

/**
 * List `docs/governance/*.md` slugs + `docs/INDEX.md` presence at the universe
 * root. Disk-driven (the files are the truth). Any error → the empty index.
 * Callers MUST only invoke this for a found+readable universe (V FV2) — the empty
 * index is what status/load_context use for none/configured-missing/degraded.
 */
export function readUniverseGovernanceIndex(universeRoot: string): UniverseGovernanceIndex {
  try {
    const dir = join(universeRoot, 'docs', 'governance')
    if (!statSync(dir).isDirectory()) return EMPTY_GOVERNANCE_INDEX
    const has_index = existsSync(join(universeRoot, 'docs', 'INDEX.md'))
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // dir exists but is unreadable — mirror knowledge.ts's degraded shape.
      return { available: true, governance_dir: fwd(dir), docs: [], has_index }
    }
    const docs = entries
      .filter((e) => e.isFile() && /\.md$/i.test(e.name) && !/^README\.md$/i.test(e.name))
      .map((e) => e.name.replace(/\.md$/i, ''))
      .sort((a, b) => a.localeCompare(b))
    return { available: true, governance_dir: fwd(dir), docs, has_index }
  } catch {
    return EMPTY_GOVERNANCE_INDEX
  }
}

/**
 * Read one universe doc and split it into sections. `slug === 'INDEX'` routes to
 * `docs/INDEX.md`; any other slug routes to `docs/governance/<slug>.md`. A unsafe
 * slug (traversal / separator / absolute) → `{exists:false}` (V FV6). Missing file
 * → `{exists:false, sections:[]}`. Never throws.
 */
export function readUniverseDoc(universeRoot: string, slug: string): UniverseDocFile {
  const miss: UniverseDocFile = { slug, exists: false, path: null, sections: [] }
  if (!isSafeDocSlug(slug)) return miss
  const rel = slug === 'INDEX' ? join('docs', 'INDEX.md') : join('docs', 'governance', `${slug}.md`)
  const full = join(universeRoot, rel)
  try {
    if (!existsSync(full)) return miss
    const body = readFileSync(full, 'utf8')
    return { slug, exists: true, path: fwd(rel), sections: parseSections(body) }
  } catch {
    return miss
  }
}
