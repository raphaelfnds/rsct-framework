import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import {
  getInstallDriftNotice,
  readScriptEvidence,
  readScriptRegistration,
  type ScriptEvidence,
} from '../../src/lib/version-drift.js'

/**
 * The version axis is pure — it takes the `evidence` seam so these stay
 * filesystem-free. The component axis gets its own tmpdir-backed block below.
 *
 * `ev` defaults to the HEALTHY state on every field, so each fixture states only
 * the one thing it is about, and a new field on `ScriptEvidence` does not force
 * an edit to every literal in this file.
 */
const ev = (o: Partial<ScriptEvidence> & { name: string }): ScriptEvidence => ({
  state: 'current',
  security_relevant: true,
  stamp_version: null,
  registration: 'registered',
  ...o,
})

const NO_DRIFT: ScriptEvidence[] = [
  ev({ name: 'sanitize-permissions.js', stamp_version: '2.1.0' }),
  ev({ name: 'edit-scope-guard.js', stamp_version: '2.1.0' }),
]

function notice(
  projectVersion: string | null | undefined,
  mcpVersion: string,
  evidence: ScriptEvidence[] = NO_DRIFT,
) {
  return getInstallDriftNotice({
    projectRoot: '/nonexistent',
    projectVersion,
    mcpVersion,
    evidence,
  })
}

describe('getInstallDriftNotice — version axis', () => {
  it('fires when the binary is strictly newer than the project version', () => {
    const { hint, severity, affected_components } = notice('2.0.0', '2.1.0')
    expect(hint).not.toBeNull()
    expect(severity).toBe('normal')
    expect(affected_components).toEqual([])
    expect(hint).toContain('v2.0.0')
    expect(hint).toContain('v2.1.0')
    expect(hint).toContain('Re-run /rsct-setup')
    expect(hint).toContain('(suggestion only)')
  })

  it('pins the normal hint text byte-for-byte', () => {
    // Nothing else pins this string: the parity test in load-context.test.ts
    // compares the two call sites against EACH OTHER, so both could drift
    // together with a green suite. This is the anchor.
    expect(notice('2.0.0', '2.1.0').hint).toBe(
      'This project was set up with RSCT v2.0.0; the installed rsct-mcp is v2.1.0. ' +
        "Re-run /rsct-setup to apply the current version's rules/prompts to this project. (suggestion only)",
    )
  })

  it('is silent when versions are equal', () => {
    expect(notice('2.1.0', '2.1.0').hint).toBeNull()
  })

  it('is silent when the project is NEWER than the binary (reverse case — out of scope)', () => {
    expect(notice('2.2.0', '2.1.0').hint).toBeNull()
  })

  it('is silent on null / undefined / empty project version', () => {
    expect(notice(null, '2.1.0').hint).toBeNull()
    expect(notice(undefined, '2.1.0').hint).toBeNull()
    expect(notice('', '2.1.0').hint).toBeNull()
  })

  it('is silent on an unparseable project version (fail-safe via isNewer)', () => {
    for (const bad of ['garbage', '1.0', '2.x', 'latest', 'v1']) {
      expect(notice(bad, '2.1.0').hint).toBeNull()
    }
  })

  it('strips a hand-edited leading "v" in the text (no "vv")', () => {
    const { hint } = notice('v2.0.0', 'v2.1.0')
    expect(hint).not.toBeNull()
    expect(hint).toContain('v2.0.0')
    expect(hint).toContain('v2.1.0')
    expect(hint).not.toContain('vv')
  })

  it('handles a minor/patch drift (2.1.0 -> 2.1.1)', () => {
    expect(notice('2.1.0', '2.1.1').hint).toContain('v2.1.1')
  })
})

