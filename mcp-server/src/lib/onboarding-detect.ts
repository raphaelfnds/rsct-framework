import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { RsctConfig } from './project-root.js'
import { getUniverse, isUniverseDir, normalizeOrg, type UniverseOptions } from './universe.js'

// DX-1 — onboarding detector. Given a project, deterministically classify the
// onboarding SITUATION and the recommended ROUTE so /rsct-setup can act as the
// single guided orchestrator (detect → route → consent-gated guided flow). This
// is the "brain" half of the hybrid design: the prompt consumes the verdict and
// narrates/consents in plain language. Two NET-NEW signals over the universe
// layer: `is_universe_repo` (the universe≠app guard — G3) and same-org SIBLING
// apps (G1, the "suggest CREATE a universe" trigger). Everything here is Node-only
// (no shell — cross-OS by construction), READ-ONLY, and FAIL-GRACEFUL: any error
// degrades to a sane verdict and NEVER throws into the bootstrap path.

// Caps — never let a pathological parent dir or huge .git/config DoS the scan.
const MAX_ENTRIES = 400
const MAX_SIBLINGS = 50
const MAX_GIT_CONFIG_BYTES = 1_000_000

// Case-insensitive filesystems (Windows, default macOS): path equality must be
// case-folded, else a case-variant of the repo's own path lists ITSELF as a
// sibling, or a junction-escape check misfires (V audit R5/R7).
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'
function caseFold(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p
}

export type Situation =
  | 'is-universe' // this repo IS a universe (governance) repo, not an app
  | 'has-universe-linked' // universe resolves, app linked + registered — fully set up
  | 'has-universe-unlinked' // a universe is reachable but this app isn't linked yet
  | 'universe-configured-missing' // .rsct.json points at a universe that doesn't resolve
  | 'offer-register' // linked, but this app isn't registered in the universe yet
  | 'siblings-no-universe' // ≥1 same-org sibling app, no universe — suggest CREATE
  | 'solo' // no universe, no confirmed siblings — near-zero-config

export type Route =
  | 'guard-universe-repo' // STOP: don't run setup as an app here
  | 'offer-link-existing' // offer /rsct-canonical-source to link the found universe
  | 'offer-create-universe' // offer the guided create→link→register flow
  | 'fix-universe-link' // tell the dev to fix universe.local (never register into a void)
  | 'none' // nothing extra to offer (Phase 4.8 self-guards registration)

export interface SiblingApp {
  /** Basename of the sibling directory (display). */
  dir: string
  /** app.name from the sibling's .rsct.json, else null (git_remote-only match). */
  name: string | null
  /** Normalized org (display); the MATCH is case-folded internally. */
  org: string | null
  /**
   * 'rsct_json' = a same-org RSCT-managed sibling (drives the create offer).
   * 'git_remote' = ADVISORY only (a same-org repo without RSCT) — never enough,
   * on its own, to trigger the create offer (V audit R5).
   */
  matched_by: 'rsct_json' | 'git_remote'
}

export interface OnboardingDetection {
  /** Deterministic universe≠app signal: this repo has a `.universe.json` (G3). */
  is_universe_repo: boolean
  app: { name: string | null; org: string | null }
  universe: {
    available: boolean
    this_app_registered: boolean
    local_path: string | null
    /** universe resolves AND .rsct.json `universe.local` is set (V audit P0-2). */
    linked: boolean
    /** .rsct.json `universe.local` is set but the target doesn't resolve. */
    configured_missing: boolean
  }
  /** Same-org siblings (populated only in the no-universe branch). */
  siblings: SiblingApp[]
  situation: Situation
  recommended_route: Route
  /** Plain guidance for the agent to narrate (the user-facing copy is in the prompt). */
  hints: string[]
}

/** Lower-cased + trimmed org key for case-insensitive same-org matching. */
function matchKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const n = normalizeOrg(raw.trim())
  return n ? n.toLowerCase() : null
}

