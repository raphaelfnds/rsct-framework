import { statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { matchesAnyGlob, pathCarriesLineTerminator, readPhaseState, toPosix, type PhaseState } from './phase-scope.js'
import { canonicalPath } from './repo-anchor.js'

export const PLAN_TRACKING_GLOBS = ['plan_*.md', 'progress_*.md', 'spec_*.md'] as const

export type ScopeVerdict =
  | { status: 'stale_context' }
  | { status: 'unknown'; why: 'no_scope' | 'outside_project' }
  | { status: 'in_scope'; matched_glob: string | null }
  | { status: 'out_of_scope'; why: 'line_terminator' | 'network_path' }
  | { status: 'out_of_scope'; why: 'not_listed'; judged_as: string }

export interface ScopePathDeps {
  isAbsolute: (path: string) => boolean
  relative: (from: string, to: string) => string
  resolve: (...segments: string[]) => string
  sep: string
  dirname: (path: string) => string
  canonical: (path: string) => string
  identity: (path: string) => FileIdentity | null
}

export interface FileIdentity {
  dev: bigint
  ino: bigint
}

function fileIdentity(path: string): FileIdentity | null {
  try {
    const stat = statSync(path, { bigint: true })
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

export const nativeScopePaths: ScopePathDeps = {
  isAbsolute,
  relative,
  resolve,
  sep,
  dirname,
  canonical: canonicalPath,
  identity: fileIdentity,
}

const BACKSLASH = String.fromCharCode(92)
const NETWORK_ROOT = BACKSLASH + BACKSLASH
const GIT_BASH_DRIVE = /^\/([A-Za-z])\/(.*)$/

function asTheClientReads(path: string, deps: ScopePathDeps): string {
  if (deps.sep !== BACKSLASH) return path
  const drive = GIT_BASH_DRIVE.exec(path)
  return drive === null ? path : `${drive[1]}:${BACKSLASH}${drive[2]}`
}

function sameFile(a: FileIdentity | null, b: FileIdentity | null, deps: ScopePathDeps): boolean {
  if (a === null || b === null || a.ino === 0n || a.ino !== b.ino) return false
  return deps.sep === BACKSLASH || a.dev === b.dev
}

function topOf(path: string, deps: ScopePathDeps): string {
  let current = path
  for (;;) {
    const parent = deps.dirname(current)
    if (parent === current) return current
    current = parent
  }
}

type Located = { where: 'inside'; path: string } | { where: 'outside' } | { where: 'unverifiable' }

function locate(root: string, file: string, deps: ScopePathDeps): Located {
  const fromRoot = deps.relative(root, file)
  if (deps.isAbsolute(fromRoot)) {
    return fromRoot.startsWith(NETWORK_ROOT) ? { where: 'unverifiable' } : { where: 'outside' }
  }
  if (fromRoot === '..' || fromRoot.startsWith(`..${deps.sep}`)) return { where: 'outside' }
  return { where: 'inside', path: fromRoot }
}

function pathBelowRootByIdentity(root: string, file: string, deps: ScopePathDeps): string | null {
  if (deps.relative(topOf(root, deps), topOf(file, deps)) !== '') return null
  const rootIdentity = deps.identity(root)
  if (rootIdentity === null) return null
  let current = file
  for (;;) {
    if (sameFile(deps.identity(current), rootIdentity, deps)) return deps.relative(current, file)
    const parent = deps.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function judgeEditScope(
  args: {
    projectRoot: string
    filePath: string
    baseDir?: string
    state: PhaseState | null
    stateExists: boolean
  },
  deps: ScopePathDeps = nativeScopePaths,
): ScopeVerdict {
  const { state } = args
  if (state?.context_stale) return { status: 'stale_context' }
  const scopeGlobs = state?.scope_globs ?? []
  if (!args.stateExists || state === null || scopeGlobs.length === 0) {
    return { status: 'unknown', why: 'no_scope' }
  }
  if (pathCarriesLineTerminator(args.filePath)) {
    return { status: 'out_of_scope', why: 'line_terminator' }
  }
  const root = deps.canonical(args.projectRoot)
  const given = asTheClientReads(args.filePath, deps)
  const typed = deps.isAbsolute(given) ? deps.resolve(given) : deps.resolve(args.baseDir ?? args.projectRoot, given)
  if (locate(root, typed, deps).where === 'unverifiable') {
    return { status: 'out_of_scope', why: 'network_path' }
  }
  const file = deps.canonical(typed)
  const located = locate(root, file, deps)
  if (located.where === 'unverifiable') {
    return { status: 'out_of_scope', why: 'network_path' }
  }
  const belowRoot = located.where === 'inside' ? located.path : pathBelowRootByIdentity(root, file, deps)
  if (belowRoot === null) {
    return { status: 'unknown', why: 'outside_project' }
  }
  if (matchesAnyGlob(belowRoot, PLAN_TRACKING_GLOBS).matched) {
    return { status: 'in_scope', matched_glob: null }
  }
  const match = matchesAnyGlob(belowRoot, scopeGlobs)
  if (match.matched) return { status: 'in_scope', matched_glob: match.matched_glob ?? null }
  return { status: 'out_of_scope', why: 'not_listed', judged_as: toPosix(belowRoot) }
}

export type EditGuardStatus =
  | 'in_scope'
  | 'out_of_scope'
  | 'unknown'
  | 'stale_context'
  | 'unmanaged'
  | 'infra_error'

export interface EditGuardResult {
  decision: 'allow' | 'block'
  status: EditGuardStatus
  reason: string
}

function outOfScopeReason(path: string, verdict: Extract<ScopeVerdict, { status: 'out_of_scope' }>): string {
  if (verdict.why === 'not_listed') {
    return (
      `'${path}' is OUTSIDE the active spec scope (judged as '${verdict.judged_as}' below the project root; ` +
      'entries are compared case-sensitively with that spelling) — expand scope_globs (with dev approval) or re-plan'
    )
  }
  if (verdict.why === 'line_terminator') {
    return `'${path}' carries a line terminator in its name — no scope glob covers such a path`
  }
  return `'${path}' is a network-style path on another root than the project — the guard cannot tell whether it points back into the project. Use the file's path under the project root, or a path on a local drive`
}

export function evaluateEditGuard(args: {
  projectRoot: string
  rsctInstalled: boolean
  filePath: string
  cwd?: string
}): EditGuardResult {
  try {
    if (!args.rsctInstalled) {
      return { decision: 'allow', status: 'unmanaged', reason: 'no .rsct.json — unmanaged project' }
    }
    const read = readPhaseState(args.projectRoot)
    if (read.parse_error) {
      return { decision: 'allow', status: 'infra_error', reason: `phase-state unreadable: ${read.parse_error}` }
    }
    const verdict = judgeEditScope({
      projectRoot: args.projectRoot,
      filePath: args.filePath,
      ...(args.cwd !== undefined && { baseDir: args.cwd }),
      state: read.state,
      stateExists: read.exists,
    })
    if (verdict.status === 'stale_context') {
      return {
        decision: 'block',
        status: 'stale_context',
        reason:
          'context is STALE (a plan closed / pivot) — run rsct_status + rsct_load_context before editing. ' +
          'If those tools are not available in this session, stop and tell the developer: ' +
          'the RSCT troubleshooting guide has the way out',
      }
    }
    if (verdict.status === 'unknown') {
      return {
        decision: 'allow',
        status: 'unknown',
        reason:
          verdict.why === 'outside_project'
            ? `'${args.filePath}' is outside the project — the phase scope does not govern it`
            : 'no active phase scope to enforce',
      }
    }
    if (verdict.status === 'in_scope') {
      return {
        decision: 'allow',
        status: 'in_scope',
        reason:
          verdict.matched_glob === null
            ? 'plan-tracking file — always editable while a scope is active'
            : `in scope via '${verdict.matched_glob}'`,
      }
    }
    return {
      decision: 'block',
      status: 'out_of_scope',
      reason: outOfScopeReason(args.filePath, verdict),
    }
  } catch (err) {
    return {
      decision: 'allow',
      status: 'infra_error',
      reason: `edit-guard fault: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