describe('getInstallDriftNotice — component axis', () => {
  const stale: ScriptEvidence[] = [
    ev({ name: 'sanitize-permissions.js', state: 'stale', stamp_version: '2.1.1' }),
    ...NO_DRIFT.slice(1),
  ]

  it('reports a differing enforcement script even when versions match — but does NOT call it security', () => {
    // The case the version axis structurally cannot see: `.rsct.json` and the
    // stamp both read the release version, so they agree while the body differs.
    // It is reported and the component is named — but a byte difference cannot
    // prove a fix is missing: these scripts are bundles, so an unrelated config
    // key changes them. Ranking it `security` would fire on every release for
    // every project, which is the failure this module exists to remove.
    const { severity, hint, affected_components } = notice('2.3.0', '2.3.0', stale)
    expect(severity).toBe('normal')
    expect(hint).not.toContain('SECURITY')
    expect(hint).toContain("sanitize-permissions.js differs from this binary's copy")
    expect(affected_components).toEqual([
      {
        name: 'sanitize-permissions.js',
        state: 'stale',
        stamp_version: '2.1.1',
        registration: 'registered',
      },
    ])
  })

  it('escalates an absent enforcement script — the only provable claim', () => {
    const absent: ScriptEvidence[] = [
      ev({ name: 'edit-scope-guard.js', state: 'absent' }),
      ...NO_DRIFT.slice(0, 1),
    ]
    const { severity, hint } = notice('2.3.0', '2.3.0', absent)
    expect(severity).toBe('security')
    expect(hint).toContain('edit-scope-guard.js is not installed')
  })

  it('does not escalate an unreadable script — absence of evidence is not evidence', () => {
    const unreadable: ScriptEvidence[] = [
      ev({ name: 'sanitize-permissions.js', state: 'unreadable' }),
      ...NO_DRIFT.slice(1),
    ]
    expect(notice('2.3.0', '2.3.0', unreadable).severity).toBe('normal')
    expect(notice('2.3.0', '2.3.0', unreadable).hint).toBeNull()
  })

  it('ignores a stale script that is not security-relevant', () => {
    const other: ScriptEvidence[] = [
      ev({ name: 'some-helper.js', state: 'stale', security_relevant: false }),
      ...NO_DRIFT,
    ]
    expect(notice('2.3.0', '2.3.0', other).severity).toBe('normal')
  })

  it('a differing script outranks the plain version notice, at normal severity', () => {
    const { severity, hint } = notice('2.1.1', '2.3.0', stale)
    expect(severity).toBe('normal')
    // Names the component instead of the generic "your version is behind" —
    // that specificity IS the ranking improvement at this tier.
    expect(hint).toContain('sanitize-permissions.js')
    expect(hint).not.toContain('was set up with RSCT')
  })

  it('an absent script outranks a merely differing one', () => {
    const mixed: ScriptEvidence[] = [
      ev({ name: 'sanitize-permissions.js', state: 'stale', stamp_version: '2.1.1' }),
      ev({ name: 'edit-scope-guard.js', state: 'absent' }),
    ]
    const { severity, hint, affected_components } = notice('2.3.0', '2.3.0', mixed)
    expect(severity).toBe('security')
    expect(hint).toContain('edit-scope-guard.js is not installed')
    // The security message speaks only about what is provably not running...
    expect(hint).not.toContain('sanitize-permissions.js')
    // ...but both components stay in the structured payload for the audit trail.
    expect(affected_components).toHaveLength(2)
  })
})

