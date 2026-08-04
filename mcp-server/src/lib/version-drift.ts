import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PROJECT_SETTINGS_FILES,
  readClaudeSettings,
  type SettingsFile,
} from './claude-settings.js'
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
 * **Component axis.** Is the enforcement actually running? That is two
 * questions, not one — a script under `.rsct/scripts/` only does something if
 * its hook is REGISTERED in `.claude/settings.json`. A byte-perfect script whose
 * hook entry was lost enforces exactly nothing, and until #24 this module
 * reported that state as healthy.
 *
 * Two states escalate to `security`, and they make the same claim:
 *
 *  - **absent** — the script is not there, so that enforcement is simply not
 *    running. Unambiguous, locally provable, and rare.
 *  - **unregistered** — the script is there, but no hook entry in this project's
 *    settings points at it. Same consequence: nothing runs. Arguably worse than
 *    absent, because the file sitting on disk reads as installed.
 *
 * One state deliberately does NOT escalate:
 *
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
 * Registration is evidence about a DIFFERENT file, with a different failure
 * mode, so it is gated on the script's own state: `unregistered` escalates only
 * for a script we could actually see (`current` or `stale`). An `unreadable`
 * script that also looks unregistered escalates on neither axis — two pieces of
 * non-evidence do not add up to a security claim.
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
 * This is a LOCAL comparison — no network, no cache, and nothing the dev can turn
 * off, because nothing leaves the machine. It is deliberately separate from
 * `update-check.ts` (which asks GitHub for the latest release; since #38 that one
 * consults by default but is switchable off, per-machine, and per release). Merging
 * them would put a check that MUST always run behind a switch that MUST be
 * respectable — the two are complementary and independent axes.
 *
 * Always fail-safe and SUGGEST-ONLY: absence of evidence is never escalated. An
 * unreadable script, an unresolvable shipped reference, a null/absent/unparseable
 * `rsct_version`, an equal version, or a project NEWER than the binary all
 * degrade quietly. `isNewer` returns false on anything it can't parse, so a
 * malformed value never produces a false "update available".
 */

/** Claude Code hook events `/rsct-setup` registers enforcement scripts under. */
type HookEvent = 'SessionStart' | 'PreToolUse'

interface EnforcementScript {
  /** Event the script must be wired under to do its job. */
  event: HookEvent
  /**
   * The substring keyed on to recognize a hook entry. Stored LITERALLY rather
   * than derived from the name: `prompts/01-setup.md` (4.V.c :3106, 4.V.d :3187)
   * and `prompts/03-uninstall.md` (:211, :603, :676) hardcode this exact string,
   * and a derivation here would be a fourth copy of the contract that no test
   * can see. `tests/bash/block-smoke.test.ts` runs the real prompt blocks and
   * feeds their output back through `readScriptRegistration`, which keeps all
   * three surfaces from desynchronizing.
   */
  marker: string
}

/**
 * The scripts whose absence — or whose missing hook — is a live enforcement
 * hole rather than a cosmetic lag. A `Map`, not an object literal: names come
 * from `readdirSync`, and `'constructor' in {}` is true.
 */
