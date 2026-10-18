import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bashAvailable, repoRoot } from './lib/bash-lint.js'
import { nodeAvailable, readIn, runBlock, type RunBlockResult } from './lib/block-harness.js'
import { bashBin } from './lib/resolve-bash.js'
import { EDIT_GUARD_HOOK, TERMINAL_GUARD_HOOK, readScriptEvidence, readScriptRegistration } from '../../src/lib/version-drift.js'

const ROOT = repoRoot(__dirname)
const BASH = bashAvailable()
const NODE = nodeAvailable()
const DIST = resolve(__dirname, '..', '..', 'dist', 'scripts')

const SESSION_HOOK_ANCHOR =
  'CHECKPOINT: Phase 4.V.c executing canonical structured-merge SessionStart hook install'
const GUARD_ANCHOR = 'CHECKPOINT: Phase 4.V.d executing canonical edit-scope guard install'
const TERMINAL_ANCHOR = 'CHECKPOINT: Phase 4.V.e executing canonical terminal guard install'
const SCRUB_ANCHOR = 'CHECKPOINT: Phase 4.V.a1 executing canonical structured-merge PreToolUse guard scrub'

const GUARD = 'edit-scope-guard.js'
const SANITIZER = 'sanitize-permissions.js'
const TERMINAL = 'terminal-guard.js'
const MATCHER = '^(Edit|Write|MultiEdit|NotebookEdit)$'
const quoted = (name: string): string => `node "\${CLAUDE_PROJECT_DIR}/.rsct/scripts/${name}"`
const legacy = (name: string): string => `node \${CLAUDE_PROJECT_DIR}/.rsct/scripts/${name}`

const PREAMBLE = 'SANITIZER_SRC="$(pwd)/fake-dist/sanitize-permissions.js"\nRSCT_MCP_VERSION=9.9.9'
const INERT_COPY =
  '#!/usr/bin/env node\n// rsct-mcp v=2.12.3 — installed by /rsct-setup\nif (isCliEntry()) {\n  process.exit(0);\n}\n'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function seed(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'fake-dist/sanitize-permissions.js': readFileSync(join(DIST, SANITIZER), 'utf8'),
    'fake-dist/edit-scope-guard.js': readFileSync(join(DIST, GUARD), 'utf8'),
    'fake-dist/terminal-guard.js': readFileSync(join(DIST, TERMINAL), 'utf8'),
    '.claude/settings.json': '{}\n',
    ...extra,
  }
}

function run(anchor: string, seedFiles: Record<string, string>, runs = 1): RunBlockResult {
  const r = runBlock(ROOT, { promptBasename: '01-setup.md', anchor, preamble: PREAMBLE, seedFiles, runs })
  dirs.push(r.dir)
  return r
}

interface HookGroup {
  matcher?: string
  hooks: Array<{ type: string; command: string }>
}

function groups(r: RunBlockResult, event: 'SessionStart' | 'PreToolUse'): HookGroup[] {
  const settings = JSON.parse(readIn(r, '.claude/settings.json')) as { hooks?: Record<string, HookGroup[]> }
  return settings.hooks?.[event] ?? []
}

const withEntry = (event: string, command: string, extra: object = {}): string =>
  JSON.stringify({ hooks: { [event]: [{ ...extra, hooks: [{ type: 'command', command }] }] } }, null, 2) + '\n'

