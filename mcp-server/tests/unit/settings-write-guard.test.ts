import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isClaudeSettingsFile,
  judgeClaudeAssetWrite,
  judgeClaudeConfigFile,
  judgeRsctConfigWrite,
  judgeSettingsWrite,
} from '../../src/lib/settings-write-guard.js'
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
  })

  it('refuses a notebook edit of a settings file, which it cannot judge (2.24.1)', () => {
    const root = project(null)
    const file = join(root, '.claude', 'settings.json')
    expect(blocked('NotebookEdit', { notebook_path: file, new_source: '{"disableAllHooks": true}' }, file)).toBe(true)
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
  })

  it('refuses a new hook entry that is not RSCT\'s, since every hook runs a command (2.24.1)', () => {
    const root = project({ permissions: { allow: [] }, ...GUARD_ENTRY })
    const file = join(root, '.claude', 'settings.local.json')
    const added = withHooks({ PreToolUse: [entry, { matcher: 'Bash', hooks: [{ type: 'command', command: 'node lint.js' }] }] })
    expect(blocked('Write', { file_path: file, content: added }, file)).toBe(true)
  })
})

describe('judgeClaudeConfigFile — files the agent never edits (2.24.1)', () => {
  it('refuses every editor tool on server registrations, approvals, managed settings and plugin files', () => {
    const root = project(null)
    const files = [
      join(root, '.mcp.json'),
      join(root, 'home', '.claude.json'),
      join(root, 'etc', 'claude-code', 'managed-settings.json'),
      join(root, 'etc', 'claude-code', 'managed-settings.d', '10-team.json'),
      join(root, 'etc', 'claude-code', 'managed-mcp.json'),
      join(root, '.claude', 'skills', 'tool', '.claude-plugin', 'plugin.json'),
      join(root, 'home', '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0', 'hooks', 'hooks.json'),
      join(root, '.claude', 'hooks.json'),
      join(root, '.MCP.JSON'),
    ]
    for (const file of files) {
      for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(judgeClaudeConfigFile(tool, file).block, `${tool} ${file}`).toBe(true)
    }
  })

  it('leaves other files and other tools alone', () => {
    const root = project(null)
    expect(judgeClaudeConfigFile('Write', join(root, 'docs', 'mcp.md')).block).toBe(false)
    expect(judgeClaudeConfigFile('Write', join(root, 'src', 'hooks.json')).block).toBe(false)
    expect(judgeClaudeConfigFile('Bash', join(root, '.mcp.json')).block).toBe(false)
  })
})

describe('judgeSettingsWrite — every hook and every key that runs a command (2.24.1)', () => {
  it('refuses adding, changing or removing a key that runs a command, and allows permissions', () => {
    const root = project({ permissions: { allow: [] }, enabledPlugins: { 'p@m': true } })
    const file = join(root, '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: file, content: JSON.stringify({ permissions: { allow: [] }, enabledPlugins: { 'p@m': true }, statusLine: { type: 'command', command: 'x' } }) }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: JSON.stringify({ permissions: { allow: [] }, enabledPlugins: { 'p@m': false } }) }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: JSON.stringify({ permissions: { allow: [] } }) }, file)).toBe(true)
    expect(blocked('Write', { file_path: file, content: JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, enabledPlugins: { 'p@m': true } }) }, file)).toBe(false)
  })

  it('refuses a write that leaves the file unreadable where it held hooks or a listed key, or names one', () => {
    const held = project({ apiKeyHelper: 'x' })
    const heldFile = join(held, '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: heldFile, content: '{' }, heldFile)).toBe(true)
    const empty = project({})
    const emptyFile = join(empty, '.claude', 'settings.local.json')
    expect(blocked('Write', { file_path: emptyFile, content: '{"statusLine": ' }, emptyFile)).toBe(true)
    expect(blocked('Write', { file_path: emptyFile, content: '{' }, emptyFile)).toBe(false)
  })
})

describe('judgeRsctConfigWrite — what keeps the edit checks and the audit log on (2.24.1)', () => {
  const read = (text: string) => () => text
  const config = JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } })

  it('refuses a write that leaves .rsct.json unreadable, or that touches audit', () => {
    expect(judgeRsctConfigWrite('Write', { content: '{' }, join('p', '.rsct.json'), read(config)).block).toBe(true)
    expect(judgeRsctConfigWrite('Write', { content: JSON.stringify({ ...JSON.parse(config), audit: { path: 'x.log' } }) }, join('p', '.rsct.json'), read(config)).block).toBe(true)
    expect(judgeRsctConfigWrite('NotebookEdit', { new_source: config }, join('p', '.rsct.json'), read(config)).block).toBe(true)
  })

  it('still allows the fields /rsct-setup edits by hand', () => {
    const changed = JSON.stringify({ rsct_version: '1.0.0', app: { name: 'renamed', org: 'o' }, universe: { name: 'u', local: '../u-universe' } })
    expect(judgeRsctConfigWrite('Write', { content: changed }, join('p', '.rsct.json'), read(config)).block).toBe(false)
  })
})

