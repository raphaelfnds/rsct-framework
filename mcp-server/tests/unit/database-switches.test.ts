import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideTerminal } from '../../src/lib/terminal-guard-hook.js'
import { readDatabaseSwitches } from '../../src/lib/database-switches.js'
import { judgeCommand, type AliasResolver } from '../../src/lib/terminal-guard.js'
import { judgeRsctConfigWrite } from '../../src/lib/settings-write-guard.js'
import { decide } from '../../src/lib/edit-scope-hook.js'
import { statusHandler } from '../../src/tools/status.js'

const NO_ALIASES: AliasResolver = () => ({ found: false })
const roots: string[] = []

function project(config: Record<string, unknown> | null, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsct-dbswitch-'))
  roots.push(dir)
  if (config !== null) writeFileSync(join(dir, '.rsct.json'), JSON.stringify(config))
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true })
})

const BASE = { rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }
const call = (command: string): string => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
const hook = (command: string, dir: string) => decideTerminal(call(command), { CLAUDE_PROJECT_DIR: dir }, dir, { resolveAlias: NO_ALIASES })

describe('database switches — the terminal hook reads them from .rsct.json', () => {
  it('refuses database-changing commands by default (no key)', () => {
    const dir = project(BASE)
    expect(hook('psql -c "drop table users"', dir).exitCode).toBe(2)
    expect(hook('psql -c "select 1"', dir).exitCode).toBe(0)
  })

  it('lets them through when the developer switched the database guard off, but keeps the git rules', () => {
    const dir = project({ ...BASE, database_guard: false })
    expect(hook('psql -c "drop table users"', dir).exitCode).toBe(0)
    expect(hook('git commit -am x', dir).exitCode).toBe(2)
  })

  it('switches only the Laravel test check off with database_test_guard', () => {
    const laravel = {
      'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' } }),
      artisan: '#!/usr/bin/env php\n',
    }
    const on = project(BASE, laravel)
    const off = project({ ...BASE, database_test_guard: false }, laravel)
    expect(hook('php artisan test', on).exitCode).toBe(2)
    expect(hook('php artisan test', off).exitCode).toBe(0)
    expect(hook('php artisan migrate:fresh', off).exitCode).toBe(2)
  })

  it('reads the switches from the project folder, not from the folder a command runs in', () => {
    const dir = project(BASE, { 'sub/.rsct.json': JSON.stringify({ ...BASE, database_guard: false }) })
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'psql -c "drop table users"' }, cwd: join(dir, 'sub') })
    expect(decideTerminal(payload, { CLAUDE_PROJECT_DIR: dir }, dir, { resolveAlias: NO_ALIASES }).exitCode).toBe(2)
  })

  it('walks up from the project folder to the nearest .rsct.json', () => {
    const dir = project({ ...BASE, database_guard: false }, { 'app/.keep': '' })
    expect(hook('psql -c "drop table users"', join(dir, 'app')).exitCode).toBe(0)
    const nested = project({ ...BASE, database_guard: false }, { 'app/.rsct.json': JSON.stringify(BASE) })
    expect(hook('psql -c "drop table users"', join(nested, 'app')).exitCode).toBe(2)
  })

  it('reads an unreadable or missing config as ON', () => {
    expect(readDatabaseSwitches(project(null))).toEqual({ database: true, test: true })
    const broken = project(null)
    writeFileSync(join(broken, '.rsct.json'), '{ not json')
    expect(readDatabaseSwitches(broken)).toEqual({ database: true, test: true })
    expect(readDatabaseSwitches(project({ ...BASE, database_guard: 'false' }))).toEqual({ database: true, test: true })
  })
})

describe('database switches — rsct_status tells the developer when they are off', () => {
  const hintsOf = async (config: Record<string, unknown>): Promise<string[]> => (await statusHandler({ project_root: project(config) })).hints
  it('says nothing while they are on', async () => {
    expect((await hintsOf(BASE)).some((h) => /database guard is switched off/.test(h))).toBe(false)
  })
  it('names the switch that is off and what that means', async () => {
    const all = await hintsOf({ ...BASE, database_guard: false })
    expect(all.some((h) => /database_guard: false/.test(h) && /NOT refused/.test(h))).toBe(true)
    const test = await hintsOf({ ...BASE, database_test_guard: false })
    expect(test.some((h) => /database_test_guard: false/.test(h) && /Laravel test check is off/.test(h))).toBe(true)
  })
  it('tells the developer even when the rest of .rsct.json is rejected, because the hook still reads the switch', async () => {
    const all = await hintsOf({ rsct_version: 7, database_guard: false })
    expect(all.some((h) => /database_guard: false/.test(h) && /NOT refused/.test(h))).toBe(true)
  })
})

