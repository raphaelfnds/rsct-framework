import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, posix, sep, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PLAN_TRACKING_GLOBS,
  evaluateEditGuard,
  judgeEditScope,
  nativeScopePaths,
  type FileIdentity,
  type ScopePathDeps,
  type ScopeVerdict,
} from '../../src/lib/edit-guard.js'
import { decide } from '../../src/lib/edit-scope-hook.js'
import { checkEditScopeHandler } from '../../src/tools/check-edit-scope.js'
import {
  matchesAnyGlob,
  stampContextStale,
  readContextStale,
  stampBootstrapMarker,
  readPhaseState,
  type PhaseState,
} from '../../src/lib/phase-scope.js'

let tmpRoot: string
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-guard-'))
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeState(state: Record<string, unknown>): void {
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(join(tmpRoot, '.rsct', 'phase-state.json'), JSON.stringify(state, null, 2))
}

describe('lib/edit-guard — evaluateEditGuard', () => {
  it('allows an unmanaged project (no .rsct.json)', () => {
    const r = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: false, filePath: 'x.ts' })
    expect(r.decision).toBe('allow')
    expect(r.status).toBe('unmanaged')
  })

  it('BLOCKS when context_stale is set', () => {
    writeState({ context_stale: { since: '2026-07-11T00:00:00Z', reason: 'plan_closed' } })
    const r = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'src/a.ts' })
    expect(r.decision).toBe('block')
    expect(r.status).toBe('stale_context')
  })

  it('allows when there is no active phase scope (unknown)', () => {
    const r = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'src/a.ts' })
    expect(r.decision).toBe('allow')
    expect(r.status).toBe('unknown')
  })

  it('allows an in-scope edit and BLOCKS an out-of-scope one', () => {
    writeState({ scope_globs: ['src/**'] })
    expect(evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'src/a.ts' }).decision).toBe('allow')
    const out = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'other/b.ts' })
    expect(out.decision).toBe('block')
    expect(out.status).toBe('out_of_scope')
  })

  it('FAILS OPEN (infra_error) on a corrupt phase-state', () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(join(tmpRoot, '.rsct', 'phase-state.json'), '{ corrupt')
    const r = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'src/a.ts' })
    expect(r.decision).toBe('allow')
    expect(r.status).toBe('infra_error')
  })
})

