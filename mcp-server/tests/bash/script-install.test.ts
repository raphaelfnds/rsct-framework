import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, delimiter } from 'node:path'
import { bashAvailable, repoRoot } from './lib/bash-lint.js'

// T0.b — script-level sandbox smoke for scripts/install.sh +
// uninstall-framework.sh. Drives them non-interactively (RSCT_ASSUME_YES +
// RSCT_SKIP_MCP — added in this block) into a throwaway $HOME, so there are NO
// global side effects (no `npm install -g`, no `claude mcp add`). Asserts the
// install layout, a non-destructive re-run, and a clean uninstall. Cross-OS via
// the existing CI matrix (Git Bash on Windows).

const BASH = bashAvailable()
const ROOT = repoRoot(__dirname)
const INSTALL = resolve(ROOT, 'scripts', 'install.sh')
const UNINSTALL = resolve(ROOT, 'scripts', 'uninstall-framework.sh')

const RUNTIME_DIRS = ['prompts', 'rules', 'doc-templates', 'memory-templates', 'universe-templates']
const COMMANDS = ['rsct-setup', 'rsct-universe', 'rsct-uninstall', 'rsct-clean-code']
// plan-lifecycle-v2 Trilha 4: the unified /rsct-universe replaces these; install
// must actively remove any leftover stubs so they no longer appear to the dev.
const LEGACY_COMMANDS = ['rsct-init-universe', 'rsct-canonical-source']

