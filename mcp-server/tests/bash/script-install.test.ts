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
