import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isPoisonPill,
  main,
  resolveProjectRootFromArgs,
  sanitize,
} from '../../src/scripts/sanitize-permissions.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-sanitize-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

type SettingsFile = 'settings.json' | 'settings.local.json'

function writeSettings(
  root: string,
  file: SettingsFile,
  content: unknown,
): string {
  const dir = join(root, '.claude')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, file)
  const body =
    typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  writeFileSync(path, body, 'utf8')
  return path
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('sanitize-permissions — isPoisonPill', () => {
  it('matches all documented git-bypass shapes', () => {
    const poisonous = [
      'Bash(git commit)',
      'Bash(git commit:*)',
      'Bash(git commit*)',
      'Bash(git commit -m "x")',
      'Bash(git push:*)',
      'Bash(git push origin main)',
      'Bash(git merge:*)',
      'Bash(git merge feat/foo)',
      'Bash(git*)',
      'Bash(git:*)',
      'Bash(*)',
      'Bash(:*)',
    ]
    for (const entry of poisonous) {
      expect(isPoisonPill(entry), `expected poison: ${entry}`).toBe(true)
    }
  })

  it('matches path-prefixed git mutations (M2 audit MED-12)', () => {
    const poisonous = [
      'Bash(/usr/bin/git commit)',
      'Bash(/usr/local/bin/git push origin main)',
      'Bash(./bin/git merge feat/foo)',
      'Bash(../tools/git commit -m "x")',
      'Bash(C:/Program Files/Git/bin/git commit)',
      'Bash(C:\\Program Files\\Git\\bin\\git push)',
    ]
    for (const entry of poisonous) {
      expect(isPoisonPill(entry), `expected poison: ${entry}`).toBe(true)
    }
  })

  it('matches shell-wrapped git mutations (M2 audit MED-12)', () => {
    const poisonous = [
      'Bash(sh -c "git commit -m fix")',
      'Bash(bash -c "git push origin main")',
      "Bash(sh -c 'git merge feat/foo')",
      'Bash(zsh -c "git commit")',
      'Bash(dash -c "git push:*")',
    ]
    for (const entry of poisonous) {
      expect(isPoisonPill(entry), `expected poison: ${entry}`).toBe(true)
    }
  })

  it('matches wildcard-around-git blankets (M2 audit MED-12)', () => {
    const poisonous = [
      'Bash(*git*)',
      'Bash(*git status*)', // wildcards make even a "read-only" command a blanket
      'Bash(my * git *)',
      'Bash(* git :*)',
    ]
    for (const entry of poisonous) {
      expect(isPoisonPill(entry), `expected poison: ${entry}`).toBe(true)
    }
  })

  it('preserves benign permission entries', () => {
    const benign = [
      'Bash(npm test)',
      'Bash(npm run build)',
      'Bash(ls)',
      'Bash(git status)',
      'Bash(git diff)',
      'Bash(git log)',
      'Edit',
      'Read',
      'WebFetch(domain:example.com)',
      'mcp__rsct__rsct_request_commit',
      '',
    ]
    for (const entry of benign) {
      expect(isPoisonPill(entry), `expected benign: ${entry}`).toBe(false)
    }
  })

  it('preserves path-prefixed read-only git (MED-12 boundary check)', () => {
    // Only commit/push/merge are stripped via the path-prefixed pattern;
    // read-only operations via an absolute path stay benign so dogfooded
    // CI scripts that pin `git` location don't lose `git status` etc.
    const benign = [
      'Bash(/usr/bin/git status)',
      'Bash(/usr/local/bin/git log)',
      'Bash(./bin/git diff)',
      // Differently-named binary that happens to start with "git" must not
      // be caught by the path-prefixed pattern. The trailing `git\s+commit`
      // word boundary makes `git-foo` distinct from `git`.
      'Bash(/usr/bin/git-credential-store)',
    ]
    for (const entry of benign) {
      expect(isPoisonPill(entry), `expected benign: ${entry}`).toBe(false)
    }
  })

  it('ignores non-string entries defensively', () => {
    expect(isPoisonPill(null)).toBe(false)
    expect(isPoisonPill(undefined)).toBe(false)
    expect(isPoisonPill(42)).toBe(false)
    expect(isPoisonPill({ Bash: 'git commit' })).toBe(false)
  })
})