const sandboxes: string[] = []
function newSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsct-install-'))
  sandboxes.push(dir)
  return dir
}
afterEach(() => {
  while (sandboxes.length) {
    const d = sandboxes.pop()!
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

/** Run a script non-interactively with HOME pointed at the sandbox. */
function runScript(script: string, home: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync('bash', [script], {
      // forward slashes so Git Bash treats a Windows temp path cleanly
      env: { ...process.env, HOME: home.replace(/\\/g, '/'), RSCT_ASSUME_YES: '1', RSCT_SKIP_MCP: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, out }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}` }
  }
}

const rsctHome = (home: string) => join(home, '.rsct')
const commandsDir = (home: string) => join(home, '.claude', 'commands')

describe.skipIf(!BASH)('scripts/install.sh + uninstall-framework.sh — sandbox smoke (T0.b)', () => {
  it('install populates ~/.rsct and registers the slash commands', () => {
    const home = newSandbox()
    const r = runScript(INSTALL, home)
    expect(r.ok, r.out).toBe(true)

    for (const d of RUNTIME_DIRS) {
      expect(existsSync(join(rsctHome(home), d)), `missing ~/.rsct/${d}`).toBe(true)
    }
    expect(existsSync(join(rsctHome(home), 'VERSION'))).toBe(true)
    expect(existsSync(join(rsctHome(home), 'VERSION-CODE'))).toBe(true)
    // PH-6 (issue #7): install reads the single-source /VERSION and stamps it into
    // ~/.rsct/VERSION. Trim both sides — install.sh writes via `echo` (adds \n) and
    // the source file's trailing newline is unpinned (V-P1).
    const installedVersion = readFileSync(join(rsctHome(home), 'VERSION'), 'utf8').replace(/\r/g, '').trim()
    const sourceVersion = readFileSync(join(ROOT, 'VERSION'), 'utf8').replace(/\r/g, '').trim()
    expect(installedVersion, 'installed ~/.rsct/VERSION should equal source /VERSION').toBe(sourceVersion)
    // #44: the CODE axis needs the same content assertion. Asserting only that the file
    // exists let install.sh write a line of version.ts's docstring into it for releases
    // — the docstring mentions RSCT_MCP_VERSION, so an unanchored grep + head -1 took
    // the prose. Because the same read fed both sides of the drift comparison, the
    // report was permanently "same" and the axis silently stopped working.
    //
    // Compared against package.json, NOT version.ts: version.ts is the file install.sh
    // parses, so checking against it could pass with a matching-but-wrong parse.
    // package.json is an independent mirror (kept in sync by scripts/sync-version.mjs).
    const installedCodeVersion = readFileSync(join(rsctHome(home), 'VERSION-CODE'), 'utf8')
      .replace(/\r/g, '')
      .trim()
    const pkgVersion = JSON.parse(
      readFileSync(join(ROOT, 'mcp-server', 'package.json'), 'utf8'),
    ).version as string
    expect(
      installedCodeVersion,
      'installed ~/.rsct/VERSION-CODE should be the rsct-mcp code version, not prose from version.ts',
    ).toBe(pkgVersion)
    expect(existsSync(join(rsctHome(home), 'prompts', '01-setup.md'))).toBe(true)
    for (const c of COMMANDS) {
      expect(existsSync(join(commandsDir(home), `${c}.md`)), `missing command ${c}.md`).toBe(true)
    }
    // Trilha 4: the legacy universe command stubs must NOT be generated.
    for (const c of LEGACY_COMMANDS) {
      expect(existsSync(join(commandsDir(home), `${c}.md`)), `legacy ${c}.md should be absent`).toBe(false)
    }
    // SKIP_MCP must keep it framework-only (no companion install attempted).
    expect(r.out).toMatch(/Skipping rsct-mcp companion/)
  }, 60_000)

  it('re-run is non-destructive (UPDATE path, no duplication/corruption)', () => {
    const home = newSandbox()
    expect(runScript(INSTALL, home).ok).toBe(true)
    const second = runScript(INSTALL, home)
    expect(second.ok, second.out).toBe(true)
    expect(second.out).toMatch(/Existing/) // took the update path, not a fresh install
    for (const c of COMMANDS) {
      expect(existsSync(join(commandsDir(home), `${c}.md`))).toBe(true)
    }
    expect(existsSync(join(rsctHome(home), 'prompts', '01-setup.md'))).toBe(true)
  }, 90_000)

  // #44: the code axis is a DRIFT REPORT — its whole job is to make a code-only change
  // visible when the protocol version did not move. These three cover the states that
  // report can be in. Before the fix all three collapsed into "same", because both
  // sides of the comparison read the same docstring line.
  it('fresh install reports the code axis as none, not as a broken marker', () => {
    const home = newSandbox()
    const r = runScript(INSTALL, home)
    expect(r.ok, r.out).toBe(true)
    expect(r.out).toMatch(/Existing code\s*: none \(fresh install\)/)
    // The empty arm of the guard has to fall through: folding '' into the sentinel
    // would make every first install claim its marker is unreadable.
    expect(r.out).not.toMatch(/unreadable/)
  }, 60_000)

  it('a real code-version bump is reported as drift, not as "same"', () => {
    const home = newSandbox()
    expect(runScript(INSTALL, home).ok).toBe(true)
    // Rewind only the code marker; the installer re-reads it on the next run.
    writeFileSync(join(rsctHome(home), 'VERSION-CODE'), '0.0.1\n', 'utf8')
    const r = runScript(INSTALL, home)
    expect(r.ok, r.out).toBe(true)
    const pkgVersion = JSON.parse(
      readFileSync(join(ROOT, 'mcp-server', 'package.json'), 'utf8'),
    ).version as string
    expect(r.out).toMatch(new RegExp(`Existing code\\s*: 0\\.0\\.1 → ${pkgVersion.replace(/\./g, '\\.')} \\(drift detected`))
  }, 90_000)

  it('a pre-#44 marker holding version.ts prose reports unreadable, not drift', () => {
    const home = newSandbox()
    expect(runScript(INSTALL, home).ok).toBe(true)
    // Exactly what the old unanchored grep wrote: line 2 of version.ts's docstring.
    writeFileSync(
      join(rsctHome(home), 'VERSION-CODE'),
      ' * The rsct-mcp server version (CODE axis) — the bundled `RSCT_MCP_VERSION` literal\n',
      'utf8',
    )
    const r = runScript(INSTALL, home)
    expect(r.ok, r.out).toBe(true)
    // Not "prose → 2.6.1 (drift detected)": the dev's code did not move, the marker is
    // simply unreadable. And the prose must not be echoed above the [y/N] confirm.
    expect(r.out).toMatch(/Existing code\s*: unreadable/)
    expect(r.out).not.toMatch(/the bundled/)
    // Self-healing: this same run rewrites the marker with a real version.
    const healed = readFileSync(join(rsctHome(home), 'VERSION-CODE'), 'utf8').trim()
    expect(healed).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/)
  }, 90_000)

  // A CRLF marker is reachable by copying ~/.rsct between machines.
  //
  // HONEST COVERAGE NOTE — measured, do not assume this test protects you locally:
  // Git Bash strips a trailing CR in command substitution, so on Windows this passes
  // WITH OR WITHOUT the `tr -d '\r'` in install.sh. Verified by removing the tr and
  // re-running: still 10/10 green on Git Bash. It only bites on the four Linux/macOS
  // CI cells, where "2.6.1\r" != "2.6.1" would report drift on EVERY run — #44
  // inverted. Kept because those cells are exactly where the bug is reachable; do not
  // "confirm the guard" from a Windows run alone.
  it('a CRLF marker does not fabricate drift (only provable on Linux/macOS)', () => {
    const home = newSandbox()
    expect(runScript(INSTALL, home).ok).toBe(true)
    const current = readFileSync(join(rsctHome(home), 'VERSION-CODE'), 'utf8').trim()
    writeFileSync(join(rsctHome(home), 'VERSION-CODE'), `${current}\r\n`, 'utf8')
    const r = runScript(INSTALL, home)
    expect(r.ok, r.out).toBe(true)
    expect(r.out).toMatch(/Existing code\s*: .*\(same — refresh only\)/)
  }, 90_000)

  it('uninstall scrubs ~/.rsct and the slash commands', () => {
    const home = newSandbox()
    expect(runScript(INSTALL, home).ok).toBe(true)
    const u = runScript(UNINSTALL, home)
    expect(u.ok, u.out).toBe(true)
    expect(existsSync(rsctHome(home)), '~/.rsct should be gone').toBe(false)
    for (const c of COMMANDS) {
      expect(existsSync(join(commandsDir(home), `${c}.md`)), `${c}.md should be gone`).toBe(false)
    }
  }, 60_000)
})

describe.skipIf(!BASH)('install/uninstall WSL guard (CAP-38 family)', () => {
  // The guard greps /proc/sys/kernel/osrelease for microsoft|wsl. We can't fake
  // /proc, but we can prove the detection pattern it relies on is correct.
  function matches(osrelease: string): boolean {
    try {
      execFileSync('bash', ['-c', `printf '%s\\n' "$1" | grep -qiE "microsoft|wsl"`, '_', osrelease], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  it('matches WSL osrelease strings', () => {
    expect(matches('5.15.0-microsoft-standard-WSL2')).toBe(true)
    expect(matches('4.4.0-19041-Microsoft')).toBe(true)
  })
  it('does not match a vanilla Linux osrelease', () => {
    expect(matches('6.5.0-generic')).toBe(false)
    expect(matches('5.10.0-21-amd64')).toBe(false)
  })
})

describe.skipIf(!BASH)('uninstall plan-line wording under --skip-mcp (A4)', () => {
  it('reports a detected global rsct-mcp as left untouched, not "will ask separately"', () => {
    const home = newSandbox()
    // A fake `rsct-mcp` on PATH so `command -v rsct-mcp` detects a global
    // deterministically (incl. CI with no real install). path.delimiter so the
    // inherited PATH hands off correctly to Git Bash (`;` on Windows).
    const binDir = newSandbox()
    const fake = join(binDir, 'rsct-mcp')
    writeFileSync(fake, '#!/bin/sh\nexit 0\n')
    chmodSync(fake, 0o755)

    let out: string
    try {
      out = execFileSync('bash', [UNINSTALL], {
        env: {
          ...process.env,
          HOME: home.replace(/\\/g, '/'),
          RSCT_ASSUME_YES: '1',
          RSCT_SKIP_MCP: '1',
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string }
      out = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`
    }

    // The plan line must mirror the SKIP gate: left untouched, not a stale "will ask".
    expect(out, out).toMatch(/global rsct-mcp at .*\(left untouched; --skip-mcp set\)/)
    expect(out).not.toMatch(/will ask separately/)
    // SKIP gate held → no removal attempted (no `npm uninstall -g` path taken).
    expect(out).not.toMatch(/Removed global rsct-mcp/)
  }, 60_000)
})