describe.skipIf(!BASH || !NODE)('block: the registered hook command quotes the project path (#114)', () => {
  it('4.V.c writes the SessionStart command with the path quoted', () => {
    const r = run(SESSION_HOOK_ANCHOR, seed())
    expect(groups(r, 'SessionStart').map((g) => g.hooks[0]?.command)).toEqual([quoted(SANITIZER)])
    expect(readScriptRegistration(r.dir, SANITIZER)).toBe('registered')
  }, 60_000)

  it('4.V.d writes the PreToolUse entry in the canonical form: quoted path, NODE_OPTIONS cleared, || exit 2', () => {
    const r = run(GUARD_ANCHOR, seed())
    const found = groups(r, 'PreToolUse')
    expect(found.map((g) => g.hooks[0]?.command)).toEqual([EDIT_GUARD_HOOK.command])
    expect(found[0]?.matcher).toBe(MATCHER)
    expect(EDIT_GUARD_HOOK.matcher).toBe(MATCHER)
    expect(readScriptRegistration(r.dir, GUARD)).toBe('registered')
  }, 60_000)

  it('4.V.c rewrites the unquoted command an older setup wrote, once', () => {
    const r = run(SESSION_HOOK_ANCHOR, seed({ '.claude/settings.json': withEntry('SessionStart', legacy(SANITIZER)) }), 2)
    expect(r.out).toContain('Rewrote the RSCT SessionStart sanitizer hook command')
    expect(r.out).toContain('already present')
    expect(groups(r, 'SessionStart').map((g) => g.hooks[0]?.command)).toEqual([quoted(SANITIZER)])
  }, 90_000)

  it.each([
    ['the unquoted command setups before 2.13.0 wrote', legacy(GUARD)],
    ['the quoted command setups 2.13.0 to 2.14.1 wrote', quoted(GUARD)],
    ['a command the developer or the agent edited', `node --no-warnings \${CLAUDE_PROJECT_DIR}/.rsct/scripts/${GUARD}; exit 0`],
  ])('4.V.d replaces %s with the canonical entry, once', (_label, older) => {
    const r = run(GUARD_ANCHOR, seed({ '.claude/settings.json': withEntry('PreToolUse', older, { matcher: MATCHER }) }), 2)
    expect(r.out).toContain('Re-registered the RSCT PreToolUse edit-scope guard hook in the form this rsct-mcp installs')
    expect(r.out).toContain('already present')
    const found = groups(r, 'PreToolUse')
    expect(found).toEqual([{ matcher: MATCHER, hooks: [{ type: 'command', command: EDIT_GUARD_HOOK.command }] }])
  }, 90_000)

  it('4.V.d replaces an entry under a different matcher and leaves the other hooks of that group alone', () => {
    const before = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: '^Write$',
            hooks: [
              { type: 'command', command: quoted(GUARD) },
              { type: 'command', command: 'node lint-on-write.js' },
            ],
          },
        ],
      },
    })
    const r = run(GUARD_ANCHOR, seed({ '.claude/settings.json': before }))
    expect(groups(r, 'PreToolUse')).toEqual([
      { matcher: '^Write$', hooks: [{ type: 'command', command: 'node lint-on-write.js' }] },
      { matcher: MATCHER, hooks: [{ type: 'command', command: EDIT_GUARD_HOOK.command }] },
    ])
  }, 60_000)

  it('4.V.c leaves a command the developer wrote by hand exactly as it is', () => {
    const own = `node --no-warnings \${CLAUDE_PROJECT_DIR}/.rsct/scripts/${SANITIZER}`
    const before = withEntry('SessionStart', own)
    const r = run(SESSION_HOOK_ANCHOR, seed({ '.claude/settings.json': before }))
    expect(r.out).toContain('already present')
    expect(readIn(r, '.claude/settings.json')).toBe(before)
  }, 60_000)

  it('4.V.d replaces a guard copy that cannot block with the shipped one', () => {
    const r = run(GUARD_ANCHOR, seed({ [`.rsct/scripts/${GUARD}`]: INERT_COPY }))
    expect(readIn(r, `.rsct/scripts/${GUARD}`)).not.toContain('if (isCliEntry()) {')
    const state = readScriptEvidence(r.dir, DIST).find((e) => e.name === GUARD)?.state
    expect(state).toBe('current')
  }, 60_000)
})

