import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isClaudeSettingsFile, judgeSettingsWrite } from '../../src/lib/settings-write-guard.js'
import { decide } from '../../src/lib/edit-scope-hook.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function project(settingsLocal: unknown | null, settings: unknown | null = null): string {
  const root = mkdtempSync(join(tmpdir(), 'rsct-settings-write-'))
  roots.push(root)
  mkdirSync(join(root, '.claude'), { recursive: true })
  if (settingsLocal !== null) writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify(settingsLocal, null, 2))
  if (settings !== null) writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(settings, null, 2))
  return root
}

const GUARD_ENTRY = {
  hooks: {
    PreToolUse: [
      {
        matcher: '^(Bash|PowerShell|Monitor)$',
        hooks: [{ type: 'command', command: 'NODE_OPTIONS= node "${CLAUDE_PROJECT_DIR}/.rsct/scripts/terminal-guard.js" || exit 2' }],
      },
    ],
  },
}

function blocked(tool: string, input: Record<string, unknown>, file: string): boolean {
  return judgeSettingsWrite(tool, input, file).block
}

describe('judgeSettingsWrite — an edit must quote the file exactly', () => {
  it('refuses an edit whose old text is not in the file, also when it differs only in its quote marks', () => {
    const root = project({ permissions: { allow: [] } })
    const file = join(root, '.claude', 'settings.local.json')
    expect(blocked('Edit', { old_string: '“permissions”', new_string: '"disableAllHooks": true, "permissions"' }, file)).toBe(true)
    expect(blocked('Edit', { old_string: 'not there', new_string: 'x' }, file)).toBe(true)
    expect(blocked('Edit', { old_string: '', new_string: '{}' }, file)).toBe(true)
    expect(blocked('MultiEdit', { edits: [{ old_string: '"allow"', new_string: '"allow"' }, { old_string: 'missing', new_string: 'y' }] }, file)).toBe(true)
  })

  it('still allows an exact edit, and an edit that fills an empty file', () => {
    const root = project({ permissions: { allow: [] } })
    expect(blocked('Edit', { old_string: '"allow": []', new_string: '"allow": ["Bash(ls)"]' }, join(root, '.claude', 'settings.local.json'))).toBe(false)
    const empty = join(project(null), '.claude', 'settings.local.json')
    writeFileSync(empty, '')
    expect(blocked('Edit', { old_string: '', new_string: '{}' }, empty)).toBe(false)
  })
})

