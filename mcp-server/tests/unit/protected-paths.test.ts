import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decide } from '../../src/lib/edit-scope-hook.js'
import { judgeProtectedPath } from '../../src/lib/protected-paths.js'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rsct-protected-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const blocked = (path: string): boolean => judgeProtectedPath(path).block

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('judgeProtectedPath — git folders', () => {
  it('refuses any path with a .git component, in any case or NTFS spelling, even with no repository there', () => {
    expect(blocked(join(base, 'p', '.git', 'hooks', 'pre-commit'))).toBe(true)
    expect(blocked(join(base, 'p', '.GIT', 'hooks', 'pre-commit'))).toBe(true)
    expect(blocked(join(base, 'p', '.git::$INDEX_ALLOCATION', 'hooks', 'x'))).toBe(true)
    expect(blocked(join(base, 'p', '.git::$DATA'))).toBe(true)
    expect(blocked(join(base, 'p', '.git'))).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('follows a Windows short name back to .git', () => {
    const repo = join(base, 'r')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    expect(blocked(join(repo, 'GIT~1', 'hooks', 'pre-commit'))).toBe(true)
  })

  it('refuses a path inside a git folder that git init --separate-git-dir moved to another name', () => {
    const repo = join(base, 'r')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'init', '-q', `--separate-git-dir=${join(base, 'elsewhere')}`)
    expect(blocked(join(base, 'elsewhere', 'hooks', 'pre-commit'))).toBe(true)
    expect(blocked(join(base, 'elsewhere', 'config'))).toBe(true)
  })

  it('leaves files that only look like git ones alone', () => {
    for (const name of ['.gitignore', '.gitattributes', '.git-blame-ignore-revs', join('.github', 'workflows', 'ci.yml'), join('src', 'config.ts')]) {
      expect(blocked(join(base, 'p', name)), name).toBe(false)
    }
  })
})

describe('judgeProtectedPath — git configuration files', () => {
  it('refuses .gitconfig, etc/gitconfig, git/config and git/attributes', () => {
    expect(blocked(join(base, 'home', '.gitconfig'))).toBe(true)
    expect(blocked(join(base, 'opt', 'etc', 'gitconfig'))).toBe(true)
    expect(blocked(join(base, 'home', '.config', 'git', 'config'))).toBe(true)
    expect(blocked(join(base, 'home', '.config', 'git', 'attributes'))).toBe(true)
    expect(blocked(join(base, 'home', '.config', 'git', 'ignore'))).toBe(false)
  })
})

describe('judgeProtectedPath — RSCT state', () => {
  it('refuses the project .rsct folder, in any case', () => {
    expect(blocked(join(base, 'p', '.rsct', 'scripts', 'terminal-guard.js'))).toBe(true)
    expect(blocked(join(base, 'p', '.rsct', 'audit.log'))).toBe(true)
    expect(blocked(join(base, 'p', '.RSCT', 'phase-state.json'))).toBe(true)
    expect(blocked(join(base, 'p', '.rsct.json'))).toBe(false)
  })

  it('refuses the .rsct folder in the home too, where the installed server and the hook scripts projects copy live', () => {
    expect(blocked(join(homedir(), '.rsct', 'mcp-server', 'dist', 'index.js'))).toBe(true)
    expect(blocked(join(homedir(), '.rsct', 'mcp-server', 'dist', 'scripts', 'terminal-guard.js'))).toBe(true)
    expect(blocked(join(homedir(), '.RSCT', 'memory-templates', 'x.md'))).toBe(true)
    expect(blocked(join(homedir(), '.rsct.', 'x'))).toBe(true)
  })

  it('refuses every rsct-mcp launcher, whatever its extension, and the package folder of a copy install', () => {
    for (const name of ['rsct-mcp', 'rsct-mcp.cmd', 'rsct-mcp.CMD', 'rsct-mcp.bat', 'rsct-mcp.ps1', 'rsct-mcp.exe', 'RSCT-MCP.com', 'rsct-mcp.cmd:stream']) {
      expect(blocked(join(base, 'npm', name)), name).toBe(true)
    }
    expect(blocked(join(base, 'npm', 'node_modules', 'rsct-mcp', 'dist', 'index.js'))).toBe(true)
    expect(blocked(join(base, 'npm', 'node_modules', 'RSCT-MCP', 'package.json'))).toBe(true)
    for (const name of ['rsct-mcp-notes.md', 'my-rsct-mcp.cmd', join('rsct-mcp-docs', 'x.md'), join('node_modules', 'rsct-mcp-extra', 'x.js')]) {
      expect(blocked(join(base, 'p', name)), name).toBe(false)
    }
  })

  it('judges the path as written as well as its real path, so a link cannot hide the .rsct or rsct-mcp name', () => {
    const real = join(base, 'elsewhere')
    mkdirSync(join(real, 'dist'), { recursive: true })
    mkdirSync(join(base, 'home'), { recursive: true })
    mkdirSync(join(base, 'npm', 'node_modules'), { recursive: true })
    symlinkSync(real, join(base, 'home', '.rsct'), 'junction')
    symlinkSync(real, join(base, 'npm', 'node_modules', 'rsct-mcp'), 'junction')
    expect(blocked(join(base, 'home', '.rsct', 'dist', 'index.js'))).toBe(true)
    expect(blocked(join(base, 'npm', 'node_modules', 'rsct-mcp', 'dist', 'index.js'))).toBe(true)
    expect(blocked(join(real, 'dist', 'index.js'))).toBe(false)
  })
})

describe('decide — the new path checks run whatever .rsct.json says', () => {
  function payload(root: string, filePath: string, tool = 'Write'): string {
    return JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath, content: 'x' }, cwd: root })
  }

  it('refuses a hook write even when .rsct.json is malformed, which turns the scope guard off', () => {
    const root = join(base, 'p')
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(root, '.rsct.json'), '{')
    const d = decide(payload(root, '.git/hooks/pre-commit'), { CLAUDE_PROJECT_DIR: root }, root)
    expect(d.exitCode).toBe(2)
    expect(d.message).toContain('protected_path')
  })

  it('refuses a write to an audit log configured outside .rsct', () => {
    const root = join(base, 'p')
    mkdirSync(join(root, 'logs'), { recursive: true })
    git(root, 'init', '-q')
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, audit: { path: 'logs/rsct-audit.log' } }))
    const d = decide(payload(root, 'logs/rsct-audit.log'), { CLAUDE_PROJECT_DIR: root }, root)
    expect(d.exitCode).toBe(2)
    expect(d.message).toContain('audit log')
    expect(decide(payload(root, 'logs/other.log'), { CLAUDE_PROJECT_DIR: root }, root).exitCode).toBe(0)
  })
})
