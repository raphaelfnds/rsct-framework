import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface ActivePlan {
  slug: string
  plan_path: string
  progress_path: string | null
  status: string | null
  branch: string | null
  created: string | null
}

export function findActivePlan(projectRoot: string): ActivePlan | null {
  let entries: string[]
  try {
    entries = readdirSync(projectRoot)
  } catch {
    return null
  }

  const candidates = entries
    .filter((name) => /^(?:plan|spec)_.+\.md$/.test(name))
    .map((name) => {
      const path = join(projectRoot, name)
      const slug = name.replace(/^(?:plan|spec)_/, '').replace(/\.md$/, '')
      const mtime = safeMtime(path)
      return { name, path, slug, mtime }
    })
    .filter((entry): entry is { name: string; path: string; slug: string; mtime: number } => entry.mtime !== null)
    .sort((a, b) => b.mtime - a.mtime)

  const winner = candidates[0]
  if (!winner) return null

  const metadata = extractPlanMetadata(winner.path)
  const progress_path = join(projectRoot, `progress_${winner.slug}.md`)
  const progress_exists = safeMtime(progress_path) !== null

  return {
    slug: winner.slug,
    plan_path: winner.path,
    progress_path: progress_exists ? progress_path : null,
    status: metadata.status,
    branch: metadata.branch,
    created: metadata.created,
  }
}

export function findPlanBySlug(projectRoot: string, slug: string): ActivePlan | null {
  const planName = `plan_${slug}.md`
  const specName = `spec_${slug}.md`
  let chosen: string | null = null
  if (safeMtime(join(projectRoot, planName)) !== null) chosen = planName
  else if (safeMtime(join(projectRoot, specName)) !== null) chosen = specName
  if (!chosen) return null

  const path = join(projectRoot, chosen)
  const metadata = extractPlanMetadata(path)
  const progress_path = join(projectRoot, `progress_${slug}.md`)
  const progress_exists = safeMtime(progress_path) !== null

  return {
    slug,
    plan_path: path,
    progress_path: progress_exists ? progress_path : null,
    status: metadata.status,
    branch: metadata.branch,
    created: metadata.created,
  }
}

export function phaseSpecExists(projectRoot: string, slug: string): boolean {
  return safeMtime(join(projectRoot, `spec_${slug}.md`)) !== null
}

export function isPlanComplete(status: string | null | undefined): boolean {
  if (!status) return false
  return /\b(complete|done|closed|shipped|finished|conclu[ií])/i.test(status)
}

export function findPlanByBranch(projectRoot: string, branch: string): ActivePlan | null {
  let entries: string[]
  try {
    entries = readdirSync(projectRoot)
  } catch {
    return null
  }
  const winner = entries
    .filter((name) => /^(?:plan|spec)_.+\.md$/.test(name))
    .map((name) => {
      const path = join(projectRoot, name)
      return {
        slug: name.replace(/^(?:plan|spec)_/, '').replace(/\.md$/, ''),
        mtime: safeMtime(path),
        branch: extractPlanMetadata(path).branch,
      }
    })
    .filter((e): e is { slug: string; mtime: number; branch: string | null } => e.mtime !== null)
    .filter((e) => e.branch !== null && e.branch === branch)
    .sort((a, b) => b.mtime - a.mtime)[0]
  return winner ? findPlanBySlug(projectRoot, winner.slug) : null
}

export type ProgressCompletionState = 'no_file' | 'no_checkboxes' | 'has_open' | 'all_closed'

function scanProgressCheckboxes(body: string): { open: number; closed: number } {
  const norm = body.replace(/\r\n?/g, '\n')
  let inFence = false
  let open = 0
  let closed = 0
  for (const line of norm.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^[ \t]*[-*+] \[ \]/.test(line)) open += 1
    else if (/^[ \t]*[-*+] \[[xX]\]/.test(line)) closed += 1
  }
  return { open, closed }
}

export function progressHasOpenItems(projectRoot: string, slug: string): boolean {
  const path = join(projectRoot, `progress_${slug}.md`)
  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  return scanProgressCheckboxes(body).open > 0
}

export function progressCompletionState(
  projectRoot: string,
  slug: string,
): ProgressCompletionState {
  const path = join(projectRoot, `progress_${slug}.md`)
  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return 'no_file'
  }
  const { open, closed } = scanProgressCheckboxes(body)
  if (open > 0) return 'has_open'
  if (closed === 0) return 'no_checkboxes'
  return 'all_closed'
}

function safeMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

interface PlanFileEntry {
  name: string
  path: string
  slug: string
  mtime: number
}

function enumeratePlanFiles(projectRoot: string): PlanFileEntry[] {
  let entries: string[]
  try {
    entries = readdirSync(projectRoot)
  } catch {
    return []
  }
  return entries
    .filter((name) => /^(?:plan|spec)_.+\.md$/.test(name))
    .map((name) => {
      const path = join(projectRoot, name)
      return {
        name,
        path,
        slug: name.replace(/^(?:plan|spec)_/, '').replace(/\.md$/, ''),
        mtime: safeMtime(path),
      }
    })
    .filter((e): e is PlanFileEntry => e.mtime !== null)
    .sort((a, b) => b.mtime - a.mtime)
}

export interface PlanSummary {
  slug: string
  plan_path: string
  plan_mtime: string
  status: string | null
  branch: string | null
  created: string | null
  declared_slug: string | null
  last_update: string | null
  progress_path: string | null
  progress_mtime: string | null
  progress_state: ProgressCompletionState
  progress_idle_days: number | null
}

