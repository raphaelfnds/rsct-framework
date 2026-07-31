import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isNewer } from './update-check.js'

/**
 * Install-drift notice, on two independent axes.
 *
 * **Version axis (`normal`).** Is the project's recorded RSCT version older than
 * the running `rsct-mcp` binary? A project's `.rsct.json` `rsct_version` is the
 * product/release version stamped at install time; the binary's
 * `RSCT_MCP_VERSION` moves when the framework is updated. When the binary is
 * strictly newer, the project's installed rules/prompts/markers are behind the
 * framework and a `/rsct-setup` re-run applies the current version.
 *
 * **Component axis (`security`).** Is a security-relevant script under
 * `.rsct/scripts/` absent, or different from the copy this binary ships? Those
 * scripts ARE the mechanical enforcement surface — a stale or missing
 * `sanitize-permissions.js` means §E leak fixes are simply not running in that
 * project, which is categorically worse than lagging prose.
 *
 * The two axes are deliberately independent, and the component axis compares
 * CONTENT rather than versions. Ranking by version cannot work here: the line-2
 * stamp `/rsct-setup` writes is the *release* version, and `.rsct.json`
 * `rsct_version` is stamped from that same release axis — so "project behind"
 * would always imply "stamp behind", and every release would read as a security
 * event. Comparing the installed body against the shipped body is positive
 * evidence and needs no per-release maintenance: a release that did not touch a
 * script produces identical bodies. It is also what `/rsct-setup` itself already
 * does (Phase 4.V.b) to decide whether to rewrite.
 *
 * This is a LOCAL comparison — no network, no consent, no cache. It is
 * deliberately separate from `update-check.ts` (which checks the binary against
 * the latest GitHub release and is opt-in / network-gated): mixing an always-on
 * local compare into that module would break its "no network/writes before
 * consent" invariant. The two are complementary and independent axes.
 *
 * Always fail-safe and SUGGEST-ONLY: absence of evidence is never escalated. An
 * unreadable script, an unresolvable shipped reference, a null/absent/unparseable
 * `rsct_version`, an equal version, or a project NEWER than the binary all
 * degrade quietly. `isNewer` returns false on anything it can't parse, so a
 * malformed value never produces a false "update available".
 */

/** Scripts whose staleness is a live enforcement hole, not a cosmetic lag. */
const SECURITY_RELEVANT: ReadonlySet<string> = new Set([
  'sanitize-permissions.js',
  'edit-scope-guard.js',
])

/**
 * Line 2 as written by `/rsct-setup` Phase 4.V.b / 4.V.d:
 * `// rsct-mcp v=X.Y.Z — installed by /rsct-setup`. Anchored at the start of the
 * line so an unrelated bundler line containing `v=1` can never be read as a
 * stamp. Display only — the verdict comes from the body comparison. A prefix
 * match with no capture is the `v=unknown` fallback that setup writes when the
 * package version cannot be resolved.
 */
const STAMP_RE = /^\s*\/\/\s*rsct-mcp\s+v=([0-9]\S*)/

export type DriftSeverity = 'normal' | 'security'

export type ScriptState = 'current' | 'stale' | 'absent' | 'unreadable'

export interface ScriptEvidence {
  name: string
  state: ScriptState
  security_relevant: boolean
  /** Line-2 stamp when present and parseable. Never drives the verdict. */
  stamp_version: string | null
}

export interface StaleComponent {
  name: string
  state: ScriptState
  stamp_version: string | null
}

export interface InstallDriftNotice {
  hint: string | null
  severity: DriftSeverity
  stale_components: StaleComponent[]
}

/**
 * Directory holding the scripts this binary ships. At runtime the bundle is
 * `dist/index.js`, so its sibling is `dist/scripts/`. Returns null when that
 * cannot be resolved (e.g. running from source under vitest) — an unresolvable
 * reference is treated as "no evidence", never as staleness.
 */
function shippedScriptsDir(): string | null {
  try {
    return join(fileURLToPath(new URL('.', import.meta.url)), 'scripts')
  } catch {
    return null
  }
}

/**
 * Read a file with CRLF normalized away, or null when unreadable. `.rsct/scripts/`
 * is not gitignored, so a Windows `autocrlf` checkout materializes CRLF while the
 * shipped copy stays LF — comparing raw bytes would report every Windows install
 * as stale (CLAUDE.md anti-pattern #4).
 */
function readNormalized(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').replace(/\r/g, '')
  } catch {
    return null
  }
}

/**
 * Body of an installed copy: drop the shebang (line 1) and the version stamp
 * (line 2) that `/rsct-setup` prepends, leaving what came from the shipped file.
 */
