import { resolve, dirname } from 'node:path'
import { readWorktreeInfo, safeGitRead } from './git.js'

/**
 * #92 — where the SHARED anchors live.
 *
 * The defect this closes: `resolveProjectRoot` takes the caller's `project_root`
 * string directly, so every framework anchor resolves DOWN from it while `git`
 * resolves UP from it to the real repository. MEASURED: a real
 * `rsct_request_commit` with `project_root` at a crafted subdirectory commits
 * into the PARENT repo while debiting a budget that lives in the crafted
 * directory, and the real project's audit log records nothing.
 *
 * The fix is not to reject the field — MEASURED, the sanctioned registration
 * passes no root at all (`prompts/01-setup.md:3790-3798`), installs default to
 * user scope, and the fallbacks are unreliable under WSL-from-Windows
 * (`project-root.ts:281-289`), so the per-call field is the last resort exactly
 * where the others fail. The fix is to resolve the shared anchors at the
 * repository the mutation actually lands in.
 *
 * SCOPE (spec AUDIT-4): the derivation is GLOBAL — a repository has ONE audit
 * log, for every writer and reader. What is scoped to the five gated tools is
 * the DISAGREEMENT CHECK: they fail closed on `relocated`, while a read-only
 * tool degrades and reports.
 */

/** Anchors that are per-checkout and must NOT follow the repository. */
export const LOCAL_ANCHORS = ['phase-state.json', 'phase-state.lock', 'scripts'] as const

export type AnchorStatus =
  /** Declared root already is the anchor root — nothing moves. */
  | 'same'
  /** Anchors live at a different directory than the declared root. */
  | 'relocated'
  /** Not a git repository: no identity exists, so nothing is bound. */
  | 'not-applicable'
  /** git is absent, too old, or failed. CAPABILITY, not tampering. */
  | 'unavailable'

export interface RepositoryAnchor {
  status: AnchorStatus
  /** Directory the shared anchors resolve under. Always usable. */
  root: string
  /** Stable repository identity (`--git-common-dir`), or null. */
  identity: string | null
  /** Why the status is what it is — surfaced to the developer, never silent. */
  detail: string | null
}

/**
 * Normalize for comparison ONLY. Measured on Win11/NTFS across five legitimate
 * spellings of one root, a naive `===` passes 2 of 5 — it fails a trailing
 * separator, forward slashes, and a lowercase drive letter.
 *
 * Which step earns which case, because a mutation run showed the obvious
 * reading is wrong: `resolve()` alone already absorbs the trailing separator,
 * the forward slashes and the `./` segments — removing the explicit trailing
 * strip reddened NOTHING. The step that actually carries the remaining case is
 * the CASEFOLD (the lowercase drive letter); mutating that away is what turns
 * the five-spelling test red. The trailing strip survives only for a drive
 * root, where `resolve('C:/')` keeps its separator.
 *
 * Case is folded on Windows only. macOS volumes are case-INSENSITIVE by default
 * but can be created case-sensitive, and Linux is case-sensitive — so folding
 * there could call two genuinely different directories equal, which is the
 * SILENT direction. Comparing exactly can only produce a false `relocated`,
 * which is loud, reported, and recoverable. Fail loud, never silent.
 */