describe.skipIf(!BASH || !NODE)('block: the command setup registers really runs the guard (#114)', () => {
  function installedIn(parentName: string): { root: string; command: string } {
    const r = run(
      GUARD_ANCHOR,
      seed({
        '.rsct.json': '{ "rsct_version": "1.0.0", "app": { "name": "hook-probe", "org": "probe" } }\n',
        '.rsct/scripts/package.json': '{ "type": "module" }\n',
        '.rsct/phase-state.json': JSON.stringify({ phase: 'code', spec_slug: 'demo', scope_globs: ['src/**'] }),
      }),
    )
    const parent = mkdtempSync(join(tmpdir(), parentName))
    dirs.push(parent)
    const root = join(parent, 'project')
    cpSync(r.dir, root, { recursive: true })
    return { root: root.replace(/\\/g, '/'), command: groups(r, 'PreToolUse')[0]!.hooks[0]!.command }
  }

  function fire(command: string, root: string, relative: string, extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stderr: string } {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toUpperCase() !== 'CLAUDE_PROJECT_DIR') env[key] = value
    }
    env.CLAUDE_PROJECT_DIR = root
    Object.assign(env, extraEnv)
    const r = spawnSync(bashBin(), ['-c', command], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: `${root}/${relative}` },
        cwd: root,
      }),
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { status: r.status, stderr: r.stderr ?? '' }
  }

  it('blocks outside the list and allows inside it, in a project whose path has a space', () => {
    const { root, command } = installedIn('rsct hook space-')
    expect(root).toContain(' ')
    expect(command).toBe(EDIT_GUARD_HOOK.command)
    const outside = fire(command, root, 'README.md')
    expect(outside.status).toBe(2)
    expect(outside.stderr).toContain('[rsct] Edit blocked (out_of_scope)')
    expect(fire(command, root, 'src/app.ts').status).toBe(0)
  }, 90_000)

  it('shows why the quotes matter: the unquoted command does not block there', () => {
    const { root } = installedIn('rsct hook space-')
    const unquoted = fire(legacy(GUARD), root, 'README.md')
    expect(unquoted.status).not.toBe(2)
    expect(unquoted.status).not.toBe(0)
    expect(fire(quoted(GUARD), root, 'README.md').status).toBe(2)
  }, 90_000)

  it('refuses every edit when the script is missing, where the 2.13.0 command let it through', () => {
    const { root, command } = installedIn('rsct hook space-')
    rmSync(join(root, '.rsct', 'scripts', GUARD))
    expect(fire(command, root, 'src/app.ts').status).toBe(2)
    expect(fire(quoted(GUARD), root, 'src/app.ts').status).not.toBe(2)
  }, 90_000)

  it('keeps a NODE_OPTIONS that preloads a script exiting 0 from switching the edit guard off', () => {
    const { root, command } = installedIn('rsct hook space-')
    const allowDir = mkdtempSync(join(tmpdir(), 'rsct-allow-'))
    dirs.push(allowDir)
    const allow = join(allowDir, 'allow.cjs').replace(/\\/g, '/')
    writeFileSync(allow, 'process.exit(0)\n')
    expect(fire(command, root, 'README.md', { NODE_OPTIONS: `--require ${allow}` }).status).toBe(2)
    expect(fire(command.replace('NODE_OPTIONS= ', ''), root, 'README.md', { NODE_OPTIONS: `--require ${allow}` }).status).toBe(0)
  }, 90_000)
})

describe.skipIf(!BASH || !NODE)('block: 4.V.e installs the terminal guard (#91)', () => {
  it('copies the script and registers the canonical entry, idempotently', () => {
    const r = run(TERMINAL_ANCHOR, seed(), 2)
    expect(r.out).toContain('Installed RSCT PreToolUse terminal guard hook')
    expect(r.out).toContain('already present')
    expect(groups(r, 'PreToolUse')).toEqual([
      { matcher: TERMINAL_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: TERMINAL_GUARD_HOOK.command }] },
    ])
    expect(readScriptRegistration(r.dir, TERMINAL)).toBe('registered')
    expect(readScriptEvidence(r.dir, DIST).find((e) => e.name === TERMINAL)?.state).toBe('current')
  }, 90_000)

  it('replaces an altered entry and keeps the edit-scope guard entry beside it', () => {
    const before = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: EDIT_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: EDIT_GUARD_HOOK.command }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: `node "\${CLAUDE_PROJECT_DIR}/.rsct/scripts/${TERMINAL}"` }] },
        ],
      },
    })
    const r = run(TERMINAL_ANCHOR, seed({ '.claude/settings.json': before }))
    expect(r.out).toContain('Re-registered the RSCT PreToolUse terminal guard hook')
    expect(groups(r, 'PreToolUse')).toEqual([
      { matcher: EDIT_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: EDIT_GUARD_HOOK.command }] },
      { matcher: TERMINAL_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: TERMINAL_GUARD_HOOK.command }] },
    ])
  }, 60_000)

  it('registers nothing when the script is not shipped beside the sanitizer', () => {
    const files = seed()
    delete files['fake-dist/terminal-guard.js']
    const r = run(TERMINAL_ANCHOR, files)
    expect(r.exit).toBe(0)
    expect(groups(r, 'PreToolUse')).toEqual([])
    expect(() => readIn(r, `.rsct/scripts/${TERMINAL}`)).toThrow()
  }, 60_000)
})

