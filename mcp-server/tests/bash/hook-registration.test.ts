import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bashAvailable, repoRoot } from './lib/bash-lint.js'
import { nodeAvailable, readIn, runBlock, type RunBlockResult } from './lib/block-harness.js'
import { bashBin } from './lib/resolve-bash.js'
import { readScriptEvidence, readScriptRegistration } from '../../src/lib/version-drift.js'

const ROOT = repoRoot(__dirname)
const BASH = bashAvailable()
const NODE = nodeAvailable()
const DIST = resolve(__dirname, '..', '..', 'dist', 'scripts')

const SESSION_HOOK_ANCHOR =
  'CHECKPOINT: Phase 4.V.c executing canonical structured-merge SessionStart hook install'
const GUARD_ANCHOR = 'CHECKPOINT: Phase 4.V.d executing canonical edit-scope guard install'

const GUARD = 'edit-scope-guard.js'
const SANITIZER = 'sanitize-permissions.js'
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

  it('4.V.d writes the PreToolUse command with the path quoted and keeps the matcher', () => {
    const r = run(GUARD_ANCHOR, seed())
    const found = groups(r, 'PreToolUse')
    expect(found.map((g) => g.hooks[0]?.command)).toEqual([quoted(GUARD)])
    expect(found[0]?.matcher).toBe(MATCHER)
    expect(readScriptRegistration(r.dir, GUARD)).toBe('registered')
  }, 60_000)

  it('4.V.c rewrites the unquoted command an older setup wrote, once', () => {
    const r = run(SESSION_HOOK_ANCHOR, seed({ '.claude/settings.json': withEntry('SessionStart', legacy(SANITIZER)) }), 2)
    expect(r.out).toContain('Rewrote the RSCT SessionStart sanitizer hook command')
    expect(r.out).toContain('already present')
    expect(groups(r, 'SessionStart').map((g) => g.hooks[0]?.command)).toEqual([quoted(SANITIZER)])
  }, 90_000)

  it('4.V.d rewrites the unquoted command an older setup wrote, once, and keeps the matcher', () => {
    const r = run(
      GUARD_ANCHOR,
      seed({ '.claude/settings.json': withEntry('PreToolUse', legacy(GUARD), { matcher: MATCHER }) }),
      2,
    )
    expect(r.out).toContain('Rewrote the RSCT PreToolUse edit-scope guard hook command')
    expect(r.out).toContain('already present')
    const found = groups(r, 'PreToolUse')
    expect(found.map((g) => g.hooks[0]?.command)).toEqual([quoted(GUARD)])
    expect(found[0]?.matcher).toBe(MATCHER)
  }, 90_000)

  it.each([
    ['4.V.c', SESSION_HOOK_ANCHOR, 'SessionStart', SANITIZER, {}],
    ['4.V.d', GUARD_ANCHOR, 'PreToolUse', GUARD, { matcher: MATCHER }],
  ] as const)('%s leaves a command the developer wrote by hand exactly as it is', (_block, anchor, event, name, extra) => {
    const own = `node --no-warnings \${CLAUDE_PROJECT_DIR}/.rsct/scripts/${name}`
    const before = withEntry(event, own, extra)
    const r = run(anchor, seed({ '.claude/settings.json': before }))
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

  function fire(command: string, root: string, relative: string): { status: number | null; stderr: string } {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toUpperCase() !== 'CLAUDE_PROJECT_DIR') env[key] = value
    }
    env.CLAUDE_PROJECT_DIR = root
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
    expect(command).toBe(quoted(GUARD))
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
})
