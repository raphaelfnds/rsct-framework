import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const DIST_SCRIPTS = process.env.RSCT_TEST_HOOK_DIST ?? resolve(__dirname, '..', '..', 'dist', 'scripts')
const TSUP_CONFIG = resolve(__dirname, '..', '..', 'tsup.config.ts')
const GUARD = 'edit-scope-guard.js'
const SANITIZER = 'sanitize-permissions.js'
const LAUNCHED = [GUARD, SANITIZER]
const POISON_PILL = 'Bash(git commit:*)'

const created: string[] = []
const links: string[] = []

afterEach(() => {
  for (const link of links.splice(0)) rmSync(link, { force: true })
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function installedCopy(name: string): string {
  const source = join(DIST_SCRIPTS, name)
  if (!existsSync(source)) {
    throw new Error(`${source} not found — run \`npm run build\` before this test`)
  }
  const body = readFileSync(source, 'utf8').split('\n').slice(1).join('\n')
  return `#!/usr/bin/env node\n// rsct-mcp v=0.0.0 — installed by /rsct-setup\n${body}`
}

function newProject(state: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsct-hooks-'))
  created.push(dir)
  writeFileSync(join(dir, '.rsct.json'), '{ "rsct_version": "1.0.0", "app": { "name": "hooks-probe", "org": "probe" } }\n')
  mkdirSync(join(dir, '.rsct', 'scripts'), { recursive: true })
  writeFileSync(join(dir, '.rsct', 'scripts', 'package.json'), '{ "type": "module" }\n')
  for (const name of LAUNCHED) writeFileSync(join(dir, '.rsct', 'scripts', name), installedCopy(name))
  if (state !== null) writeFileSync(join(dir, '.rsct', 'phase-state.json'), JSON.stringify(state))
  mkdirSync(join(dir, 'src'), { recursive: true })
  return dir
}

function linkTo(target: string): string {
  const link = join(tmpdir(), `rsct-hooks-link-${process.pid}-${Date.now()}-${links.length}`)
  symlinkSync(target, link, 'junction')
  links.push(link)
  return link
}

function hookEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== 'CLAUDE_PROJECT_DIR') env[key] = value
  }
  env.CLAUDE_PROJECT_DIR = root
  return env
}

function launch(name: string, root: string, input: string): { status: number | null; stderr: string } {
  const r = spawnSync('node', [join(root, '.rsct', 'scripts', name)], {
    input,
    cwd: root,
    env: hookEnv(root),
    encoding: 'utf8',
    timeout: 20_000,
  })
  return { status: r.status, stderr: r.stderr ?? '' }
}

function payloadFor(root: string, filePath: string): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath },
    cwd: root,
  })
}

function writePayload(root: string, relative: string): string {
  return payloadFor(root, join(root, relative))
}

function guard(root: string, relative: string): { status: number | null; stderr: string } {
  return launch(GUARD, root, writePayload(root, relative))
}

function settingsWith(root: string, allow: string[]): string {
  const path = join(root, '.claude', 'settings.json')
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(path, JSON.stringify({ permissions: { allow } }, null, 2))
  return path
}

function baselineLines(root: string): number {
  const log = join(root, '.rsct', 'audit.log')
  if (!existsSync(log)) return 0
  return readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('"settings.baseline"')).length
}

const CODE_PHASE = { phase: 'code', spec_slug: 'demo', scope_globs: ['src/**'] }
const STALE = { spec_slug: 'demo', context_stale: { since: '2026-01-01T00:00:00.000Z', reason: 'plan_closed' } }

describe('compiled hooks — every script entry is launched here', () => {
  it('covers each src/scripts entry of the build', () => {
    const entries = [...readFileSync(TSUP_CONFIG, 'utf8').matchAll(/'src\/scripts\/([a-z0-9-]+)\.ts'/g)].map((m) => `${m[1]}.js`)
    expect(entries.sort()).toEqual([...LAUNCHED].sort())
  })
})