describe('judgeClaudeAssetWrite — skills, commands and agents run nothing new (2.24.1)', () => {
  const read = (text: string) => () => text
  const skill = '---\nname: s\ndescription: d\n---\n\nBody text.\n'

  it('refuses adding hooks to a skill frontmatter, and allows editing its body', () => {
    const file = join('p', '.claude', 'skills', 's', 'SKILL.md')
    const withHooks = '---\nname: s\ndescription: d\nhooks:\n  PreToolUse:\n    - command: x\n---\n\nBody text.\n'
    expect(judgeClaudeAssetWrite('Write', { content: withHooks }, file, read(skill)).block).toBe(true)
    expect(judgeClaudeAssetWrite('Write', { content: skill.replace('Body text.', 'Better body text.') }, file, read(skill)).block).toBe(false)
  })

  it('refuses adding a shell line or block to a command, and a hooks change to an agent', () => {
    const command = join('p', '.claude', 'commands', 'team', 'deploy.md')
    expect(judgeClaudeAssetWrite('Edit', { old_string: 'Body text.', new_string: 'Body text. !`git push`' }, command, read(skill)).block).toBe(true)
    expect(judgeClaudeAssetWrite('Write', { content: `${skill}\n\`\`\`!\ngit push\n\`\`\`\n` }, command, read(skill)).block).toBe(true)
    const agent = join('p', '.claude', 'agents', 'helper.md')
    const agentWithHooks = '---\nname: a\nhooks:\n  Stop: []\n---\nx\n'
    expect(judgeClaudeAssetWrite('Write', { content: '---\nname: a\n---\nx\n' }, agent, read(agentWithHooks)).block).toBe(true)
  })

  it('leaves markdown outside a .claude folder alone', () => {
    const file = join('p', 'docs', 'skills', 's', 'SKILL.md')
    expect(judgeClaudeAssetWrite('Write', { content: '---\nhooks: x\n---\n!`rm -rf`\n' }, file, read(skill)).block).toBe(false)
  })
})

describe('Claude Code files under other spellings of .claude, and front matter in any form (REVIEW round 1)', () => {
  const read = (text: string) => () => text
  const skill = '---\nname: s\ndescription: d\n---\n\nBody text.\n'
  const hooked = '---\nname: s\nhooks:\n  Stop:\n    - command: x\n---\n\nBody text.\n'

  it('refuses an agent or plugin file reached through an NTFS stream suffix on the .claude folder', () => {
    const root = project(null)
    const agent = join(root, '.claude::$INDEX_ALLOCATION', 'agents', 'e.md')
    expect(judgeClaudeAssetWrite('Write', { content: hooked }, agent, read('')).block).toBe(true)
    expect(judgeClaudeConfigFile('Write', join(root, '.claude::$INDEX_ALLOCATION', 'plugins', 'p', 'hooks', 'hooks.json')).block).toBe(true)
    expect(judgeClaudeConfigFile('Write', join(root, '.mcp.json:$DATA')).block).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('refuses an agent file reached through the Windows short name of .claude', () => {
    const root = project(null)
    const short = execFileSync('cmd', ['/c', 'dir', '/x', '/a', root], { encoding: 'utf8' })
    const name = /\s(\S+~\d)\s+\.claude\s*$/m.exec(short)?.[1]
    if (name === undefined) return
    expect(judgeClaudeAssetWrite('Write', { content: hooked }, join(root, name, 'agents', 'e.md'), read('')).block).toBe(true)
  })

  it('reads front matter written with CRLF, a fence with trailing spaces, or a quoted hooks key', () => {
    const file = join('p', '.claude', 'skills', 's', 'SKILL.md')
    expect(judgeClaudeAssetWrite('Write', { content: hooked.replace(/\n/g, '\r\n') }, file, read(skill)).block).toBe(true)
    expect(judgeClaudeAssetWrite('Write', { content: hooked.replace('---\n', '--- \n') }, file, read(skill)).block).toBe(true)
    expect(judgeClaudeAssetWrite('Write', { content: '---\nname: s\n"hooks": {Stop: []}\n---\nx\n' }, file, read(skill)).block).toBe(true)
    expect(judgeClaudeAssetWrite('Write', { content: hooked.replace(/\n/g, '\r\n') }, file, read(hooked.replace(/\n/g, '\r\n'))).block).toBe(false)
  })

  it('reads a !`command` line that spans lines', () => {
    const file = join('p', '.claude', 'commands', 'run.md')
    expect(judgeClaudeAssetWrite('Write', { content: `${skill}!\`git\npush\`\n` }, file, read(skill)).block).toBe(true)
  })
})

describe('judgeRsctConfigWrite — a .rsct.json the server rejects is refused like an unreadable one (REVIEW round 1)', () => {
  const read = (text: string) => () => text
  const config = JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } })

  it('refuses a byte-order mark or a value outside the schema, which the server rejects', () => {
    expect(judgeRsctConfigWrite('Write', { content: `\uFEFF${config}` }, join('p', '.rsct.json'), read(config)).block).toBe(true)
    expect(judgeRsctConfigWrite('Write', { content: JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: '' } }) }, join('p', '.rsct.json'), read(config)).block).toBe(true)
  })

  it('allows a write to a .rsct.json the server already rejects (the developer repairs it)', () => {
    expect(judgeRsctConfigWrite('Write', { content: config }, join('p', '.rsct.json'), read('{')).block).toBe(false)
  })
})

