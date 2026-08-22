import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
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

interface RunOpts {
  /** Extra/override env. Spread AFTER the defaults, so `RSCT_SKIP_MCP: undefined`
   *  CLEARS it — Node drops undefined values from the child env. Omitting the key
   *  is NOT enough: `...process.env` would inherit a contributor's exported one. */
  env?: Record<string, string | undefined>
  /** Prepended to PATH (stub bin dir). */
  path?: string
  /** When set, stdin is a PIPE carrying this text instead of /dev/null. */
  input?: string
}

/** Run a script non-interactively with HOME pointed at the sandbox. */
function runScript(script: string, home: string, opts: RunOpts = {}): { ok: boolean; out: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    // forward slashes so Git Bash treats a Windows temp path cleanly
    HOME: home.replace(/\\/g, '/'),
    RSCT_ASSUME_YES: '1',
    RSCT_SKIP_MCP: '1',
    ...opts.env,
  }
  if (opts.path) env.PATH = `${opts.path}${delimiter}${process.env.PATH ?? ''}`
  try {
    const out = execFileSync('bash', [script], {
      env,
      encoding: 'utf8',
      // #71: `read -r` on a closed stdin returns non-zero and `set -e`
      // (install.sh:12) kills the script at the FIRST prompt, so the
      // interactive case needs a real pipe.
      stdio: opts.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      ...(opts.input === undefined ? {} : { input: opts.input }),
    })
    return { ok: true, out }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}` }
  }
}

/**
 * #71 — a stub bin dir for the cases that must reach the MCP scope menu.
 *
 * The menu sits inside the `npm install -g .` SUCCESS arm, so those cases must
 * run WITHOUT RSCT_SKIP_MCP. That makes two real binaries reachable and both
 * MUST be stubbed:
 *
 *  - `npm`  — otherwise a real `npm install -g .` runs from this worktree and
 *             repoints the machine-global rsct-mcp. Self-identifying so a case
 *             can PROVE the stub won `command -v` rather than assuming it.
 *  - `claude` — otherwise `claude mcp add rsct rsct-mcp --scope user`
 *             (install.sh, the `*)` arm) hits the developer's REAL config.
 *             $HOME does NOT sandbox it: the Claude CLI is a Node program and
 *             `os.homedir()` reads USERPROFILE on Windows, not HOME (measured).
 *             USERPROFILE/CLAUDE_CONFIG_DIR are redirected too, belt and braces.
 *
 * `node` is deliberately NOT stubbed: an `exit 0` stub emits no version, so
 * NODE_MAJOR="" → MCP_INSTALLABLE="no" → the menu never runs. Real Node >= 20
 * is a precondition of these cases; the `Choice [1/2/3]` assertion catches a
 * violation instead of letting it pass silently.
 *
 * Do NOT "optimize away" the `claude` stub after noticing CI has no Claude CLI.
 * Without it, ubuntu/macos take install.sh's `claude CLI not on PATH` arm while a
 * dev machine takes the `Registering…` arm — the stub equalizes the matrix, and
 * it is the only thing protecting a dev's real registration.
 *
 * PRE-FLIGHT, not post-detect: bash resolves PATH with access(X_OK) and SKIPS an
 * entry that fails it. On a hardened Linux box with a `noexec` TMPDIR the 0755
 * stub is skipped, bash walks on to the REAL npm, and `npm install -g .` runs
 * from this worktree — repointing the machine-global rsct-mcp. The
 * `/STUB-NPM install -g \./` assertion would only report that afterwards. So we
 * verify resolution BEFORE handing the dir to runScript, and mcpEnv additionally
 * pins `npm_config_prefix` into the sandbox so even a real npm cannot escape.
 */
function newStubBin(): string {
  const dir = newSandbox()
  writeFileSync(join(dir, 'npm'), '#!/bin/sh\necho "STUB-NPM $*"\nexit 0\n')
  chmodSync(join(dir, 'npm'), 0o755)
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'claude'), 0o755)

  const resolved = execFileSync('bash', ['-c', 'command -v npm'], {
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  }).trim()
  if (!resolved.includes('rsct-install-')) {
    throw new Error(
      `stub npm did not win PATH resolution (got "${resolved}") — refusing to run, ` +
        `a real \`npm install -g .\` would repoint the machine-global rsct-mcp. ` +
        `Most likely cause: TMPDIR mounted noexec.`,
    )
  }
  return dir
}