describe('judgeSettingsWrite — what it refuses', () => {
  it('refuses writing disableAllHooks: true, also when the key is written with a unicode escape', () => {
    const root = project(null)
    const file = join(root, '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: file, content: '{"disableAllHooks": true}' }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: '{"disable\\u0041llHooks": true}' }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: '{"disableAllHooks": true,' }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: '{"disable\\u0041llHooks": true,' }, file)).toBe(true)
  })

  it('refuses an Edit that turns an existing false into true', () => {
    const root = project({ disableAllHooks: false })
    const file = join(root, '.claude', 'settings.local.json')
    expect(blocked('Edit', { file_path: file, old_string: 'false', new_string: 'true' }, file)).toBe(true)
  })

  it('refuses removing an RSCT hook entry, by Write, Edit or MultiEdit', () => {
    const root = project(null, GUARD_ENTRY)
    const file = join(root, '.claude', 'settings.json')
    expect(blocked('Write', { file_path: file, content: '{}' }, file)).toBe(true)
    expect(blocked('Edit', { file_path: file, old_string: 'terminal-guard.js', new_string: 'noop.js' }, file)).toBe(true)
    expect(blocked('MultiEdit', { file_path: file, edits: [{ old_string: '.rsct/scripts/terminal-guard.js', new_string: 'x' }] }, file)).toBe(true)
  })

  it('refuses setting NODE_OPTIONS or PATH (any letter case) in the env block', () => {
    const root = project({})
    const file = join(root, '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: file, content: '{"env": {"NODE_OPTIONS": "--require x.js"}}' }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: '{"env": {"Path": "/tmp/fake"}}' }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: '{"env": {"NODE_OPTIONS": "--require x.js"' }, file)).toBe(true)
  })

  it('refuses every env key, the hook-start ones and ordinary ones alike', () => {
    const root = project({})
    const file = join(root, '.claude', 'settings.local.json')
    const keys = [
      'BASH_ENV', 'bash_env', 'ENV', 'SHELLOPTS', 'CLAUDE_PROJECT_DIR', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_FUNC_node%%',
      'LD_AUDIT', 'DYLD_FRAMEWORK_PATH', 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
      'GIT_CONFIG_COUNT', 'MY_FLAG',
    ]
    for (const key of keys) {
      expect(blocked('Write', { file_path: file, content: JSON.stringify({ env: { [key]: 'x' } }) }, file), key).toBe(true)
    }
    expect(blocked('Write', { file_path: file, content: '{"env": {"BASH_ENV": "x"' }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: '{"env": {"MY_FLAG": "1"' }, file)).toBe(true)
  })

  it('refuses changing or removing an env entry that is already there', () => {
    const root = project({ env: { HTTPS_PROXY: 'http://proxy.example:3128', MY_FLAG: '1' } })
    const file = join(root, '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: file, content: JSON.stringify({ env: { HTTPS_PROXY: 'http://elsewhere:3128', MY_FLAG: '1' } }) }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: JSON.stringify({ env: { MY_FLAG: '1' } }) }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: '{}' }, file)).toBe(true)
    expect(blocked('Edit', { file_path: file, old_string: '"MY_FLAG": "1"', new_string: '"MY_FLAG": "2"' }, file)).toBe(true)
    const nullValued = join(project({ env: { UNSET_ME: null } }), '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: nullValued, content: '{}' }, nullValued)).toBe(true)
  })

  it('refuses an env key that shares its name with a built-in object property', () => {
    const file = join(project({}), '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: file, content: '{"env": {"toString": null}}' }, file)).toBe(true)
  })

  it('allows an edit that keeps an existing guarded env value as it was, and refuses changing it', () => {
    const root = project({ env: { BASH_ENV: '/etc/profile.rsct' }, permissions: { allow: [] } })
    const file = join(root, '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: file, content: JSON.stringify({ env: { BASH_ENV: '/etc/profile.rsct' }, permissions: { allow: ['Bash(ls)'] } }) }, file)).toBe(false)
    expect(blocked('Write', { file_path: file, content: JSON.stringify({ env: { BASH_ENV: '/tmp/other' }, permissions: { allow: [] } }) }, file)).toBe(true)
  })

  it('applies to the user settings file in ~/.claude', () => {
    const home = mkdtempSync(join(tmpdir(), 'rsct-settings-home-'))
    roots.push(home)
    const userFile = join(home, '.claude', 'settings.json')
    expect(blocked('Write', { file_path: userFile, content: '{"disableAllHooks": true}' }, userFile)).toBe(true)
  })
})

describe('judgeSettingsWrite — what keeps working', () => {
  it('allows an ordinary settings edit, including one that leaves an existing env.PATH as it was', () => {
    const root = project({ env: { PATH: '/usr/bin' }, permissions: { allow: [] } }, GUARD_ENTRY)
    const local = join(root, '.claude', 'settings.local.json')
    const shared = join(root, '.claude', 'settings.json')
    expect(blocked('Edit', { file_path: local, old_string: '"allow": []', new_string: '"allow": ["Bash(npm test)"]' }, local)).toBe(false)
    expect(blocked('Write', { file_path: local, content: JSON.stringify({ env: { PATH: '/usr/bin' }, model: 'x' }) }, local)).toBe(false)
    expect(blocked('Edit', { file_path: shared, old_string: '"hooks"', new_string: '"model": "x",\n  "hooks"' }, shared)).toBe(false)
    expect(blocked('Write', { file_path: local, content: JSON.stringify({ env: { PATH: '/usr/bin' }, disableAllHooks: false }) }, local)).toBe(false)
  })

  it('leaves other files and other tools alone', () => {
    const root = project(null)
    const other = join(root, 'docs', 'settings-notes.md')
    expect(blocked('Write', { file_path: other, content: 'disableAllHooks: true' }, other)).toBe(false)
    const notSettings = join(root, '.claude', 'commands.json')
    expect(blocked('Write', { file_path: notSettings, content: '{"disableAllHooks": true}' }, notSettings)).toBe(false)
    const file = join(root, '.claude', 'settings.json')
    expect(blocked('NotebookEdit', { notebook_path: file, new_source: '{"disableAllHooks": true}' }, file)).toBe(false)
  })

  it('recognises settings files by name and folder only', () => {
    expect(isClaudeSettingsFile(join('x', '.claude', 'settings.json'))).toBe(true)
    expect(isClaudeSettingsFile(join('x', '.CLAUDE', 'Settings.Local.json'))).toBe(true)
    expect(isClaudeSettingsFile(join('x', 'claude', 'settings.json'))).toBe(false)
  })
})

describe('edit-scope hook — the settings rule runs before anything else', () => {
  it('refuses the write in a project with no .rsct.json and no phase scope', () => {
    const root = project(null)
    const file = join(root, '.claude', 'settings.local.json')
    const d = decide(
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content: '{"disableAllHooks": true}' }, cwd: root }),
      { CLAUDE_PROJECT_DIR: root },
      root,
    )
    expect(d.exitCode).toBe(2)
    expect(d.message).toContain('[rsct] Edit blocked (claude_settings)')
  })

  it('still allows an ordinary edit there', () => {
    const root = project(null)
    const file = join(root, 'src', 'a.ts')
    const d = decide(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: root }), { CLAUDE_PROJECT_DIR: root }, root)
    expect(d.exitCode).toBe(0)
  })
})

describe('edit-scope hook — a fault inside the guard', () => {
  it('refuses the edit and tells the agent to stop', () => {
    const root = project(null)
    const exploding = (): never => {
      throw new Error('evaluator exploded')
    }
    const d = decide(
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(root, 'src', 'a.ts'), content: 'x' }, cwd: root }),
      { CLAUDE_PROJECT_DIR: root },
      root,
      exploding,
    )
    expect(d.exitCode).toBe(2)
    expect(d.message).toContain('[rsct] Edit blocked (guard_failed)')
    expect(d.message).toContain('evaluator exploded')
    expect(d.message).toContain('STOP and tell the developer')
  })
})

describe('judgeSettingsWrite — names that reach the same file (REVIEW #91)', () => {
  it('refuses a name with trailing dots or spaces, which Windows writes to the real file', () => {
    const root = project(null)
    for (const name of ['settings.json.', 'settings.local.json ', 'settings.json. .']) {
      const file = join(root, '.claude', name)
      expect(blocked('Write', { file_path: file, content: '{"disableAllHooks": true}' }, file)).toBe(true)
    }
    const dotted = join(root, '.claude.', 'settings.json')
    expect(blocked('Write', { file_path: dotted, content: '{"disableAllHooks": true}' }, dotted)).toBe(true)
    const stream = join(root, '.claude', 'settings.json::$DATA')
    expect(blocked('Write', { file_path: stream, content: '{"disableAllHooks": true}' }, stream)).toBe(true)
  })

  it('refuses a write through a folder link whose own name is not .claude', () => {
    const root = project({})
    const link = join(root, 'cfg')
    symlinkSync(join(root, '.claude'), link, 'junction')
    const file = join(link, 'settings.local.json')
    expect(blocked('Write', { file_path: file, content: '{"disableAllHooks": true}' }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: '{"model": "x"}' }, file)).toBe(false)
  })

  it('refuses creating a settings file through such a link, before the file exists', () => {
    const root = project(null)
    const link = join(root, 'cfg')
    symlinkSync(join(root, '.claude'), link, 'junction')
    const file = join(link, 'settings.local.json')
    expect(blocked('Write', { file_path: file, content: '{"disableAllHooks": true}' }, file)).toBe(true)
  })
})