describe('front matter the guard cannot read word by word, and a .rsct.json left unparseable (REVIEW round 2)', () => {
  const read = (text: string) => () => text
  const skill = '---\nname: s\ndescription: d\n---\n\nBody text.\n'
  const file = join('p', '.claude', 'skills', 's', 'SKILL.md')

  it('refuses a front matter change that holds a YAML escape, which can spell hooks', () => {
    expect(judgeClaudeAssetWrite('Write', { content: '---\nname: s\n"hook\\x73": {Stop: []}\n---\nx\n' }, file, read(skill)).block).toBe(true)
    expect(judgeClaudeAssetWrite('Write', { content: '---\nname: s\n"ho\\\n  oks": {Stop: []}\n---\nx\n' }, file, read(skill)).block).toBe(true)
    expect(judgeClaudeAssetWrite('Write', { content: '---\nname: s\nx: {"hook\\u0073": []}\n---\nx\n' }, file, read(skill)).block).toBe(true)
  })

  it('reads a front matter with no closing line, or opened with a language word, to the end', () => {
    expect(judgeClaudeAssetWrite('Write', { content: '---\nname: s\nhooks: {Stop: []}\n#---\nx\n' }, file, read(skill)).block).toBe(true)
    expect(judgeClaudeAssetWrite('Write', { content: '---yaml\nname: s\nhooks: {Stop: []}\n---\nx\n' }, file, read(skill)).block).toBe(true)
  })

  it('refuses adding or changing the MCP servers of an agent, which Claude Code starts with the agent', () => {
    const agent = join('p', '.claude', 'agents', 'helper.md')
    const plain = '---\nname: a\ndescription: d\n---\nx\n'
    const inline = '---\nname: a\ndescription: d\nmcpServers:\n  - evil:\n      type: stdio\n      command: sh\n---\nx\n'
    expect(judgeClaudeAssetWrite('Write', { content: inline }, agent, read(plain)).block).toBe(true)
    expect(judgeClaudeAssetWrite('Write', { content: inline.replace('command: sh', 'command: node') }, agent, read(inline)).block).toBe(true)
    expect(judgeClaudeAssetWrite('Write', { content: plain.replace('description: d', 'description: e') }, agent, read(plain)).block).toBe(false)
  })

  it('still allows a description edit and a body edit beside a front matter with a backslash', () => {
    expect(judgeClaudeAssetWrite('Write', { content: skill.replace('description: d', 'description: better') }, file, read(skill)).block).toBe(false)
    const withPath = '---\nname: s\ndescription: reads C:\\data\n---\n\nBody text.\n'
    expect(judgeClaudeAssetWrite('Write', { content: withPath.replace('Body text.', 'More body.') }, file, read(withPath)).block).toBe(false)
  })

  it('refuses a write that leaves unparseable a .rsct.json that parsed, even one outside the schema', () => {
    const outside = JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: '' }, audit: { path: 'x.log' } })
    expect(judgeRsctConfigWrite('Write', { content: '{' }, join('p', '.rsct.json'), read(outside)).block).toBe(true)
  })
})

