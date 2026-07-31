import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import {
  getInstallDriftNotice,
  readScriptEvidence,
  type ScriptEvidence,
} from '../../src/lib/version-drift.js'

/**
 * The version axis is pure — it takes the `evidence` seam so these stay
 * filesystem-free. The component axis gets its own tmpdir-backed block below.
 */
const NO_DRIFT: ScriptEvidence[] = [
  {
    name: 'sanitize-permissions.js',
    state: 'current',
    security_relevant: true,
    stamp_version: '2.1.0',
  },
  {
    name: 'edit-scope-guard.js',
    state: 'current',
    security_relevant: true,
    stamp_version: '2.1.0',
  },
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
    const { hint, severity, stale_components } = notice('2.0.0', '2.1.0')
    expect(hint).not.toBeNull()
    expect(severity).toBe('normal')
    expect(stale_components).toEqual([])
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
    {
      name: 'sanitize-permissions.js',
      state: 'stale',
      security_relevant: true,
      stamp_version: '2.1.1',
    },
    ...NO_DRIFT.slice(1),
  ]

  it('reports a differing enforcement script even when versions match — but does NOT call it security', () => {
    // The case the version axis structurally cannot see: `.rsct.json` and the
    // stamp both read the release version, so they agree while the body differs.
    // It is reported and the component is named — but a byte difference cannot
    // prove a fix is missing: these scripts are bundles, so an unrelated config
    // key changes them. Ranking it `security` would fire on every release for
    // every project, which is the failure this module exists to remove.
    const { severity, hint, stale_components } = notice('2.3.0', '2.3.0', stale)
    expect(severity).toBe('normal')
    expect(hint).not.toContain('SECURITY')
    expect(hint).toContain("sanitize-permissions.js differs from this binary's copy")
    expect(stale_components).toEqual([
      { name: 'sanitize-permissions.js', state: 'stale', stamp_version: '2.1.1' },
    ])
  })

  it('escalates an absent enforcement script — the only provable claim', () => {
    const absent: ScriptEvidence[] = [
      {
        name: 'edit-scope-guard.js',
        state: 'absent',
        security_relevant: true,
        stamp_version: null,
      },
      ...NO_DRIFT.slice(0, 1),
    ]
    const { severity, hint } = notice('2.3.0', '2.3.0', absent)
    expect(severity).toBe('security')
    expect(hint).toContain('edit-scope-guard.js is not installed')
  })

  it('does not escalate an unreadable script — absence of evidence is not evidence', () => {
    const unreadable: ScriptEvidence[] = [
      {
        name: 'sanitize-permissions.js',
        state: 'unreadable',
        security_relevant: true,
        stamp_version: null,
      },
      ...NO_DRIFT.slice(1),
    ]
    expect(notice('2.3.0', '2.3.0', unreadable).severity).toBe('normal')
    expect(notice('2.3.0', '2.3.0', unreadable).hint).toBeNull()
  })

  it('ignores a stale script that is not security-relevant', () => {
    const other: ScriptEvidence[] = [
      { name: 'some-helper.js', state: 'stale', security_relevant: false, stamp_version: null },
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
      { name: 'sanitize-permissions.js', state: 'stale', security_relevant: true, stamp_version: '2.1.1' },
      { name: 'edit-scope-guard.js', state: 'absent', security_relevant: true, stamp_version: null },
    ]
    const { severity, hint, stale_components } = notice('2.3.0', '2.3.0', mixed)
    expect(severity).toBe('security')
    expect(hint).toContain('edit-scope-guard.js is not installed')
    // The security message speaks only about what is provably missing...
    expect(hint).not.toContain('sanitize-permissions.js')
    // ...but both components stay in the structured payload for the audit trail.
    expect(stale_components).toHaveLength(2)
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