describe('sanitize-permissions — sanitize()', () => {
  it('strips poison-pill entries and preserves benign ones', () => {
    const path = writeSettings(tmpRoot, 'settings.local.json', {
      permissions: {
        allow: [
          'Bash(git commit:*)',
          'Bash(npm test)',
          'Edit',
          'Bash(git push:*)',
        ],
        deny: ['Bash(rm -rf /)'],
      },
      other: 'keep me',
    })
    const result = sanitize(tmpRoot, { auditWriter: () => {} })
    const file = result.files.find((f) => f.path === path)
    expect(file?.status).toBe('sanitized')
    expect(file?.stripped).toEqual([
      'Bash(git commit:*)',
      'Bash(git push:*)',
    ])
    const after = readJson(path)
    expect((after.permissions as { allow: string[] }).allow).toEqual([
      'Bash(npm test)',
      'Edit',
    ])
    expect((after.permissions as { deny: string[] }).deny).toEqual([
      'Bash(rm -rf /)',
    ])
    expect(after.other).toBe('keep me')
  })

  it('is idempotent — second run is no_change', () => {
    writeSettings(tmpRoot, 'settings.local.json', {
      permissions: { allow: ['Bash(git commit:*)', 'Edit'] },
    })
    sanitize(tmpRoot, { auditWriter: () => {} })
    const second = sanitize(tmpRoot, { auditWriter: () => {} })
    const file = second.files.find((f) =>
      f.path.endsWith('settings.local.json'),
    )
    expect(file?.status).toBe('no_change')
  })

  it('returns absent when no settings files exist', () => {
    const result = sanitize(tmpRoot, { auditWriter: () => {} })
    for (const file of result.files) {
      expect(file.status).toBe('absent')
    }
  })

  it('reports malformed JSON and writes a sanitize.malformed audit entry', () => {
    const path = writeSettings(
      tmpRoot,
      'settings.local.json',
      'not-valid-json{{{',
    )
    const audited: Record<string, unknown>[] = []
    const result = sanitize(tmpRoot, { auditWriter: (e) => audited.push(e) })
    const file = result.files.find((f) => f.path === path)
    expect(file?.status).toBe('malformed')
    expect(file?.error).toBeDefined()
    expect(readFileSync(path, 'utf8')).toBe('not-valid-json{{{')
    const audit = audited.find(
      (e) => e.event === 'sanitize.malformed' && e.file === path,
    )
    expect(audit).toBeDefined()
  })

  it('processes both settings.json and settings.local.json', () => {
    const sharedPath = writeSettings(tmpRoot, 'settings.json', {
      permissions: { allow: ['Bash(git merge:*)'] },
    })
    const localPath = writeSettings(tmpRoot, 'settings.local.json', {
      permissions: { allow: ['Bash(git commit:*)'] },
    })
    const result = sanitize(tmpRoot, { auditWriter: () => {} })
    const shared = result.files.find((f) => f.path === sharedPath)
    const local = result.files.find((f) => f.path === localPath)
    expect(shared?.status).toBe('sanitized')
    expect(shared?.stripped).toEqual(['Bash(git merge:*)'])
    expect(local?.status).toBe('sanitized')
    expect(local?.stripped).toEqual(['Bash(git commit:*)'])
  })

  it('writes a sanitize.stripped audit entry with the removed list', () => {
    writeSettings(tmpRoot, 'settings.local.json', {
      permissions: { allow: ['Bash(git commit:*)', 'Edit'] },
    })
    const audited: Record<string, unknown>[] = []
    sanitize(tmpRoot, { auditWriter: (e) => audited.push(e) })
    const entry = audited.find((e) => e.event === 'sanitize.stripped')
    expect(entry).toBeDefined()
    expect(entry?.count).toBe(1)
    expect(entry?.stripped).toEqual(['Bash(git commit:*)'])
  })

  it('default audit writer appends JSONL to .rsct/audit.log', () => {
    writeSettings(tmpRoot, 'settings.local.json', {
      permissions: { allow: ['Bash(git commit:*)'] },
    })
    sanitize(tmpRoot, { now: new Date('2026-06-06T12:00:00Z') })
    const auditPath = join(tmpRoot, '.rsct', 'audit.log')
    expect(existsSync(auditPath)).toBe(true)
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(entry.event).toBe('sanitize.stripped')
    expect(entry.ts).toBe('2026-06-06T12:00:00.000Z')
  })

  it('is no_change when allow is empty or absent — no audit entry', () => {
    writeSettings(tmpRoot, 'settings.local.json', {
      permissions: { allow: [] },
      other: 'data',
    })
    const audited: Record<string, unknown>[] = []
    const result = sanitize(tmpRoot, { auditWriter: (e) => audited.push(e) })
    const file = result.files.find((f) =>
      f.path.endsWith('settings.local.json'),
    )
    expect(file?.status).toBe('no_change')
    expect(audited.length).toBe(0)
  })

  it('preserves unrelated top-level fields when sanitizing', () => {
    const path = writeSettings(tmpRoot, 'settings.local.json', {
      permissions: {
        allow: ['Bash(git commit:*)'],
        deny: ['something'],
      },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }],
      },
      env: { FOO: 'bar' },
    })
    sanitize(tmpRoot, { auditWriter: () => {} })
    const after = readJson(path)
    expect(after.hooks).toBeDefined()
    expect(after.env).toEqual({ FOO: 'bar' })
    expect((after.permissions as { deny: string[] }).deny).toEqual([
      'something',
    ])
  })
})