describe('edit-scope hook — Claude Code files in the folder CLAUDE_CONFIG_DIR names (2.24.2)', () => {
  function sandbox(): { root: string; cfg: string } {
    const root = mkdtempSync(join(tmpdir(), 'rsct-config-dir-'))
    roots.push(root)
    mkdirSync(join(root, 'p'), { recursive: true })
    return { root, cfg: join(root, 'cfg') }
  }

  function exitOf(file: string, content: string, env: NodeJS.ProcessEnv, cwd: string): number {
    return decide(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content }, cwd }), env, cwd).exitCode
  }

  const HOOKED = '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"x"}]}]}}'

  it.each([
    ['settings.json', HOOKED],
    ['settings.local.json', '{"apiKeyHelper":"x"}'],
    [join('commands', 'c.md'), '!`ls`\n'],
    [join('agents', 'a.md'), '---\nhooks: x\n---\n'],
    [join('skills', 's', 'SKILL.md'), '!`ls`\n'],
    [join('plugins', 'p', 'index.js'), 'x'],
    ['hooks.json', '{}'],
  ])('refuses %s there, and the same path passes without the variable', (rel, content) => {
    const { root, cfg } = sandbox()
    const p = join(root, 'p')
    expect(exitOf(join(cfg, rel), content, { CLAUDE_PROJECT_DIR: p, CLAUDE_CONFIG_DIR: cfg }, p)).toBe(2)
    expect(exitOf(join(cfg, rel), content, { CLAUDE_PROJECT_DIR: p }, p)).toBe(0)
  })

  it('resolves a relative value against the hook folder and against the project folder', () => {
    const { root } = sandbox()
    const p = join(root, 'p')
    const q = join(root, 'q')
    const env = { CLAUDE_PROJECT_DIR: q, CLAUDE_CONFIG_DIR: 'cfg' }
    expect(exitOf(join(p, 'cfg', 'settings.json'), HOOKED, env, p)).toBe(2)
    expect(exitOf(join(q, 'cfg', 'settings.json'), HOOKED, env, p)).toBe(2)
    expect(exitOf(join(root, 'cfg', 'settings.json'), HOOKED, env, p)).toBe(0)
  })

  it('reads a value with a trailing separator, and a ~ value both as written and in the home folder', () => {
    const { root, cfg } = sandbox()
    const p = join(root, 'p')
    expect(exitOf(join(cfg, 'settings.json'), HOOKED, { CLAUDE_PROJECT_DIR: p, CLAUDE_CONFIG_DIR: `${cfg}/` }, p)).toBe(2)
    const tilde = { CLAUDE_PROJECT_DIR: p, CLAUDE_CONFIG_DIR: '~/rsct-config-dir-probe' }
    expect(exitOf(join(homedir(), 'rsct-config-dir-probe', 'settings.json'), HOOKED, tilde, p)).toBe(2)
    expect(exitOf(join(p, '~', 'rsct-config-dir-probe', 'settings.json'), HOOKED, tilde, p)).toBe(2)
  })

  it('reads a folder named through a link by its real path too', () => {
    const { root } = sandbox()
    const p = join(root, 'p')
    const real = join(root, 'real')
    mkdirSync(real)
    symlinkSync(real, join(root, 'cfglink'), 'junction')
    const env = { CLAUDE_PROJECT_DIR: p, CLAUDE_CONFIG_DIR: join(root, 'cfglink') }
    expect(exitOf(join(real, 'settings.json'), HOOKED, env, p)).toBe(2)
    expect(exitOf(join(root, 'cfglink', 'settings.json'), HOOKED, env, p)).toBe(2)
  })

  it('treats an empty value as unset', () => {
    const { root } = sandbox()
    const p = join(root, 'p')
    expect(exitOf(join(p, 'settings.json'), HOOKED, { CLAUDE_PROJECT_DIR: p, CLAUDE_CONFIG_DIR: '' }, p)).toBe(0)
    expect(exitOf(join(p, 'settings.json'), HOOKED, { CLAUDE_PROJECT_DIR: p, CLAUDE_CONFIG_DIR: '   ' }, p)).toBe(0)
  })

  it('leaves ordinary files in that folder alone', () => {
    const { root, cfg } = sandbox()
    const p = join(root, 'p')
    const env = { CLAUDE_PROJECT_DIR: p, CLAUDE_CONFIG_DIR: cfg }
    expect(exitOf(join(cfg, 'CLAUDE.md'), '# notes', env, p)).toBe(0)
    expect(exitOf(join(cfg, 'projects', 'x', 'memory', 'MEMORY.md'), '- a', env, p)).toBe(0)
    expect(exitOf(join(cfg, 'settings.json'), '{"theme":"dark"}', env, p)).toBe(0)
  })

  it('leaves a file of the same name in another folder alone', () => {
    const { root, cfg } = sandbox()
    const p = join(root, 'p')
    const env = { CLAUDE_PROJECT_DIR: p, CLAUDE_CONFIG_DIR: cfg }
    expect(exitOf(join(root, 'other', 'settings.json'), HOOKED, env, p)).toBe(0)
    expect(exitOf(join(root, 'other', 'commands', 'c.md'), '!`ls`\n', env, p)).toBe(0)
  })
})