describe('getInstallDriftNotice — registration axis (#24)', () => {
  const unregistered = (name: string, over: Partial<ScriptEvidence> = {}): ScriptEvidence[] => [
    ev({ name, registration: 'unregistered', ...over }),
    ...NO_DRIFT.filter((e) => e.name !== name),
  ]

  it('escalates a present, byte-current, UNREGISTERED script — the state #16 read as healthy', () => {
    const { severity, hint, affected_components } = notice(
      '2.3.0',
      '2.3.0',
      unregistered('edit-scope-guard.js'),
    )
    expect(severity).toBe('security')
    // Wording distinct from "is not installed": the file IS there.
    expect(hint).toContain('edit-scope-guard.js is installed, but no PreToolUse entry')
    expect(hint).not.toContain('edit-scope-guard.js is not installed')
    expect(affected_components).toEqual([
      {
        name: 'edit-scope-guard.js',
        state: 'current',
        stamp_version: null,
        registration: 'unregistered',
      },
    ])
  })

  it('names the canonical event of each script, not a generic one', () => {
    expect(notice('2.3.0', '2.3.0', unregistered('sanitize-permissions.js')).hint).toContain(
      'sanitize-permissions.js is installed, but no SessionStart entry',
    )
  })

  it('claims only what was searched — never that the machine has no such hook', () => {
    const { hint } = notice('2.3.0', '2.3.0', unregistered('edit-scope-guard.js'))
    // A user-level or enterprise hook is invisible here (lib/claude-settings.ts),
    // so the sentence must name the files that were read.
    expect(hint).toContain("this project's .claude/settings.json or .claude/settings.local.json")
  })

  it('does NOT escalate an unregistered script we could not read — two non-evidences are not evidence', () => {
    // The dangerous cell: under vitest the shipped dir does not resolve, so every
    // script reads `unreadable`. Escalating on registration alone would have made
    // "I could not look" a security claim.
    const { severity, hint } = notice(
      '2.3.0',
      '2.3.0',
      unregistered('edit-scope-guard.js', { state: 'unreadable' }),
    )
    expect(severity).toBe('normal')
    expect(hint).toBeNull()
  })

  it('stays silent when registration is unknown — no readable settings, no verdict', () => {
    const { severity, hint } = notice('2.3.0', '2.3.0', [
      ev({ name: 'edit-scope-guard.js', registration: 'unknown' }),
      ...NO_DRIFT.slice(0, 1),
    ])
    expect(severity).toBe('normal')
    expect(hint).toBeNull()
  })

  it('ignores an unregistered script that is not security-relevant', () => {
    const { severity } = notice('2.3.0', '2.3.0', [
      ev({ name: 'some-helper.js', security_relevant: false, registration: 'unregistered' }),
      ...NO_DRIFT,
    ])
    expect(severity).toBe('normal')
  })

  it('reports absence and non-registration in ONE hint when both are true of a project', () => {
    // Reachable and previously silent on half of it: the old branch filtered to
    // absent and dropped the unwired component from the message entirely.
    const { severity, hint } = notice('2.3.0', '2.3.0', [
      ev({ name: 'sanitize-permissions.js', state: 'absent' }),
      ev({ name: 'edit-scope-guard.js', registration: 'unregistered' }),
    ])
    expect(severity).toBe('security')
    expect(hint).toContain('sanitize-permissions.js is not installed')
    expect(hint).toContain('edit-scope-guard.js is installed, but no PreToolUse entry')
  })

  it('says a script is missing ONCE when it is both absent and unregistered', () => {
    const { hint } = notice('2.3.0', '2.3.0', [
      ev({ name: 'edit-scope-guard.js', state: 'absent', registration: 'unregistered' }),
      ...NO_DRIFT.slice(0, 1),
    ])
    expect(hint).toContain('edit-scope-guard.js is not installed')
    // Absence subsumes non-registration — one fact, one sentence.
    expect(hint).not.toContain('edit-scope-guard.js is installed')
  })

  it('leads with non-registration for a script that is both stale and unwired', () => {
    const { severity, hint } = notice('2.3.0', '2.3.0', [
      ev({ name: 'edit-scope-guard.js', state: 'stale', registration: 'unregistered' }),
      ...NO_DRIFT.slice(0, 1),
    ])
    expect(severity).toBe('security')
    expect(hint).toContain('edit-scope-guard.js is installed, but no PreToolUse entry')
    // "differs" never appears at the security tier — it cannot prove anything.
    expect(hint).not.toContain('differs from')
  })

  it('pins the security hint text byte-for-byte', () => {
    expect(notice('2.1.1', '2.3.0', unregistered('edit-scope-guard.js')).hint).toBe(
      '⚠ SECURITY: RSCT enforcement is not running in this project — edit-scope-guard.js is ' +
        'installed, but no PreToolUse entry pointing at it was found in this project\'s ' +
        '.claude/settings.json or .claude/settings.local.json. ' +
        'Run /rsct-setup to repair it, then restart the IDE. ' +
        'See docs/troubleshooting.md. (never blocks)',
    )
  })
})