describe('database switches — the agent cannot switch them off', () => {
  it('the terminal guard refuses any command that names a switch', () => {
    for (const c of [
      'node -e "const f=\'.rsct.json\';const j=JSON.parse(require(\'fs\').readFileSync(f));j.database_guard=false"',
      "sed -i 's/}/,\"database_guard\":false}/' .rsct.json",
      'grep database_test_guard .rsct.json',
    ]) {
      const v = judgeCommand(c, { resolveAlias: NO_ALIASES })
      expect(v.verdict === 'deny' && v.reason).toMatch(/switching the database guard off is the developer's own edit/)
    }
  })

  it('the edit guard refuses a write that switches a key off, and allows switching it back on', () => {
    const dir = project(BASE)
    const file = join(dir, '.rsct.json')
    const current = JSON.stringify(BASE)
    const read = () => current
    expect(judgeRsctConfigWrite('Write', { content: JSON.stringify({ ...BASE, database_guard: false }) }, file, read).block).toBe(true)
    expect(judgeRsctConfigWrite('Write', { content: JSON.stringify({ ...BASE, database_test_guard: false }) }, file, read).block).toBe(true)
    expect(judgeRsctConfigWrite('Edit', { old_string: '"o"}}', new_string: '"o"},"database_guard":false}' }, file, read).block).toBe(true)
    expect(judgeRsctConfigWrite('Write', { content: '{ "database_guard": false, broken' }, file, read).block).toBe(true)
    const off = JSON.stringify({ ...BASE, database_guard: false })
    expect(judgeRsctConfigWrite('Write', { content: JSON.stringify(BASE) }, file, () => off).block).toBe(false)
    expect(judgeRsctConfigWrite('Write', { content: JSON.stringify({ ...BASE, protected_branches: ['main'] }) }, file, read).block).toBe(false)
    expect(judgeRsctConfigWrite('Write', { content: JSON.stringify({ database_guard: false }) }, join(dir, 'other.json'), read).block).toBe(false)
  })

  it('the terminal guard also reads a switch name written with a unicode escape', () => {
    const v = judgeCommand('node -e "x[\'\\u0064atabase_guard\']=false"', { resolveAlias: NO_ALIASES })
    expect(v.verdict === 'deny' && v.reason).toMatch(/switching the database guard off/)
  })

  it('the edit guard refuses an edit of .rsct.json that does not quote the file exactly', () => {
    const file = join(project(BASE), '.rsct.json')
    const read = () => JSON.stringify(BASE)
    expect(judgeRsctConfigWrite('Edit', { old_string: '“o”}}', new_string: '"o"},"database_guard":false}' }, file, read).reason).toMatch(/does not quote the file exactly/)
    expect(judgeRsctConfigWrite('Edit', { old_string: '"o"}}', new_string: '"o"}}' }, file, read).block).toBe(false)
  })

  it('the edit guard refuses switching a key off when the current file is not valid JSON', () => {
    const file = join(project(BASE), '.rsct.json')
    expect(judgeRsctConfigWrite('Write', { content: JSON.stringify({ ...BASE, database_guard: false }) }, file, () => '{ broken').block).toBe(true)
  })

  it('the edit guard recognises .rsct.json by other spellings of the name, including a trailing dot or NTFS stream', () => {
    const read = () => JSON.stringify(BASE)
    const dir = project(null)
    for (const name of ['.rsct.json::$DATA', '.rsct.json.', '.rsct.json ', '.RSCT.JSON::$data']) {
      const file = join(dir, name)
      expect(judgeRsctConfigWrite('Write', { content: JSON.stringify({ ...BASE, database_guard: false }) }, file, read).block).toBe(true)
    }
  })

  it('the edit hook blocks it before any scope check', () => {
    const dir = project(BASE)
    const d = decide(
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(dir, '.rsct.json'), content: JSON.stringify({ ...BASE, database_guard: false }) }, cwd: dir }),
      { CLAUDE_PROJECT_DIR: dir },
      dir,
    )
    expect(d.exitCode).toBe(2)
    expect(d.message).toMatch(/^\[rsct\] Edit blocked \(rsct_config\): /)
  })
})
