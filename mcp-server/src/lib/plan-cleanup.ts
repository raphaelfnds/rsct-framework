import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { gitIsTracked, defaultGitExecutor, type GitExecutor } from './git.js'
import { progressCompletionState, type ProgressCompletionState } from './plan.js'
import type { RsctConfig } from './project-root.js'

/**
 * plan-lifecycle-v2 — Bloco 2.3 plan-artifact cleanup, ADVISORY-ONLY (Fork
 * 2/A). This module NEVER deletes anything. It reports which branch-local
 * `plan_`/`progress_`/`spec_<slug>.md` artifacts exist, labels each tracked vs
 * loose, and — gated on POSITIVE completion evidence — SUGGESTS that the dev
 * remove the loose ones. `progress_<slug>.md` is gitignored agent-writable
 * scratch, so its completion state can never be an independent machine fact;
 * therefore the actual deletion is always the dev's action, never an auto
 * `fs.rm`. Tracked artifacts are surfaced as `deferred` (the dev removes them
 * deliberately with `git rm`), never suggested for a loose delete.
 */

export interface PlanArtifact {
  name: string
  tracked: boolean
}

export interface PlanCleanupReport {
  slug: string
  artifacts: PlanArtifact[]
  completion: ProgressCompletionState
  /** True ONLY when the progress file shows positive completion (`all_closed`). */
  can_suggest_delete: boolean
  /** Human-readable advisory (never an instruction the server acts on). */
  hint: string
}

function retentionMode(config: RsctConfig | null): 'ephemeral' | 'documented' {
  return config?.plan_file_retention === 'documented' ? 'documented' : 'ephemeral'
}

/**
 * Build the advisory cleanup report for a plan slug. `config` selects the
 * retention mode (in `documented` mode the `spec_` file is intentionally kept
 * and excluded from the report). Never throws.
 */
export function planCleanupReport(
  projectRoot: string,
  slug: string,
  config: RsctConfig | null,
  executor: GitExecutor = defaultGitExecutor,
): PlanCleanupReport {
  const documented = retentionMode(config) === 'documented'
  const names = [`plan_${slug}.md`, `progress_${slug}.md`, `spec_${slug}.md`]
  const artifacts: PlanArtifact[] = []
  for (const name of names) {
    // documented mode: spec_ is versioned-and-kept — never a cleanup candidate.
    if (documented && name.startsWith('spec_')) continue
    if (existsSync(join(projectRoot, name))) {
      artifacts.push({ name, tracked: gitIsTracked(projectRoot, name, executor) })
    }
  }

  const completion = progressCompletionState(projectRoot, slug)
  const can_suggest_delete = completion === 'all_closed'

  let hint: string
  if (artifacts.length === 0) {
    hint = `No branch-local plan artifacts found for '${slug}'.`
  } else {
    const loose = artifacts.filter((a) => !a.tracked).map((a) => a.name)
    const tracked = artifacts.filter((a) => a.tracked).map((a) => a.name)
    const parts: string[] = []
    parts.push(
      can_suggest_delete
        ? `Plan '${slug}' looks complete (progress all-closed).`
        : `Plan '${slug}' progress is '${completion}' — NOT confirmed complete; keep the artifacts unless you are sure.`,
    )
    if (loose.length > 0) {
      parts.push(
        can_suggest_delete
          ? `Loose (gitignored) artifacts you can remove: ${loose.join(', ')}.`
          : `Loose artifacts (keep for now): ${loose.join(', ')}.`,
      )
    }
    if (tracked.length > 0) {
      parts.push(
        `⚠ TRACKED artifacts — remove deliberately with \`git rm\` only if intended: ${tracked.join(', ')}.`,
      )
    }
    parts.push('(RSCT never auto-deletes plan artifacts — you remove them.)')
    hint = parts.join(' ')
  }

  return { slug, artifacts, completion, can_suggest_delete, hint }
}