export function listPlans(
  projectRoot: string,
  opts: { now?: Date } = {},
): PlanSummary[] {
  const now = (opts.now ?? new Date()).getTime()
  const DAY_MS = 86_400_000

  return enumeratePlanFiles(projectRoot).map((entry) => {
    const metadata = extractPlanMetadata(entry.path)
    const progressPath = join(projectRoot, `progress_${entry.slug}.md`)
    const progressMtime = safeMtime(progressPath)

    return {
      slug: entry.slug,
      plan_path: entry.path,
      plan_mtime: new Date(entry.mtime).toISOString(),
      status: metadata.status,
      branch: metadata.branch,
      created: metadata.created,
      declared_slug: metadata.declared_slug,
      last_update: metadata.last_update,
      progress_path: progressMtime !== null ? progressPath : null,
      progress_mtime:
        progressMtime !== null ? new Date(progressMtime).toISOString() : null,
      progress_state: progressCompletionState(projectRoot, entry.slug),
      progress_idle_days:
        progressMtime !== null
          ? Math.floor((now - progressMtime) / DAY_MS)
          : null,
    }
  })
}

interface PlanMetadata {
  status: string | null
  branch: string | null
  created: string | null
  declared_slug: string | null
  last_update: string | null
}

function extractPlanMetadata(path: string): PlanMetadata {
  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return {
      status: null,
      branch: null,
      created: null,
      declared_slug: null,
      last_update: null,
    }
  }

  const head = body.split('\n').slice(0, 60).join('\n')

  return {
    status: extractTableField(head, 'Status'),
    branch: extractTableField(head, 'Branch'),
    created: extractTableField(head, 'Created'),
    declared_slug: extractTableField(head, 'Slug'),
    last_update: extractTableField(head, 'Last update'),
  }
}

function extractTableField(text: string, field: string): string | null {
  const regex = new RegExp(`\\|\\s*${field}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'i')
  const match = text.match(regex)
  if (!match || !match[1]) return null
  return match[1].trim().replace(/`/g, '')
}

const SAFE_PLAN_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isSafePlanSlug(slug: string): boolean {
  return SAFE_PLAN_SLUG.test(slug) && !slug.includes('..')
}

export function findPlanFileBySlug(projectRoot: string, slug: string): ActivePlan | null {
  if (!isSafePlanSlug(slug)) return null
  const name = `plan_${slug}.md`
  let entries: string[]
  try {
    entries = readdirSync(projectRoot)
  } catch {
    return null
  }
  if (!entries.includes(name)) return null
  const path = join(projectRoot, name)
  if (safeMtime(path) === null) return null
  const metadata = extractPlanMetadata(path)
  const progressPath = join(projectRoot, `progress_${slug}.md`)
  return {
    slug,
    plan_path: path,
    progress_path: safeMtime(progressPath) !== null ? progressPath : null,
    status: metadata.status,
    branch: metadata.branch,
    created: metadata.created,
  }
}

export function findNewestPlanFile(projectRoot: string): ActivePlan | null {
  let entries: string[]
  try {
    entries = readdirSync(projectRoot)
  } catch {
    return null
  }
  const newest = entries
    .filter((name) => /^plan_.+\.md$/.test(name))
    .map((name) => ({ slug: name.slice('plan_'.length, -'.md'.length), mtime: safeMtime(join(projectRoot, name)) }))
    .filter((entry): entry is { slug: string; mtime: number } => entry.mtime !== null && isSafePlanSlug(entry.slug))
    .sort((a, b) => b.mtime - a.mtime)[0]
  return newest ? findPlanFileBySlug(projectRoot, newest.slug) : null
}

export interface PlanPhase {
  id: string
  goal: string
}

const FENCE = /^\s*(```|~~~)/
const PHASES_HEADING = /^#{2,6}\s+Phases\b/i
const ANY_HEADING = /^#{1,6}\s/
const TABLE_ROW = /^\s*\|/
const SEPARATOR_ROW = /^\s*\|?\s*:?-{3,}/
const PLACEHOLDER = /^(?:<[^>]*>|tbd|todo|n\/a|—|–|-)?$/i
const ESCAPED_PIPE = String.fromCharCode(92, 124)
const PIPE_MARK = String.fromCharCode(0)

function tableCells(line: string): string[] {
  const cells = line.split(ESCAPED_PIPE).join(PIPE_MARK).split('|').map((cell) => cell.split(PIPE_MARK).join('|').trim())
  if (cells.length > 0 && cells[0] === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  return cells
}

function filledCell(cell: string | undefined): cell is string {
  return cell !== undefined && !PLACEHOLDER.test(cell.replace(/`/g, '').trim())
}

export function readPlanPhases(text: string): PlanPhase[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let inFence = false
  let at = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence && PHASES_HEADING.test(line)) {
      at = i + 1
      break
    }
  }
  if (at < 0) return []
  const table: string[] = []
  for (let i = at; i < lines.length; i++) {
    const line = lines[i]!
    if (FENCE.test(line)) {
      inFence = !inFence
      if (table.length > 0) break
      continue
    }
    if (inFence) continue
    if (ANY_HEADING.test(line)) break
    if (TABLE_ROW.test(line)) table.push(line)
    else if (table.length > 0) break
  }
  if (table.length < 3 || !SEPARATOR_ROW.test(table[1]!)) return []
  const header = tableCells(table[0]!).map((cell) => cell.toLowerCase())
  const idColumn = header.indexOf('phase')
  const goalColumn = header.indexOf('goal')
  if (idColumn < 0 || goalColumn < 0) return []
  const phases: PlanPhase[] = []
  for (const row of table.slice(2)) {
    const cells = tableCells(row)
    const id = cells[idColumn]
    const goal = cells[goalColumn]
    if (filledCell(id) && filledCell(goal)) phases.push({ id, goal })
  }
  return phases
}

export function readPlanFilePhases(path: string): PlanPhase[] {
  try {
    return readPlanPhases(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}