/**
 * Extract the org segment from a git remote URL (DOCUMENTED scope, no exec).
 * Supported: scp-like `git@host:org/repo(.git)`; `ssh://[user@]host[:port]/org/
 * repo(.git)`; `https?://[user[:tok]@]host/org/repo(.git)`; `git://host/org/repo`.
 * org = the FIRST path segment (GitLab subgroups → the top group is the org).
 * Unknown shapes (file://, relative/local paths, insteadOf rewrites) → null.
 */
export function parseGitRemoteOrg(url: string): string | null {
  const s = url.trim()
  if (s.length === 0) return null

  let path: string | null = null
  const schemeMatch = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.+)$/)
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? '').toLowerCase()
    // local-file and unknown non-network schemes are out of scope.
    if (scheme === 'file') return null
    let rest = schemeMatch[2] ?? ''
    // strip userinfo@ that precedes the host (before the first '/').
    const at = rest.indexOf('@')
    const firstSlash = rest.indexOf('/')
    if (at >= 0 && (firstSlash === -1 || at < firstSlash)) rest = rest.slice(at + 1)
    const slash = rest.indexOf('/')
    if (slash === -1) return null
    path = rest.slice(slash + 1)
  } else {
    // scp-like: [user@]host:path — require a host that looks like a host (has a
    // '@' or a '.'), so a Windows drive path ("C:\...") is NOT misread as scp.
    const colon = s.indexOf(':')
    if (colon === -1) return null
    const before = s.slice(0, colon)
    if (!before.includes('@') && !before.includes('.')) return null
    path = s.slice(colon + 1)
  }

  path = path.replace(/^\/+/, '')
  const segs = path.split('/').filter((seg) => seg.length > 0)
  if (segs.length < 2) return null // need at least org/repo
  const org = segs[0]
  return org && org.length > 0 ? org : null
}

/** Read the org from a sibling's `.git/config` origin remote (CRLF-safe, no exec). */
function readGitRemoteOrg(dir: string): string | null {
  const cfgPath = join(dir, '.git', 'config')
  let text: string
  try {
    if (statSync(cfgPath).size > MAX_GIT_CONFIG_BYTES) return null
    // R6: strip CRLF before any line-split / regex (the org regex is $-anchored).
    text = readFileSync(cfgPath, 'utf8').replace(/\r/g, '')
  } catch {
    return null
  }
  const url = extractOriginUrl(text)
  return url ? parseGitRemoteOrg(url) : null
}

/** Parse `.git/config` INI text; prefer `[remote "origin"]`, else the first remote (V audit R3). */
function extractOriginUrl(text: string): string | null {
  let currentRemote: string | null = null
  let originUrl: string | null = null
  let firstUrl: string | null = null
  for (const line of text.split('\n')) {
    // git config keywords/variable names are CASE-INSENSITIVE (`[REMOTE "origin"]`,
    // `URL =` are valid) → `i` flag. The subsection NAME ("origin") stays
    // case-sensitive (git treats it so) via the exact `=== 'origin'` compare below.
    const remoteHeader = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/i)
    if (remoteHeader) {
      currentRemote = remoteHeader[1] ?? null
      continue
    }
    // any other section header ends the current remote section.
    if (/^\s*\[/.test(line)) {
      currentRemote = null
      continue
    }
    if (currentRemote) {
      const u = line.match(/^\s*url\s*=\s*(.+?)\s*$/i)
      if (u) {
        const val = (u[1] ?? '').trim()
        if (firstUrl === null) firstUrl = val
        if (currentRemote === 'origin' && originUrl === null) originUrl = val
      }
    }
  }
  return originUrl ?? firstUrl
}

interface SiblingMatch {
  name: string | null
  org: string | null
  matched_by: 'rsct_json' | 'git_remote'
}

/** Read app.name / app.org from a sibling `.rsct.json` (fail-graceful, byte-capped). */
function readRsctAppIdentity(rsctPath: string): { name: string | null; org: string | null } | null {
  try {
    if (statSync(rsctPath).size > MAX_GIT_CONFIG_BYTES) return null
    const parsed = JSON.parse(readFileSync(rsctPath, 'utf8')) as { app?: { name?: unknown; org?: unknown } }
    const name = typeof parsed.app?.name === 'string' ? parsed.app.name : null
    const org = typeof parsed.app?.org === 'string' ? parsed.app.org : null
    return { name, org }
  } catch {
    return null
  }
}