describe('lib/edit-scope-hook — decide (exit 2 only for a real block)', () => {
  function payload(filePath: string): string {
    return JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath }, cwd: tmpRoot })
  }
  const env = () => ({ CLAUDE_PROJECT_DIR: tmpRoot }) as NodeJS.ProcessEnv

  it('exits 0 on empty stdin', () => {
    expect(decide('', env(), tmpRoot).exitCode).toBe(0)
  })
  it('exits 0 on malformed stdin', () => {
    expect(decide('not json', env(), tmpRoot).exitCode).toBe(0)
  })
  it('exits 0 when there is no file_path', () => {
    expect(decide(JSON.stringify({ tool_input: {} }), env(), tmpRoot).exitCode).toBe(0)
  })
  it('exits 2 (deny) when context is stale', () => {
    writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    writeState({ context_stale: { since: '2026-07-11T00:00:00Z', reason: 'plan_closed' } })
    const d = decide(payload('src/a.ts'), env(), tmpRoot)
    expect(d.exitCode).toBe(2)
    expect(d.message).toMatch(/stale_context/)
  })
  it('exits 0 (allow) for an in-scope edit', () => {
    writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    writeState({ scope_globs: ['src/**'] })
    expect(decide(payload('src/a.ts'), env(), tmpRoot).exitCode).toBe(0)
  })
  it('handles a NotebookEdit payload (notebook_path)', () => {
    writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    writeState({ context_stale: { since: '2026-07-11T00:00:00Z', reason: 'pivot' } })
    const d = decide(JSON.stringify({ tool_input: { notebook_path: 'nb.ipynb' }, cwd: tmpRoot }), env(), tmpRoot)
    expect(d.exitCode).toBe(2)
  })

  it('judges every path the payload carries and refuses when one of them is refused (#114)', () => {
    writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    writeState({ scope_globs: ['src/**'] })
    const both = (file_path: unknown, notebook_path: unknown): number =>
      decide(JSON.stringify({ tool_input: { file_path, notebook_path }, cwd: tmpRoot }), env(), tmpRoot).exitCode
    expect(both('', join(tmpRoot, 'nb.ipynb'))).toBe(2)
    expect(both(join(tmpRoot, 'src', 'a.ts'), join(tmpRoot, 'nb.ipynb'))).toBe(2)
    expect(both(join(tmpRoot, 'README.md'), join(tmpRoot, 'src', 'nb.ipynb'))).toBe(2)
    expect(both(join(tmpRoot, 'src', 'a.ts'), join(tmpRoot, 'src', 'nb.ipynb'))).toBe(0)
    expect(both('', '')).toBe(0)
    expect(both(7, null)).toBe(0)
  })

  it('resolves a relative path against the directory the payload names (#114)', () => {
    writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    writeState({ scope_globs: ['src/**'] })
    const from = (cwd: string, file_path: string): number =>
      decide(JSON.stringify({ tool_input: { file_path }, cwd }), env(), tmpRoot).exitCode
    expect(from(join(tmpRoot, 'packages', 'a'), 'src/x.ts')).toBe(2)
    expect(from(join(tmpRoot, 'src'), 'a.ts')).toBe(0)
    expect(from(tmpRoot, 'src/x.ts')).toBe(0)
  })

  it('carries the reason the guard gave into the message the agent sees (#114)', () => {
    writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    writeState({ scope_globs: ['src/**'] })
    const blocked = decide(payload(join(tmpRoot, 'docs', 'guide.md')), env(), tmpRoot)
    expect(blocked.exitCode).toBe(2)
    expect(blocked.message).toBe(
      `[rsct] Edit blocked (out_of_scope): ${evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: join(tmpRoot, 'docs', 'guide.md') }).reason}`,
    )
    expect(blocked.message).toContain("judged as 'docs/guide.md'")
    writeState({ context_stale: { since: '2026-07-11T00:00:00Z', reason: 'plan_closed' } })
    const stale = decide(payload(join(tmpRoot, 'src', 'a.ts')), env(), tmpRoot)
    expect(stale.message).toContain('stop and tell the developer')
  })
})

describe('tools/check-edit-scope — stale_context status', () => {
  it('returns stale_context (before the empty-scope short-circuit) via override', async () => {
    const out = await checkEditScopeHandler({
      project_root: tmpRoot,
      file_path: 'src/a.ts',
      phase_state_override: { context_stale: { since: '2026-07-11T00:00:00Z', reason: 'plan_closed' } },
    })
    expect(out.status).toBe('stale_context')
    expect(out.hints.some((h) => /STALE/.test(h))).toBe(true)
  })
})

describe('lib/phase-scope — context_stale flag lifecycle (D4)', () => {
  it('stampContextStale sets it and readContextStale reads it back', () => {
    stampContextStale(tmpRoot, 'plan_closed', new Date('2026-07-11T00:00:00Z'))
    expect(readContextStale(readPhaseState(tmpRoot).state)?.reason).toBe('plan_closed')
  })
  it('rsct_status-style stamp (no clearStale) does NOT clear it', () => {
    stampContextStale(tmpRoot, 'plan_closed', new Date('2026-07-11T00:00:00Z'))
    stampBootstrapMarker(tmpRoot, { now: new Date('2026-07-11T01:00:00Z') })
    expect(readContextStale(readPhaseState(tmpRoot).state)).not.toBeNull()
  })
  it('load_context-style stamp (clearStale:true) clears it', () => {
    stampContextStale(tmpRoot, 'plan_closed', new Date('2026-07-11T00:00:00Z'))
    stampBootstrapMarker(tmpRoot, { now: new Date('2026-07-11T01:00:00Z'), clearStale: true })
    expect(readContextStale(readPhaseState(tmpRoot).state)).toBeNull()
  })
})

