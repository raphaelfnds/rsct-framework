import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('escalates a stale enforcement script even when versions match', () => {
    // The case the version axis structurally cannot see: `.rsct.json` and the
    // stamp both read the release version, so they agree while the body differs.
    const { severity, hint, stale_components } = notice('2.3.0', '2.3.0', stale)
    expect(severity).toBe('security')
    expect(hint).toContain('SECURITY')
    expect(hint).toContain('sanitize-permissions.js is outdated (installed at v2.1.1)')
    expect(stale_components).toEqual([
      { name: 'sanitize-permissions.js', state: 'stale', stamp_version: '2.1.1' },
    ])
  })

  it('escalates an absent enforcement script — worse than a stale one', () => {
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

  it('security outranks the version axis when both fire', () => {
    const { severity, hint } = notice('2.1.1', '2.3.0', stale)
    expect(severity).toBe('security')
    expect(hint).toContain('project installed at v2.1.1')
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
    // Pre-MED-11 installs have no line-2 stamp. Line 2 is dropped either way, so
    // an unstamped copy whose code matches must not be reported as stale.
    const { root, installed, shipped } = sandbox()
    writeFileSync(join(installed, 'sanitize-permissions.js'), `#!/usr/bin/env node\n${BODY}`)
    writeFileSync(join(shipped, 'sanitize-permissions.js'), ship(`const a = 1\n`))
    const e = evidenceFor('sanitize-permissions.js', readScriptEvidence(root, shipped))
    expect(e.stamp_version).toBeNull()
    expect(e.state).toBe('current')
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
