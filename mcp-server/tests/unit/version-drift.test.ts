import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import {
  EDIT_GUARD_HOOK,
  TERMINAL_GUARD_HOOK,
  getInstallDriftNotice,
  readScriptEvidence,
  readScriptRegistration,
  type ScriptEvidence,
} from '../../src/lib/version-drift.js'

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
    expect(hint).not.toContain('sanitize-permissions.js')
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
    expect(hint).toContain("this project's .claude/settings.json or .claude/settings.local.json")
  })

  it('does NOT escalate an unregistered script we could not read — two non-evidences are not evidence', () => {
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
    expect(hint).not.toContain('edit-scope-guard.js is installed')
  })

  it('leads with non-registration for a script that is both stale and unwired', () => {
    const { severity, hint } = notice('2.3.0', '2.3.0', [
      ev({ name: 'edit-scope-guard.js', state: 'stale', registration: 'unregistered' }),
      ...NO_DRIFT.slice(0, 1),
    ])
    expect(severity).toBe('security')
    expect(hint).toContain('edit-scope-guard.js is installed, but no PreToolUse entry')
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
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'sanitize-permissions.js'), `#!/usr/bin/env node\n${BODY}`)
    writeFileSync(join(shipped, 'sanitize-permissions.js'), ship())
    const e = evidenceFor('sanitize-permissions.js', readScriptEvidence(root, shipped))
    expect(e.stamp_version).toBeNull()
    expect(e.state).toBe('current')
  })

  it('ignores a trailing-newline difference — the installer adds one, the bundler does not', () => {
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
    expect(ev.map((e) => e.name)).toEqual(['edit-scope-guard.js', 'sanitize-permissions.js', 'terminal-guard.js'])
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
    }
    expect(() => readScriptEvidence(root, shipped)).not.toThrow()
  })
})

describe('readScriptRegistration — file-backed (#24)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

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

  const withHook = (event: string, command: string, extra: object = {}): string =>
    JSON.stringify({ hooks: { [event]: [{ ...extra, hooks: [{ type: 'command', command }] }] } }, null, 2) +
    '\n'

  const GUARD_CMD = 'node ${CLAUDE_PROJECT_DIR}/.rsct/scripts/edit-scope-guard.js'
  const SANITIZE_CMD = 'node ${CLAUDE_PROJECT_DIR}/.rsct/scripts/sanitize-permissions.js'
  const canonicalGuard = (hook = EDIT_GUARD_HOOK): string => withHook('PreToolUse', hook.command, { matcher: hook.matcher })

  it('recognizes the hook entry setup writes', () => {
    expect(readScriptRegistration(project({ settings: canonicalGuard() }), 'edit-scope-guard.js')).toBe('registered')
    expect(readScriptRegistration(project({ settings: canonicalGuard(TERMINAL_GUARD_HOOK) }), 'terminal-guard.js')).toBe('registered')
  })

  it('reports a guard entry in any other form as altered — an older setup, or an edit', () => {
    const forms = [
      withHook('PreToolUse', GUARD_CMD, { matcher: EDIT_GUARD_HOOK.matcher }),
      withHook('PreToolUse', 'node "${CLAUDE_PROJECT_DIR}/.rsct/scripts/edit-scope-guard.js"', { matcher: EDIT_GUARD_HOOK.matcher }),
      withHook('PreToolUse', EDIT_GUARD_HOOK.command.replace(' || exit 2', ''), { matcher: EDIT_GUARD_HOOK.matcher }),
      withHook('PreToolUse', EDIT_GUARD_HOOK.command + '; exit 0', { matcher: EDIT_GUARD_HOOK.matcher }),
      withHook('PreToolUse', EDIT_GUARD_HOOK.command, { matcher: '^Write$' }),
      withHook('PreToolUse', EDIT_GUARD_HOOK.command),
    ]
    for (const settings of forms) expect(readScriptRegistration(project({ settings }), 'edit-scope-guard.js')).toBe('altered')
    const terminal = withHook('PreToolUse', TERMINAL_GUARD_HOOK.command, { matcher: 'Bash' })
    expect(readScriptRegistration(project({ settings: terminal }), 'terminal-guard.js')).toBe('altered')
  })

  it('takes the canonical entry when an altered one sits beside it', () => {
    const both = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node .rsct/scripts/terminal-guard.js' }] },
          { matcher: TERMINAL_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: TERMINAL_GUARD_HOOK.command }] },
        ],
      },
    })
    expect(readScriptRegistration(project({ settings: both }), 'terminal-guard.js')).toBe('registered')
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

  it('folds backslash separators: a hand-written Windows sanitizer path counts, a guard entry in that form is altered', () => {
    const root = project({
      settings: withHook('SessionStart', 'node C:\\proj\\.rsct\\scripts\\sanitize-permissions.js'),
    })
    expect(readScriptRegistration(root, 'sanitize-permissions.js')).toBe('registered')
    const guard = project({ settings: withHook('PreToolUse', 'node C:\\proj\\.rsct\\scripts\\edit-scope-guard.js') })
    expect(readScriptRegistration(guard, 'edit-scope-guard.js')).toBe('altered')
  })

  it('sees through a UTF-8 BOM now that every RSCT reader does (#12)', () => {
    const root = project({ settings: '\uFEFF' + canonicalGuard() })
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('registered')
  })

  it('reads a CRLF settings file identically', () => {
    const root = project({ settings: canonicalGuard().replace(/\n/g, '\r\n') })
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('registered')
  })

  it('reports unregistered when NO settings file exists — the fresh-clone case', () => {
    const root = mkdtempSync(join(tmpdir(), 'rsct-reg-'))
    dirs.push(root)
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('unregistered')
  })

  it('is unknown when the settings file is malformed — a trailing comma is not a security event', () => {
    expect(readScriptRegistration(project({ settings: '{"hooks":{},}\n' }), 'edit-scope-guard.js')).toBe('unknown')
  })

  it('still finds the hook when settings.json is malformed but the local file carries it', () => {
    const root = project({ settings: '{ broken', local: canonicalGuard() })
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('registered')
  })

  it('is unknown — never unregistered — when one file is unreadable and the other lacks the hook', () => {
    const root = project({ settings: '{ broken', local: '{"permissions":{"allow":[]}}\n' })
    expect(readScriptRegistration(root, 'edit-scope-guard.js')).toBe('unknown')
  })

  it('is unregistered when one file is absent and the other parses without the hook', () => {
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
              { matcher: EDIT_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: EDIT_GUARD_HOOK.command }] },
              { matcher: TERMINAL_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: TERMINAL_GUARD_HOOK.command }] },
            ],
          },
        },
        null,
        2,
      ) + '\n',
    )

    for (const name of ['sanitize-permissions.js', 'edit-scope-guard.js', 'terminal-guard.js']) {
      const shippedText = readFileSync(join(DIST, name), 'utf8')
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