const ENFORCEMENT_SCRIPTS: ReadonlyMap<string, EnforcementScript> = new Map([
  [
    'sanitize-permissions.js',
    { event: 'SessionStart', marker: '.rsct/scripts/sanitize-permissions.js' },
  ],
  ['edit-scope-guard.js', { event: 'PreToolUse', marker: '.rsct/scripts/edit-scope-guard.js' }],
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

/**
 * A three-state answer, not `boolean | null`: `null` would have to carry both
 * "the settings could not be read" and "this script has no canonical event to be
 * wired under" (enumeration is data-driven, so rows exist for scripts this
 * module knows nothing about). Two facts, one representation, is the overload
 * this module's docstring spends its length refusing.
 */
export type RegistrationState = 'registered' | 'unregistered' | 'unknown'

export interface ScriptEvidence {
  name: string
  state: ScriptState
  security_relevant: boolean
  /** Line-2 stamp when present and parseable. Never drives the verdict. */
  stamp_version: string | null
  /** Whether a hook entry in this project's settings points at this script. */
  registration: RegistrationState
}

/**
 * A component the notice speaks about. Renamed from `StaleComponent` in #24: it
 * now carries entries whose own `state` reads `current` (present, unregistered),
 * so a field named "stale" would have been self-contradictory — and this shape
 * is persisted verbatim into the `install.drift_detected` audit payload
 * (`tools/load-context.ts`, `tools/request-commit.ts`), which makes it a record
 * someone reads back later, not just an in-memory type.
 */
export interface AffectedComponent {
  name: string
  state: ScriptState
  stamp_version: string | null
  registration: RegistrationState
}

export interface InstallDriftNotice {
  hint: string | null
  severity: DriftSeverity
  affected_components: AffectedComponent[]
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
 * Every `command` string under `hooks.<event>[].hooks[]`, mirroring exactly the
 * shape `/rsct-setup` writes and `/rsct-uninstall` scrubs. Anything that is not
 * that shape yields nothing rather than throwing — this runs against a file a
 * human edits freely.
 */
function hookCommands(data: unknown, event: HookEvent): string[] {
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null

  const groups = asRecord(asRecord(data)?.hooks)?.[event]
  if (!Array.isArray(groups)) return []

  const commands: string[] = []
  for (const group of groups) {
    const inner = asRecord(group)?.hooks
    if (!Array.isArray(inner)) continue
    for (const entry of inner) {
      const command = asRecord(entry)?.command
      if (typeof command === 'string') commands.push(command)
    }
  }
  return commands
}

/**
 * Whether a hook entry points at this script, decided across the project-scope
 * settings files. The rule keys on whether the evidence is COMPLETE, not on
 * whether any single file happened to parse:
 *
 *  - a marker match under the canonical event, in any file → `registered`
 *  - no match, and every candidate was either parsed or provably absent →
 *    `unregistered`. An absent file holds no hook; that is a fact, the same way
 *    an absent `.rsct/scripts` directory is positive evidence below. This is the
 *    issue's own "fresh clone where the file was never committed" case, and
 *    treating it as no-evidence would leave #24 open on it.
 *  - anything else — a file we could not read or could not parse → `unknown`.
 *    A gap anywhere makes the whole answer a guess: the hook is most likely IN
 *    the file we could not read, since that is where `/rsct-setup` writes it.
 *    Reporting `unregistered` here would name files we never searched, in a
 *    message whose entire value is that it only claims what it observed.
 *
 * The event is required, not incidental: a sanitizer wired under `PreToolUse`
 * does not run at session start, and reporting that as registered would be the
 * same false-healthy answer #24 exists to close.
 *
 * Backslashes are folded to `/` on the PARSED command before matching. Setup
 * always writes forward slashes, so this only matters for a hand-edited Windows
 * path — where the hook genuinely runs, and a miss would produce a false
 * `security` claim. The bash side does not normalize, because it only ever
 * inspects what it wrote; that asymmetry is intentional, and the TS side being
 * strictly more permissive is the safe direction. Do NOT "fix" the prompts to
 * match.
 */
function readRegistration(settings: SettingsFile[], script: EnforcementScript): RegistrationState {
  // No candidates at all (an empty project root) is a gap, not proof.
  if (settings.length === 0) return 'unknown'

  let complete = true
  for (const file of settings) {
    if (file.status === 'absent') continue
    if (file.status !== 'ok') {
      complete = false
      continue
    }
    for (const command of hookCommands(file.data, script.event)) {
      if (command.replace(/\\/g, '/').includes(script.marker)) return 'registered'
    }
  }
  return complete ? 'unregistered' : 'unknown'
}

/**
 * Registration of one script by name, reading the project's settings directly.
 * Convenience for callers that hold a project root rather than parsed settings —
 * notably `tests/bash/block-smoke.test.ts`, which runs the REAL setup block and
 * asks THIS function whether the file bash just wrote is recognized. A script
 * with no canonical event is `unknown`: there is no question to answer.
 */
export function readScriptRegistration(projectRoot: string, name: string): RegistrationState {
  const script = ENFORCEMENT_SCRIPTS.get(name)
  if (!script) return 'unknown'
  return readRegistration(readClaudeSettings(projectRoot), script)
}

/**
 * Compare every `.js` under `<projectRoot>/.rsct/scripts` against the copy this
 * binary ships, and check whether each known script's hook is registered.
 * Enumeration is data-driven, so a script a future setup installs is picked up
 * without a change here; only `ENFORCEMENT_SCRIPTS` is hand-maintained. Its
 * names are always reported even when the directory does not list them — an
 * absent enforcement script is the loudest state, not a silent one.
 *
 * The settings files are read ONCE for the whole sweep, not per script.
 *
 * Never throws. `shippedDir` is a test seam; registration deliberately has none —
 * it reads `<projectRoot>/.claude/`, so a test that builds a project root
 * already controls it, and a real file is better evidence than an injected
 * object.
 */
export function readScriptEvidence(
  projectRoot: string,
  shippedDir: string | null = shippedScriptsDir(),
): ScriptEvidence[] {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return []
  const installedDir = join(projectRoot, '.rsct', 'scripts')
  const settings = readClaudeSettings(projectRoot)
  const registrationOf = (name: string): RegistrationState => {
    const script = ENFORCEMENT_SCRIPTS.get(name)
    return script ? readRegistration(settings, script) : 'unknown'
  }

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

  const names = [...new Set([...entries, ...ENFORCEMENT_SCRIPTS.keys()])].sort()
  const evidence: ScriptEvidence[] = []

  for (const name of names) {
    const security_relevant = ENFORCEMENT_SCRIPTS.has(name)
    // Reported for every known script regardless of its file state: an entry
    // left behind after someone deleted `.rsct/scripts/` is a different
    // diagnosis from an entry that was never written, and the audit log should
    // be able to tell them apart. Which fact the HINT leads with is decided in
    // `getInstallDriftNotice`, not here.
    const registration = registrationOf(name)

    if (!entries.includes(name)) {
      evidence.push({
        name,
        state: listed ? 'absent' : 'unreadable',
        security_relevant,
        stamp_version: null,
        registration,
      })
      continue
    }

    const installed = readNormalized(join(installedDir, name))
    if (installed === null) {
      evidence.push({
        name,
        state: 'unreadable',
        security_relevant,
        stamp_version: null,
        registration,
      })
      continue
    }

    const stamp_version = stampOf(installed)
    const shipped = shippedDir === null ? null : readNormalized(join(shippedDir, name))
    if (shipped === null) {
      // No reference to compare against — no evidence, so no verdict.
      evidence.push({ name, state: 'unreadable', security_relevant, stamp_version, registration })
      continue
    }

    const a = installedBody(installed)
    const b = shippedBody(shipped)
    // An empty body on either side means the file was truncated or wiped. Two
    // empty bodies would compare equal and read as `current` — a fail-OPEN in
    // exactly the case the check exists to catch, so require a real body.
    const state: ScriptState = a.length === 0 || b.length === 0 ? 'stale' : a === b ? 'current' : 'stale'
    evidence.push({ name, state, security_relevant, stamp_version, registration })
  }

  return evidence
}

/**
 * Why this component is not running. `absent` wins over `unregistered` — an
 * absent script is always unregistered too, and saying both would be one fact
 * dressed as two.
 *
 * The registration sentence names the FILES that were searched rather than
 * asserting "your hook is not registered": a hook declared at user or enterprise
 * level is invisible to this check (see `lib/claude-settings.ts`), so the only
 * honest claim is about what was looked at.
 */
function describeNotRunning(c: AffectedComponent): string {
  if (c.state === 'absent') return `${c.name} is not installed`
  const event = ENFORCEMENT_SCRIPTS.get(c.name)?.event
  // Derived from the reader's own list rather than retyped: the sentence names
  // the files that were searched, so it must not be able to name a different set
  // from the one actually read.
  const searched = PROJECT_SETTINGS_FILES.map((f) => `.claude/${f}`).join(' or ')
  return (
    `${c.name} is installed, but no ${event ?? 'hook'} entry pointing at it was found in ` +
    `this project's ${searched}`
  )
}

function describeStale(c: AffectedComponent): string {
  // "differs from", never "outdated": `.rsct/scripts/` is committed, so a
  // teammate on an older binary can legitimately hold a NEWER script, and this
  // comparison has no direction.
  const at = c.stamp_version ? ` (installed at v${c.stamp_version})` : ''
  return `${c.name} differs from this binary's copy${at}`
}

/**
 * Enforcement this project is provably not getting: the script is not there, or
 * it is there and nothing is wired to run it. `unreadable` is excluded on both
 * counts — a script we could not read, or settings we could not parse, is
 * absence of evidence, and this tier only carries claims that were observed.
 */
function isNotRunning(e: ScriptEvidence): boolean {
  if (e.state === 'absent') return true
  if (e.state === 'current' || e.state === 'stale') return e.registration === 'unregistered'
  return false
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

  const toComponent = (e: ScriptEvidence): AffectedComponent => ({
    name: e.name,
    state: e.state,
    stamp_version: e.stamp_version,
    registration: e.registration,
  })

  const relevant = evidence.filter((e) => e.security_relevant)
  const notRunning = relevant.filter(isNotRunning).map(toComponent)
  // Everything the notice speaks about, in evidence order: what is not running,
  // plus what merely differs.
  const affected_components: AffectedComponent[] = relevant
    .filter((e) => isNotRunning(e) || e.state === 'stale')
    .map(toComponent)

  // Strip a hand-edited leading `v` in the DISPLAY text (the compare in isNewer
  // already normalizes it). `.rsct.json` `rsct_version` is schema-typed as a
  // free string, so `"v2.0.0"` is possible — avoid rendering "vv2.0.0".
  const m = mcpVersion.replace(/^v/, '')

  // Absent or unregistered — see the module docstring for why "differs" cannot
  // join them. The message asserts exactly what was observed, and names EVERY
  // component that is not running: a project can have one script missing and
  // another one merely unwired, and reporting only the first would leave the
  // second to be discovered the hard way.
  if (notRunning.length > 0) {
    return {
      severity: 'security',
      affected_components,
      hint:
        `⚠ SECURITY: RSCT enforcement is not running in this project — ` +
        `${notRunning.map(describeNotRunning).join('; ')}. ` +
        `Run /rsct-setup to repair it, then restart the IDE. ` +
        `See docs/troubleshooting.md. (never blocks)`,
    }
  }

  if (affected_components.length > 0) {
    return {
      severity: 'normal',
      affected_components,
      hint:
        `This project's RSCT enforcement scripts are not the ones rsct-mcp v${m} ships — ` +
        `${affected_components.map(describeStale).join('; ')}. ` +
        `That usually just means the project has not been re-synced since an update; re-run /rsct-setup. (suggestion only)`,
    }
  }

  if (!projectVersion) return { hint: null, severity: 'normal', affected_components: [] }
  if (!isNewer(mcpVersion, projectVersion))
    return { hint: null, severity: 'normal', affected_components: [] }

  const p = projectVersion.replace(/^v/, '')
  return {
    severity: 'normal',
    affected_components: [],
    hint:
      `This project was set up with RSCT v${p}; the installed rsct-mcp is v${m}. ` +
      `Re-run /rsct-setup to apply the current version's rules/prompts to this project. (suggestion only)`,
  }
}
