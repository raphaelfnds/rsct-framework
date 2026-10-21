import { resolve, dirname, basename, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { readWorktreeInfo, safeGitRead } from './git.js'
import { DIALOG_PATH_LIMIT, specLabel } from './dialog-text.js'

export const LOCAL_ANCHORS = ['phase-state.json', 'phase-state.lock', 'scripts'] as const

export type AnchorStatus =
  | 'same'
  | 'relocated'
  | 'not-applicable'
  | 'unavailable'

export interface RepositoryAnchor {
  status: AnchorStatus
  root: string
  identity: string | null
  detail: string | null
}

export function canonicalPath(p: string): string {
  let current = resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      const real = (realpathSync.native ?? realpathSync)(current)
      return tail.length > 0 ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(p)
      tail.push(basename(current))
      current = parent
    }
  }
}

function comparable(p: string): string {
  const abs = canonicalPath(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export function sameDirectory(a: string, b: string): boolean {
  return comparable(a) === comparable(b)
}

export interface AnchorDeps {
  gitRead?: (cwd: string, args: string[]) => string | null
  worktreeInfo?: typeof readWorktreeInfo
}

const anchorCache = new Map<string, RepositoryAnchor>()

export function anchorFor(projectRoot: string, deps: AnchorDeps = {}): RepositoryAnchor {
  const key = canonicalPath(projectRoot)
  const hit = anchorCache.get(key)
  if (hit) return hit
  const computed = resolveRepositoryAnchor(projectRoot, deps)
  anchorCache.set(key, computed)
  return computed
}

export function clearAnchorCache(): void {
  anchorCache.clear()
}

export function repositoryDialogLine(projectRoot: string): string {
  const a = anchorFor(projectRoot)
  const shown = specLabel(a.root.replace(/\\/g, '/'), DIALOG_PATH_LIMIT)
  if (a.status === 'relocated') {
    return `Repository: ${shown}\n⚠ RSCT state resolves there, NOT at the folder you passed (${specLabel(resolve(projectRoot).replace(/\\/g, '/'), DIALOG_PATH_LIMIT)}).`
  }
  if (a.status === 'not-applicable') return `Folder: ${shown} (not a git repository)`
  if (a.status === 'unavailable') return `Folder: ${shown} (git could not confirm the repository)`
  return `Repository: ${shown}`
}

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
      root: resolve(projectRoot),
      identity: null,
      detail:
        'not a git repository — no repository identity exists, so the shared anchors stay at the project root',
    }
  }

  const commonRaw = gitRead(projectRoot, ['rev-parse', '--git-common-dir'])
  if (commonRaw === null) {
    return {
      status: 'unavailable',
      root: resolve(projectRoot),
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
    if (anchorRoot === null || anchorRoot.length === 0) anchorRoot = dirname(identity)
  } else {
    anchorRoot = info.toplevel
  }

  if (anchorRoot === null || anchorRoot.length === 0) {
    return {
      status: 'unavailable',
      root: resolve(projectRoot),
      identity,
      detail:
        'git reported a repository but no usable working root — anchors stay at the project root and the binding is not enforced',
    }
  }

  const resolved = canonicalPath(anchorRoot)
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