describe('readScriptEvidence', () => {
  const dirs: string[] = []

  function sandbox(): { root: string; installed: string; shipped: string } {
    const root = mkdtempSync(join(tmpdir(), 'rsct-drift-'))
    dirs.push(root)
    const installed = join(root, '.rsct', 'scripts')
    const shipped = join(root, 'shipped')
    mkdirSync(installed, { recursive: true })
    mkdirSync(shipped, { recursive: true })
    return { root, installed, shipped }
  }

  const BODY = "import { x } from 'y'\nconst a = 1\n"
  const ship = (b = BODY): string => `#!/usr/bin/env node\n${b}`
  const install = (v: string, b = BODY): string =>
    `#!/usr/bin/env node\n// rsct-mcp v=${v} — installed by /rsct-setup\n${b}`

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function evidenceFor(name: string, ev: ScriptEvidence[]): ScriptEvidence {
    const found = ev.find((e) => e.name === name)
    if (!found) throw new Error(`no evidence for ${name}`)
    return found
  }

  it('reports current when the installed body matches the shipped body', () => {
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'sanitize-permissions.js'), install('2.3.0'))
    writeFileSync(join(shipped, 'sanitize-permissions.js'), ship())
    const e = evidenceFor('sanitize-permissions.js', readScriptEvidence(root, shipped))
    expect(e.state).toBe('current')
    expect(e.stamp_version).toBe('2.3.0')
    expect(e.security_relevant).toBe(true)
  })

  it('reports stale when the bodies differ, regardless of a matching stamp', () => {
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'sanitize-permissions.js'), install('2.3.0', 'const a = 1\n'))
    writeFileSync(join(shipped, 'sanitize-permissions.js'), ship('const a = 2\n'))
    expect(evidenceFor('sanitize-permissions.js', readScriptEvidence(root, shipped)).state).toBe(
      'stale',
    )
  })

  it('treats a CRLF-materialized install as current (Windows autocrlf checkout)', () => {
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'sanitize-permissions.js'), install('2.3.0').replace(/\n/g, '\r\n'))
    writeFileSync(join(shipped, 'sanitize-permissions.js'), ship())
    expect(evidenceFor('sanitize-permissions.js', readScriptEvidence(root, shipped)).state).toBe(
      'current',
    )
  })

  it('compares the body, so an unstamped legacy copy with identical code is current', () => {
    // Pre-stamp installs carry the source body from line 2, so line 2 must only
    // be dropped when it actually is a stamp. Both files hold the SAME body here
    // — a rigged shorter fixture would make this pass without testing anything.
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'sanitize-permissions.js'), `#!/usr/bin/env node\n${BODY}`)
    writeFileSync(join(shipped, 'sanitize-permissions.js'), ship())
    const e = evidenceFor('sanitize-permissions.js', readScriptEvidence(root, shipped))
    expect(e.stamp_version).toBeNull()
    expect(e.state).toBe('current')
  })

  it('ignores a trailing-newline difference — the installer adds one, the bundler does not', () => {
    // The shipped bundle ends at its sourceMappingURL with no terminating
    // newline; setup builds the file in `$( … )` (which strips them) and writes
    // it with `printf '%s\n'`. Comparing raw would call every healthy install
    // stale. This is the exact one-byte divergence the real artifacts have.
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'sanitize-permissions.js'), install('2.3.0', 'const a = 1\n'))
    writeFileSync(join(shipped, 'sanitize-permissions.js'), '#!/usr/bin/env node\nconst a = 1')
    expect(evidenceFor('sanitize-permissions.js', readScriptEvidence(root, shipped)).state).toBe(
      'current',
    )
  })

  it('reports stale when a body is empty on either side — never fail open', () => {
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'sanitize-permissions.js'), '')
    writeFileSync(join(shipped, 'sanitize-permissions.js'), ship())
    expect(evidenceFor('sanitize-permissions.js', readScriptEvidence(root, shipped)).state).toBe(
      'stale',
    )
  })

  it('reports unreadable — not absent — when the scripts dir cannot be listed', () => {
    // ENOTDIR here; EACCES and a stalled UNC share take the same path. "Could not
    // look" must never be reported as "is not installed", which would escalate.
    const root = mkdtempSync(join(tmpdir(), 'rsct-drift-'))
    dirs.push(root)
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(join(root, '.rsct', 'scripts'), 'not a directory\n')
    const ev = readScriptEvidence(root, null)
    expect(ev.every((e) => e.state === 'unreadable')).toBe(true)
  })

  it('returns [] for a non-string project root rather than throwing', () => {
    expect(readScriptEvidence(undefined as unknown as string)).toEqual([])
    expect(readScriptEvidence('')).toEqual([])
  })

  it('reads v=unknown as no stamp without affecting the verdict', () => {
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'sanitize-permissions.js'), install('unknown'))
    writeFileSync(join(shipped, 'sanitize-permissions.js'), ship())
    const e = evidenceFor('sanitize-permissions.js', readScriptEvidence(root, shipped))
    expect(e.stamp_version).toBeNull()
    expect(e.state).toBe('current')
  })

  it('does not read a stamp-shaped fragment from elsewhere on the line', () => {
    const { root, installed, shipped } = sandbox()
    writeFileSync(
      join(installed, 'sanitize-permissions.js'),
      `#!/usr/bin/env node\nconst url = 'https://x/?v=1.2.3'\n${BODY}`,
    )
    writeFileSync(join(shipped, 'sanitize-permissions.js'), ship())
    expect(
      evidenceFor('sanitize-permissions.js', readScriptEvidence(root, shipped)).stamp_version,
    ).toBeNull()
  })

  it('reports absent for a security-relevant script the directory does not hold', () => {
    const { root, shipped } = sandbox()
    const ev = readScriptEvidence(root, shipped)
    expect(evidenceFor('sanitize-permissions.js', ev).state).toBe('absent')
    expect(evidenceFor('edit-scope-guard.js', ev).state).toBe('absent')
  })

  it('reports absent for both when .rsct/scripts does not exist at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'rsct-drift-'))
    dirs.push(root)
    const ev = readScriptEvidence(root, null)
    expect(ev).toHaveLength(2)
    expect(ev.every((e) => e.state === 'absent')).toBe(true)
  })

  it('reports unreadable when the shipped reference cannot be resolved', () => {
    const { root, installed } = sandbox()
    writeFileSync(join(installed, 'sanitize-permissions.js'), install('2.3.0'))
    const e = evidenceFor('sanitize-permissions.js', readScriptEvidence(root, null))
    expect(e.state).toBe('unreadable')
    expect(e.stamp_version).toBe('2.3.0')
  })

  it('ignores non-.js entries such as the ESM-pinning package.json', () => {
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'package.json'), '{ "type": "module" }\n')
    const ev = readScriptEvidence(root, shipped)
    expect(ev.some((e) => e.name === 'package.json')).toBe(false)
  })

  it('picks up an unknown installed script without classifying it as security-relevant', () => {
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'future-hook.js'), install('2.3.0'))
    writeFileSync(join(shipped, 'future-hook.js'), ship())
    const e = evidenceFor('future-hook.js', readScriptEvidence(root, shipped))
    expect(e.state).toBe('current')
    expect(e.security_relevant).toBe(false)
  })

  it('never throws on a directory it cannot read', () => {
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'sanitize-permissions.js'), install('2.3.0'))
    try {
      chmodSync(join(installed, 'sanitize-permissions.js'), 0o000)
    } catch {
      /* chmod is a no-op on some Windows setups — the assertion below still holds */
    }
    expect(() => readScriptEvidence(root, shipped)).not.toThrow()
  })
})