function comparable(p: string): string {
  const abs = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export function sameDirectory(a: string, b: string): boolean {
  return comparable(a) === comparable(b)
}

export interface AnchorDeps {
  /** Seam for tests; defaults to the real git reader. */
  gitRead?: (cwd: string, args: string[]) => string | null
  worktreeInfo?: typeof readWorktreeInfo
}

const anchorCache = new Map<string, RepositoryAnchor>()

/**
 * Memoized {@link resolveRepositoryAnchor}, and the cache is a REQUIREMENT, not
 * an optimization. MEASURED on Win11: one `git rev-parse` subprocess costs
 * ~32 ms, `readWorktreeInfo` spends three of them and this derivation adds a
 * fourth on the worktree branch — ~130 ms per resolution. `resolveAuditPath`
 * runs on every audit write, so an uncached read would put that on the hot path
 * of every gated tool.
 *
 * Cached for the life of the process, deliberately. The only way the answer goes
 * stale for a given root is the repository identity itself changing under it —
 * `git init` inside the directory, or `.git` being removed. A NEW worktree is a
 * NEW root and therefore a different key, so the case the binding exists to
 * cover is not affected. And where an agent runs `git init` inside a crafted
 * subdirectory, that subdirectory becomes its own repository and the commits
 * land there rather than in the parent — so the escape closes itself.
 */
export function anchorFor(projectRoot: string, deps: AnchorDeps = {}): RepositoryAnchor {
  const key = resolve(projectRoot)
  const hit = anchorCache.get(key)
  if (hit) return hit
  const computed = resolveRepositoryAnchor(projectRoot, deps)
  anchorCache.set(key, computed)
  return computed
}

/** Test seam — the cache is process-wide and would leak between cases. */
export function clearAnchorCache(): void {
  anchorCache.clear()
}

/**
 * #92 defect F — the line every §C dialog owes the developer.
 *
 * MEASURED: no gated tool's dialog named the project root or the repository.
 * Every message named a branch, a commit message or refs, which is what let the
 * crafted-root findings survive the human: in the `plan_authorize` probe the dev
 * read *"Authorize batch commits for this plan on 'main'?"* — true, complete and
 * useless, because `main` IS the real branch. `readGitState` had walked up to
 * the real repository while every anchor stayed in the crafted directory.
 *
 * The dialog is the one channel an agent cannot forge (`os-dialog.ts:5-9`). It
 * cannot forge it, but it could AIM it. This names the target.
 */
export function repositoryDialogLine(projectRoot: string): string {
  const a = anchorFor(projectRoot)
  const shown = a.root.replace(/\\/g, '/')
  if (a.status === 'relocated') {
    return `Repository: ${shown}\n⚠ RSCT state resolves there, NOT at the folder you passed (${resolve(projectRoot).replace(/\\/g, '/')}).`
  }
  if (a.status === 'not-applicable') return `Folder: ${shown} (not a git repository)`
  if (a.status === 'unavailable') return `Folder: ${shown} (git could not confirm the repository)`
  return `Repository: ${shown}`
}

/**
 * Resolve the directory the shared anchors belong under.
 *
 * The derivation is CONDITIONAL, and both obvious one-liners are measured wrong
 * for a submodule:
 *
 * | case             | dirname(common-dir) | worktree list | --show-toplevel |
 * | plain repo       | ok                  | ok            | ok              |
 * | linked worktree  | <main>              | <main>        | <worktree> WRONG|
 * | monorepo package | ok                  | ok            | ok              |
 * | submodule        | inside .git/modules | inside .git   | ok              |
 *
 * So: a LINKED worktree resolves to its main worktree (that is what makes the
 * free-commit ceiling survive `git worktree add`); everything else resolves to
 * its own toplevel. `readWorktreeInfo` supplies the discriminator and its own
 * docstring records why detecting the `/worktrees/<name>` tail is the robust
 * test rather than string-comparing git-dir against common-dir.
 *
 * `--path-format=absolute` is deliberately NOT used: it needs git >= 2.31, the
 * project declares no minimum git version anywhere, and a capability failure
 * would fail closed and brick every commit. MEASURED, the bare form returns a
 * RELATIVE `.git` for a plain repo and absolute elsewhere; resolving it against
 * the root yields the identical answer with no version floor.
 */
export function resolveRepositoryAnchor(
  projectRoot: string,
  deps: AnchorDeps = {},
): RepositoryAnchor {
  const gitRead = deps.gitRead ?? safeGitRead
  const worktreeInfo = deps.worktreeInfo ?? readWorktreeInfo

  const info = worktreeInfo(projectRoot)
  if (!info.in_git_repo) {
    return {
      status: 'not-applicable',
      root: projectRoot,
      identity: null,
      detail:
        'not a git repository — no repository identity exists, so the shared anchors stay at the project root',
    }
  }

  const commonRaw = gitRead(projectRoot, ['rev-parse', '--git-common-dir'])
  if (commonRaw === null) {
    return {
      status: 'unavailable',
      root: projectRoot,
      identity: null,
      detail:
        'git could not report the repository identity (absent, unreadable, or an unsupported version) — anchors stay at the project root and the binding is not enforced',
    }
  }
  const identity = resolve(projectRoot, commonRaw).replace(/\\/g, '/')

  let anchorRoot: string | null
  if (info.is_worktree) {
    const first = gitRead(projectRoot, ['worktree', 'list', '--porcelain'])
    const line = first?.split('\n')[0]?.trim() ?? ''
    anchorRoot = line.startsWith('worktree ') ? line.slice('worktree '.length).trim() : null
    // A bare main repository has no working tree to name; its common-dir's
    // parent is the closest stable directory and keeps one anchor per repo.
    if (anchorRoot === null || anchorRoot.length === 0) anchorRoot = dirname(identity)
  } else {
    anchorRoot = info.toplevel
  }

  if (anchorRoot === null || anchorRoot.length === 0) {
    return {
      status: 'unavailable',
      root: projectRoot,
      identity,
      detail:
        'git reported a repository but no usable working root — anchors stay at the project root and the binding is not enforced',
    }
  }

  const resolved = resolve(anchorRoot)
  if (sameDirectory(resolved, projectRoot)) {
    return { status: 'same', root: resolve(projectRoot), identity, detail: null }
  }
  return {
    status: 'relocated',
    root: resolved,
    identity,
    detail: `shared RSCT state resolves at ${resolved.replace(/\\/g, '/')}, the repository this action lands in — not at the declared project root`,
  }
}
