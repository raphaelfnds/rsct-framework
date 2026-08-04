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
import { hashSettingsContent } from '../../src/lib/settings-drift.js'
import { tmpdir } from 'node:os'
import {
  containsMachinePath,
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

describe('sanitize-permissions — UTF-8 BOM tolerance (#12)', () => {
  const BOM = '﻿'

  it('strips the poison pill from a BOM-prefixed settings.json', () => {
    // The worst consequence of the old behaviour: a BOM made this file
    // `malformed`, the strip never ran, and a `Bash(git commit:*)` allow-entry
    // survived — so commits bypassed rsct_request_commit entirely while every
    // surface reported healthy.
    const path = writeSettings(
      tmpRoot,
      'settings.json',
      BOM + JSON.stringify({ permissions: { allow: ['Bash(git commit:*)', 'Bash(ls)'] } }, null, 2),
    )
    const result = sanitize(tmpRoot)
    const file = result.files.find((f) => f.path === path)

    expect(file?.status).toBe('sanitized')
    expect(readJson(path)).toEqual({ permissions: { allow: ['Bash(ls)'] } })
  })

  it('does not re-emit the BOM it tolerated', () => {
    // Tolerate on read, never re-emit: a rewritten file must be plain UTF-8, or
    // it stays hostile to every other JSON reader in the ecosystem.
    const path = writeSettings(
      tmpRoot,
      'settings.json',
      BOM + JSON.stringify({ permissions: { allow: ['Bash(git commit:*)'] } }, null, 2),
    )
    sanitize(tmpRoot)
    expect(readFileSync(path, 'utf8').charCodeAt(0)).not.toBe(0xfeff)
  })

  it('reads a BOM-prefixed settings.local.json during the migration', () => {
    writeSettings(tmpRoot, 'settings.json', {
      permissions: { additionalDirectories: ['/abs/path'] },
    })
    const localPath = writeSettings(
      tmpRoot,
      'settings.local.json',
      BOM + JSON.stringify({ permissions: { additionalDirectories: [] } }, null, 2),
    )
    const result = sanitize(tmpRoot)

    // Before #12 the local read threw, the migration was skipped, and the
    // absolute path stayed in the versioned file.
    expect(result.files.some((f) => f.status === 'migration_skipped')).toBe(false)
    expect(readJson(localPath)).toEqual({
      permissions: { additionalDirectories: ['/abs/path'] },
    })
  })

  it('still reports genuinely malformed JSON as malformed', () => {
    // The BOM fix must not turn the parser lenient about anything else.
    const path = writeSettings(tmpRoot, 'settings.json', BOM + '{"permissions": {,}')
    const file = sanitize(tmpRoot).files.find((f) => f.path === path)
    expect(file?.status).toBe('malformed')
  })
})

describe('sanitize-permissions — machine paths in permissions.allow[] (#12)', () => {
  /**
   * The corpus IS the spec. Every entry here is either a real one from the field
   * report on #17 or a common Claude Code permission shape. A false positive
   * deletes a working permission from the file the team shares, so the negatives
   * matter as much as the positives.
   */
  const MUST_RELOCATE = [
    String.raw`Bash(git -C "C:\Users\raphael\VSCode\repo" status)`,
    'Bash(git -C /home/raphael/proj status)',
    'Read(/Users/raphael/notes/**)',
    'Read(//wsl.localhost/Ubuntu/home/raphael/**)',
    'Bash(cat /mnt/c/Users/raphael/.env)',
    'Bash(git -C "c:/users/RAPHAEL/x" log)', // drive letter: case-insensitive
    // The NATIVE Windows spelling of the WSL UNC path — what a Windows shell
    // actually produces, and the CAP-41 field-report environment.
    String.raw`Bash(cd \\wsl.localhost\Ubuntu\home\me && npm test)`,
  ]

  const MUST_KEEP = [
    'Bash(./mvnw -q -o compile)',
    'Bash(mvn -version)',
    'Bash(echo "exit=$?")',
    'mcp__rsct__rsct_persona_review',
    // Measured false positives of the naive "absolute path anywhere" predicate.
    'WebFetch(domain:https://github.com)',
    'Bash(curl -s https://registry.npmjs.org/)',
    'Bash(sed "s:/opt:/srv:")',
    // Absolute, but username-free and identical on every machine — relocating
    // these would only make teammates re-approve them.
    'Read(/etc/hosts)',
    'Bash(cd /tmp && ls)',
    'Read(//c//**)',
    // Path-shaped entries with a `home`/`users` SEGMENT. An unanchored predicate
    // relocated all six, which DELETES a working permission from the file the
    // team shares — the exact failure V-3 named. Found in REVIEW, not by these
    // tests, because the original corpus had no path-style entry at all.
    'Read(src/pages/home/**)',
    'Edit(src/app/home/**)',
    'Read(app/controllers/users/**)',
    'Read(**/users/**)',
    // Lower-case `/users/` is an API path; macOS is `/Users/`. That is why the
    // POSIX branches are case-SENSITIVE while the drive-letter one is not.
    'Bash(gh api /users/octocat)',
    'Bash(curl http://localhost:3000/api/users/1)',
  ]

  it('classifies the whole corpus correctly', () => {
    for (const e of MUST_RELOCATE) expect(`${e} → ${containsMachinePath(e)}`).toBe(`${e} → true`)
    for (const e of MUST_KEEP) expect(`${e} → ${containsMachinePath(e)}`).toBe(`${e} → false`)
  })

  it('ignores non-strings without throwing', () => {
    for (const v of [null, undefined, 42, {}, [], true]) {
      expect(containsMachinePath(v)).toBe(false)
    }
  })

  it('relocates only the offending entries, verbatim, and keeps the rest', () => {
    const leak = String.raw`Bash(git -C "C:\Users\raphael\VSCode\repo" status)`
    const settingsPath = writeSettings(tmpRoot, 'settings.json', {
      permissions: { allow: [leak, 'Bash(mvn -version)', 'Read(/etc/hosts)'] },
    })
    const result = sanitize(tmpRoot)

    expect(result.files.find((f) => f.path === settingsPath)?.status).toBe('migrated')
    expect(readJson(settingsPath)).toEqual({
      permissions: { allow: ['Bash(mvn -version)', 'Read(/etc/hosts)'] },
    })
    // Verbatim — the command text is never rewritten, the path never genericised.
    expect(readJson(join(tmpRoot, '.claude', 'settings.local.json'))).toEqual({
      permissions: { allow: [leak] },
    })
  })

  it('migrates BOTH keys but reports the file ONCE', () => {
    // Two migration passes over one file must not yield two FileResults — the
    // stderr loop would print the migration line twice and a reader would count
    // the same file as two.
    const settingsPath = writeSettings(tmpRoot, 'settings.json', {
      permissions: {
        allow: ['Bash(git -C /home/raphael/p status)'],
        additionalDirectories: ['/home/raphael/other'],
      },
    })
    const result = sanitize(tmpRoot)
    const migrations = result.files.filter(
      (f) => f.path === settingsPath && f.status === 'migrated',
    )

    // ONE migration result, carrying both keys — not one per key. Two would make
    // the stderr loop print the migration line twice for the same file.
    expect(migrations).toHaveLength(1)
    expect(migrations[0]?.stripped).toHaveLength(2)
    expect(readJson(settingsPath)).toEqual({
      permissions: { allow: [], additionalDirectories: [] },
    })
  })

  it('an entry that is BOTH a machine path and a poison pill is stripped, not parked', () => {
    // The ordering hazard this pins: migrate-then-strip relocates the entry into
    // settings.local.json, and the loop's SECOND iteration — over that same local
    // file — removes it in the same run. Reversed, a live §C bypass would be
    // parked in the file nobody reviews and survive until the next session.
    //
    // Uses a form the pill detector actually recognises. `Bash(git -C <path>
    // commit)` is NOT recognised — see the sibling test below.
    writeSettings(tmpRoot, 'settings.json', {
      permissions: { allow: ['Bash(git commit -m /home/me/x)'] },
    })
    sanitize(tmpRoot)

    const local = readJson(join(tmpRoot, '.claude', 'settings.local.json')) as {
      permissions?: { allow?: unknown[] }
    }
    expect(local.permissions?.allow).toEqual([])
    expect(readJson(join(tmpRoot, '.claude', 'settings.json'))).toEqual({
      permissions: { allow: [] },
    })
  })

  it('`git -C <path> commit` is now BOTH relocated and stripped (#32 closed the gap)', () => {
    // INVERTED from v2.5.0, where this was pinned as a DOCUMENTED GAP: #12 got
    // the entry out of the versioned file (its own job, §E) but the pill detector
    // did not recognise the `-C` form, so it survived in settings.local.json and
    // still authorised a §C bypass on this machine. #32 widened the patterns to
    // allow git global options before the subcommand, so the loop's second
    // iteration now strips it from the local file in the same run.
    writeSettings(tmpRoot, 'settings.json', {
      permissions: { allow: [String.raw`Bash(git -C "C:\Users\me\repo" commit -m x)`] },
    })
    sanitize(tmpRoot)

    expect(readJson(join(tmpRoot, '.claude', 'settings.json'))).toEqual({
      permissions: { allow: [] },
    })
    const local = readJson(join(tmpRoot, '.claude', 'settings.local.json')) as {
      permissions?: { allow?: unknown[] }
    }
    expect(local.permissions?.allow).toEqual([])
  })

  it('LOCAL-WRITE-FIRST: a malformed local file aborts with settings.json untouched', () => {
    const before = { permissions: { allow: ['Bash(git -C /home/me/p status)'] } }
    const settingsPath = writeSettings(tmpRoot, 'settings.json', before)
    writeSettings(tmpRoot, 'settings.local.json', '{ not json')

    const result = sanitize(tmpRoot)
    expect(result.files.find((f) => f.path === settingsPath)?.status).toBe('migration_skipped')
    // The entries are still where they were — a failed migration never loses them.
    expect(readJson(settingsPath)).toEqual(before)
  })

  it('is idempotent — a second run finds nothing left to move', () => {
    writeSettings(tmpRoot, 'settings.json', {
      permissions: { allow: ['Bash(git -C /home/me/p status)', 'Bash(mvn -version)'] },
    })
    sanitize(tmpRoot)
    const afterFirst = readJson(join(tmpRoot, '.claude', 'settings.local.json'))
    sanitize(tmpRoot)
    expect(readJson(join(tmpRoot, '.claude', 'settings.local.json'))).toEqual(afterFirst)
  })
})

describe('sanitize-permissions — settings baseline (#17)', () => {
  function baselineEvents(): Record<string, unknown>[] {
    const p = join(tmpRoot, '.rsct', 'audit.log')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.event === 'settings.baseline')
  }

  it('records a baseline hash of settings.json', () => {
    writeSettings(tmpRoot, 'settings.json', { permissions: { allow: ['Bash(ls)'] } })
    sanitize(tmpRoot)
    const events = baselineEvents()
    expect(events).toHaveLength(1)
    expect(typeof events[0]?.hash).toBe('string')
  })

  it('records the POST-scrub content, not what it found', () => {
    // The ordering that matters: a baseline taken before the strip would freeze
    // the poison pill this run just removed, and the next commit would report
    // the framework's own cleanup as drift.
    writeSettings(tmpRoot, 'settings.json', {
      permissions: { allow: ['Bash(git commit:*)', 'Bash(ls)'] },
    })
    sanitize(tmpRoot)

    const recorded = baselineEvents()[0]?.hash
    const afterScrub = hashSettingsContent(
      readFileSync(join(tmpRoot, '.claude', 'settings.json'), 'utf8'),
    )
    expect(recorded).toBe(afterScrub)
  })

  it('records nothing when there is no settings.json — no file, no claim', () => {
    sanitize(tmpRoot)
    expect(baselineEvents()).toHaveLength(0)
  })
})