describe('sanitize-permissions — resolveProjectRootFromArgs', () => {
  it('honors --project-root <relative> resolved against cwd', () => {
    const root = resolveProjectRootFromArgs({
      argv: ['--project-root', 'sub'],
      env: { CLAUDE_PROJECT_DIR: '/should/be/ignored' },
      cwd: tmpRoot,
    })
    expect(root).toBe(join(tmpRoot, 'sub'))
  })

  it('honors --project-root <absolute> verbatim', () => {
    const abs = tmpRoot
    const root = resolveProjectRootFromArgs({
      argv: ['--project-root', abs],
      env: {},
      cwd: '/elsewhere',
    })
    expect(root).toBe(abs)
  })

  it('falls back to CLAUDE_PROJECT_DIR when --project-root is absent', () => {
    const root = resolveProjectRootFromArgs({
      argv: [],
      env: { CLAUDE_PROJECT_DIR: tmpRoot },
      cwd: '/elsewhere',
    })
    expect(root).toBe(tmpRoot)
  })

  it('falls back to cwd when neither arg nor env provided', () => {
    const root = resolveProjectRootFromArgs({
      argv: [],
      env: {},
      cwd: tmpRoot,
    })
    expect(root).toBe(tmpRoot)
  })
})

describe('sanitize-permissions — main()', () => {
  it('returns exit code 0 and emits diagnostic when something was stripped', () => {
    writeSettings(tmpRoot, 'settings.local.json', {
      permissions: { allow: ['Bash(git commit:*)'] },
    })
    const messages: string[] = []
    const exit = main({
      argv: ['--project-root', tmpRoot],
      env: {},
      cwd: '/elsewhere',
      stderr: (m) => messages.push(m),
    })
    expect(exit).toBe(0)
    expect(
      messages.some((m) => m.includes('stripped 1 poison-pill entry')),
    ).toBe(true)
  })

  it('returns exit code 0 silently when nothing to do', () => {
    const messages: string[] = []
    const exit = main({
      argv: [],
      env: { CLAUDE_PROJECT_DIR: tmpRoot },
      cwd: '/elsewhere',
      stderr: (m) => messages.push(m),
    })
    expect(exit).toBe(0)
    expect(messages.length).toBe(0)
  })
})