/** Classify one candidate sibling against our org key; null = not a same-org sibling. */
function matchSibling(full: string, selfKey: string): SiblingMatch | null {
  const rsctPath = join(full, '.rsct.json')
  if (existsSync(rsctPath)) {
    const id = readRsctAppIdentity(rsctPath)
    if (id && id.org) {
      // An RSCT-managed sibling with a DIFFERENT org is definitively not ours —
      // do not fall through to the git_remote guess.
      return matchKey(id.org) === selfKey
        ? { name: id.name, org: normalizeOrg(id.org.trim()), matched_by: 'rsct_json' }
        : null
    }
    // .rsct.json present but unreadable / no org → fall through to advisory.
  }
  const gitOrg = readGitRemoteOrg(full)
  if (gitOrg && matchKey(gitOrg) === selfKey) {
    return { name: null, org: normalizeOrg(gitOrg.trim()), matched_by: 'git_remote' }
  }
  return null
}

/**
 * Scan the PARENT dir (one level, direct children only) for same-org sibling
 * apps. Read-only, traversal-safe: skips dotdirs, symlinks, junction-escapes
 * (realpath must stay a direct child of the parent — V audit R7), the universe
 * dir, and self (case-folded — R5). Capped. Never throws.
 */
function scanSiblings(root: string, selfKey: string | null): SiblingApp[] {
  if (!selfKey) return []
  const parent = dirname(root)
  if (caseFold(resolve(parent)) === caseFold(resolve(root))) return [] // filesystem root

  let entries
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return []
  }

  const out: SiblingApp[] = []
  // MAX_ENTRIES bounds the entries EXAMINED (a DoS bound on a pathological parent),
  // not siblings found — skipped entries (dotdirs, self, non-dirs) count toward it.
  let scanned = 0
  for (const e of entries) {
    if (scanned >= MAX_ENTRIES) break
    scanned++
    if (e.name.startsWith('.')) continue
    const full = join(parent, e.name)
    if (caseFold(resolve(full)) === caseFold(resolve(root))) continue // self

    let st
    try {
      st = lstatSync(full)
    } catch {
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    // R7: Windows junctions are NOT reported as symlinks by lstat — verify the
    // real path is still a direct child of the parent (rejects junction escapes).
    try {
      if (caseFold(dirname(realpathSync(full))) !== caseFold(resolve(parent))) continue
    } catch {
      continue
    }
    if (isUniverseDir(full)) continue // a universe is not an app sibling

    const m = matchSibling(full, selfKey)
    if (m) {
      out.push({ dir: e.name, ...m })
      if (out.length >= MAX_SIBLINGS) break
    }
  }
  out.sort((a, b) => a.dir.localeCompare(b.dir))
  return out
}

function buildHints(d: Omit<OnboardingDetection, 'hints'>): string[] {
  const hints: string[] = []
  switch (d.recommended_route) {
    case 'guard-universe-repo':
      hints.push(
        'This repo is a UNIVERSE (governance) repo, not an application — /rsct-setup is for apps. STOP setup; edit the universe files (.universe.json, contracts.json, docs/governance/) and commit them yourself.',
      )
      break
    case 'fix-universe-link':
      hints.push(
        `.rsct.json points at a universe (${d.universe.local_path}) that does not resolve — fix universe.local or re-run /rsct-canonical-source. Do NOT register this app into it.`,
      )
      break
    case 'offer-link-existing':
      hints.push(
        `A universe was found at ${d.universe.local_path} but this app is not linked to it — offer to link it (/rsct-canonical-source), then register it.`,
      )
      break
    case 'offer-create-universe': {
      const confirmed = d.siblings.filter((s) => s.matched_by === 'rsct_json').map((s) => s.dir)
      hints.push(
        `Found ${confirmed.length} same-org sibling app(s) (${confirmed.join(', ')}) and no universe — offer the guided flow: create a universe (/rsct-init-universe), link this app (/rsct-canonical-source), then register it. Each step is consent-gated; the dev edits contract content and commits the universe repo themselves.`,
      )
      break
    }
    case 'none':
      if (d.situation === 'offer-register') {
        hints.push(
          'This app is linked to the universe but not registered there — Phase 4.8 of /rsct-setup will offer to register it.',
        )
      }
      break
  }
  // Advisory: same-org repos found without RSCT (do not, alone, trigger create).
  const advisory = d.siblings.filter((s) => s.matched_by === 'git_remote').map((s) => s.dir)
  if (advisory.length > 0) {
    hints.push(
      `Possible same-org repos without RSCT (advisory, not counted toward the universe suggestion): ${advisory.join(', ')}.`,
    )
  }
  return hints
}