describe('sanitize-permissions — git global options before the subcommand (#32)', () => {
  /**
   * Every pattern used to assume `commit|push|merge` came immediately after
   * `git`. But git accepts global options first, and `git -C <path> commit`
   * commits in ANOTHER repository — which escapes both §C and the project-scoped
   * reasoning the rest of the framework relies on. Five forms walked past.
   */
  const MUST_CATCH = [
    'Bash(git -C /repo commit -m x)',
    'Bash(git -C /repo push)',
    'Bash(git -C:*)', // a wildcard where the subcommand belongs
    'Bash(git --git-dir=/r/.git commit)',
    'Bash(git -c user.name=x commit)',
    // Same family, not in the issue but the same shape.
    String.raw`Bash(git -C "C:\Program Files\repo" commit)`,
    'Bash(git --work-tree=/w --git-dir=/g merge x)',
    'Bash(git --no-pager -C /r push)',
    'Bash(git -c a=b -c c=d commit)',
  ]

  /**
   * Read-only subcommands that merely START with a mutating verb. These were
   * false positives BEFORE #32 too — `commit\b` matches `commit-graph`, since a
   * hyphen is not a word character — so the fix closes a pre-existing hole while
   * widening the pattern.
   */
  const MUST_KEEP = [
    'Bash(git commit-graph write)',
    'Bash(git merge-base HEAD main)',
    'Bash(git merge-tree a b)',
    'Bash(git -C /r merge-base a b)',
    // Global options on a read-only subcommand stay benign.
    'Bash(git -C /repo status)',
    'Bash(git --no-pager log)',
    'Bash(git log -- src/*.ts)', // a wildcard in a pathspec is not a blanket
  ]

  it('catches every documented bypass form', () => {
    for (const e of MUST_CATCH) expect(`${e} → ${isPoisonPill(e)}`).toBe(`${e} → true`)
  })

  it('does not touch read-only git, even with global options or a hyphenated subcommand', () => {
    for (const e of MUST_KEEP) expect(`${e} → ${isPoisonPill(e)}`).toBe(`${e} → false`)
  })

  it('still pins the basename — git-credential-store is a different binary', () => {
    expect(isPoisonPill('Bash(/usr/bin/git-credential-store)')).toBe(false)
    expect(isPoisonPill('Bash(/usr/bin/git commit)')).toBe(true)
  })

  it('strips a global-option bypass end to end', () => {
    const path = writeSettings(tmpRoot, 'settings.local.json', {
      permissions: { allow: ['Bash(git -C /other/repo commit -m x)', 'Bash(npm test)'] },
    })
    const result = sanitize(tmpRoot, { auditWriter: () => {} })
    expect(result.files.find((f) => f.path === path)?.status).toBe('sanitized')
    expect(readJson(path)).toEqual({ permissions: { allow: ['Bash(npm test)'] } })
  })
})