describe('compiled edit-scope guard, launched as the installed hook', () => {
  it('blocks a file outside the declared list and allows one inside it', () => {
    const root = newProject(CODE_PHASE)
    const outside = guard(root, 'README.md')
    expect(outside.status).toBe(2)
    expect(outside.stderr).toContain('[rsct] Edit blocked (out_of_scope)')
    const inside = guard(root, join('src', 'app.ts'))
    expect(inside.status).toBe(0)
    expect(inside.stderr).toBe('')
  })

  it('blocks every edit while the context is stale and allows the same file once it is not', () => {
    const stale = newProject(STALE)
    const refused = guard(stale, join('src', 'app.ts'))
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('[rsct] Edit blocked (stale_context)')
    const fresh = newProject(CODE_PHASE)
    expect(guard(fresh, join('src', 'app.ts')).status).toBe(0)
  })

  it('allows everything in a project the framework does not manage, and blocks the same file once it does', () => {
    const managed = newProject(CODE_PHASE)
    expect(guard(managed, 'README.md').status).toBe(2)
    const unmanaged = newProject(CODE_PHASE)
    rmSync(join(unmanaged, '.rsct.json'))
    expect(guard(unmanaged, 'README.md').status).toBe(0)
  })

  it('allows a plan-tracking file the list does not name and blocks its neighbour', () => {
    const root = newProject(CODE_PHASE)
    const tracking = guard(root, 'progress_demo.md')
    expect(tracking.status).toBe(0)
    expect(tracking.stderr).toBe('')
    expect(guard(root, 'notes_demo.md').status).toBe(2)
  })

  it('allows a file outside the project and blocks an unlisted one inside it', () => {
    const root = newProject(CODE_PHASE)
    const elsewhere = newProject(null)
    const outside = launch(GUARD, root, JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(elsewhere, 'note.md') },
      cwd: root,
    }))
    expect(outside.status).toBe(0)
    expect(guard(root, 'README.md').status).toBe(2)
  })

  it('blocks a path that climbs out of the list with ".."', () => {
    const root = newProject(CODE_PHASE)
    const climbing = [root, 'src', '..', 'README.md'].join(sep)
    const staying = [root, 'docs', '..', 'src', 'app.ts'].join(sep)
    expect(climbing).toContain(`${sep}..${sep}`)
    expect(launch(GUARD, root, payloadFor(root, climbing)).status).toBe(2)
    expect(launch(GUARD, root, payloadFor(root, staying)).status).toBe(0)
  })

  it('does not let a folder above the project satisfy the list', () => {
    const parent = mkdtempSync(join(tmpdir(), 'rsct-hooks-above-'))
    created.push(parent)
    const root = join(parent, 'build', 'project')
    mkdirSync(join(root, '.rsct', 'scripts'), { recursive: true })
    writeFileSync(join(root, '.rsct.json'), '{ "rsct_version": "1.0.0", "app": { "name": "hooks-probe", "org": "probe" } }\n')
    writeFileSync(join(root, '.rsct', 'scripts', 'package.json'), '{ "type": "module" }\n')
    writeFileSync(join(root, '.rsct', 'scripts', GUARD), installedCopy(GUARD))
    writeFileSync(join(root, '.rsct', 'phase-state.json'), JSON.stringify({ ...CODE_PHASE, scope_globs: ['**/build/**'] }))
    expect(guard(root, 'README.md').status).toBe(2)
    expect(guard(root, join('build', 'out.js')).status).toBe(0)
    expect(guard(root, join('packages', 'build', 'out.js')).status).toBe(0)
  })

  it('does not run the sanitizer', () => {
    const root = newProject(CODE_PHASE)
    const settings = settingsWith(root, [POISON_PILL, 'Read(*)'])
    const before = readFileSync(settings, 'utf8')
    expect(guard(root, 'README.md').status).toBe(2)
    expect(guard(root, join('src', 'app.ts')).status).toBe(0)
    expect(readFileSync(settings, 'utf8')).toBe(before)
    expect(baselineLines(root)).toBe(0)
  })

  it('blocks and allows the same way when the project is reached through a link', () => {
    const root = newProject(CODE_PHASE)
    const link = linkTo(root)
    expect(realpathSync.native(link)).not.toBe(resolve(link))
    const outside = guard(link, 'README.md')
    expect(outside.status).toBe(2)
    expect(outside.stderr).toContain('[rsct] Edit blocked (out_of_scope)')
    expect(guard(link, join('src', 'app.ts')).status).toBe(0)
  })

  it('records a rejected config once for several edits and warns on each one (#93)', () => {
    const root = newProject(CODE_PHASE)
    writeFileSync(join(root, '.rsct.json'), '{ not valid json')
    for (const file of ['README.md', 'README.md', join('src', 'app.ts')]) {
      expect(guard(root, file).stderr).toContain('.rsct.json rejected')
    }
    const recorded = readFileSync(join(root, '.rsct', 'audit.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"rsct_json.malformed"'))
    expect(recorded).toHaveLength(1)
  })
})

describe('compiled sanitizer, launched as the installed hook', () => {
  it('strips a standing git grant, keeps the others and records one baseline', () => {
    const root = newProject(null)
    const settings = settingsWith(root, [POISON_PILL, 'Read(*)'])
    const r = launch(SANITIZER, root, '')
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('[rsct-sanitize] stripped 1 poison-pill entry')
    const allow = (JSON.parse(readFileSync(settings, 'utf8')) as { permissions: { allow: string[] } }).permissions.allow
    expect(allow).toEqual(['Read(*)'])
    expect(baselineLines(root)).toBe(1)
  })

  it('strips the grant when the project is reached through a link', () => {
    const root = newProject(null)
    const settings = settingsWith(root, [POISON_PILL, 'Read(*)'])
    const link = linkTo(root)
    expect(realpathSync.native(link)).not.toBe(resolve(link))
    const r = launch(SANITIZER, link, '')
    expect(r.status).toBe(0)
    expect(readFileSync(settings, 'utf8')).not.toContain(POISON_PILL)
  })
})