/** #71 — seed ~/.rsct/mcp-scope before a run. install.sh's `mkdir -p "$RSCT_HOME"`
 *  happens later and its wipe loop only iterates RUNTIME_DIRS, so the file survives. */
function seedScope(home: string, raw: string): void {
  mkdirSync(rsctHome(home), { recursive: true })
  writeFileSync(join(rsctHome(home), 'mcp-scope'), raw)
}

const readScope = (home: string) =>
  readFileSync(join(rsctHome(home), 'mcp-scope'), 'utf8').replace(/\r/g, '').trim()

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

describe.skipIf(!BASH)('install.sh reads ~/.rsct/mcp-scope as the menu default (#71)', () => {
  /**
   * Every case here asserts a POSITIVE proof that the menu actually ran, before
   * asserting the marker. Without it these are negative assertions over state the
   * SEED already produced: the marker is written only inside the menu, so any gate
   * that short-circuits earlier — an inherited RSCT_SKIP_MCP, MCP_INSTALLABLE=no,
   * a stub that failed to exec, or the "install failed" arm (which still exits 0)
   * — leaves the seeded value untouched and the test passes green with the fix
   * reverted. `Choice [1/2/3] (default: N)` proves BOTH reachability and the
   * recorded→default mapping in one assertion.
   */
  function expectMenuRan(out: string, expectedDefault: string): void {
    expect(out, out).toMatch(new RegExp(`Choice \\[1/2/3\\] \\(default: ${expectedDefault}\\)`))
    // Proves the stub won `command -v npm` — otherwise a REAL `npm install -g .`
    // ran from this worktree and repointed the machine-global rsct-mcp.
    expect(out, out).toMatch(/STUB-NPM install -g \./)
    expect(out).not.toMatch(/Skipping rsct-mcp companion/)
    expect(out).not.toMatch(/rsct-mcp install failed/)
  }

  const mcpEnv = (home: string) => ({
    // Explicitly CLEAR it — omitting the key would inherit a contributor's export.
    RSCT_SKIP_MCP: undefined,
    // $HOME does not sandbox a Node CLI on Windows (os.homedir() reads USERPROFILE).
    USERPROFILE: home.replace(/\\/g, '/'),
    CLAUDE_CONFIG_DIR: home.replace(/\\/g, '/'),
    // Belt to newStubBin's braces: npm honours npm_config_* from the environment
    // on all three platforms, so even a real `npm install -g .` — if the stub ever
    // lost PATH resolution — lands in the sandbox, never the machine prefix.
    npm_config_prefix: join(home, 'npm-global').replace(/\\/g, '/'),
  })

  it('keeps a recorded "project" on an unattended re-run', () => {
    const home = newSandbox()
    seedScope(home, 'project\n')
    const r = runScript(INSTALL, home, { env: mcpEnv(home), path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '2')
    expect(readScope(home)).toBe('project')
    // Prefix only — the suffix is mode-aware (no Enter exists in a --yes run).
    expect(r.out).toMatch(/\(current: project/)
    expect(r.out).toMatch(/Project scope kept/)
  }, 60_000)

  it('keeps a recorded "user" — the arm a project/skip-only suite cannot see', () => {
    // Without this, deleting the `user)` arm is INVISIBLE: the value still maps
    // to default 1 through `*)`, so the marker survives and every other case
    // stays green — while a legal `user` marker gets announced as unrecognized.
    const home = newSandbox()
    seedScope(home, 'user\n')
    const r = runScript(INSTALL, home, { env: mcpEnv(home), path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '1')
    expect(readScope(home)).toBe('user')
    expect(r.out).toMatch(/\(current: user/)
    expect(r.out).not.toMatch(/unrecognized/)
  }, 60_000)

  it('announces an UNRECOGNIZED marker instead of promising to keep it', () => {
    // The V phase's headline finding (G1): the "(current: …)" line was gated on
    // non-emptiness while the default was gated on an exact `case` match, so a
    // marker with a stray space / different case / BOM printed "press Enter to
    // keep it" and then Enter wrote `user` — shipping issue #71 with an on-screen
    // promise that it would not happen. Two mutations reintroduce it: dropping
    // the `elif` arm, or reverting the gate to `[ -n "$MCP_SCOPE_RECORDED" ]`.
    // This is the only case that kills either.
    const home = newSandbox()
    seedScope(home, ' project\n')
    const r = runScript(INSTALL, home, { env: mcpEnv(home), path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '1')
    expect(r.out).toMatch(/recorded scope unrecognized/)
    expect(r.out).not.toMatch(/press Enter to keep it/)
    expect(r.out).not.toMatch(/kept unless overridden/)
    expect(readScope(home)).toBe('user')
  }, 60_000)

  it('keeps a recorded "skip" on an unattended re-run', () => {
    const home = newSandbox()
    seedScope(home, 'skip\n')
    const r = runScript(INSTALL, home, { env: mcpEnv(home), path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '3')
    expect(readScope(home)).toBe('skip')
    expect(r.out).toMatch(/Skip kept/)
  }, 60_000)

  it('still defaults a FRESH install to user scope', () => {
    // REGRESSION GUARD, not proof of the fix: this passes against the unfixed
    // code too (both paths write `user`). It pins the `*)` arm of the new mapping
    // and is the one case that cannot pass vacuously — with no marker there is
    // nothing for a short-circuit to leave behind. The fix's proof is the other
    // three cases.
    const home = newSandbox()
    const r = runScript(INSTALL, home, { env: mcpEnv(home), path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '1')
    expect(readScope(home)).toBe('user')
    expect(r.out).not.toMatch(/press Enter to keep it/)
  }, 60_000)

  it('reads a marker whose value carries a CR', () => {
    // HONEST COVERAGE NOTE — measured, do not assume the shape of this fixture is
    // incidental. A TRAILING CR (`project\r\n`) is stripped by MSYS inside command
    // substitution, so on Git Bash the mutation "remove `tr -d '\r'`" would leave
    // this GREEN — the same trap already documented for the VERSION-CODE read
    // above. An INTERIOR CR survives `$( )` on all three OSes, so the guard is
    // falsifiable everywhere, including locally.
    const home = newSandbox()
    seedScope(home, 'pro\rject\n')
    const r = runScript(INSTALL, home, { env: mcpEnv(home), path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '2')
    expect(readScope(home)).toBe('project')
  }, 60_000)

  it('announces the replacement when a typo overwrites a recorded scope', () => {
    // One mistyped key was enough to turn `project` into `user` in silence — right
    // after the menu offered to keep it. `1` and a typo both land on `*)` and both
    // write `user`; only the typo-over-a-recorded-value says so.
    const home = newSandbox()
    seedScope(home, 'project\n')
    const r = runScript(INSTALL, home, {
      env: { ...mcpEnv(home), RSCT_ASSUME_YES: undefined },
      path: newStubBin(),
      input: 'y\n\nx\n',
    })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '2')
    expect(r.out).toMatch(/REPLACING the recorded 'project'/)
    expect(readScope(home)).toBe('user')
  }, 60_000)

  it('keeps a recorded "project" when the dev just presses Enter', () => {
    // The ONLY case covering the empty-reply resolution: under RSCT_ASSUME_YES
    // read_or_default assigns the (non-empty) default and never reaches it.
    // stdin must be a real pipe — with /dev/null `read -r` returns non-zero and
    // `set -e` kills install.sh at its FIRST prompt, long before the menu.
    //   "y"  → Proceed? [y/N]        (a bare newline there cancels and exits 0)
    //   ""   → Install rsct-mcp now? [Y/n]
    //   ""   → the scope menu        ← the line under test
    const home = newSandbox()
    seedScope(home, 'project\n')
    const r = runScript(INSTALL, home, {
      env: { ...mcpEnv(home), RSCT_ASSUME_YES: undefined },
      path: newStubBin(),
      input: 'y\n\n\n',
    })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '2')
    expect(readScope(home)).toBe('project')
  }, 60_000)
})
