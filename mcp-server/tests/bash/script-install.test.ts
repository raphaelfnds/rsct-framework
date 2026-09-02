import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, delimiter } from 'node:path'
import { bashAvailable, repoRoot } from './lib/bash-lint.js'
import { bashBin } from './lib/resolve-bash.js'

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
  // forward slashes so Git Bash treats a Windows temp path cleanly
  const sandbox = home.replace(/\\/g, '/')
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: sandbox,
    // #73: sandboxed BY DEFAULT, not per-case. These three used to live only in
    // the #71 block's opt-in `mcpEnv`, so any case that cleared RSCT_SKIP_MCP
    // without remembering them ran against the developer's REAL machine. Under
    // #71 the worst reachable call was an additive `claude mcp add`; under #73
    // it is `claude mcp remove rsct --scope user`, which de-registers rsct in
    // EVERY project on the machine. A safety property that depends on each new
    // case remembering an opt-in is not a safety property.
    //   USERPROFILE      — os.homedir() reads it on Windows, NOT HOME (measured)
    //   CLAUDE_CONFIG_DIR— what the CLI honours first, and what install.sh now
    //                      resolves its host config through, exactly like the CLI
    //   npm_config_prefix— so even a real `npm install -g .` lands in the sandbox
    USERPROFILE: sandbox,
    CLAUDE_CONFIG_DIR: sandbox,
    npm_config_prefix: `${sandbox}/npm-global`,
    RSCT_ASSUME_YES: '1',
    RSCT_SKIP_MCP: '1',
    ...opts.env,
  }
  // #73: reaching the MCP branch REQUIRES stubs. Without this guard a future
  // case that clears RSCT_SKIP_MCP and forgets `path:` runs a real
  // `npm install -g .` from this worktree (repointing the machine-global
  // rsct-mcp) and a real `claude mcp remove`. Structural, so it cannot be
  // forgotten.
  // `!env.RSCT_SKIP_MCP`, not `=== undefined`: `RSCT_SKIP_MCP: ''` is the
  // natural way a contributor writes "clear it", and bash's `[ -n "$X" ]` reads
  // it as cleared too — so the strict-equality form let the MCP branch run with
  // no stubs at all. Same for the sandbox pins: they are the actual
  // containment, so they are asserted here rather than trusted.
  if (!env.RSCT_SKIP_MCP) {
    if (!opts.path) {
      throw new Error(
        'runScript: RSCT_SKIP_MCP was cleared without a stub bin dir — refusing to run. ' +
          'The MCP branch would reach the REAL `npm` and `claude`. Pass `path: newStubBin()`.',
      )
    }
    // `rsct-install-` is newSandbox()'s mkdtemp prefix, so this proves the value
    // is SOME throwaway sandbox — not the developer's real profile. It is
    // deliberately not "this test's own home": the CLAUDE_CONFIG_DIR case points
    // at a second sandbox on purpose, which is the whole point of that case.
    for (const key of ['USERPROFILE', 'CLAUDE_CONFIG_DIR', 'npm_config_prefix'] as const) {
      if (!env[key] || !env[key]!.includes('rsct-install-')) {
        throw new Error(
          `runScript: ${key} does not point into a test sandbox (${env[key]}) — refusing to run. ` +
            'A real `claude` or `npm` would reach the developer\'s own machine.',
        )
      }
    }
  }
  if (opts.path) env.PATH = `${opts.path}${delimiter}${process.env.PATH ?? ''}`
  try {
    const out = execFileSync(bashBin(), [script], {
      env,
      encoding: 'utf8',
      // #71: `read -r` on a closed stdin returns non-zero and `set -e`
      // (install.sh:12) kills the script at the FIRST prompt, so the
      // interactive case needs a real pipe.
      stdio: opts.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      ...(opts.input === undefined ? {} : { input: opts.input }),
      // execFileSync BLOCKS the vitest worker thread. A bash that never exits —
      // an unexpected prompt reading a pipe that stays open, a hung `npm` stub —
      // therefore hangs the worker with the event loop stopped, so vitest's own
      // per-test timeout can never fire. This is the only bound that exists.
      // 45s against runs that normally take 1-3s: high enough that CPU
      // contention cannot trip it, low enough to surface inside the 60s cases.
      timeout: 45_000,
      killSignal: 'SIGKILL',
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
 * is a precondition of these cases; the `Choice [1/2]` assertion catches a
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
/**
 * #73 — the `claude` stub is no longer `exit 0`.
 *
 * install.sh now RE-VERIFIES the host config after every `claude mcp add` /
 * `remove` instead of trusting the CLI's exit code, so an inert stub would make
 * every case take the "did not land" arm. The stub therefore performs the real
 * mutation, against the SAME file install.sh resolves — `$CLAUDE_CONFIG_DIR` —
 * which is what makes the two agree by test rather than by assumption.
 *
 * A JSON round-trip inside the stub is fine and is NOT the anti-pattern #5
 * class: this is a throwaway sandbox fixture, not a managed file, and under
 * option B install.sh itself never writes the host config at all (asserted by
 * `it('never writes the host config itself')`).
 *
 * Two env knobs let a case drive the failure arms that matter:
 *   STUB_CLAUDE_FAIL=1         — exits non-zero WITHOUT acting (add/remove failed)
 *   STUB_CLAUDE_LIE=1          — exits 0 but mutates NOTHING. Kills "drop the
 *                                re-verify": without it install.sh believes the
 *                                lie and records a scope that does not resolve.
 *   STUB_CLAUDE_ACT_THEN_FAIL=1 — mutates and THEN exits non-zero. The Rv found
 *                                the suite structurally blind to this direction:
 *                                a probe gated on the CLI's exit code falsifies
 *                                success but never failure, so a `claude` that
 *                                acted and reported failure left the marker
 *                                lying. This file's own notes document those
 *                                exit codes differing across Windows wrappers.
 *
 * Every invocation is appended to `$CLAUDE_CONFIG_DIR/stub-claude.log`. That
 * side-effect file — not stdout — is how a case proves the stub ran: install.sh
 * redirects the CLI with `>/dev/null 2>&1`, so a self-identifying echo is
 * swallowed and could never be asserted.
 */
const STUB_CLAUDE = [
  '#!/bin/sh',
  'CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME}"',
  'CFG="$CFG_DIR/.claude.json"',
  'echo "STUB-CLAUDE $*" >> "$CFG_DIR/stub-claude.log"',
  'if [ -n "$STUB_CLAUDE_FAIL" ]; then exit 1; fi',
  'if [ -n "$STUB_CLAUDE_LIE" ]; then exit 0; fi',
  // Drain stdin so a missing `</dev/null` at the call site is caught: without
  // it the CLI would eat the answer to the NEXT prompt and the installer would
  // hang or take a wrong default.
  'cat >/dev/null 2>&1 || true',
  'case "$1 $2 $3" in',
  // `rc=$?` FIRST. A POSIX `if` whose condition is false and which has no else
  // completes with status 0, so the previous `if ...; fi` + `exit $?` shape
  // exited 0 on EVERY unset-knob run and discarded the node exit code entirely
  // — a stub that silently reports success is the exact failure this suite
  // exists to catch, sitting inside the suite's own instrument.
  '  "mcp add rsct")',
  "    node -e 'var fs=require(\"fs\");var p=process.argv[1];var j={};try{j=JSON.parse(fs.readFileSync(p,\"utf8\"))}catch(e){j={}}j.mcpServers=j.mcpServers||{};j.mcpServers.rsct={command:\"rsct-mcp\",args:[]};fs.writeFileSync(p,JSON.stringify(j,null,2))' \"$CFG\"",
  '    rc=$?',
  '    if [ -n "$STUB_CLAUDE_ACT_THEN_FAIL" ]; then exit 7; fi',
  '    exit $rc ;;',
  '  "mcp remove rsct")',
  "    node -e 'var fs=require(\"fs\");var p=process.argv[1];var j;try{j=JSON.parse(fs.readFileSync(p,\"utf8\"))}catch(e){process.exit(1)}if(!j.mcpServers||!j.mcpServers.rsct){process.exit(1)}delete j.mcpServers.rsct;fs.writeFileSync(p,JSON.stringify(j,null,2))' \"$CFG\"",
  '    rc=$?',
  '    if [ -n "$STUB_CLAUDE_ACT_THEN_FAIL" ]; then exit 7; fi',
  '    exit $rc ;;',
  'esac',
  'exit 0',
  '',
].join('\n')

function newStubBin(): string {
  const dir = newSandbox()
  writeFileSync(join(dir, 'npm'), '#!/bin/sh\necho "STUB-NPM $*"\nexit 0\n')
  chmodSync(join(dir, 'npm'), 0o755)
  writeFileSync(join(dir, 'claude'), STUB_CLAUDE)
  chmodSync(join(dir, 'claude'), 0o755)

  // PRE-FLIGHT BOTH. Until #73 only `npm` was checked, while the docstring
  // claimed the dir was verified — and `claude` is now the dangerous one.
  for (const bin of ['npm', 'claude']) {
    const resolved = execFileSync(bashBin(), ['-c', `command -v ${bin}`], {
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    }).trim()
    if (!resolved.includes('rsct-install-')) {
      throw new Error(
        `stub ${bin} did not win PATH resolution (got "${resolved}") — refusing to run. ` +
          (bin === 'npm'
            ? 'A real `npm install -g .` would repoint the machine-global rsct-mcp.'
            : 'A real `claude mcp remove rsct --scope user` would de-register rsct on this machine.') +
          ' Most likely cause: TMPDIR mounted noexec.',
      )
    }
  }
  return dir
}

/** #73 — seed the sandbox host config. `raw` is written verbatim so a case can
 *  plant formatting canaries and prove install.sh never rewrites the file. */
function seedHostConfig(home: string, raw: string): void {
  writeFileSync(join(home, '.claude.json'), raw, 'utf8')
}
const hostConfigRaw = (home: string) => readFileSync(join(home, '.claude.json'), 'utf8')
const hostConfig = (home: string) => JSON.parse(hostConfigRaw(home)) as {
  mcpServers?: Record<string, unknown>
  projects?: Record<string, { enabledMcpjsonServers?: string[] }>
}
const USER_ENTRY = '{\n  "mcpServers": {\n    "rsct": {\n      "command": "rsct-mcp",\n      "args": []\n    }\n  }\n}\n'
/** Proof the stubbed CLI ran — stdout is swallowed by install.sh's redirects. */
function stubClaudeLog(home: string): string {
  const p = join(home, 'stub-claude.log')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

/**
 * A POSITIVE proof that the menu actually ran, before any marker assertion.
 * Without it those are negative assertions over state the SEED already
 * produced: the marker is written only inside the menu, so any gate that
 * short-circuits earlier — an inherited RSCT_SKIP_MCP, MCP_INSTALLABLE=no, a
 * stub that failed to exec, or the "install failed" arm (which still exits 0)
 * — leaves the seeded value untouched and the test passes green with the fix
 * reverted. `Choice [1/2] (default: N)` proves BOTH reachability and the
 * recorded->default mapping in one assertion.
 *
 * Module scope since #73: both the #71 and #73 blocks need it, and a helper
 * that lives in one describe is a helper the next block quietly does without.
 */
function expectMenuRan(out: string, expectedDefault: string): void {
  // #73: the menu is binary. Asserting the prompt alone would still pass with a
  // body that prints "[3] Skip", so the absence is asserted too.
  expect(out, out).toMatch(new RegExp(`Choice \\[1/2\\] \\(default: ${expectedDefault}\\)`))
  expect(out, out).not.toMatch(/\[3\] Skip/)
  // Proves the stub won `command -v npm` — otherwise a REAL `npm install -g .`
  // ran from this worktree and repointed the machine-global rsct-mcp.
  expect(out, out).toMatch(/STUB-NPM install -g \./)
  expect(out).not.toMatch(/Skipping rsct-mcp companion/)
  expect(out).not.toMatch(/rsct-mcp install failed/)
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
      execFileSync(bashBin(), ['-c', `printf '%s\\n' "$1" | grep -qiE "microsoft|wsl"`, '_', osrelease], { stdio: 'ignore' })
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
      out = execFileSync(bashBin(), [UNINSTALL], {
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
  // #73: USERPROFILE / CLAUDE_CONFIG_DIR / npm_config_prefix moved into
  // runScript's DEFAULTS — sandboxing must not be opt-in. What is left here is
  // the one thing that genuinely is per-case: reaching the MCP branch at all.
  // Explicitly CLEARED — omitting the key would inherit a contributor's export.
  const mcpEnv = (_home: string) => ({ RSCT_SKIP_MCP: undefined as string | undefined })

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

  it('reads a legacy "skip" as the documented default [1] without acting on it', () => {
    // #73 AC 6. `skip` must stay READABLE (machines installed before the binary
    // menu carry it) and resolve deterministically — but resolving is NOT
    // registering. README told every teammate on a project-scope team to press
    // [3], so `skip` is the TEAM population: an unattended run that quietly ran
    // `claude mcp add --scope user` on their machines would mask the .mcp.json
    // they share via git, in every repo.
    //
    // Two mutations this kills, and neither is caught by the marker assertion
    // alone — deleting the `skip)` arm still yields default 1 through `*)`:
    //   1. drop the legacy line      -> the "is legacy" text disappears
    //   2. drop the unattended guard -> stub-claude.log records `mcp add`
    const home = newSandbox()
    seedScope(home, 'skip\n')
    const r = runScript(INSTALL, home, { env: mcpEnv(home), path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '1')
    expect(r.out, r.out).toMatch(/'skip' is legacy/)
    expect(r.out).not.toMatch(/unrecognized/)
    expect(r.out).not.toMatch(/press Enter to keep it/)
    // Registered NOTHING, and said so.
    expect(stubClaudeLog(home), 'the CLI must not be invoked at all').not.toMatch(/mcp add/)
    expect(r.out).toMatch(/registering nothing/)
    // Marker untouched — the legacy value survives for the next interactive run.
    expect(readScope(home)).toBe('skip')
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

describe.skipIf(!BASH)('install.sh makes the MCP scope choice EFFECTIVE (#73)', () => {
  // Both flags CLEARED: RSCT_SKIP_MCP to reach the MCP branch at all, and
  // RSCT_ASSUME_YES because otherwise read_or_default echoes the default and
  // the piped `keys(...)` are never read — the menu answers itself and every
  // interactive assertion below tests the unattended path by accident.
  const mcp = { RSCT_SKIP_MCP: undefined as string | undefined, RSCT_ASSUME_YES: undefined as string | undefined }
  /** Unattended: reach the MCP branch but keep RSCT_ASSUME_YES set. */
  const mcpYes = { RSCT_SKIP_MCP: undefined as string | undefined }
  /** Reaches the scope menu interactively. "y" -> Proceed?, "" -> Install mcp?. */
  const keys = (...rest: string[]) => `y\n\n${rest.join('\n')}\n`

  it('AC 1 — the menu renders exactly two options, and no [3] anywhere', () => {
    // Dedicated to AC 1 ("the scope menu offers exactly two choices"), the
    // headline of the issue. It was otherwise guarded only by expectMenuRan's
    // shared `Choice [1/2]` literal — coverage of a helper across nine cases,
    // not of the acceptance criterion. This case deliberately does NOT call
    // expectMenuRan, so restoring `[3]` reddens HERE, on its own, and the
    // mutation run proves that rather than the helper firing again.
    const home = newSandbox()
    const r = runScript(INSTALL, home, { env: mcpYes, path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    // Bound the slice to the menu itself: `[3] Skip no longer exists` is a
    // legitimate string elsewhere in the script (the `3`-keypress notice), so
    // an unbounded search would be both flaky and wrong.
    const start = r.out.indexOf('Register rsct-mcp with Claude Code now?')
    const end = r.out.indexOf('Choice [1/2]')
    expect(start, r.out).toBeGreaterThan(-1)
    expect(end, r.out).toBeGreaterThan(start)
    const menu = r.out.slice(start, end)
    const options = (menu.match(/^\s*\[\d\]/gm) ?? []).map((s) => s.trim())
    expect(options, 'exactly two options, numbered 1 and 2').toEqual(['[1]', '[2]'])
    expect(menu, 'no [3] may survive anywhere in the rendered menu').not.toMatch(/\[3\]/)
    expect(r.out, r.out).toMatch(/Choice \[1\/2\] \(default: 1\)/)
  }, 60_000)

  it('[2] + consent removes the user-scope entry and records project', () => {
    // AC 2/9. Three mutations turn this red, and each needs its own assertion:
    //   - delete the `claude mcp remove` call   -> stub log has no `mcp remove`
    //   - keep writing the marker up-front      -> marker would be project even
    //                                              on the paths below
    //   - skip the removal but record project   -> mcpServers.rsct survives
    const home = newSandbox()
    seedScope(home, 'user\n')
    seedHostConfig(home, USER_ENTRY)
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('2', 'y') })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '1')
    // The consent was actually asked, and named the consequence before acting.
    expect(r.out, r.out).toMatch(/affects EVERY project on this machine/)
    expect(stubClaudeLog(home), 'the CLI must own the removal').toMatch(/mcp remove rsct --scope user/)
    expect(hostConfig(home).mcpServers?.rsct, 'user-scope entry should be gone').toBeUndefined()
    expect(readScope(home)).toBe('project')
    expect(r.out).toMatch(/project scope is now effective/)
  }, 60_000)

  it('[2] + decline records user, never project, and removes nothing', () => {
    // AC 4 — the subtle one. Recording `project` here reproduces the exact
    // defect this issue exists to remove, with consent attached to it.
    const home = newSandbox()
    seedScope(home, 'user\n')
    seedHostConfig(home, USER_ENTRY)
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('2', 'n') })
    expect(r.ok, r.out).toBe(true)
    expect(readScope(home), 'declining must not record project').toBe('user')
    expect(stubClaudeLog(home)).not.toMatch(/mcp remove/)
    expect(hostConfig(home).mcpServers?.rsct, 'entry must survive a decline').toBeDefined()
    expect(r.out).toMatch(/Kept the user-scope entry/)
  }, 60_000)

  it('[2] + consent but a LYING CLI records user, not project', () => {
    // Kills "drop the re-verify". STUB_CLAUDE_LIE exits 0 and mutates nothing —
    // exactly the shape install.sh used to trust. Without the re-verify the
    // marker says `project` while user scope still resolves: #73, reintroduced.
    const home = newSandbox()
    seedScope(home, 'user\n')
    seedHostConfig(home, USER_ENTRY)
    const r = runScript(INSTALL, home, {
      env: { ...mcp, STUB_CLAUDE_LIE: '1' },
      path: newStubBin(),
      input: keys('2', 'y'),
    })
    expect(r.ok, r.out).toBe(true)
    expect(stubClaudeLog(home), 'the CLI WAS called').toMatch(/mcp remove rsct --scope user/)
    expect(hostConfig(home).mcpServers?.rsct, 'the lie: nothing was removed').toBeDefined()
    expect(readScope(home), 'must record what is TRUE, not what the CLI claimed').toBe('user')
    expect(r.out).toMatch(/could not be removed \(or is still present\)/)
  }, 60_000)

  it('RSCT_ASSUME_YES never removes, and leaves the marker alone', () => {
    // AC 5. EVERY assertion this case used to make was blind to the mutation it
    // claimed to kill, and the mutation harness proved it: both
    // `SCOPE_EFFECTIVE="unattended"` -> `="project"` and DELETING the assignment
    // SURVIVED. The old comment said the byte-identical host config was what
    // killed them. It is not:
    //   - `="project"` takes the project arm, which writes `project` to the
    //     marker — and the seed ALREADY says `project`, so readScope agrees.
    //     It removes nothing either, so the host config is untouched too.
    //   - deleting the assignment leaves it EMPTY, which wrote nothing and
    //     printed the same "left unchanged" line the correct path prints.
    // The only falsifiable signal is WHICH ARM RAN, so that is what is asserted:
    // install.sh now gives `unattended` its own arm and makes the empty case a
    // loud INTERNAL error. Both mutations are red here, verified by mutation.
    const home = newSandbox()
    seedScope(home, 'project\n')
    seedHostConfig(home, USER_ENTRY)
    const before = hostConfigRaw(home)
    const r = runScript(INSTALL, home, { env: mcpYes, path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '2')
    expect(hostConfigRaw(home), 'unattended runs must not touch the host config').toBe(before)
    expect(stubClaudeLog(home)).not.toMatch(/mcp remove/)
    expect(readScope(home)).toBe('project')
    expect(r.out).toMatch(/nothing was removed and the/)
    // The unattended arm, positively identified.
    expect(r.out, r.out).toMatch(/Recorded scope left unchanged \(project\)/)
    // Falls through to the project arm -> announces a selection that never happened.
    expect(r.out, 'unattended must not take the project arm').not.toMatch(/Project scope (kept|selected)/)
    // Assignment deleted -> empty -> the unreachable arm.
    expect(r.out, 'no arm may leave SCOPE_EFFECTIVE unset').not.toMatch(/INTERNAL: no scope decision/)
  }, 60_000)

  it('never writes the host config itself — formatting canaries survive', () => {
    // AC 7, in the form option B allows: install.sh delegates every host-config
    // MUTATION to the CLI and only ever READS the file. The canaries (4-space
    // indent, no space after a colon) are what a JSON.parse -> JSON.stringify
    // round-trip would normalise, so re-introducing a direct write is red here.
    //
    // expectMenuRan is NOT optional here. Both assertions below are also
    // satisfied by a run in which the MCP branch never executed at all — the
    // marker is only ever written inside the menu, so a seeded value survives
    // any short-circuit, and a file install.sh never writes is trivially
    // unchanged. Without a positive reachability proof this case passes green
    // against a completely dead branch.
    const home = newSandbox()
    seedScope(home, 'project\n')
    const canary = '{\n    "numStartups":9,\n    "projects": {\n        "/tmp/p":{"enabledMcpjsonServers":[]}\n    }\n}\n'
    seedHostConfig(home, canary)
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('2') })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '2')
    expect(r.out, r.out).toMatch(/Project scope (kept|selected)/)
    expect(readScope(home)).toBe('project')
    expect(hostConfigRaw(home), 'install.sh must never rewrite the host config').toBe(canary)
  }, 60_000)

  it('a headless run (no stdin, no RSCT_ASSUME_YES) still CANCELS', () => {
    // Rv BLOCKER, and a regression this fix introduced before the review caught
    // it. `Proceed? [y/N]` displays N but passes a coded default of "y", so an
    // unconditional EOF fallback in read_or_default turned
    // `bash install.sh </dev/null` into a full unattended install: global
    // `npm install -g`, `claude mcp add --scope user`, and on a team machine a
    // recorded `project` silently rewritten to `user` — with none of the
    // RSCT_ASSUME_YES guards firing, because ASSUME_YES was never set.
    // Mutation: drop the `__rod_eof_ok` gate and make the fallback
    // unconditional again.
    const home = newSandbox()
    seedScope(home, 'project\n')
    const r = runScript(INSTALL, home, {
      env: { ...mcp, RSCT_SKIP_MCP: '1' }, // no stub needed: nothing may run
      input: '',
    })
    // `set -e` turns the refusal into a non-zero exit — that IS the documented
    // pre-#73 behaviour, and the point is that it is preserved.
    expect(r.ok, `must NOT complete a full install headlessly:\n${r.out}`).toBe(false)
    expect(r.out, r.out).toMatch(/stdin closed with no answer — cancelling/)
    expect(r.out, r.out).not.toMatch(/Choice \[1\/2\]/)
    expect(r.out, r.out).not.toMatch(/MANUAL STEPS STILL REQUIRED/)
    expect(readScope(home), 'a cancelled run must not touch the marker').toBe('project')
  }, 60_000)

  it('the consent prompt alone survives EOF, and defaults to keeping the entry', () => {
    // The positive control for the case above: the opt-in fallback must still
    // work where it was actually needed, or the fix would just be a revert.
    // Mutation: remove the `eof-ok` argument at the consent call site.
    const home = newSandbox()
    seedScope(home, 'user\n')
    seedHostConfig(home, USER_ENTRY)
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('2') })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/stdin closed — taking the default/)
    expect(readScope(home)).toBe('user')
    expect(hostConfig(home).mcpServers?.rsct).toBeDefined()
  }, 60_000)

  it('a CLI that acts and then exits non-zero is believed by the PROBE, not the exit code', () => {
    // Rv BLOCKER. The re-verify was gated on the CLI having reported success,
    // which falsifies success but never failure. A `claude` that removes the
    // entry and exits non-zero — this file documents those exit codes differing
    // across Windows wrapper variants — left the marker recording `user` on a
    // machine where rsct was then registered NOWHERE.
    // Mutation: re-gate the probe on the CLI's exit code.
    const home = newSandbox()
    seedScope(home, 'user\n')
    seedHostConfig(home, USER_ENTRY)
    const r = runScript(INSTALL, home, {
      env: { ...mcp, STUB_CLAUDE_ACT_THEN_FAIL: '1' },
      path: newStubBin(),
      input: keys('2', 'y'),
    })
    expect(r.ok, r.out).toBe(true)
    expect(stubClaudeLog(home)).toMatch(/mcp remove rsct --scope user/)
    expect(hostConfig(home).mcpServers?.rsct, 'the CLI really did remove it').toBeUndefined()
    expect(readScope(home), 'the probe saw it gone, so project scope IS effective').toBe('project')
  }, 60_000)

  it('[1] with a CLI that adds and then exits non-zero still records user', () => {
    // The same defect on the other side of the menu: the entry is live, the
    // installer used to deny it ("NOT registered at user scope") and leave the
    // marker on `project` — #73 reproduced with the fix installed.
    const home = newSandbox()
    seedScope(home, 'project\n')
    const r = runScript(INSTALL, home, {
      env: { ...mcp, STUB_CLAUDE_ACT_THEN_FAIL: '1' },
      path: newStubBin(),
      input: keys('1'),
    })
    expect(r.ok, r.out).toBe(true)
    expect(hostConfig(home).mcpServers?.rsct, 'the CLI really did add it').toBeDefined()
    expect(readScope(home)).toBe('user')
    expect(r.out).not.toMatch(/is NOT registered at user scope/)
  }, 60_000)

  it('[1] over a recorded project scope says the marker is being replaced', () => {
    // "no change" was the whole output when the entry already existed — while
    // the marker flipped project -> user and /rsct-setup stopped maintaining
    // every committed .mcp.json. That is #71's silent replacement, reached on
    // purpose instead of by a typo.
    const home = newSandbox()
    seedScope(home, 'project\n')
    seedHostConfig(home, USER_ENTRY)
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('1') })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/Recorded scope changes 'project' → 'user'/)
    expect(readScope(home)).toBe('user')
  }, 60_000)

  it('reports a project that is registered but not approved, not just a missing .mcp.json', () => {
    // The pending report named the wrong set: it listed projects with NO
    // .mcp.json, while the ones the removal actually breaks are those that HAVE
    // one and are unapproved — every project a legacy CAP-48 machine set up
    // while the masking user entry made them work. Both are asserted in one
    // run, so neither half can pass by the report being deleted.
    const home = newSandbox()
    const registeredNotApproved = join(home, 'p-reg').replace(/\\/g, '/')
    const noMcpJson = join(home, 'p-none').replace(/\\/g, '/')
    const notRsct = join(home, 'p-other').replace(/\\/g, '/')
    for (const p of [registeredNotApproved, noMcpJson, notRsct]) {
      mkdirSync(p, { recursive: true })
      writeFileSync(join(p, '.rsct.json'), '{}\n')
    }
    writeFileSync(join(registeredNotApproved, '.mcp.json'), '{"mcpServers":{"rsct":{"command":"rsct-mcp","args":[]}}}\n')
    // Fully working: registered AND approved — must NOT be listed.
    const working = join(home, 'p-ok').replace(/\\/g, '/')
    mkdirSync(join(working, '.claude'), { recursive: true })
    writeFileSync(join(working, '.rsct.json'), '{}\n')
    writeFileSync(join(working, '.mcp.json'), '{"mcpServers":{"rsct":{"command":"rsct-mcp","args":[]}}}\n')
    writeFileSync(join(working, '.claude', 'settings.local.json'), '{"enabledMcpjsonServers":["rsct"]}\n')
    // A directory the host knows but RSCT never touched — must NOT be listed.
    rmSync(join(notRsct, '.rsct.json'))

    seedScope(home, 'project\n')
    seedHostConfig(home, JSON.stringify({
      projects: Object.fromEntries([registeredNotApproved, noMcpJson, notRsct, working].map((p) => [p, {}])),
    }, null, 2))
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('2') })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '2')
    expect(r.out, r.out).toMatch(/p-reg\s+\(registered, not approved\)/)
    expect(r.out, r.out).toMatch(/p-none\s+\(no \.mcp\.json\)/)
    expect(r.out, r.out).not.toMatch(/p-ok/)
    expect(r.out, r.out).not.toMatch(/p-other/)
  }, 60_000)

  it('[1] does not record user when registration did not land', () => {
    // AC 3's failure path. This arm used to write `user` BEFORE it even tried,
    // so `claude` missing or an add that failed left the marker claiming a scope
    // that does not resolve — and /rsct-setup then stopped maintaining the
    // team's .mcp.json. Mutation: move the marker write back above the add.
    const home = newSandbox()
    seedScope(home, 'project\n')
    const r = runScript(INSTALL, home, {
      env: { ...mcp, STUB_CLAUDE_FAIL: '1' },
      path: newStubBin(),
      input: keys('1'),
    })
    expect(r.ok, r.out).toBe(true)
    expect(readScope(home), 'a failed add must not be recorded as user scope').toBe('project')
    expect(r.out).toMatch(/is NOT registered at user scope/)
  }, 60_000)

  it('[1] records user once the entry is verified present', () => {
    // The positive control for the case above: same arm, working CLI. Without
    // it, "does not record user" would also pass if [1] were deleted entirely.
    const home = newSandbox()
    seedScope(home, 'project\n')
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('1') })
    expect(r.ok, r.out).toBe(true)
    expect(stubClaudeLog(home)).toMatch(/mcp add rsct rsct-mcp --scope user/)
    expect(hostConfig(home).mcpServers?.rsct).toBeDefined()
    expect(readScope(home)).toBe('user')
  }, 60_000)

  it('a `3` keypress is announced on a FRESH machine, not silently taken as [1]', () => {
    // README told every teammate to press [3]; muscle memory outlives a menu.
    // The pre-#73 `*)` notice is gated on a recorded scope, so on a teammate's
    // fresh machine there was NOTHING on screen while user scope got registered
    // — masking the .mcp.json their repo shares. Mutation: delete the `3`
    // normalisation and let it fall through to `*)`.
    const home = newSandbox() // no seedScope: fresh machine, no marker
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('3') })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/\[3\] Skip no longer exists/)
    expect(readScope(home)).toBe('user')
  }, 60_000)

  it('survives stdin running out at the second prompt', () => {
    // Measured: two `read -r` with one line of stdin -> rc=1 under `set -e`, no
    // epilogue, marker unwritten. Harmless while the script asked one question
    // per branch; [2] now asks two. Mutation: remove the EOF arm in
    // read_or_default. The consent line is deliberately NOT supplied.
    const home = newSandbox()
    seedScope(home, 'user\n')
    seedHostConfig(home, USER_ENTRY)
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('2') })
    expect(r.ok, r.out).toBe(true)
    // Reached the end of the script rather than dying at the prompt.
    expect(r.out, r.out).toMatch(/MANUAL STEPS STILL REQUIRED/)
    // EOF took the documented default of the consent prompt, which is "no".
    expect(readScope(home)).toBe('user')
    expect(hostConfig(home).mcpServers?.rsct).toBeDefined()
  }, 60_000)

  it('honours CLAUDE_CONFIG_DIR when it points somewhere other than HOME', () => {
    // The divergence three V lenses converged on: detection read $HOME while the
    // removal went through a Node CLI reading os.homedir()/CLAUDE_CONFIG_DIR.
    // When they disagree, [2] skips the consent entirely and records `project`
    // with the user-scope entry still live — #73 with the fix installed.
    // Mutation: revert HOST_CFG to a hardcoded "$HOME/.claude.json".
    const home = newSandbox()
    const cfgDir = newSandbox()
    seedScope(home, 'user\n')
    seedHostConfig(cfgDir, USER_ENTRY) // the entry lives ONLY in the other dir
    const r = runScript(INSTALL, home, {
      env: { ...mcp, CLAUDE_CONFIG_DIR: cfgDir.replace(/\\/g, '/') },
      path: newStubBin(),
      input: keys('2', 'y'),
    })
    expect(r.ok, r.out).toBe(true)
    // It found the entry in CLAUDE_CONFIG_DIR, so it asked before acting…
    expect(r.out, r.out).toMatch(/affects EVERY project on this machine/)
    // …and removed it there.
    expect(hostConfig(cfgDir).mcpServers?.rsct).toBeUndefined()
    expect(readScope(home)).toBe('project')
  }, 60_000)
})