/**
 * The deterministic onboarding verdict. Reuses the single-source `getUniverse`
 * for universe facts; adds `is_universe_repo` + the same-org sibling scan; then
 * synthesizes the situation/route (first-match precedence). Never throws.
 */
export function detectOnboarding(
  config: RsctConfig | null,
  projectRoot: string,
  opts: UniverseOptions = {},
): OnboardingDetection {
  const root = resolve(projectRoot)
  const appName = config?.app?.name ?? null

  // Self org: from .rsct.json app.org, else inferred from ./.git/config origin
  // (so sibling detection works on a FRESH install before .rsct.json exists).
  const rawSelfOrg = config?.app?.org ?? readGitRemoteOrg(root)
  // `|| null`: a digits/dash-only org (e.g. "-9") normalizes to '' — surface null,
  // not an odd empty-string display value (selfKey already goes null → scan skipped).
  const selfOrg = normalizeOrg(rawSelfOrg ? rawSelfOrg.trim() : null) || null
  const selfKey = matchKey(rawSelfOrg)

  // P0-2: is_universe_repo := the repo root carries a `.universe.json`, full stop
  // (so the bash guard in 01-setup.md and this signal are bit-identical).
  const isUniverseRepo = existsSync(join(root, '.universe.json'))

  const { block: uni } = getUniverse(config, root, opts)
  const hasLocal = !!(config?.universe?.local && config.universe.local.trim().length > 0)
  // configured-missing: universe.local set but it doesn't resolve (resolveUniverseRoot
  // does NOT fall through to the probe when local is set, so !available ⇒ missing).
  const configuredMissing = hasLocal && !uni.available
  const linked = uni.available && hasLocal

  let siblings: SiblingApp[] = []
  let situation: Situation
  let route: Route

  if (isUniverseRepo) {
    situation = 'is-universe'
    route = 'guard-universe-repo'
  } else if (uni.available) {
    if (!linked) {
      situation = 'has-universe-unlinked'
      route = 'offer-link-existing'
    } else if (!uni.this_app_registered) {
      // P1-6: Phase 4.8 already self-guards registration — no extra route.
      situation = 'offer-register'
      route = 'none'
    } else {
      situation = 'has-universe-linked'
      route = 'none'
    }
  } else if (configuredMissing) {
    situation = 'universe-configured-missing'
    route = 'fix-universe-link'
  } else {
    siblings = scanSiblings(root, selfKey)
    const confirmed = siblings.filter((s) => s.matched_by === 'rsct_json')
    if (confirmed.length >= 1) {
      situation = 'siblings-no-universe'
      route = 'offer-create-universe'
    } else {
      situation = 'solo'
      route = 'none'
    }
  }

  const core: Omit<OnboardingDetection, 'hints'> = {
    is_universe_repo: isUniverseRepo,
    app: { name: appName, org: selfOrg },
    universe: {
      available: uni.available,
      this_app_registered: uni.this_app_registered,
      local_path: uni.local_path,
      linked,
      configured_missing: configuredMissing,
    },
    siblings,
    situation,
    recommended_route: route,
  }
  return { ...core, hints: buildHints(core) }
}