function installedBody(text: string): string {
  return text.split('\n').slice(2).join('\n')
}

/** Body of a shipped copy: drop only the tsup shebang banner (line 1). */
function shippedBody(text: string): string {
  return text.split('\n').slice(1).join('\n')
}

function stampOf(text: string): string | null {
  const line2 = text.split('\n')[1] ?? ''
  const m = STAMP_RE.exec(line2)
  return m ? (m[1] ?? null) : null
}

/**
 * Compare every `.js` under `<projectRoot>/.rsct/scripts` against the copy this
 * binary ships. Enumeration is data-driven, so a script a future setup installs is
 * picked up without a change here; only the security classification is a
 * hand-maintained set. Security-relevant names are always reported even when the
 * directory does not list them — an absent enforcement script is the loudest
 * state, not a silent one.
 *
 * Never throws. `shippedDir` is a test seam.
 */
export function readScriptEvidence(
  projectRoot: string,
  shippedDir: string | null = shippedScriptsDir(),
): ScriptEvidence[] {
  const installedDir = join(projectRoot, '.rsct', 'scripts')

  let entries: string[] = []
  try {
    entries = readdirSync(installedDir).filter((f) => f.endsWith('.js'))
  } catch {
    entries = []
  }

  const names = [...new Set([...entries, ...SECURITY_RELEVANT])].sort()
  const evidence: ScriptEvidence[] = []

  for (const name of names) {
    const security_relevant = SECURITY_RELEVANT.has(name)

    if (!entries.includes(name)) {
      evidence.push({ name, state: 'absent', security_relevant, stamp_version: null })
      continue
    }

    const installed = readNormalized(join(installedDir, name))
    if (installed === null) {
      evidence.push({ name, state: 'unreadable', security_relevant, stamp_version: null })
      continue
    }

    const stamp_version = stampOf(installed)
    const shipped = shippedDir === null ? null : readNormalized(join(shippedDir, name))
    if (shipped === null) {
      // No reference to compare against — no evidence, so no verdict.
      evidence.push({ name, state: 'unreadable', security_relevant, stamp_version })
      continue
    }

    const state: ScriptState =
      installedBody(installed) === shippedBody(shipped) ? 'current' : 'stale'
    evidence.push({ name, state, security_relevant, stamp_version })
  }

  return evidence
}

function describe(c: StaleComponent): string {
  if (c.state === 'absent') return `${c.name} is not installed`
  const at = c.stamp_version ? ` (installed at v${c.stamp_version})` : ''
  return `${c.name} is outdated${at}`
}

export function getInstallDriftNotice(args: {
  projectRoot: string
  projectVersion: string | null | undefined
  mcpVersion: string
  /** Test seam only — bypasses the filesystem. */
  evidence?: ScriptEvidence[]
}): InstallDriftNotice {
  const { projectRoot, projectVersion, mcpVersion } = args
  const evidence = args.evidence ?? readScriptEvidence(projectRoot)

  const stale_components: StaleComponent[] = evidence
    .filter((e) => e.security_relevant && (e.state === 'stale' || e.state === 'absent'))
    .map((e) => ({ name: e.name, state: e.state, stamp_version: e.stamp_version }))

  // Strip a hand-edited leading `v` in the DISPLAY text (the compare in isNewer
  // already normalizes it). `.rsct.json` `rsct_version` is schema-typed as a
  // free string, so `"v2.0.0"` is possible — avoid rendering "vv2.0.0".
  const m = mcpVersion.replace(/^v/, '')

  if (stale_components.length > 0) {
    const p = projectVersion ? projectVersion.replace(/^v/, '') : 'unknown'
    return {
      severity: 'security',
      stale_components,
      hint:
        `⚠ SECURITY: this project's enforcement scripts do not match rsct-mcp v${m} — ` +
        `${stale_components.map(describe).join('; ')}. ` +
        `Fixes shipped in those scripts are NOT active here (project installed at v${p}). ` +
        `Re-run /rsct-setup to apply them. (suggestion only)`,
    }
  }

  if (!projectVersion) return { hint: null, severity: 'normal', stale_components: [] }
  if (!isNewer(mcpVersion, projectVersion))
    return { hint: null, severity: 'normal', stale_components: [] }

  const p = projectVersion.replace(/^v/, '')
  return {
    severity: 'normal',
    stale_components: [],
    hint:
      `This project was set up with RSCT v${p}; the installed rsct-mcp is v${m}. ` +
      `Re-run /rsct-setup to apply the current version's rules/prompts to this project. (suggestion only)`,
  }
}
