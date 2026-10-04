import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync, readdirSync, statSync, symlinkSync, lstatSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, delimiter } from 'node:path'
import { bashAvailable, repoRoot } from './lib/bash-lint.js'
import { bashBin } from './lib/resolve-bash.js'

const BASH = bashAvailable()
const ROOT = repoRoot(__dirname)
const INSTALL = resolve(ROOT, 'scripts', 'install.sh')
const UNINSTALL = resolve(ROOT, 'scripts', 'uninstall-framework.sh')

const RUNTIME_DIRS = ['prompts', 'rules', 'doc-templates', 'memory-templates', 'universe-templates']
const COMMANDS = ['rsct-setup', 'rsct-universe', 'rsct-uninstall', 'rsct-clean-code']
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
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

interface RunOpts {
  env?: Record<string, string | undefined>
  path?: string
  input?: string
  timeoutMs?: number
}

type Env = Record<string, string | undefined>

function overlayEnv(base: Env, overrides: Env): Env {
  const replaced = new Set(Object.keys(overrides).map((key) => key.toLowerCase()))
  const kept = Object.entries(base).filter(([key]) => !replaced.has(key.toLowerCase()))
  return { ...Object.fromEntries(kept), ...overrides }
}

const inheritedPath = () =>
  Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''

function runScript(script: string, home: string, opts: RunOpts = {}): { ok: boolean; out: string } {
  const sandbox = home.replace(/\\/g, '/')
  const env = overlayEnv(process.env, {
    HOME: sandbox,
    USERPROFILE: sandbox,
    CLAUDE_CONFIG_DIR: sandbox,
    npm_config_prefix: `${sandbox}/npm-global`,
    RSCT_ASSUME_YES: '1',
    RSCT_SKIP_MCP: '1',
    ...opts.env,
    ...(opts.path ? { PATH: `${opts.path}${delimiter}${inheritedPath()}` } : {}),
  })
  if (!env.RSCT_SKIP_MCP) {
    if (!opts.path) {
      throw new Error(
        'runScript: RSCT_SKIP_MCP was cleared without a stub bin dir — refusing to run. ' +
          'The MCP branch would reach the REAL `npm` and `claude`. Pass `path: newStubBin()`.',
      )
    }
    for (const key of ['USERPROFILE', 'CLAUDE_CONFIG_DIR', 'npm_config_prefix'] as const) {
      if (!env[key] || !env[key]!.includes('rsct-install-')) {
        throw new Error(
          `runScript: ${key} does not point into a test sandbox (${env[key]}) — refusing to run. ` +
            'A real `claude` or `npm` would reach the developer\'s own machine.',
        )
      }
    }
  }
  try {
    const out = execFileSync(bashBin(), [script], {
      env,
      encoding: 'utf8',
      stdio: opts.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      ...(opts.input === undefined ? {} : { input: opts.input }),
      timeout: opts.timeoutMs ?? 45_000,
      killSignal: 'SIGKILL',
    })
    return { ok: true, out }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}` }
  }
}

const STUB_CLAUDE = [
  '#!/bin/sh',
  'CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME}"',
  'CFG="$CFG_DIR/.claude.json"',
  'echo "STUB-CLAUDE $*" >> "$CFG_DIR/stub-claude.log"',
  'if [ -n "$STUB_CLAUDE_FAIL" ]; then exit 1; fi',
  'if [ -n "$STUB_CLAUDE_LIE" ]; then exit 0; fi',
  'cat >/dev/null 2>&1 || true',
  'case "$1 $2 $3" in',
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

const STUB_NPM = [
  '#!/bin/sh',
  'echo "STUB-NPM $* (cwd=$PWD)"',
  'if [ -n "$STUB_NPM_FAIL" ]; then exit 1; fi',
  'exit 0',
  '',
].join('\n')

const STUB_RSCT_MCP = [
  '#!/bin/sh',
  'echo "STUB-RSCT-MCP stdin=$(cat | wc -c | tr -d " ")" >> "$(dirname "$0")/rsct-mcp.log"',
  'if [ -n "$STUB_RSCT_MCP_FAIL" ]; then exit 1; fi',
  'exit 0',
  '',
].join('\n')
const STARTED_ONCE_WITH_NO_INPUT = 'STUB-RSCT-MCP stdin=0'

const STUB_REASON: Record<string, string> = {
  npm: 'A real `npm install -g .` would repoint the machine-global rsct-mcp.',
  claude: 'A real `claude mcp remove rsct --scope user` would de-register rsct on this machine.',
  'rsct-mcp': 'The scripts would resolve, and could start, the rsct-mcp installed on this machine.',
}

function newStubBin(opts: { realNpm?: boolean; withoutCommand?: boolean } = {}): string {
  const dir = newSandbox()
  const stubs: Record<string, string> = opts.realNpm
    ? { claude: STUB_CLAUDE }
    : { npm: STUB_NPM, claude: STUB_CLAUDE, ...(opts.withoutCommand ? {} : { 'rsct-mcp': STUB_RSCT_MCP }) }
  for (const [bin, body] of Object.entries(stubs)) {
    writeFileSync(join(dir, bin), body)
    chmodSync(join(dir, bin), 0o755)
  }

  for (const bin of Object.keys(stubs)) {
    const resolved = execFileSync(bashBin(), ['-c', `command -v ${bin}`], {
      env: overlayEnv(process.env, { PATH: `${dir}${delimiter}${inheritedPath()}` }),
      encoding: 'utf8',
    }).trim()
    if (!resolved.includes('rsct-install-')) {
      throw new Error(
        `stub ${bin} did not win PATH resolution (got "${resolved}") — refusing to run. ` +
          STUB_REASON[bin] +
          ' Most likely cause: TMPDIR mounted noexec.',
      )
    }
  }
  return dir
}

const stubMcpLog = (stub: string) => {
  const p = join(stub, 'rsct-mcp.log')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

function seedHostConfig(home: string, raw: string): void {
  writeFileSync(join(home, '.claude.json'), raw, 'utf8')
}
const hostConfigRaw = (home: string) => readFileSync(join(home, '.claude.json'), 'utf8')
const hostConfig = (home: string) => JSON.parse(hostConfigRaw(home)) as {
  mcpServers?: Record<string, unknown>
  projects?: Record<string, { enabledMcpjsonServers?: string[] }>
}
const USER_ENTRY = '{\n  "mcpServers": {\n    "rsct": {\n      "command": "rsct-mcp",\n      "args": []\n    }\n  }\n}\n'
function stubClaudeLog(home: string): string {
  const p = join(home, 'stub-claude.log')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

function expectMenuRan(out: string, expectedDefault: string): void {
  expect(out, out).toMatch(new RegExp(`Choice \\[1/2\\] \\(default: ${expectedDefault}\\)`))
  expect(out, out).not.toMatch(/\[3\] Skip/)
  expect(out, out).toMatch(/STUB-NPM install -g \./)
  expect(out).not.toMatch(/Skipping rsct-mcp companion/)
  expect(out).not.toMatch(/rsct-mcp install failed/)
}

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
    const installedVersion = readFileSync(join(rsctHome(home), 'VERSION'), 'utf8').replace(/\r/g, '').trim()
    const sourceVersion = readFileSync(join(ROOT, 'VERSION'), 'utf8').replace(/\r/g, '').trim()
    expect(installedVersion, 'installed ~/.rsct/VERSION should equal source /VERSION').toBe(sourceVersion)
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
    for (const c of LEGACY_COMMANDS) {
      expect(existsSync(join(commandsDir(home), `${c}.md`)), `legacy ${c}.md should be absent`).toBe(false)
    }
    expect(r.out).toMatch(/Skipping rsct-mcp companion/)
  }, 60_000)

  it('re-run is non-destructive (UPDATE path, no duplication/corruption)', () => {
    const home = newSandbox()
    expect(runScript(INSTALL, home).ok).toBe(true)
    const second = runScript(INSTALL, home)
    expect(second.ok, second.out).toBe(true)
    expect(second.out).toMatch(/Existing/)
    for (const c of COMMANDS) {
      expect(existsSync(join(commandsDir(home), `${c}.md`))).toBe(true)
    }
    expect(existsSync(join(rsctHome(home), 'prompts', '01-setup.md'))).toBe(true)
  }, 90_000)

  it('fresh install reports the code axis as none, not as a broken marker', () => {
    const home = newSandbox()
    const r = runScript(INSTALL, home)
    expect(r.ok, r.out).toBe(true)
    expect(r.out).toMatch(/Existing code\s*: none \(fresh install\)/)
    expect(r.out).not.toMatch(/unreadable/)
  }, 60_000)

  it('a real code-version bump is reported as drift, not as "same"', () => {
    const home = newSandbox()
    expect(runScript(INSTALL, home).ok).toBe(true)
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
    writeFileSync(
      join(rsctHome(home), 'VERSION-CODE'),
      ' * The rsct-mcp server version (CODE axis) — the bundled `RSCT_MCP_VERSION` literal\n',
      'utf8',
    )
    const r = runScript(INSTALL, home)
    expect(r.ok, r.out).toBe(true)
    expect(r.out).toMatch(/Existing code\s*: unreadable/)
    expect(r.out).not.toMatch(/the bundled/)
    const healed = readFileSync(join(rsctHome(home), 'VERSION-CODE'), 'utf8').trim()
    expect(healed).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/)
  }, 90_000)

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

    expect(out, out).toMatch(/global rsct-mcp at .*\(left untouched; --skip-mcp set\)/)
    expect(out).not.toMatch(/will ask separately/)
    expect(out).not.toMatch(/Removed global rsct-mcp/)
  }, 60_000)
})

describe.skipIf(!BASH)('install.sh reads ~/.rsct/mcp-scope as the menu default (#71)', () => {
  const mcpEnv = (_home: string) => ({ RSCT_SKIP_MCP: undefined as string | undefined })

  it('keeps a recorded "project" on an unattended re-run', () => {
    const home = newSandbox()
    seedScope(home, 'project\n')
    const r = runScript(INSTALL, home, { env: mcpEnv(home), path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '2')
    expect(readScope(home)).toBe('project')
    expect(r.out).toMatch(/\(current: project/)
    expect(r.out).toMatch(/Project scope kept/)
  }, 60_000)

  it('keeps a recorded "user" — the arm a project/skip-only suite cannot see', () => {
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
    const home = newSandbox()
    seedScope(home, 'skip\n')
    const r = runScript(INSTALL, home, { env: mcpEnv(home), path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '1')
    expect(r.out, r.out).toMatch(/'skip' is legacy/)
    expect(r.out).not.toMatch(/unrecognized/)
    expect(r.out).not.toMatch(/press Enter to keep it/)
    expect(stubClaudeLog(home), 'the CLI must not be invoked at all').not.toMatch(/mcp add/)
    expect(r.out).toMatch(/registering nothing/)
    expect(readScope(home)).toBe('skip')
  }, 60_000)

  it('still defaults a FRESH install to user scope', () => {
    const home = newSandbox()
    const r = runScript(INSTALL, home, { env: mcpEnv(home), path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '1')
    expect(readScope(home)).toBe('user')
    expect(r.out).not.toMatch(/press Enter to keep it/)
  }, 60_000)

  it('reads a marker whose value carries a CR', () => {
    const home = newSandbox()
    seedScope(home, 'pro\rject\n')
    const r = runScript(INSTALL, home, { env: mcpEnv(home), path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '2')
    expect(readScope(home)).toBe('project')
  }, 60_000)

  it('announces the replacement when a typo overwrites a recorded scope', () => {
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
  const mcp = { RSCT_SKIP_MCP: undefined as string | undefined, RSCT_ASSUME_YES: undefined as string | undefined }
  const mcpYes = { RSCT_SKIP_MCP: undefined as string | undefined }
  const keys = (...rest: string[]) => `y\n\n${rest.join('\n')}\n`

  it('AC 1 — the menu renders exactly two options, and no [3] anywhere', () => {
    const home = newSandbox()
    const r = runScript(INSTALL, home, { env: mcpYes, path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
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
    const home = newSandbox()
    seedScope(home, 'user\n')
    seedHostConfig(home, USER_ENTRY)
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('2', 'y') })
    expect(r.ok, r.out).toBe(true)
    expectMenuRan(r.out, '1')
    expect(r.out, r.out).toMatch(/affects EVERY project on this machine/)
    expect(stubClaudeLog(home), 'the CLI must own the removal').toMatch(/mcp remove rsct --scope user/)
    expect(hostConfig(home).mcpServers?.rsct, 'user-scope entry should be gone').toBeUndefined()
    expect(readScope(home)).toBe('project')
    expect(r.out).toMatch(/project scope is now effective/)
  }, 60_000)

  it('[2] + decline records user, never project, and removes nothing', () => {
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
    expect(r.out, r.out).toMatch(/Recorded scope left unchanged \(project\)/)
    expect(r.out, 'unattended must not take the project arm').not.toMatch(/Project scope (kept|selected)/)
    expect(r.out, 'no arm may leave SCOPE_EFFECTIVE unset').not.toMatch(/INTERNAL: no scope decision/)
  }, 60_000)

  it('never writes the host config itself — formatting canaries survive', () => {
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
    const home = newSandbox()
    seedScope(home, 'project\n')
    const r = runScript(INSTALL, home, {
      env: { ...mcp, RSCT_SKIP_MCP: '1' },
      input: '',
    })
    expect(r.ok, `must NOT complete a full install headlessly:\n${r.out}`).toBe(false)
    expect(r.out, r.out).toMatch(/stdin closed with no answer — cancelling/)
    expect(r.out, r.out).not.toMatch(/Choice \[1\/2\]/)
    expect(r.out, r.out).not.toMatch(/MANUAL STEPS STILL REQUIRED/)
    expect(readScope(home), 'a cancelled run must not touch the marker').toBe('project')
  }, 60_000)

  it('the consent prompt alone survives EOF, and defaults to keeping the entry', () => {
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
    const home = newSandbox()
    seedScope(home, 'project\n')
    seedHostConfig(home, USER_ENTRY)
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('1') })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/Recorded scope changes 'project' → 'user'/)
    expect(readScope(home)).toBe('user')
  }, 60_000)

  it('reports a project that is registered but not approved, not just a missing .mcp.json', () => {
    const home = newSandbox()
    const registeredNotApproved = join(home, 'p-reg').replace(/\\/g, '/')
    const noMcpJson = join(home, 'p-none').replace(/\\/g, '/')
    const notRsct = join(home, 'p-other').replace(/\\/g, '/')
    for (const p of [registeredNotApproved, noMcpJson, notRsct]) {
      mkdirSync(p, { recursive: true })
      writeFileSync(join(p, '.rsct.json'), '{}\n')
    }
    writeFileSync(join(registeredNotApproved, '.mcp.json'), '{"mcpServers":{"rsct":{"command":"rsct-mcp","args":[]}}}\n')
    const working = join(home, 'p-ok').replace(/\\/g, '/')
    mkdirSync(join(working, '.claude'), { recursive: true })
    writeFileSync(join(working, '.rsct.json'), '{}\n')
    writeFileSync(join(working, '.mcp.json'), '{"mcpServers":{"rsct":{"command":"rsct-mcp","args":[]}}}\n')
    writeFileSync(join(working, '.claude', 'settings.local.json'), '{"enabledMcpjsonServers":["rsct"]}\n')
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
    const home = newSandbox()
    seedScope(home, 'project\n')
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('1') })
    expect(r.ok, r.out).toBe(true)
    expect(stubClaudeLog(home)).toMatch(/mcp add rsct rsct-mcp --scope user/)
    expect(hostConfig(home).mcpServers?.rsct).toBeDefined()
    expect(readScope(home)).toBe('user')
  }, 60_000)

  it('a `3` keypress is announced on a FRESH machine, not silently taken as [1]', () => {
    const home = newSandbox()
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('3') })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/\[3\] Skip no longer exists/)
    expect(readScope(home)).toBe('user')
  }, 60_000)

  it('survives stdin running out at the second prompt', () => {
    const home = newSandbox()
    seedScope(home, 'user\n')
    seedHostConfig(home, USER_ENTRY)
    const r = runScript(INSTALL, home, { env: mcp, path: newStubBin(), input: keys('2') })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/MANUAL STEPS STILL REQUIRED/)
    expect(readScope(home)).toBe('user')
    expect(hostConfig(home).mcpServers?.rsct).toBeDefined()
  }, 60_000)

  it('honours CLAUDE_CONFIG_DIR when it points somewhere other than HOME', () => {
    const home = newSandbox()
    const cfgDir = newSandbox()
    seedScope(home, 'user\n')
    seedHostConfig(cfgDir, USER_ENTRY)
    const r = runScript(INSTALL, home, {
      env: { ...mcp, CLAUDE_CONFIG_DIR: cfgDir.replace(/\\/g, '/') },
      path: newStubBin(),
      input: keys('2', 'y'),
    })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/affects EVERY project on this machine/)
    expect(hostConfig(cfgDir).mcpServers?.rsct).toBeUndefined()
    expect(readScope(home)).toBe('project')
  }, 60_000)
})

const mcpHome = (home: string) => join(rsctHome(home), 'mcp-server')

function linkCommandToCopy(stub: string, home: string): void {
  mkdirSync(join(stub, 'node_modules'), { recursive: true })
  symlinkSync(mcpHome(home), join(stub, 'node_modules', 'rsct-mcp'), 'junction')
}

interface SourceTree {
  install: string
  pkg: string
  dist: string
}

function writeTreePackage(tree: SourceTree, files: string[]): void {
  writeFileSync(
    tree.pkg,
    JSON.stringify({ name: 'rsct-mcp', version: '9.9.9', bin: { 'rsct-mcp': './dist/index.js' }, files }, null, 2),
  )
}

function newSourceTree(files: string[], marker: string): SourceTree {
  const root = newSandbox()
  mkdirSync(join(root, 'scripts'))
  copyFileSync(INSTALL, join(root, 'scripts', 'install.sh'))
  writeFileSync(join(root, 'VERSION'), '9.9.9\n')
  for (const d of RUNTIME_DIRS) {
    mkdirSync(join(root, d))
    writeFileSync(join(root, d, 'placeholder.md'), 'x\n')
  }
  writeFileSync(join(root, 'prompts', '01-setup.md'), 'x\n')
  mkdirSync(join(root, 'mcp-server', 'dist'), { recursive: true })
  const tree: SourceTree = {
    install: join(root, 'scripts', 'install.sh'),
    pkg: join(root, 'mcp-server', 'package.json'),
    dist: join(root, 'mcp-server', 'dist', 'index.js'),
  }
  writeFileSync(tree.dist, `${marker}\n`)
  writeTreePackage(tree, files)
  return tree
}

function seedCompanion(home: string): void {
  mkdirSync(join(mcpHome(home), 'dist'), { recursive: true })
  writeFileSync(join(mcpHome(home), 'dist', 'index.js'), 'SEEDED\n')
  writeFileSync(join(mcpHome(home), 'package.json'), '{}\n')
}

function seedFramework(home: string): void {
  mkdirSync(join(rsctHome(home), 'prompts'), { recursive: true })
  writeFileSync(join(rsctHome(home), 'prompts', '01-setup.md'), 'x\n')
  writeFileSync(join(rsctHome(home), 'VERSION'), '9.9.9\n')
  writeFileSync(join(rsctHome(home), '.hidden'), 'x\n')
  writeFileSync(join(rsctHome(home), '..odd'), 'x\n')
}

function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

const FOREIGN_COMMAND = BASH
  ? execFileSync(bashBin(), ['-c', 'command -v rsct-mcp || true'], { env: process.env, encoding: 'utf8' }).trim()
  : ''

describe.skipIf(!BASH)('install.sh runs the companion from a copy it owns (#74)', () => {
  const mcpYes = { RSCT_SKIP_MCP: undefined as string | undefined }
  const copiedDist = (home: string) => readFileSync(join(mcpHome(home), 'dist', 'index.js'), 'utf8')

  it('copies package.json plus the files entries, and runs npm from that copy', () => {
    const home = newSandbox()
    mkdirSync(mcpHome(home), { recursive: true })
    writeFileSync(join(mcpHome(home), 'STALE.txt'), 'stale\n')
    mkdirSync(`${mcpHome(home)}.new`)
    writeFileSync(join(`${mcpHome(home)}.new`, 'STALE.txt'), 'left by an interrupted run\n')
    writeFileSync(`${mcpHome(home)}.old`, 'a leftover that is not a folder\n')
    const r = runScript(INSTALL, home, { env: mcpYes, path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/STUB-NPM install -g \. --install-links=false \(cwd=[^)]*\.rsct\/mcp-server\)/)
    expect(r.out, r.out).toMatch(/bash "[^"]*scripts\/uninstall-framework\.sh"/)
    const shipped = JSON.parse(readFileSync(join(ROOT, 'mcp-server', 'package.json'), 'utf8')).files as string[]
    expect(readdirSync(mcpHome(home)).sort()).toEqual(['package.json', ...shipped].sort())
    expect(readdirSync(rsctHome(home)).filter((entry) => entry.startsWith('mcp-server'))).toEqual(['mcp-server'])
  }, 60_000)

  it('reports the command as installed only after it proved to be the copy and started', () => {
    const home = newSandbox()
    const stub = newStubBin()
    linkCommandToCopy(stub, home)
    const tree = newSourceTree(['dist'], 'V1')
    const r = runScript(tree.install, home, { env: mcpYes, path: stub })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/✓ rsct-mcp installed\. The command runs from \S*\.rsct\/mcp-server/)
    expect(stubMcpLog(stub).trim(), 'the command must be started exactly once').toBe(STARTED_ONCE_WITH_NO_INPUT)
    expectMenuRan(r.out, '1')
  }, 60_000)

  it('starts the command without handing it the answers still waiting on stdin', () => {
    const home = newSandbox()
    const stub = newStubBin()
    linkCommandToCopy(stub, home)
    const tree = newSourceTree(['dist'], 'V1')
    const r = runScript(tree.install, home, {
      env: { ...mcpYes, RSCT_ASSUME_YES: undefined },
      path: stub,
      input: 'y\n\n2\n',
    })
    expect(r.ok, r.out).toBe(true)
    expect(stubMcpLog(stub).trim(), 'the menu answer must not reach the command').toBe(STARTED_ONCE_WITH_NO_INPUT)
    expect(r.out, r.out).toMatch(/Project scope selected/)
  }, 60_000)

  it('says the command did not start when it is the copy and exits non-zero', () => {
    const home = newSandbox()
    const stub = newStubBin()
    linkCommandToCopy(stub, home)
    const tree = newSourceTree(['dist'], 'V1')
    const r = runScript(tree.install, home, { env: { ...mcpYes, STUB_RSCT_MCP_FAIL: '1' }, path: stub })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/installed at \S*\.rsct\/mcp-server but did not start/)
    expect(r.out).not.toMatch(/✓ rsct-mcp installed/)
    expect(stubMcpLog(stub).trim()).toBe(STARTED_ONCE_WITH_NO_INPUT)
    expectMenuRan(r.out, '1')
  }, 60_000)

  it('names a command that is not the copy, and never starts it', () => {
    const home = newSandbox()
    const stub = newStubBin()
    const tree = newSourceTree(['dist'], 'V1')
    const r = runScript(tree.install, home, { env: mcpYes, path: stub })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/could not be confirmed to run from that copy:\s+\S*rsct-mcp/)
    expect(r.out).not.toMatch(/✓ rsct-mcp installed/)
    expect(stubMcpLog(stub), 'a command that is not the copy must not be started').toBe('')
    expectMenuRan(r.out, '1')
  }, 60_000)

  it.skipIf(FOREIGN_COMMAND !== '')('carries on, and says so, when no rsct-mcp is on PATH at all', () => {
    const tree = newSourceTree(['dist'], 'V1')
    const linked = runScript(tree.install, newSandbox(), { env: mcpYes, path: newStubBin({ withoutCommand: true }) })
    expect(linked.ok, linked.out).toBe(true)
    expect(linked.out, linked.out).toMatch(/could not be confirmed to run from that copy:\s+not found/)
    expectMenuRan(linked.out, '1')
    expect(linked.out, linked.out).toMatch(/MANUAL STEPS STILL REQUIRED/)

    const failed = runScript(tree.install, newSandbox(), {
      env: { ...mcpYes, STUB_NPM_FAIL: '1' },
      path: newStubBin({ withoutCommand: true }),
    })
    expect(failed.ok, failed.out).toBe(true)
    expect(failed.out, failed.out).toMatch(/could not be confirmed to run from it: not found/)
    expect(failed.out, failed.out).toMatch(/MANUAL STEPS STILL REQUIRED/)
  }, 90_000)

  it.skipIf(process.platform === 'win32')('recognises a command that is a symlink into the copy', () => {
    const home = newSandbox()
    const stub = newStubBin()
    rmSync(join(stub, 'rsct-mcp'))
    symlinkSync(join(mcpHome(home), 'dist', 'index.js'), join(stub, 'rsct-mcp'))
    const r = runScript(INSTALL, home, { env: mcpYes, path: stub })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/✓ rsct-mcp installed\. The command runs from/)
  }, 60_000)

  it('replaces a copy folder that is a link, and leaves the folder it pointed at alone', () => {
    const home = newSandbox()
    const other = newSandbox()
    writeFileSync(join(other, 'KEEP.txt'), 'keep\n')
    mkdirSync(rsctHome(home), { recursive: true })
    symlinkSync(other, mcpHome(home), 'junction')
    const tree = newSourceTree(['dist'], 'V1')
    const r = runScript(tree.install, home, { env: mcpYes, path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expect(existsSync(join(other, 'KEEP.txt')), 'the folder the link pointed at must keep its files').toBe(true)
    expect(lstatSync(mcpHome(home)).isSymbolicLink()).toBe(false)
    expect(copiedDist(home)).toBe('V1\n')
  }, 60_000)

  it('replaces a copy folder that is a link to nothing', () => {
    const home = newSandbox()
    mkdirSync(rsctHome(home), { recursive: true })
    symlinkSync(join(newSandbox(), 'gone'), mcpHome(home), 'junction')
    const tree = newSourceTree(['dist'], 'V1')
    const r = runScript(tree.install, home, { env: mcpYes, path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expect(r.out).not.toMatch(/rsct-mcp install failed/)
    expect(lstatSync(mcpHome(home)).isSymbolicLink()).toBe(false)
    expect(copiedDist(home)).toBe('V1\n')
  }, 60_000)

  it('keeps the previous copy when an update fails before the swap', () => {
    const home = newSandbox()
    const stub = newStubBin()
    linkCommandToCopy(stub, home)
    const tree = newSourceTree(['dist'], 'VERSION-ONE')
    const first = runScript(tree.install, home, { env: mcpYes, path: stub })
    expect(first.out, first.out).toMatch(/✓ rsct-mcp installed/)
    writeFileSync(tree.dist, 'VERSION-TWO\n')
    writeTreePackage(tree, ['no-such-entry', 'dist'])
    const second = runScript(tree.install, home, { env: mcpYes, path: stub })
    expect(second.ok, second.out).toBe(true)
    expect(second.out, second.out).toMatch(/rsct-mcp install failed/)
    expect(second.out, second.out).toMatch(/Nothing was replaced: the 'rsct-mcp' on your PATH still runs from the copy/)
    expect(copiedDist(home), 'the copy that was running must still be there').toBe('VERSION-ONE\n')
  }, 90_000)

  it('refuses a copy without dist/index.js before npm is reached', () => {
    const home = newSandbox()
    const tree = newSourceTree([], 'V1')
    const r = runScript(tree.install, home, { env: mcpYes, path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/rsct-mcp install failed/)
    expect(r.out, r.out).toMatch(/No copy of this version was put in \S*\.rsct\/mcp-server/)
    expect(r.out).not.toMatch(/Nothing was replaced/)
    expect(r.out).not.toMatch(/STUB-NPM install -g/)
    expect(present(mcpHome(home))).toBe(false)
  }, 60_000)

  it('tells a fresh machine the copy is in place and quotes the command that links it', () => {
    const home = newSandbox()
    const tree = newSourceTree(['dist'], 'V1')
    const r = runScript(tree.install, home, { env: { ...mcpYes, STUB_NPM_FAIL: '1' }, path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/rsct-mcp install failed/)
    expect(r.out, r.out).toMatch(/is this version, but the 'rsct-mcp'/)
    expect(r.out, r.out).toMatch(/could not be confirmed to run from it: \S*rsct-mcp/)
    expect(r.out).not.toMatch(/Common causes/)
    expect(r.out, r.out).toMatch(/cd "[^"]*\.rsct\/mcp-server" && sudo npm install -g \. --install-links=false/)
    expect(r.out).not.toMatch(/Choice \[1\/2\]/)
    expect(copiedDist(home)).toBe('V1\n')
  }, 60_000)

  it('tells an updated machine the command already runs from the new copy when npm fails', () => {
    const home = newSandbox()
    const stub = newStubBin()
    linkCommandToCopy(stub, home)
    const tree = newSourceTree(['dist'], 'V1')
    const r = runScript(tree.install, home, { env: { ...mcpYes, STUB_NPM_FAIL: '1' }, path: stub })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/rsct-mcp install failed/)
    expect(r.out, r.out).toMatch(/is this version, and the 'rsct-mcp'/)
    expect(r.out, r.out).toMatch(/so the companion is in place/)
    expect(r.out).not.toMatch(/sudo npm install/)
    expect(r.out).not.toMatch(/Common causes/)
    expect(stubMcpLog(stub), 'a failed install must not start the command').toBe('')
  }, 60_000)

  it('with a real npm: install, update and uninstall leave the machine as stated', () => {
    const home = newSandbox()
    const sandbox = home.replace(/\\/g, '/')
    const prefix = join(home, 'npm-global')
    const path = [newStubBin({ realNpm: true }), join(prefix, 'bin'), prefix].join(delimiter)
    const timeoutMs = 240_000
    const env = {
      RSCT_SKIP_MCP: undefined as string | undefined,
      npm_config_cache: `${sandbox}/npm-cache`,
      npm_config_userconfig: `${sandbox}/npmrc`,
      npm_config_globalconfig: `${sandbox}/npmrc-global`,
      npm_config_install_links: 'true',
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    }
    expect(existsSync(join(ROOT, 'mcp-server', 'dist', 'index.js')), 'no prebuilt dist: a real npm would build in the clone').toBe(true)
    const globalRoot = execFileSync(bashBin(), ['-c', 'npm root -g'], {
      env: overlayEnv(process.env, { ...env, npm_config_prefix: `${sandbox}/npm-global` }),
      encoding: 'utf8',
      timeout: timeoutMs,
    }).trim()
    expect(globalRoot, 'a real npm must be confined to the sandbox prefix').toContain('rsct-install-')
    const entry = join(globalRoot, 'rsct-mcp')
    const copy = () => realpathSync.native(mcpHome(home))

    const first = runScript(INSTALL, home, { env, path, timeoutMs })
    expect(first.ok, first.out).toBe(true)
    expect(first.out, first.out).toMatch(/✓ rsct-mcp installed\. The command runs from/)
    expect(lstatSync(entry).isSymbolicLink(), 'npm must link the global entry, not copy it').toBe(true)
    expect(realpathSync.native(entry)).toBe(copy())

    writeFileSync(join(mcpHome(home), 'STALE.txt'), 'stale\n')
    const second = runScript(INSTALL, home, { env, path, timeoutMs })
    expect(second.ok, second.out).toBe(true)
    expect(second.out, second.out).toMatch(/✓ rsct-mcp installed\. The command runs from/)
    expect(existsSync(join(mcpHome(home), 'STALE.txt'))).toBe(false)
    expect(realpathSync.native(entry)).toBe(copy())

    const removed = runScript(UNINSTALL, home, { env, path, timeoutMs })
    expect(removed.ok, removed.out).toBe(true)
    expect(present(rsctHome(home)), '~/.rsct should be gone').toBe(false)
    expect(present(entry), 'the global entry should be gone').toBe(false)
    for (const command of [join(prefix, 'rsct-mcp'), join(prefix, 'rsct-mcp.cmd'), join(prefix, 'bin', 'rsct-mcp')]) {
      expect(present(command), `${command} should be gone`).toBe(false)
    }
    expect(removed.out, removed.out).toMatch(
      FOREIGN_COMMAND ? /an rsct-mcp is still on PATH: / : /Removed global rsct-mcp\./,
    )
  }, 900_000)
})

describe.skipIf(!BASH)('uninstall-framework.sh treats the copy as part of the companion (#74)', () => {
  const reach = { RSCT_SKIP_MCP: undefined as string | undefined }
  const asked = { ...reach, RSCT_ASSUME_YES: undefined as string | undefined }
  const copyIntact = (home: string) => existsSync(join(mcpHome(home), 'dist', 'index.js'))

  it('keeping the companion keeps its folder and removes every other entry', () => {
    const home = newSandbox()
    seedFramework(home)
    seedCompanion(home)
    const r = runScript(UNINSTALL, home, { env: asked, path: newStubBin(), input: 'y\nn\n' })
    expect(r.ok, r.out).toBe(true)
    expect(readdirSync(rsctHome(home))).toEqual(['mcp-server'])
    expect(copyIntact(home)).toBe(true)
    expect(r.out, r.out).toMatch(/except \S*\.rsct\/mcp-server — the rsct-mcp companion's files/)
    expect(r.out, r.out).toMatch(/Kept: \S*\.rsct\/mcp-server/)
    expect(r.out, r.out).toMatch(/To remove both later, run this uninstaller again/)
    expect(r.out).not.toMatch(/STUB-NPM uninstall/)
  }, 60_000)

  it('removes the framework files even when globbing is switched off in the environment', () => {
    const home = newSandbox()
    seedFramework(home)
    seedCompanion(home)
    const r = runScript(UNINSTALL, home, { env: { SHELLOPTS: 'noglob' }, path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expect(readdirSync(rsctHome(home))).toEqual(['mcp-server'])
  }, 60_000)

  it.skipIf(FOREIGN_COMMAND !== '')('asks about a copy that no command on PATH points at', () => {
    const home = newSandbox()
    seedFramework(home)
    seedCompanion(home)
    const r = runScript(UNINSTALL, home, { env: reach, path: newStubBin({ withoutCommand: true }) })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/rsct-mcp files at \S*\.rsct\/mcp-server \(no rsct-mcp command on PATH\)/)
    expect(r.out, r.out).toMatch(/STUB-NPM uninstall -g rsct-mcp/)
    expect(present(rsctHome(home)), '~/.rsct should be gone').toBe(false)
    expect(r.out, r.out).toMatch(/Removed global rsct-mcp\./)
  }, 60_000)

  it('removing the companion removes the copy and names a command that is still on PATH', () => {
    const home = newSandbox()
    seedFramework(home)
    seedCompanion(home)
    const stub = newStubBin()
    const r = runScript(UNINSTALL, home, { env: reach, path: stub })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/STUB-NPM uninstall -g rsct-mcp/)
    expect(present(rsctHome(home)), '~/.rsct should be gone').toBe(false)
    expect(r.out, r.out).toMatch(/Removed: \S*\.rsct\/mcp-server/)
    expect(r.out, r.out).toMatch(/an rsct-mcp is still on PATH: \S*rsct-mcp/)
    expect(r.out).not.toMatch(/Removed global rsct-mcp\./)
    expect(stubMcpLog(stub), 'the uninstaller must never start the command').toBe('')
  }, 60_000)

  it('--skip-mcp leaves the copy where it is', () => {
    const home = newSandbox()
    seedFramework(home)
    seedCompanion(home)
    const r = runScript(UNINSTALL, home, { path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expect(readdirSync(rsctHome(home))).toEqual(['mcp-server'])
    expect(copyIntact(home)).toBe(true)
    expect(r.out, r.out).toMatch(/mcp-server\/ left untouched; --skip-mcp set/)
    expect(r.out).not.toMatch(/STUB-NPM/)
  }, 60_000)

  it('a failing npm uninstall keeps the copy and says to run the uninstaller again', () => {
    const home = newSandbox()
    seedFramework(home)
    seedCompanion(home)
    const r = runScript(UNINSTALL, home, { env: { ...reach, STUB_NPM_FAIL: '1' }, path: newStubBin() })
    expect(r.ok, r.out).toBe(true)
    expect(copyIntact(home)).toBe(true)
    expect(r.out, r.out).toMatch(/npm uninstall -g rsct-mcp failed/)
    expect(r.out, r.out).toMatch(/\.rsct\/mcp-server was left in place\. After the retry, run this uninstaller again/)
    expect(r.out).not.toMatch(/Removed: \S*\.rsct\/mcp-server/)
  }, 60_000)

  it('keeps the copy when the command on PATH still runs from it after npm reported success', () => {
    const home = newSandbox()
    seedFramework(home)
    seedCompanion(home)
    const stub = newStubBin()
    linkCommandToCopy(stub, home)
    const r = runScript(UNINSTALL, home, { env: reach, path: stub })
    expect(r.ok, r.out).toBe(true)
    expect(r.out, r.out).toMatch(/STUB-NPM uninstall -g rsct-mcp/)
    expect(r.out, r.out).toMatch(/the rsct-mcp on PATH still runs from/)
    expect(copyIntact(home)).toBe(true)
    expect(r.out).not.toMatch(/Removed global rsct-mcp\./)
  }, 60_000)

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a copy that cannot be removed is a warning, and the script still finishes',
    () => {
      const home = newSandbox()
      seedCompanion(home)
      chmodSync(rsctHome(home), 0o555)
      try {
        const r = runScript(UNINSTALL, home, { env: reach, path: newStubBin() })
        expect(r.ok, r.out).toBe(true)
        expect(r.out, r.out).toMatch(/Could not remove \S*\.rsct\/mcp-server/)
        expect(r.out, r.out).toMatch(/Run this uninstaller again once nothing is using it/)
        expect(r.out).not.toMatch(/Removed: \S*\.rsct\/mcp-server/)
        expect(r.out, r.out).toMatch(/Done\. RSCT framework removed/)
      } finally {
        if (existsSync(rsctHome(home))) chmodSync(rsctHome(home), 0o755)
      }
    },
    60_000,
  )
})

describe('the companion is installed by the installer, not from the clone (#74)', () => {
  const cloneInstall = (page: string) =>
    readFileSync(join(ROOT, page), 'utf8')
      .split('\n')
      .map((line, index) => `${page}:${index + 1} ${line.trim()}`)
      .filter((line) => /npm install -g \./.test(line))

  it('package.json files are plain names that exist, as the copy step needs', () => {
    const shipped = JSON.parse(readFileSync(join(ROOT, 'mcp-server', 'package.json'), 'utf8')).files as string[]
    expect(shipped.length).toBeGreaterThan(0)
    for (const entry of shipped) {
      expect(entry, `"${entry}" is copied with cp -R and must be a plain name`).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(existsSync(join(ROOT, 'mcp-server', entry)), `${entry} must exist in mcp-server/`).toBe(true)
    }
  })

  it('the package installs nothing and builds nothing when npm links it', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'mcp-server', 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(pkg[field], `${field}: the copy has no node_modules`).toBeUndefined()
    }
    for (const script of ['prepare', 'preinstall', 'install', 'postinstall']) {
      expect(pkg.scripts?.[script], `"${script}" would have to run in the copy, which has no src/ and no toolchain`).toBeUndefined()
    }
  })

  it('no user page sends the reader to npm install -g . inside the clone', () => {
    for (const page of ['docs/getting-started.md', 'docs/troubleshooting.md', 'mcp-server/README.md']) {
      expect(cloneInstall(page), `${page} must point at scripts/install.sh instead`).toEqual([])
    }
    expect(cloneInstall('README.md'), 'only the contributor flow in README.md keeps the command').toHaveLength(1)
  })

  it('every npm install -g . the installer runs or prints carries --install-links=false', () => {
    const lines = cloneInstall('scripts/install.sh')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line, line).toMatch(/--install-links=false/)
  })
})

describe('architectural boundary — rsct-mcp does not know the host config (#73)', () => {
  const HOST_TOKENS = [
    'mcpServers',
    'enabledMcpjsonServers',
    'disabledMcpjsonServers',
    '.claude.json',
    'mcp-scope',
    'CLAUDE_CONFIG_DIR',
  ]
  const SRC = resolve(ROOT, 'mcp-server', 'src')

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
    const fixture = newSandbox()
    mkdirSync(join(fixture, 'deep', 'nested'), { recursive: true })
    HOST_TOKENS.forEach((t, i) => {
      writeFileSync(join(fixture, 'deep', 'nested', `f${i}.ts`), `export const x = { "${t}": 1 }\n`)
    })
    writeFileSync(join(fixture, 'deep', 'nested', 'readme.md'), HOST_TOKENS.join('\n'))

    const hits = scanSrc(fixture)
    for (const t of HOST_TOKENS) {
      expect(hits.some((h) => h.includes(`[${t}]`)), `${t} must be found by the scanner itself`).toBe(true)
    }
    expect(hits.length, hits.join('\n')).toBe(HOST_TOKENS.length)
    expect(hits.some((h) => h.includes('readme.md')), 'non-source files must be skipped').toBe(false)

    const scanned = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((rel) => /\.ts$/.test(rel))
    expect(scanned.length, 'the src/ walk must find TypeScript files').toBeGreaterThan(10)
  })
})