describe('evaluateEditGuard — a path carrying a line terminator is blocked', () => {
  const LF = String.fromCharCode(10)

  it('blocks it even under a glob that spans directories', () => {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct.json'),
      JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }),
      'utf8',
    )
    writeFileSync(
      join(tmpRoot, '.rsct', 'phase-state.json'),
      JSON.stringify({ phase: 'code', spec_slug: 'feat-x', scope_globs: ['**/x.ts'] }),
      'utf8',
    )
    const blocked = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: `a${LF}b/x.ts` })
    expect(blocked.decision).toBe('block')
    expect(blocked.status).toBe('out_of_scope')
    const allowed = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'a/b/x.ts' })
    expect(allowed.decision).toBe('allow')
  })
})

describe('evaluateEditGuard — plan-tracking files, canonical paths and paths outside the project (#114)', () => {
  const LF = String.fromCharCode(10)
  const STALE = { since: '2026-07-11T00:00:00Z', reason: 'plan_closed' }
  const swapCase = (p: string): string =>
    p.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
  const caseInsensitive = existsSync(swapCase(tmpdir()))
  const links: string[] = []

  afterEach(() => {
    for (const link of links.splice(0)) rmSync(link, { force: true })
  })

  function judge(filePath: string, projectRoot = tmpRoot) {
    return evaluateEditGuard({ projectRoot, rsctInstalled: true, filePath })
  }

  function linkToRoot(): string {
    const link = join(tmpdir(), `rsct-guard-link-${process.pid}-${Date.now()}-${links.length}`)
    symlinkSync(tmpRoot, link, 'junction')
    links.push(link)
    return link
  }

  it.each(['plan_demo.md', 'progress_demo.md', 'spec_demo.md'])(
    'allows %s at the project root although the list does not name it',
    (name) => {
      writeState({ scope_globs: ['src/**'] })
      for (const form of [name, join(tmpRoot, name)]) {
        const r = judge(form)
        expect(r.decision).toBe('allow')
        expect(r.status).toBe('in_scope')
        expect(r.reason).toBe('plan-tracking file — always editable while a scope is active')
      }
      expect(judge('notes_demo.md').decision).toBe('block')
    },
  )

  it.each(['docs/plan_demo.md', 'sub/progress_demo.md', 'plan_demo.md/evil.ts', 'PLAN_demo.md', 'plan_demo.ts', 'myplan_demo.md'])(
    'blocks %s — the exemption is the three root patterns only',
    (path) => {
      writeState({ scope_globs: ['src/**'] })
      const r = judge(path)
      expect(r.decision).toBe('block')
      expect(r.status).toBe('out_of_scope')
    },
  )

  it('still blocks a plan-tracking name that carries a line terminator', () => {
    writeState({ scope_globs: ['src/**'] })
    expect(matchesAnyGlob(`plan_a${LF}b.md`, PLAN_TRACKING_GLOBS).matched).toBe(true)
    const r = judge(`plan_a${LF}b.md`)
    expect(r.decision).toBe('block')
    expect(r.reason).toContain('line terminator')
  })

  it('still blocks a plan-tracking file while the context is stale', () => {
    writeState({ scope_globs: ['src/**'], context_stale: STALE })
    const r = judge('progress_demo.md')
    expect(r.decision).toBe('block')
    expect(r.status).toBe('stale_context')
  })

  it('judges the path a ".." resolves to, not the one that was typed', () => {
    writeState({ scope_globs: ['src/**'] })
    const climbing = [tmpRoot, 'src', '..', 'README.md'].join(sep)
    expect(climbing).toContain(`${sep}..${sep}`)
    expect(judge('src/../README.md').decision).toBe('block')
    expect(judge(climbing).decision).toBe('block')
    expect(judge('other/../src/a.ts').decision).toBe('allow')
    expect(judge([tmpRoot, 'other', '..', 'src', 'a.ts'].join(sep)).decision).toBe('allow')
  })

  it('matches the list against the path below the project root, never against the folders above it', () => {
    const above = mkdtempSync(join(tmpdir(), 'rsct-guard-above-'))
    const root = join(above, 'build', 'project')
    try {
      mkdirSync(join(root, '.rsct'), { recursive: true })
      writeFileSync(join(root, '.rsct', 'phase-state.json'), JSON.stringify({ scope_globs: ['**/build/**'] }))
      expect(judge(join(root, 'README.md'), root).decision).toBe('block')
      expect(judge('README.md', root).decision).toBe('block')
      expect(judge(join(root, 'build', 'out.js'), root).decision).toBe('allow')
      expect(judge(join(root, 'packages', 'build', 'out.js'), root).decision).toBe('allow')
    } finally {
      rmSync(above, { recursive: true, force: true })
    }
  })

  it('resolves a relative path against the directory the client is in, when it gives one', () => {
    writeState({ scope_globs: ['src/**'] })
    const inPackage = (filePath: string, cwd: string) =>
      evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath, cwd })
    expect(inPackage('src/x.ts', join(tmpRoot, 'packages', 'a')).decision).toBe('block')
    expect(inPackage('a.ts', join(tmpRoot, 'src')).decision).toBe('allow')
    expect(inPackage('plan_x.md', join(tmpRoot, 'docs')).decision).toBe('block')
    expect(judge('src/x.ts').decision).toBe('allow')
  })

  it('allows a path outside the project and says the scope does not govern it', () => {
    writeState({ scope_globs: ['src/**'] })
    for (const outside of [join(tmpdir(), 'rsct-elsewhere', 'note.md'), `${tmpRoot}-sibling/src/a.ts`, 'src/../../escaped.ts']) {
      const r = judge(outside)
      expect(r.decision).toBe('allow')
      expect(r.status).toBe('unknown')
      expect(r.reason).toContain('outside the project')
    }
    expect(judge('README.md').decision).toBe('block')
  })

  it('does not take a name that merely starts with two dots for a path outside the project', () => {
    writeState({ scope_globs: ['src/**'] })
    for (const inside of ['..env.ts', '..cache/a.ts', join(tmpRoot, '..env.ts')]) {
      const r = judge(inside)
      expect(r.decision).toBe('block')
      expect(r.status).toBe('out_of_scope')
    }
    expect(judge('..').status).toBe('unknown')
  })

  it('still blocks a path outside the project while the context is stale', () => {
    writeState({ scope_globs: ['src/**'], context_stale: STALE })
    const r = judge(join(tmpdir(), 'rsct-elsewhere', 'note.md'))
    expect(r.decision).toBe('block')
    expect(r.status).toBe('stale_context')
  })

  it('matches a listed file when the project is reached through a link on either side', () => {
    writeState({ scope_globs: ['src/**'] })
    const link = linkToRoot()
    expect(judge(join(tmpRoot, 'src', 'a.ts'), link).decision).toBe('allow')
    expect(judge(join(link, 'src', 'a.ts'), tmpRoot).decision).toBe('allow')
    expect(judge(join(tmpRoot, 'README.md'), link).decision).toBe('block')
    expect(judge(join(link, 'README.md'), tmpRoot).decision).toBe('block')
  })

  it.skipIf(!caseInsensitive)('matches a listed file when the project folder is typed in another letter case', () => {
    writeState({ scope_globs: ['src/**'] })
    const other = swapCase(tmpRoot)
    expect(other).not.toBe(tmpRoot)
    expect(judge(join(other, 'src', 'a.ts'), tmpRoot).decision).toBe('allow')
    expect(judge(join(tmpRoot, 'src', 'a.ts'), other).decision).toBe('allow')
    expect(judge(join(other, 'README.md'), tmpRoot).decision).toBe('block')
  })
})

