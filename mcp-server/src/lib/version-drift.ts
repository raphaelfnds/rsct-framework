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
 * **Component axis.** What is the state of the enforcement scripts under
 * `.rsct/scripts/` — the mechanical surface that strips poison-pill permission
 * entries and gates out-of-scope edits?
 *
 * Only ABSENCE escalates to `security`, and the distinction is deliberate:
 *
 *  - **absent** — the script is not there, so that enforcement is simply not
 *    running. Unambiguous, locally provable, and rare. This is the state worth
 *    shouting about.
 *  - **stale** (body differs from the copy this binary ships) — real and worth
 *    reporting, but it CANNOT be read as "a fix is missing". The scripts are
 *    bundles: `edit-scope-guard.js` embeds the whole config layer, so adding one
 *    unrelated `.rsct.json` key changes its bytes. Ranking that as a security
 *    event would fire for every installed project on almost every release, and a
 *    signal that is always on is a signal nobody reads — the exact failure this
 *    module exists to remove, merely inverted. So `stale` rides the `normal`
 *    tier, with a hint that names the components rather than a generic
 *    "your version is behind".
 *
 * Nothing available locally can tell whether a byte difference matters; content
 * comparison answers "is it the same build", not "is a fix missing". This module
 * says only what it can prove.
 *
 * Content comparison is still the right primitive for "is it the same build" —
 * the line-2 stamp cannot do even that, since it carries the *release* version
 * and `.rsct.json` `rsct_version` comes from the same axis, so "project behind"
 * would always imply "stamp behind". It is also what `/rsct-setup` itself does
 * (Phase 4.V.b) to decide whether to rewrite.
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
 * stamp. Display only — the verdict comes from the body comparison. The version
 * group requires a leading digit, so setup's `v=unknown` fallback does not match
 * at all and yields no stamp, which is the intended outcome.
 *
 * Exported so `tests/bash/block-smoke.test.ts` asserts the bash writer against
 * THIS pattern rather than a copy of it — a copy would stay green if the pattern
 * changed, pinning nothing.
 */
export const STAMP_RE = /^\s*\/\/\s*rsct-mcp\s+v=([0-9]\S*)/

/**
 * Whether line 2 IS a stamp, independent of whether its version parses. Setup
 * writes `v=unknown` when it cannot resolve the package version — that line is
 * still a stamp and must still be excluded from the body, even though it yields
 * no version. Keeping the two questions separate is the difference between
 * "no version to display" and "this line is source code".
 */
const STAMP_LINE_RE = /^\s*\/\/\s*rsct-mcp\s+v=/

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
 * Trailing newlines carry no meaning here and DO differ by construction: setup
 * builds the file inside `$( … )`, which strips them, then writes it back with
 * `printf '%s\n'` — while the shipped bundle ends at its sourceMappingURL with
 * no terminating newline. Comparing them raw reports every healthy install as
 * stale. Setup's own idempotency check normalizes the same way.
 */
function trimTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, '')
}

/**
 * Body of an installed copy: drop the shebang (line 1), and the version stamp
 * (line 2) only when line 2 actually IS a stamp. A pre-stamp install carries the
 * source body from line 2, so dropping it unconditionally would corrupt the
 * comparison and report a byte-identical legacy copy as stale.
 */
function installedBody(text: string): string {
  const lines = text.split('\n')
  const from = STAMP_LINE_RE.test(lines[1] ?? '') ? 2 : 1
  return trimTrailingNewlines(lines.slice(from).join('\n'))
}

/** Body of a shipped copy: drop only the tsup shebang banner (line 1). */
function shippedBody(text: string): string {
  return trimTrailingNewlines(text.split('\n').slice(1).join('\n'))
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
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return []
  const installedDir = join(projectRoot, '.rsct', 'scripts')

  // A directory that does not exist IS positive evidence: setup skipped Phase
  // 4.V, or an uninstall removed it, and the scripts genuinely are not there.
  // Any OTHER failure (ENOTDIR, EACCES, a stalled UNC share) means we could not
  // look — reporting that as `absent` would raise a phantom security alarm, so
  // it degrades to `unreadable` instead.
  let entries: string[] = []
  let listed = true
  try {
    entries = readdirSync(installedDir).filter((f) => f.endsWith('.js'))
  } catch (err) {
    listed = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
  }

  const names = [...new Set([...entries, ...SECURITY_RELEVANT])].sort()
  const evidence: ScriptEvidence[] = []

  for (const name of names) {
    const security_relevant = SECURITY_RELEVANT.has(name)

    if (!entries.includes(name)) {
      evidence.push({
        name,
        state: listed ? 'absent' : 'unreadable',
        security_relevant,
        stamp_version: null,
      })
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

    const a = installedBody(installed)
    const b = shippedBody(shipped)
    // An empty body on either side means the file was truncated or wiped. Two
    // empty bodies would compare equal and read as `current` — a fail-OPEN in
    // exactly the case the check exists to catch, so require a real body.
    const state: ScriptState = a.length === 0 || b.length === 0 ? 'stale' : a === b ? 'current' : 'stale'
    evidence.push({ name, state, security_relevant, stamp_version })
  }

  return evidence
}

function describe(c: StaleComponent): string {
  if (c.state === 'absent') return `${c.name} is not installed`
  // "differs from", never "outdated": `.rsct/scripts/` is committed, so a
  // teammate on an older binary can legitimately hold a NEWER script, and this
  // comparison has no direction.
  const at = c.stamp_version ? ` (installed at v${c.stamp_version})` : ''
  return `${c.name} differs from this binary's copy${at}`
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

  const affected = evidence.filter(
    (e) => e.security_relevant && (e.state === 'stale' || e.state === 'absent'),
  )
  const stale_components: StaleComponent[] = affected.map((e) => ({
    name: e.name,
    state: e.state,
    stamp_version: e.stamp_version,
  }))
  const absent = stale_components.filter((c) => c.state === 'absent')

  // Strip a hand-edited leading `v` in the DISPLAY text (the compare in isNewer
  // already normalizes it). `.rsct.json` `rsct_version` is schema-typed as a
  // free string, so `"v2.0.0"` is possible — avoid rendering "vv2.0.0".
  const m = mcpVersion.replace(/^v/, '')

  // Only absence is a security claim — see the module docstring for why "differs"
  // cannot be one. The message asserts exactly what was observed: this script is
  // not here, therefore what it enforces is not running.
  if (absent.length > 0) {
    return {
      severity: 'security',
      stale_components,
      hint:
        `⚠ SECURITY: an RSCT enforcement script is missing from this project — ` +
        `${absent.map(describe).join('; ')}. ` +
        `What it enforces is not running here. Run /rsct-setup to install it, then restart the IDE. ` +
        `See docs/troubleshooting.md. (never blocks)`,
    }
  }

  if (stale_components.length > 0) {
    return {
      severity: 'normal',
      stale_components,
      hint:
        `This project's RSCT enforcement scripts are not the ones rsct-mcp v${m} ships — ` +
        `${stale_components.map(describe).join('; ')}. ` +
        `That usually just means the project has not been re-synced since an update; re-run /rsct-setup. (suggestion only)`,
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
