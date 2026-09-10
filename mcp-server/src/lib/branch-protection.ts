/**
 * Branch-protection logic originally drafted as a Bash hook
 * (sectionD-protected-branch.sh) in an early prototype, moved here
 * as the canonical TypeScript implementation when the framework
 * adopted the MCP-first architecture.
 *
 * v1 semantics: exact branch-name match against the effective list.
 * The config field is named `protected_patterns_extra` to leave room
 * for glob/regex support in M3 without a breaking rename — for now
 * every entry is interpreted as a literal branch name.
 */

export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = [
  'main',
  'master',
  'test',
  'dev',
] as const

export type ProtectedListSource = 'default' | 'config' | 'config+extras'

export interface BranchProtectionConfig {
  protected_branches?: string[]
  protected_patterns_extra?: string[]
}

export interface EffectiveProtectedList {
  list: string[]
  source: ProtectedListSource
  /**
   * #92 defect A — built-in defaults the config dropped.
   *
   * Narrowing stays LEGAL: `.rsct.json` replacing the default is deliberate and
   * documented, and `prompts/01-setup.md:247` already writes a UNION at install
   * time so the accidental case is handled. The defect is that narrowing is
   * SILENT — MEASURED, `protected_branches: ["release/*"]` drops `main`,
   * `master`, `test` and `dev`, and the schema's `.min(1)` guard only ever
   * caught the empty array.
   *
   * So this is not a capability being removed; it is the fact being surfaced at
   * the moment it matters — the OS dialog the developer reads, and the audit.
   */
  narrowed: string[]
}

/**
 * Resolve the effective protected list for a project.
 *
 *  - If `protected_branches` is set in `.rsct.json`, it REPLACES the default
 *    (project explicitly opts in/out of each branch). If unset, the default
 *    list is used.
 *  - `protected_patterns_extra` always APPENDS, regardless of source.
 *
 * Order is preserved, duplicates collapsed.
 */
export function effectiveProtectedList(
  config?: BranchProtectionConfig,
): EffectiveProtectedList {
  const fromConfig = config?.protected_branches
  const usingConfig = Array.isArray(fromConfig)
  const base = usingConfig ? [...fromConfig] : [...DEFAULT_PROTECTED_BRANCHES]
  const extras = config?.protected_patterns_extra ?? []

  const merged: string[] = []
  for (const entry of [...base, ...extras]) {
    if (entry.length === 0) continue
    if (!merged.includes(entry)) merged.push(entry)
  }

  let source: ProtectedListSource
  if (extras.length > 0) source = 'config+extras'
  else if (usingConfig) source = 'config'
  else source = 'default'

  const narrowed = DEFAULT_PROTECTED_BRANCHES.filter((d) => !merged.includes(d))
  return { list: merged, source, narrowed: [...narrowed] }
}

/**
 * One line for the OS dialog and the audit entry when the config protects less
 * than the built-in default. Empty string when nothing was dropped, so a caller
 * can concatenate it unconditionally.
 *
 * This is the only channel that reaches the human before they click, and #92
 * defect F is that no dialog names the repository either — the two belong in
 * the same sentence, because "protects less than default" is only meaningful
 * once you know WHICH repository is about to be written to.
 */
export function narrowedProtectionNotice(effective: EffectiveProtectedList): string {
  if (effective.narrowed.length === 0) return ''
  return (
    `⚠ This project's .rsct.json protects FEWER branches than the built-in default — ` +
    `dropped: ${effective.narrowed.join(', ')}. Protecting now: ` +
    `${effective.list.join(', ')}.`
  )
}

/**
 * Pure check: is the given branch name in the effective protected list?
 * Returns `false` when `branch` is null (e.g., outside a git repo) so
 * callers can route on "unknown vs protected" cleanly.
 */
export function isProtectedBranch(branch: string | null, list: string[]): boolean {
  if (!branch) return false
  return list.includes(branch)
}