describe('architectural boundary — rsct-mcp does not know the host config (#73)', () => {
  // install.sh knows about Claude Code's own config and may continue to: it is
  // the installer, it runs once, and the CLI owns the format. The SERVER must
  // not. It runs inside every session of every project; a host-config reference
  // there is a machine-wide side effect reachable from a tool call.
  //
  // Tokens are pinned as a named constant, and the negative assertion is paired
  // with a positive control in the same file: a pattern that matches nothing
  // passes this test for a typo just as happily as for a clean tree, which is
  // the class of assertion that cannot fail.
  const HOST_TOKENS = [
    'mcpServers',
    'enabledMcpjsonServers',
    'disabledMcpjsonServers',
    '.claude.json',
    'mcp-scope',
    'CLAUDE_CONFIG_DIR',
  ]
  const SRC = resolve(ROOT, 'mcp-server', 'src')

  // Parameterised on the directory ON PURPOSE: a scanner that is only ever
  // pointed at the tree it must find nothing in cannot be shown to find
  // anything. The positive control below runs THIS function against a seeded
  // fixture, which is the only way the walk, the extension filter and the
  // match are proven as a composition rather than one at a time.
  function scanSrc(dir: string): string[] {
    const hits: string[] = []
    for (const rel of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const abs = join(dir, rel)
      if (!statSync(abs).isFile() || !/\.(ts|js|mjs|cjs)$/.test(rel)) continue
      const text = readFileSync(abs, 'utf8')
      text.split('\n').forEach((line, i) => {
        for (const t of HOST_TOKENS) {
          if (line.includes(t)) hits.push(`${rel}:${i + 1} [${t}] ${line.trim().slice(0, 90)}`)
        }
      })
    }
    return hits
  }

  it('mcp-server/src/ holds zero host-config references', () => {
    const hits = scanSrc(SRC)
    expect(hits, `host-config knowledge leaked into the MCP server:\n${hits.join('\n')}`).toEqual([])
  })

  it('positive control — scanSrc itself finds every token in a seeded tree', () => {
    // The old control asserted two things SEPARATELY: that each token matches a
    // synthetic string, and that the src/ walk sees >10 .ts files. Neither runs
    // scanSrc against anything that ought to produce a hit, so the whole
    // composition was unproven — a defect in the extension regex (it is applied
    // to `rel`, which is backslash-joined on Windows), in the statSync branch,
    // or in the push would leave scanSrc returning [] and the assertion above
    // passing against a scanner that can no longer find anything.
    const fixture = newSandbox()
    mkdirSync(join(fixture, 'deep', 'nested'), { recursive: true })
    HOST_TOKENS.forEach((t, i) => {
      // One token per file, and nested, so the recursive walk is exercised too.
      writeFileSync(join(fixture, 'deep', 'nested', `f${i}.ts`), `export const x = { "${t}": 1 }\n`)
    })
    // Same tokens in a file the extension filter must SKIP — otherwise a filter
    // that matched everything would also pass.
    writeFileSync(join(fixture, 'deep', 'nested', 'readme.md'), HOST_TOKENS.join('\n'))

    const hits = scanSrc(fixture)
    for (const t of HOST_TOKENS) {
      expect(hits.some((h) => h.includes(`[${t}]`)), `${t} must be found by the scanner itself`).toBe(true)
    }
    // No pinned token is a substring of another, so it is exactly one hit each.
    expect(hits.length, hits.join('\n')).toBe(HOST_TOKENS.length)
    expect(hits.some((h) => h.includes('readme.md')), 'non-source files must be skipped').toBe(false)

    // And the real tree is genuinely being walked, not silently empty.
    const scanned = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((rel) => /\.ts$/.test(rel))
    expect(scanned.length, 'the src/ walk must find TypeScript files').toBeGreaterThan(10)
  })
})