/**
 * The regression guard for the defect the synthetic fixtures could not see: the
 * comparison must hold against the ACTUAL shipped artifacts, installed the way
 * `/rsct-setup` Phase 4.V.b installs them. The whole feature is wrong if this
 * fails — every healthy project would report a security escalation.
 */
/**
 * Registration, read from REAL settings files on disk. Every case here writes
 * JSON text and lets the production reader parse it: a hand-built object literal
 * would only prove the matcher agrees with itself, and would stay green if the
 * parsing, the BOM handling or the separator folding broke.
 */
describe('readScriptRegistration — file-backed (#24)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** Writes real files; `undefined` content means "do not create this file". */
  function project(files: { settings?: string; local?: string }): string {
    const root = mkdtempSync(join(tmpdir(), 'rsct-reg-'))
    dirs.push(root)
    mkdirSync(join(root, '.claude'), { recursive: true })
    if (files.settings !== undefined) {
      writeFileSync(join(root, '.claude', 'settings.json'), files.settings)
    }
    if (files.local !== undefined) {
      writeFileSync(join(root, '.claude', 'settings.local.json'), files.local)
    }
    return root
  }

  /** The exact shape `/rsct-setup` Phase 4.V.c / 4.V.d writes. */
  const withHook = (event: string, command: string, extra: object = {}): string =>
    JSON.stringify({ hooks: { [event]: [{ ...extra, hooks: [{ type: 'command', command }] }] } }, null, 2) +
    '\n'

  const GUARD_CMD = 'node ${CLAUDE_PROJECT_DIR}/.rsct/scripts/edit-scope-guard.js'
  const SANITIZE_CMD = 'node ${CLAUDE_PROJECT_DIR}/.rsct/scripts/sanitize-permissions.js'

  it('recognizes the hook entry setup writes', () => {
    const root = project({
      settings: withHook('PreToolUse', GUARD_CMD, { matcher: '^(Edit|Write|MultiEdit|NotebookEdit)$' }),
    })
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('registered')
  })

  it('reports unregistered when the file parses but holds no matching entry', () => {
    expect(readScriptRegistration(project({ settings: '{"permissions":{"allow":[]}}\n' }), 'edit-scope-guard.js')).toBe(
      'unregistered',
    )
  })

  it('requires the CANONICAL event — a sanitizer wired under PreToolUse does not run at boot', () => {
    const root = project({ settings: withHook('PreToolUse', SANITIZE_CMD) })
    expect(readScriptRegistration(root, 'sanitize-permissions.js')).toBe('unregistered')
  })

  it('does not accept an entry pointing at a DIFFERENT script', () => {
    const root = project({ settings: withHook('PreToolUse', GUARD_CMD) })
    expect(readScriptRegistration(root, 'sanitize-permissions.js')).toBe('unregistered')
  })

  it('accepts an entry a dev moved into settings.local.json — there it still runs', () => {
    const root = project({ settings: '{}\n', local: withHook('SessionStart', SANITIZE_CMD) })
    expect(readScriptRegistration(root, 'sanitize-permissions.js')).toBe('registered')
  })

  it('tolerates backslash separators — a hand-written Windows path still runs', () => {
    // Written as JSON text with escaped backslashes, exactly as the file holds
    // them. Without folding, this is a false SECURITY claim about a live hook.
    const root = project({
      settings: withHook('PreToolUse', 'node C:\\proj\\.rsct\\scripts\\edit-scope-guard.js'),
    })
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('registered')
  })

  it('does NOT see through a UTF-8 BOM — no RSCT surface can read that file', () => {
    // Tempting to strip it. But `src/scripts/sanitize-permissions.ts` and all
    // five bash blocks parse raw, so on a BOM-prefixed file the sanitizer aborts
    // and enforcement genuinely is not running. A lenient read here would find
    // the hook and report healthy — the exact false-healthy #24 closes,
    // reintroduced by its own fix. `unknown` is the wrong answer, safe direction.
    const root = project({ settings: '\uFEFF' + withHook('PreToolUse', GUARD_CMD) })
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('unknown')
  })

  it('reads a CRLF settings file identically', () => {
    // Documentation, not coverage: JSON forbids a literal CR inside a string, so
    // the carriage return never reaches the command value and no code here is
    // CRLF-sensitive. Kept so nobody bolts a readNormalized onto this path.
    const root = project({ settings: withHook('PreToolUse', GUARD_CMD).replace(/\n/g, '\r\n') })
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('registered')
  })

  it('reports unregistered when NO settings file exists — the fresh-clone case', () => {
    // A file that is not there holds no hook. Issue #24 names this cause
    // explicitly, and `.claude/settings.json` is exactly the file a project
    // forgets to commit while `.rsct/scripts/` rides along tracked.
    const root = mkdtempSync(join(tmpdir(), 'rsct-reg-'))
    dirs.push(root)
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('unregistered')
  })

  it('is unknown when the settings file is malformed — a trailing comma is not a security event', () => {
    expect(readScriptRegistration(project({ settings: '{"hooks":{},}\n' }), 'edit-scope-guard.js')).toBe('unknown')
  })

  it('still finds the hook when settings.json is malformed but the local file carries it', () => {
    const root = project({ settings: '{ broken', local: withHook('PreToolUse', GUARD_CMD) })
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('registered')
  })

  it('is unknown — never unregistered — when one file is unreadable and the other lacks the hook', () => {
    // The dangerous mirror of the case above: settings.json unparseable, the
    // local file parses and holds nothing. Claiming "not found in settings.json
    // or settings.local.json" would name a file that was never searched — and
    // that is where /rsct-setup writes, so it is where the hook most likely is.
    const root = project({ settings: '{ broken', local: '{"permissions":{"allow":[]}}\n' })
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('unknown')
  })

  it('is unregistered when one file is absent and the other parses without the hook', () => {
    // Absent is evidence; only unreadable/malformed is a gap in it.
    const root = project({ local: '{"permissions":{"allow":[]}}\n' })
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('unregistered')
  })

  it('is unknown for a script with no canonical event — there is no question to answer', () => {
    expect(readScriptRegistration(project({ settings: '{}\n' }), 'future-hook.js')).toBe('unknown')
  })

  it('never throws on a settings file of the wrong shape', () => {
    for (const body of ['null', '[]', '"a string"', '{"hooks":[]}', '{"hooks":{"PreToolUse":{}}}', '{"hooks":{"PreToolUse":[null,{"hooks":"x"}]}}']) {
      expect(readScriptRegistration(project({ settings: body }), 'edit-scope-guard.js')).toBe('unregistered')
    }
  })

  it('flows into readScriptEvidence, so a current script can still be reported unwired', () => {
    const root = project({ settings: '{}\n' })
    const installed = join(root, '.rsct', 'scripts')
    const shipped = join(root, 'shipped')
    mkdirSync(installed, { recursive: true })
    mkdirSync(shipped, { recursive: true })
    const body = "const a = 1\n"
    writeFileSync(join(installed, 'edit-scope-guard.js'), `#!/usr/bin/env node\n// rsct-mcp v=2.3.0 — installed by /rsct-setup\n${body}`)
    writeFileSync(join(shipped, 'edit-scope-guard.js'), `#!/usr/bin/env node\n${body}`)
    const e = readScriptEvidence(root, shipped).find((x) => x.name === 'edit-scope-guard.js')
    expect(e?.state).toBe('current')
    expect(e?.registration).toBe('unregistered')
  })
})

