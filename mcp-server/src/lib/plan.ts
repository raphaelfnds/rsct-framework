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

/**
 * Find the most-recently-modified `plan_<slug>.md` at the project root.
 * Returns null if none found. Metadata extraction is best-effort — fields
 * may be null if the plan file does not follow the standard template.
 */
export function findActivePlan(projectRoot: string): ActivePlan | null {
  let entries: string[]
  try {
    entries = readdirSync(projectRoot)
  } catch {
    return null
  }

  const candidates = entries
    // CAP-53: detect the `spec_` alias too (rules/B accepts spec_ as an alias
    // of plan_). The §C reminder hints must see either form.
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

/**
 * T3 (FV1): resolve a plan by its EXACT slug — `plan_<slug>.md` (preferred) or
 * `spec_<slug>.md` (fallback) at the project root. Unlike {@link findActivePlan}
 * (which returns the most-recent plan_/spec_ by mtime), this is stable against
 * mtime drift: touching an unrelated `spec_`/`plan_` mid-session does NOT change
 * what this returns. The plan-authorization token validates against THIS (its own
 * plan_slug) so an unrelated edit never falsely revokes the token. Returns null
 * when neither file exists (the token's plan was deleted → `plan_gone`).
 */
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

/**
 * PH-1 plan-tracking gate: does a per-phase spec file `spec_<slug>.md` exist
 * at the project root? Distinct from {@link findPlanBySlug} (which also accepts
 * the `plan_` alias) — this checks the `spec_` form SPECIFICALLY, used to
 * require one spec per phase in a multi-phase plan.
 */
export function phaseSpecExists(projectRoot: string, slug: string): boolean {
  return safeMtime(join(projectRoot, `spec_${slug}.md`)) !== null
}

/**
 * Heuristic: does a plan-tracking `Status` field denote a finished task?
 * Used by the §C push/merge tools (CAP-53) to SUGGEST — never auto-perform —
 * cleanup of the branch-local `plan_`/`progress_`/`spec_` files before they can
 * reach a protected branch (they must never be tracked on `main`/`test`).
 * Matches EN + pt-BR completion words; returns false for a null/empty status.
 */
export function isPlanComplete(status: string | null | undefined): boolean {
  if (!status) return false
  // `\b` so "incomplete" does NOT match "complete".
  return /\b(complete|done|closed|shipped|finished|conclu[ií])/i.test(status)
}

function safeMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

interface PlanMetadata {
  status: string | null
  branch: string | null
  created: string | null
}

function extractPlanMetadata(path: string): PlanMetadata {
  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return { status: null, branch: null, created: null }
  }

  // Metadata table parsing: look for a markdown row `| Status | <value> |`
  // anywhere in the first 60 lines.
  const head = body.split('\n').slice(0, 60).join('\n')

  return {
    status: extractTableField(head, 'Status'),
    branch: extractTableField(head, 'Branch'),
    created: extractTableField(head, 'Created'),
  }
}

function extractTableField(text: string, field: string): string | null {
  const regex = new RegExp(`\\|\\s*${field}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'i')
  const match = text.match(regex)
  if (!match || !match[1]) return null
  return match[1].trim().replace(/`/g, '')
}