describe.skipIf(!BASH || !NODE)('block: the terminal guard command setup registers fails closed (#91)', () => {
  function installed(): { root: string; command: string } {
    const r = run(TERMINAL_ANCHOR, seed({ '.rsct/scripts/package.json': '{ "type": "module" }\n' }))
    const parent = mkdtempSync(join(tmpdir(), 'rsct terminal space-'))
    dirs.push(parent)
    const root = join(parent, 'project')
    cpSync(r.dir, root, { recursive: true })
    return { root: root.replace(/\\/g, '/'), command: groups(r, 'PreToolUse')[0]!.hooks[0]!.command }
  }

  function fire(command: string, root: string, shellCommand: string, extraEnv: NodeJS.ProcessEnv = {}): number | null {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toUpperCase() !== 'CLAUDE_PROJECT_DIR') env[key] = value
    }
    env.CLAUDE_PROJECT_DIR = root
    Object.assign(env, extraEnv)
    const r = spawnSync(bashBin(), ['-c', command], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: shellCommand }, cwd: root }),
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    return r.status
  }

  it('blocks a git commit and allows git status, in a project whose path has a space', () => {
    const { root, command } = installed()
    expect(command).toBe(TERMINAL_GUARD_HOOK.command)
    expect(fire(command, root, 'git commit -m x')).toBe(2)
    expect(fire(command, root, 'git status')).toBe(0)
  }, 90_000)

  it('blocks every command when the script is missing', () => {
    const { root, command } = installed()
    rmSync(join(root, '.rsct', 'scripts', TERMINAL))
    expect(fire(command, root, 'git status')).toBe(2)
  }, 90_000)

  it('keeps a NODE_OPTIONS that preloads a script exiting 0 from switching the terminal guard off', () => {
    const { root, command } = installed()
    const allowDir = mkdtempSync(join(tmpdir(), 'rsct-allow-'))
    dirs.push(allowDir)
    const allow = join(allowDir, 'allow.cjs').replace(/\\/g, '/')
    writeFileSync(allow, 'process.exit(0)\n')
    expect(fire(command.replace('NODE_OPTIONS= ', ''), root, 'git commit -m x', { NODE_OPTIONS: `--require ${allow}` })).toBe(0)
    expect(fire(command, root, 'git commit -m x', { NODE_OPTIONS: `--require ${allow}` })).toBe(2)
  }, 90_000)
})

describe.skipIf(!BASH || !NODE)('block: 03-uninstall 4.V.a1 scrubs both guard entries (#91)', () => {
  it('removes the edit-scope and terminal guard entries and keeps every other hook', () => {
    const before = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: EDIT_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: EDIT_GUARD_HOOK.command }] },
          { matcher: TERMINAL_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: TERMINAL_GUARD_HOOK.command }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-own-hook.js' }] },
        ],
      },
    })
    const r = runBlock(ROOT, { promptBasename: '03-uninstall.md', anchor: SCRUB_ANCHOR, seedFiles: { '.claude/settings.json': before } })
    dirs.push(r.dir)
    expect(r.out).toContain('Scrubbed 2 RSCT PreToolUse guard hook entries')
    expect(groups(r, 'PreToolUse')).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-own-hook.js' }] }])
  }, 60_000)

  it('removes a guard entry moved into settings.local.json and leaves a file with nothing to scrub as it was', () => {
    const local = JSON.stringify({
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { PreToolUse: [{ matcher: TERMINAL_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: TERMINAL_GUARD_HOOK.command }] }] },
    })
    const shared = '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node my-own-hook.js"}]}]}}\n'
    const r = runBlock(ROOT, {
      promptBasename: '03-uninstall.md',
      anchor: SCRUB_ANCHOR,
      seedFiles: { '.claude/settings.json': shared, '.claude/settings.local.json': local },
    })
    dirs.push(r.dir)
    expect(r.out).toContain('Scrubbed 1 RSCT PreToolUse guard hook entry')
    expect(JSON.parse(readIn(r, '.claude/settings.local.json'))).toEqual({ permissions: { allow: ['Bash(npm test)'] } })
    expect(readIn(r, '.claude/settings.json')).toBe(shared)
  }, 60_000)

  it('removes a settings.local.json that held only the guard entry', () => {
    const local = JSON.stringify({ hooks: { PreToolUse: [{ matcher: EDIT_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: EDIT_GUARD_HOOK.command }] }] } })
    const r = runBlock(ROOT, { promptBasename: '03-uninstall.md', anchor: SCRUB_ANCHOR, seedFiles: { '.claude/settings.local.json': local } })
    dirs.push(r.dir)
    expect(() => readIn(r, '.claude/settings.local.json')).toThrow()
  }, 60_000)
})