describe('readScriptEvidence — against the real dist/scripts artifacts', () => {
  const DIST = resolve(__dirname, '..', '..', 'dist', 'scripts')
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('reports current for a faithful reproduction of the installer output', () => {
    const root = mkdtempSync(join(tmpdir(), 'rsct-drift-real-'))
    dirs.push(root)
    const installed = join(root, '.rsct', 'scripts')
    mkdirSync(installed, { recursive: true })
    // A faithful reproduction includes the hooks: Phase 4.V.c/4.V.d always write
    // them alongside the scripts. Without this the project would be a healthy
    // install with no wiring — a real `security` state, and this test would be
    // asserting the wrong axis.
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.rsct/scripts/sanitize-permissions.js' }] },
            ],
            PreToolUse: [
              {
                matcher: '^(Edit|Write|MultiEdit|NotebookEdit)$',
                hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.rsct/scripts/edit-scope-guard.js' }],
              },
            ],
          },
        },
        null,
        2,
      ) + '\n',
    )

    for (const name of ['sanitize-permissions.js', 'edit-scope-guard.js']) {
      const shippedText = readFileSync(join(DIST, name), 'utf8')
      // Phase 4.V.b: shebang, stamp, then `tail -n +2` of the source — built in
      // `$( … )` (strips trailing newlines) and written with `printf '%s\n'`.
      const body = shippedText.split('\n').slice(1).join('\n').replace(/\n+$/, '')
      writeFileSync(
        join(installed, name),
        `#!/usr/bin/env node\n// rsct-mcp v=9.9.9 — installed by /rsct-setup\n${body}\n`,
      )
    }

    const ev = readScriptEvidence(root, DIST)
    for (const e of ev) {
      expect(`${e.name}=${e.state}`).toBe(`${e.name}=current`)
    }
    expect(
      getInstallDriftNotice({
        projectRoot: root,
        projectVersion: '9.9.9',
        mcpVersion: '9.9.9',
        evidence: ev,
      }).severity,
    ).toBe('normal')
  })

  it('detects a real tampered install', () => {
    const root = mkdtempSync(join(tmpdir(), 'rsct-drift-real-'))
    dirs.push(root)
    const installed = join(root, '.rsct', 'scripts')
    mkdirSync(installed, { recursive: true })
    const shippedText = readFileSync(join(DIST, 'sanitize-permissions.js'), 'utf8')
    const body = shippedText.split('\n').slice(1).join('\n').replace(/\n+$/, '')
    writeFileSync(
      join(installed, 'sanitize-permissions.js'),
      `#!/usr/bin/env node\n// rsct-mcp v=9.9.9 — installed by /rsct-setup\n${body}\n// tampered\n`,
    )
    const ev = readScriptEvidence(root, DIST)
    expect(ev.find((e) => e.name === 'sanitize-permissions.js')?.state).toBe('stale')
  })
})