describe('judgeSettingsWrite — the RSCT hook entry itself (REVIEW #91 round 3)', () => {
  const entry = GUARD_ENTRY.hooks.PreToolUse[0]!
  const hook = entry.hooks[0]!
  const withHooks = (hooks: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ permissions: { allow: [] }, ...extra, hooks })

  it('refuses a write that keeps the script name but changes what the entry does', () => {
    const root = project({ permissions: { allow: [] }, ...GUARD_ENTRY })
    const file = join(root, '.claude', 'settings.local.json')
    for (const content of [
      withHooks({ PreToolUse: [{ ...entry, matcher: '^Read$' }] }),
      withHooks({ PreToolUse: [{ ...entry, hooks: [{ ...hook, command: `${hook.command}; exit 0` }] }] }),
      withHooks({ PreToolUse: [{ ...entry, hooks: [{ ...hook, timeout: 0.001 }] }] }),
      withHooks({ PostToolUse: [entry] }),
      JSON.stringify({ permissions: { allow: [] }, note: hook.command }),
      '{ "permissions": { "allow": [] }, "hooks": ',
    ]) {
      expect(blocked('Write', { file_path: file, content }, file)).toBe(true)
    }
  })

  it('refuses an unparseable result even when it still names the script', () => {
    const root = project({ permissions: { allow: [] }, ...GUARD_ENTRY })
    const file = join(root, '.claude', 'settings.local.json')
    const broken = `${JSON.stringify({ permissions: { allow: [] }, ...GUARD_ENTRY }, null, 2).slice(0, -1)},\n}`
    expect(blocked('Write', { file_path: file, content: broken }, file)).toBe(true)
  })

  it('reads a CRLF file the way the editor matches it', () => {
    const root = project(null)
    const file = join(root, '.claude', 'settings.json')
    const lfText = JSON.stringify({ ...GUARD_ENTRY }, null, 2)
    writeFileSync(file, lfText.replace(/\n/g, '\r\n'))
    expect(blocked('Edit', { file_path: file, old_string: lfText, new_string: '{}' }, file)).toBe(true)
    writeFileSync(file, lfText)
    expect(blocked('Edit', { file_path: file, old_string: lfText.replace(/\n/g, '\r\n'), new_string: '{}' }, file)).toBe(true)
  })

  it('treats an empty matcher like a missing one', () => {
    const sessionEntry = { hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.rsct/scripts/sanitize-permissions.js"' }] }
    const root = project({ hooks: { SessionStart: [sessionEntry] } })
    const file = join(root, '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: file, content: JSON.stringify({ hooks: { SessionStart: [{ matcher: '', ...sessionEntry }] } }) }, file)).toBe(false)
  })

  it('refuses PATH written into a file that does not parse', () => {
    const root = project({})
    const file = join(root, '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: file, content: '{"env": {"PATH": "/tmp/fake"' }, file)).toBe(true)
  })

  it('falls back to the script name when the current file does not parse', () => {
    const root = project(null)
    const file = join(root, '.claude', 'settings.local.json')
    writeFileSync(file, `{ "hooks": { "PreToolUse": [{ "hooks": [{ "type": "command", "command": ${JSON.stringify(hook.command)} }] }] }, }`)
    expect(blocked('Write', { file_path: file, content: '{ "hooks": {} }' }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: `{ "note": ${JSON.stringify(hook.command)} }` }, file)).toBe(false)
  })

  it('counts each RSCT entry: dropping one of two identical entries is refused', () => {
    const root = project({ permissions: { allow: [] }, hooks: { PreToolUse: [entry, entry] } })
    const file = join(root, '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: file, content: withHooks({ PreToolUse: [entry] }) }, file)).toBe(true)
  })

  it('allows an edit that leaves the entry as it was, in any key order', () => {
    const root = project({ permissions: { allow: [] }, ...GUARD_ENTRY })
    const file = join(root, '.claude', 'settings.local.json')
    const reordered = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: hook.command, type: 'command' }], matcher: entry.matcher }] }, permissions: { allow: ['Bash(npm test)'] } })
    expect(blocked('Write', { file_path: file, content: reordered }, file)).toBe(false)
    const added = withHooks({ PreToolUse: [entry, { matcher: 'Bash', hooks: [{ type: 'command', command: 'node lint.js' }] }] })
    expect(blocked('Write', { file_path: file, content: added }, file)).toBe(false)
  })
})