describe('judgeEditScope — inside is shown by the resolved path or by file identity; the rest is outside (#114)', () => {
  const BS = String.fromCharCode(92)
  const UNC = BS + BS
  const w = (...parts: string[]): string => parts.join(BS)
  const STATE: PhaseState = { phase: 'code', scope_globs: ['src/**'] }
  const LOCAL = w('C:', 'proj')
  const SHARE = UNC + w('wsl.localhost', 'Ubuntu', 'home', 'p')
  const OUTSIDE: ScopeVerdict = { status: 'unknown', why: 'outside_project' }
  const NETWORK: ScopeVerdict = { status: 'out_of_scope', why: 'network_path' }
  const listed = (matched_glob: string): ScopeVerdict => ({ status: 'in_scope', matched_glob })
  const unlisted = (judged_as: string): ScopeVerdict => ({ status: 'out_of_scope', why: 'not_listed', judged_as })

  function ask(
    api: typeof win32,
    projectRoot: string,
    filePath: string,
    canonical: (path: string) => string = (path) => path,
    more: { identity?: (path: string) => FileIdentity | null; globs?: string[]; baseDir?: string } = {},
  ): { verdict: ScopeVerdict; resolved: string[] } {
    const seen = new Map<string, bigint>()
    const distinct = (path: string): FileIdentity => {
      if (!seen.has(path)) seen.set(path, BigInt(seen.size + 1))
      return { dev: 1n, ino: seen.get(path)! }
    }
    const resolved: string[] = []
    const deps: ScopePathDeps = {
      isAbsolute: api.isAbsolute,
      relative: api.relative,
      resolve: api.resolve,
      sep: api.sep,
      dirname: api.dirname,
      canonical: (path) => {
        resolved.push(path)
        return canonical(path)
      },
      identity: more.identity ?? distinct,
    }
    const state: PhaseState = more.globs ? { ...STATE, scope_globs: more.globs } : STATE
    const verdict = judgeEditScope(
      { projectRoot, filePath, state, stateExists: true, ...(more.baseDir !== undefined && { baseDir: more.baseDir }) },
      deps,
    )
    return { verdict, resolved }
  }

  const ABOVE: Array<[typeof win32, string, string, ScopeVerdict]> = [
    [win32, w('C:', 'src', 'proj'), w('C:', 'src', 'proj', 'README.md'), unlisted('README.md')],
    [win32, w('C:', 'src', 'proj'), w('C:', 'src', 'proj', 'lib', 'x.ts'), unlisted('lib/x.ts')],
    [win32, w('C:', 'src', 'proj'), w('C:', 'src', 'proj', 'src', 'x.ts'), listed('**/src/**')],
    [win32, w('C:', 'src', 'proj'), w('C:', 'src', 'proj', 'pkg', 'src', 'x.ts'), listed('**/src/**')],
    [posix, '/usr/src/app', '/usr/src/app/README.md', unlisted('README.md')],
    [posix, '/usr/src/app', '/usr/src/app/src/x.ts', listed('**/src/**')],
  ]
  it.each(ABOVE)('a folder above the project never satisfies the list: %#', (api, projectRoot, filePath, expected) => {
    expect(ask(api, projectRoot, filePath, undefined, { globs: ['**/src/**'] }).verdict).toEqual(expected)
  })

  it('does not match a list entry written as an absolute path', () => {
    const absolute = ['C:/proj/src/**']
    expect(ask(win32, LOCAL, w('C:', 'proj', 'src', 'a.ts'), undefined, { globs: absolute }).verdict).toEqual(
      unlisted('src/a.ts'),
    )
  })

  it('compares a list entry with the spelling the disk holds, and says which spelling that was', () => {
    const typed = w('C:', 'proj', 'src', 'a.ts')
    const onDisk = (path: string): string => (path === typed ? w('C:', 'proj', 'Src', 'a.ts') : path)
    expect(ask(win32, LOCAL, typed, onDisk).verdict).toEqual(unlisted('Src/a.ts'))
    expect(ask(win32, LOCAL, typed, onDisk, { globs: ['Src/**'] }).verdict).toEqual(listed('Src/**'))
  })

  it('finds the project behind another spelling of its folder by file identity', () => {
    const root = '/mnt/c/Users/u/proj'
    const foldingDisk = (dev: bigint, ino: bigint) => (path: string): FileIdentity | null =>
      path.toLowerCase() === root.toLowerCase() ? { dev, ino } : { dev, ino: BigInt(path.length) + 1000n }
    const through = (filePath: string, identity: (path: string) => FileIdentity | null = foldingDisk(130n, 7n)) =>
      ask(posix, root, filePath, undefined, { identity }).verdict
    expect(through('/mnt/c/USERS/u/proj/README.md')).toEqual(unlisted('README.md'))
    expect(through('/mnt/c/USERS/u/proj/docs/guide.md')).toEqual(unlisted('docs/guide.md'))
    expect(through('/mnt/c/USERS/u/proj/src/a.ts')).toEqual(listed('src/**'))
    expect(through('/mnt/c/USERS/u/proj/progress_demo.md')).toEqual({ status: 'in_scope', matched_glob: null })
    expect(through('/mnt/c/USERS/u/elsewhere/README.md')).toEqual(OUTSIDE)
    expect(through('/mnt/c/USERS/u/proj/README.md', () => null)).toEqual(OUTSIDE)
    expect(through('/mnt/c/USERS/u/proj/README.md', foldingDisk(130n, 0n))).toEqual(OUTSIDE)
    const otherDisk = (path: string): FileIdentity | null => ({ dev: path === root ? 130n : 131n, ino: 7n })
    expect(through('/mnt/c/USERS/u/proj/README.md', otherDisk)).toEqual(OUTSIDE)
  })

  it('on Windows trusts the file number on one drive only, and never the device number', () => {
    const alias = w('C:', 'Alias')
    const numbered = (path: string): FileIdentity | null => {
      if (path === LOCAL) return { dev: 0n, ino: 42n }
      if (path === alias) return { dev: 2899514627n, ino: 42n }
      return { dev: 0n, ino: BigInt(path.length) + 1000n }
    }
    expect(ask(win32, LOCAL, w('C:', 'Alias', 'README.md'), undefined, { identity: numbered }).verdict).toEqual(
      unlisted('README.md'),
    )
    expect(ask(win32, LOCAL, w('C:', 'Alias', 'src', 'a.ts'), undefined, { identity: numbered }).verdict).toEqual(
      listed('src/**'),
    )
    const driveRoots = (path: string): FileIdentity | null =>
      path.length === 3 ? { dev: 0n, ino: 5n } : { dev: 0n, ino: BigInt(path.length) + 1000n }
    expect(ask(win32, w('D:', ''), w('C:', 'Users', 'u', 'note.md'), undefined, { identity: driveRoots }).verdict).toEqual(
      OUTSIDE,
    )
    expect(ask(win32, w('D:', ''), w('D:', 'src', 'a.ts'), undefined, { identity: driveRoots }).verdict).toEqual(
      listed('src/**'),
    )
  })

  it('on Windows reads a Git-Bash drive path the way the client does', () => {
    expect(ask(win32, LOCAL, '/c/proj/README.md').verdict).toEqual(unlisted('README.md'))
    expect(ask(win32, LOCAL, '/c/proj/src/a.ts').verdict).toEqual(listed('src/**'))
    expect(ask(win32, LOCAL, '/C/proj/src/a.ts').verdict).toEqual(listed('src/**'))
    expect(ask(win32, LOCAL, '/c/proj/plan_demo.md').verdict).toEqual({ status: 'in_scope', matched_glob: null })
    expect(ask(win32, LOCAL, '/d/notes/a.md').verdict).toEqual(OUTSIDE)
    expect(['unknown', 'out_of_scope']).toContain(ask(win32, LOCAL, '/tmp/note.md').verdict.status)
    expect(ask(posix, '/c/proj', '/c/proj/src/a.ts').verdict).toEqual(listed('src/**'))
    expect(ask(posix, '/c/proj', '/c/proj/README.md').verdict).toEqual(unlisted('README.md'))
  })

  it('keeps every character of the remainder when the project path holds a dotted capital I', () => {
    const root = w('C:', String.fromCharCode(0x130), 'proj')
    expect(ask(win32, root, root + BS + w('xsrc', 'a.ts')).verdict).toEqual(unlisted('xsrc/a.ts'))
    expect(ask(win32, root, root + BS + w('src', 'a.ts')).verdict).toEqual(listed('src/**'))
  })

  it('resolves a relative path against the base directory it is given', () => {
    const below = (filePath: string, baseDir?: string) =>
      ask(posix, '/home/u/p', filePath, undefined, baseDir === undefined ? {} : { baseDir }).verdict
    expect(below('src/x.ts', '/home/u/p/packages/a')).toEqual(unlisted('packages/a/src/x.ts'))
    expect(below('a.ts', '/home/u/p/src')).toEqual(listed('src/**'))
    expect(below('../x.ts', '/home/u/p')).toEqual(OUTSIDE)
    expect(below('src/x.ts')).toEqual(listed('src/**'))
  })

  const WINDOWS: Array<[string, string, ScopeVerdict]> = [
    [LOCAL, w('C:', 'proj', 'src', 'a.ts'), listed('src/**')],
    [LOCAL, w('C:', 'proj', 'README.md'), unlisted('README.md')],
    [LOCAL, w('C:', 'proj', '..env.ts'), unlisted('..env.ts')],
    [LOCAL, w('C:', 'other', 'src', 'a.ts'), OUTSIDE],
    [LOCAL, w('C:', 'proj-sibling', 'src', 'a.ts'), OUTSIDE],
    [LOCAL, w('D:', 'notes', 'a.md'), OUTSIDE],
    [LOCAL, UNC + w('localhost', 'C$', 'proj', 'README.md'), NETWORK],
    [LOCAL, UNC + w('localhost', 'C$', 'proj', 'src', 'a.ts'), NETWORK],
    [SHARE, SHARE + BS + w('src', 'a.ts'), listed('src/**')],
    [SHARE, SHARE + BS + 'README.md', unlisted('README.md')],
    [SHARE, UNC + w('wsl.localhost', 'Ubuntu', 'home', 'q', 'a.ts'), OUTSIDE],
    [SHARE, UNC + w('wsl$', 'Ubuntu', 'home', 'p', 'README.md'), NETWORK],
    [SHARE, w('C:', 'Users', 'u', 'note.md'), OUTSIDE],
  ]
  it.each(WINDOWS)('Windows paths: project %j, file %j', (projectRoot, filePath, expected) => {
    expect(ask(win32, projectRoot, filePath).verdict).toEqual(expected)
  })

  it('refuses a network path on another root without asking the disk about it', () => {
    const foreign = UNC + w('localhost', 'C$', 'proj', 'README.md')
    const { verdict, resolved } = ask(win32, LOCAL, foreign)
    expect(verdict).toEqual(NETWORK)
    expect(resolved).toEqual([LOCAL])
    expect(ask(win32, LOCAL, w('D:', 'notes', 'a.md')).resolved).toEqual([LOCAL, w('D:', 'notes', 'a.md')])
  })

  it('refuses a local path that resolves to a network path on another root', () => {
    const viaLink = w('C:', 'proj', 'shared', 'a.ts')
    const target = UNC + w('server', 'share', 'a.ts')
    const { verdict } = ask(win32, LOCAL, viaLink, (path) => (path === viaLink ? target : path))
    expect(verdict).toEqual(NETWORK)
    expect(ask(win32, LOCAL, viaLink).verdict).toEqual(unlisted('shared/a.ts'))
  })

  it('judges a project on a mapped drive by where the drive really points', () => {
    const mapped = (path: string): string =>
      path.startsWith('Z:') ? UNC + w('server', 'share') + path.slice(2) : path
    expect(ask(win32, w('Z:', 'proj'), w('Z:', 'proj', 'src', 'a.ts'), mapped).verdict).toEqual(listed('src/**'))
    expect(ask(win32, w('Z:', 'proj'), 'README.md', mapped).verdict).toEqual(unlisted('README.md'))
  })

  const POSIX: Array<[string, string, ScopeVerdict]> = [
    ['/home/u/p', '/home/u/p/src/a.ts', listed('src/**')],
    ['/home/u/p', '/home/u/p/..env.ts', unlisted('..env.ts')],
    ['/home/u/p', '/home/u/q/src/a.ts', OUTSIDE],
    ['/home/u/p', '/tmp/note.md', OUTSIDE],
    ['/home/u/p', '/home/u/p/../p-sibling/src/a.ts', OUTSIDE],
  ]
  it.each(POSIX)('POSIX paths: project %j, file %j', (projectRoot, filePath, expected) => {
    expect(ask(posix, projectRoot, filePath).verdict).toEqual(expected)
  })

  it('reads the identity of real folders: a link the path resolver was not asked about still leads to the project', () => {
    const link = join(tmpdir(), `rsct-guard-identity-${process.pid}-${Date.now()}`)
    symlinkSync(tmpRoot, link, 'junction')
    try {
      const unresolved: ScopePathDeps = { ...nativeScopePaths, canonical: (path) => path }
      const through = (filePath: string, deps: ScopePathDeps): ScopeVerdict =>
        judgeEditScope({ projectRoot: tmpRoot, filePath, state: STATE, stateExists: true }, deps)
      expect(through(join(link, 'README.md'), unresolved)).toEqual(unlisted('README.md'))
      expect(through(join(link, 'src', 'a.ts'), unresolved)).toEqual(listed('src/**'))
      expect(through(join(tmpdir(), 'rsct-elsewhere', 'README.md'), unresolved)).toEqual(OUTSIDE)
      expect(through(join(link, 'README.md'), { ...unresolved, identity: () => null })).toEqual(OUTSIDE)
    } finally {
      rmSync(link, { force: true })
    }
  })

  it('says which path it judged, for the hook and for the tool', async () => {
    writeState({ scope_globs: ['src/**'] })
    const hook = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: join(tmpRoot, 'docs', 'guide.md') })
    expect(hook.reason).toContain("is OUTSIDE the active spec scope (judged as 'docs/guide.md' below the project root;")
    const tool = (await checkEditScopeHandler({ project_root: tmpRoot, file_path: join(tmpRoot, 'docs', 'guide.md') })) as {
      hints: string[]
    }
    expect(tool.hints).toContain(
      "It was judged as 'docs/guide.md' below the project root; list entries are relative to that root and compared case-sensitively with the spelling on disk.",
    )
    const listedFile = (await checkEditScopeHandler({ project_root: tmpRoot, file_path: join(tmpRoot, 'src', 'a.ts') })) as {
      hints: string[]
    }
    expect(listedFile.hints.join(' ')).not.toContain('It was judged as')
  })

  it('tells the agent to stop and tell the developer when the context is stale', () => {
    writeState({ scope_globs: ['src/**'], context_stale: { since: '2026-07-11T00:00:00Z', reason: 'plan_closed' } })
    const stale = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: 'src/a.ts' })
    expect(stale.reason).toBe(
      'context is STALE (a plan closed / pivot) — run rsct_status + rsct_load_context before editing. ' +
        'If those tools are not available in this session, stop and tell the developer: ' +
        'the RSCT troubleshooting guide has the way out',
    )
    expect(stale.reason).not.toContain('\n')
  })

  it.runIf(process.platform === 'win32')('words the refusal of a network path for the hook and for the tool', async () => {
    writeState({ scope_globs: ['src/**'] })
    const foreign = UNC + w('rsct-no-such-host.invalid', 'share', 'src', 'a.ts')
    const hook = evaluateEditGuard({ projectRoot: tmpRoot, rsctInstalled: true, filePath: foreign })
    const tool = (await checkEditScopeHandler({ project_root: tmpRoot, file_path: foreign })) as { status: string; hints: string[] }
    expect(hook.status).toBe('out_of_scope')
    expect(tool.status).toBe('out_of_scope')
    expect(hook.decision).toBe('block')
    expect(hook.reason).toBe(
      `'${foreign}' is a network-style path on another root than the project — the guard cannot tell whether it points back into the project. Use the file's path under the project root, or a path on a local drive`,
    )
    expect(tool.hints).toContain(
      `File '${foreign}' is a network-style path on another root than the project — it cannot be compared with the project root, so it is treated as out of scope. Use the file's path under the project root, or a path on a local drive.`,
    )
  })
})
