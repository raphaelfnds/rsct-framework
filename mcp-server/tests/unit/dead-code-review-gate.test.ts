import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  OTHER_LANGUAGE_EVIDENCE_HINT_PREFIX,
  UNCOVERED_LANGUAGE_HINT_PREFIX,
  auditBoundKeeps,
  checkDeadCode,
  checkStagedDeadCode,
  declarationSha256,
  keepPrunePaths,
  mergeDeadCodeKeeps,
  readDeadCodeKeeps,
  setDeadCodeAnalysisHookForTests,
  type DeadCodeKeep,
} from '../../src/lib/dead-code/review-gate.js'
import { UNREADABLE_HINT_PREFIX } from '../../src/lib/dead-code/references.js'
import { limitBlobReadsForTests, openSweepRepo, readIndexEntries } from '../../src/lib/comment-sweep/git-reads.js'
import { deadCodeKeepKey } from '../../src/lib/free-commit.js'

let tmpRoot: string

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: tmpRoot, stdio: 'ignore' })
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-dcgate-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.autocrlf', 'false')
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(rel: string, content: string): void {
  const full = join(tmpRoot, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function commitAll(): void {
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
}

const LIVE_PAIR = {
  used: 'export function used(): void {}\n',
  withRotting: 'export function used(): void {}\nexport function rotting(): void {}\n',
  caller: "import { used } from './a.js'\nexport const run = () => used()\n",
  main: "import { run } from './b.js'\nrun()\n",
}

function decisionsFor(keeps: readonly DeadCodeKeep[]): Set<string> {
  return new Set(keeps.map((k) => deadCodeKeepKey(k.path, k.name, k.declaration_sha256)))
}

describe('checkDeadCode — the REVIEW gate reads the working tree', () => {
  it('passes when the touched files carry no dead symbol', async () => {
    writeFile('a.ts', LIVE_PAIR.used)
    writeFile('b.ts', LIVE_PAIR.caller)
    writeFile('main.ts', LIVE_PAIR.main)
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.unknown).toBe(0)
  })

  it('rejects a dead symbol in a touched file and names it', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reject_kind).toBe('dead_code_remaining')
    expect(check.reason).toContain('a.ts:rotting')
    expect(check.pending.map((p) => p.name)).toEqual(['rotting'])
  })

  it('trims a very long declaration preview but hashes the whole declaration', async () => {
    const body = `export function rotting(): string { return '${'x'.repeat(600)}' }`
    writeFile('a.ts', `export function used(): void {}\n${body}\n`)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (check.ok) throw new Error('expected a rejection')
    const pending = check.pending[0]!
    expect(pending.declaration.length).toBe(400)
    expect(pending.declaration_sha256).toBe(createHash('sha256').update(body, 'utf8').digest('hex'))
  })

  it('hands back the declaration text and its sha256, so a keep can be bound to bytes', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (check.ok) throw new Error('expected a rejection')
    expect(check.pending[0]?.declaration).toBe('export function rotting(): void {}')
    expect(check.pending[0]?.declaration_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(check.pending[0]?.keep_stale).toBe(false)
  })

  it('passes once the symbol is kept with the matching sha256, and returns what it kept', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const first = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (first.ok) throw new Error('expected a rejection')
    const pending = first.pending[0]!
    const second = await checkDeadCode({
      projectRoot: tmpRoot,
      touched: ['a.ts'],
      keeps: [{ path: pending.path, name: pending.name, declaration_sha256: pending.declaration_sha256, note: 'fails the build when removed' }],
    })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.kept.map((k) => k.name)).toEqual(['rotting'])
  })

  it('refuses a keep whose declaration changed since the developer granted it', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const staleSha = createHash('sha256').update('export function rotting(): void {}', 'utf8').digest('hex')
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): number { return 1 }\n')
    const check = await checkDeadCode({
      projectRoot: tmpRoot,
      touched: ['a.ts'],
      keeps: [{ path: 'a.ts', name: 'rotting', declaration_sha256: staleSha, note: 'granted earlier' }],
    })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reject_kind).toBe('dead_code_keep_stale')
    expect(check.pending[0]?.keep_stale).toBe(true)
  })

  it('reports a stale keep and an unkept dead symbol TOGETHER, so neither hides the other', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function kept(): number { return 2 }\nexport function other(): void {}\n')
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const staleSha = createHash('sha256').update('export function kept(): number { return 1 }', 'utf8').digest('hex')
    const check = await checkDeadCode({
      projectRoot: tmpRoot,
      touched: ['a.ts'],
      keeps: [{ path: 'a.ts', name: 'kept', declaration_sha256: staleSha, note: 'old bytes' }],
    })
    if (check.ok) throw new Error('expected a rejection')
    expect(check.reject_kind).toBe('dead_code_keep_stale')
    expect(check.pending.map((p) => [p.name, p.keep_stale]).sort()).toEqual([
      ['kept', true],
      ['other', false],
    ])
  })

  it('does not let a keep for one symbol cover another', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function first(): void {}\nexport function second(): void {}\n')
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const first = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (first.ok) throw new Error('expected a rejection')
    const one = first.pending.find((p) => p.name === 'first')!
    const second = await checkDeadCode({
      projectRoot: tmpRoot,
      touched: ['a.ts'],
      keeps: [{ path: one.path, name: one.name, declaration_sha256: one.declaration_sha256, note: 'keep' }],
    })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reject_kind).toBe('dead_code_remaining')
    expect(second.pending.map((p) => p.name)).toEqual(['second'])
  })

  it('says out loud that a touched file in another language was not checked', async () => {
    writeFile('script.py', 'def orphan():\n    pass\n')
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['script.py'], keeps: [] })
    expect(check.ok).toBe(true)
    if (!check.ok) return
    const hint = check.hints.find((h) => h.startsWith(UNCOVERED_LANGUAGE_HINT_PREFIX))
    expect(hint).toContain('script.py')
  })

  it('stays quiet about other languages when every touched file is analysable', async () => {
    writeFile('a.ts', LIVE_PAIR.used)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (!check.ok) throw new Error('expected a pass')
    expect(check.hints.some((h) => h.startsWith(UNCOVERED_LANGUAGE_HINT_PREFIX))).toBe(false)
  })

  it('returns what public_api exempted, so the REVIEW can show it to the developer', async () => {
    writeFile('a.ts', 'export function used(): void {}\nexport function exposed(): void {}\n')
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], publicApi: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.public_exempted.map((p) => p.name)).toEqual(['exposed'])
  })

  it('honours an import from a .vue component the repository holds', async () => {
    writeFile('a.ts', 'export function helper(): void {}\n')
    writeFile('entry.ts', "import './a.js'\n")
    writeFile('Comp.vue', "<script setup lang=\"ts\">\nimport { helper } from './a.js'\nhelper()\n</script>\n")
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.unknown).toBe(1)
  })

  it('never lets build output keep a symbol alive', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    writeFile('dist/index.js', "import { rotting } from '../a.js'\nrotting()\n")
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.pending.map((p) => p.name)).toEqual(['rotting'])
  })

  it('works when project_root is a subdirectory of the repository', async () => {
    writeFile('pkg/a.ts', LIVE_PAIR.withRotting)
    writeFile('pkg/b.ts', LIVE_PAIR.caller)
    commitAll()
    const check = await checkDeadCode({ projectRoot: join(tmpRoot, 'pkg'), touched: ['pkg/a.ts'], keeps: [] })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.pending.map((p) => `${p.path}:${p.name}`)).toEqual(['pkg/a.ts:rotting'])
  })
})

describe('checkStagedDeadCode — the commit gate reads the index, never the working tree', () => {
  it('passes when nothing staged is dead', async () => {
    writeFile('a.ts', LIVE_PAIR.used)
    writeFile('b.ts', LIVE_PAIR.caller)
    writeFile('main.ts', LIVE_PAIR.main)
    commitAll()
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.unknown).toBe(0)
  })

  it('refuses a staged file carrying a dead symbol, naming it and the path', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reject_kind).toBe('dead_code_staged')
    expect(check.reason).toContain('a.ts:rotting')
    expect(check.paths).toEqual(['a.ts'])
  })

  it('does NOT let an unstaged edit that calls the symbol get it through', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    writeFile('b.ts', "import { used, rotting } from './a.js'\nexport const run = () => { used(); rotting() }\n")
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('a.ts:rotting')
  })

  it('does NOT refuse a correct commit because of an unstaged edit that removes the caller', async () => {
    writeFile('a.ts', LIVE_PAIR.used)
    writeFile('b.ts', LIVE_PAIR.caller)
    writeFile('c.ts', "import './a.js'\n")
    commitAll()
    writeFile('b.ts', 'export const run = () => 0\n')
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(true)
  })

  it('judges the staged bytes of the file itself, not its working-tree copy', async () => {
    writeFile('a.ts', LIVE_PAIR.used)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    writeFile('a.ts', LIVE_PAIR.withRotting)
    git('add', 'a.ts')
    writeFile('a.ts', LIVE_PAIR.used)
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('a.ts:rotting')
  })

  it('honours a keep only when the audit log holds the developer decision for it', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const review = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (review.ok) throw new Error('expected the review to reject first')
    const pending = review.pending[0]!
    const keeps = [{ path: pending.path, name: pending.name, declaration_sha256: pending.declaration_sha256, note: 'load-bearing' }]

    const forged = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps, keepDecisions: new Set() })
    expect(forged.ok).toBe(false)

    const decided = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps, keepDecisions: decisionsFor(keeps) })
    expect(decided.ok).toBe(true)
    if (decided.ok) expect(decided.kept).toBe(1)
  })

  it('refuses again once the kept declaration is edited and staged', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const review = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (review.ok) throw new Error('expected the review to reject first')
    const pending = review.pending[0]!
    const keeps = [{ path: pending.path, name: pending.name, declaration_sha256: pending.declaration_sha256, note: 'load-bearing' }]
    writeFile('a.ts', 'export function used(): void {}\nexport function rotting(): number { return 7 }\n')
    git('add', 'a.ts')
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps, keepDecisions: decisionsFor(keeps) })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('different declaration bytes')
  })

  it('passes its hints through on success, so an unknown is never a silent pass', async () => {
    writeFile('entry.ts', 'export function looksOrphaned(): void {}\n')
    commitAll()
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['entry.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(true)
    if (check.ok) {
      expect(check.unknown).toBe(1)
      expect(check.hints.join(' ')).toContain('entry.ts')
    }
  })
})

describe('the gate says what it did not read', () => {
  it('names the other-language files it did not read as evidence when it reports a dead export', async () => {
    writeFile('a.ts', 'export function fromPython(): void {}\n')
    writeFile('entry.ts', "import './a.js'\n")
    writeFile('caller.py', 'import subprocess\nsubprocess.run(["node", "a.js"])\n')
    writeFile('styles.css', 'a { color: red }\n')
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (check.ok) throw new Error('expected a rejection')
    const hint = check.hints.find((h) => h.startsWith(OTHER_LANGUAGE_EVIDENCE_HINT_PREFIX))
    expect(hint).toContain('.py')
    expect(hint).not.toContain('.css')
  })

  it('does not raise that hint when only a private symbol is dead', async () => {
    writeFile('a.ts', 'function rotting(): void {}\nexport {}\n')
    writeFile('caller.py', 'print(1)\n')
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (check.ok) throw new Error('expected a rejection')
    expect(check.hints.some((h) => h.startsWith(OTHER_LANGUAGE_EVIDENCE_HINT_PREFIX))).toBe(false)
  })

  it('names a touched shell script as not checked, and never a markdown file', async () => {
    writeFile('run.sh', 'echo hi\n')
    writeFile('README.md', '# readme\n')
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['run.sh', 'README.md'], keeps: [] })
    const hints = check.hints.join(' ')
    expect(hints).toContain('not checked in run.sh')
    expect(hints).not.toContain('README.md')
  })

  it('calls a touched file under a root dist/ build output, not an unread language', async () => {
    writeFile('dist/index.js', 'export function bundled() {}\n')
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['dist/index.js'], keeps: [] })
    expect(check.ok).toBe(true)
    const hint = check.hints.find((h) => h.includes('dist/index.js'))
    expect(hint).toContain('build output')
    expect(hint).not.toContain('reads JavaScript and TypeScript only')
  })
})

describe('what counts as build output', () => {
  it('reads a nested build/ directory as ordinary source, so its imports are uses', async () => {
    writeFile('src/lib/x.ts', 'export function forBuild(): void {}\n')
    writeFile('src/commands/build/run.ts', "import { forBuild } from '../../lib/x.js'\nforBuild()\n")
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['src/lib/x.ts'], keeps: [] })
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.unknown).toBe(0)
  })

  it('never lets an HTML page under a root dist/ keep a symbol alive', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    writeFile('dist/index.html', '<script type="module">import { rotting } from "../a.js"; rotting()</script>\n')
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(false)
  })
})

describe('the REVIEW reads the working tree as the developer sees it', () => {
  it('counts a use in an untracked .vue component the change adds', async () => {
    writeFile('a.ts', 'export function useThing(): void {}\n')
    writeFile('entry.ts', "import './a.js'\n")
    commitAll()
    writeFile('Foo.vue', "<script setup lang=\"ts\">\nimport { useThing } from './a.js'\nuseThing()\n</script>\n")
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts', 'Foo.vue'], keeps: [] })
    expect(check.ok).toBe(true)
  })

  it('reads a sparse-checkout file from the index instead of dropping its uses', async () => {
    writeFile('a.ts', LIVE_PAIR.used)
    writeFile('b.ts', LIVE_PAIR.caller)
    writeFile('main.ts', LIVE_PAIR.main)
    writeFile('side.ts', "import './a.js'\n")
    commitAll()
    git('update-index', '--skip-worktree', 'b.ts')
    unlinkSync(join(tmpRoot, 'b.ts'))
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(true)
  })

  it('is not blinded by a tracked file deleted from the working tree', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    writeFile('old.ts', 'export const legacy = 1\n')
    commitAll()
    unlinkSync(join(tmpRoot, 'old.ts'))
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(false)
  })

  it('normalises CRLF before slicing a declaration, so the preview and the hash agree with LF', async () => {
    writeFile('a.ts', 'export function used(): void {}\r\nexport function rotting(): void {\r\n  return\r\n}\r\n')
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    if (check.ok) throw new Error('expected a rejection')
    const lf = 'export function rotting(): void {\n  return\n}'
    expect(check.pending[0]?.declaration).toBe(lf)
    expect(check.pending[0]?.declaration_sha256).toBe(createHash('sha256').update(lf, 'utf8').digest('hex'))
  })

  it('matches public_api relative to a project root below the repository root', async () => {
    writeFile('pkg/src/index.ts', 'export function publicThing(): void {}\n')
    writeFile('pkg/entry.ts', "import './src/index.js'\n")
    commitAll()
    const check = await checkDeadCode({ projectRoot: join(tmpRoot, 'pkg'), touched: ['pkg/src/index.ts'], publicApi: ['src/index.ts'], keeps: [] })
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.public_exempted.map((p) => p.name)).toEqual(['publicThing'])
  })
})

describe('a file the developer allowed without a mechanical check is not judged', () => {
  it('skips an exempt file in the REVIEW and says so', async () => {
    writeFile('vendor/lib.js', 'export function unusedVendored() {}\n')
    writeFile('entry.ts', "import './vendor/lib.js'\n")
    commitAll()
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['vendor/lib.js'], keeps: [], exempt: ['vendor/lib.js'] })
    expect(check.ok).toBe(true)
    expect(check.hints.join(' ')).toContain('not checked in vendor/lib.js')
  })

  it('skips it at the commit too', async () => {
    writeFile('vendor/lib.js', 'export function unusedVendored() {}\n')
    writeFile('entry.ts', "import './vendor/lib.js'\n")
    commitAll()
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['vendor/lib.js'], keeps: [], keepDecisions: new Set(), exempt: ['vendor/lib.js'] })
    expect(check.ok).toBe(true)
  })
})

describe('the gate fails closed when it cannot finish', () => {
  afterEach(() => setDeadCodeAnalysisHookForTests(null))

  it('refuses the REVIEW, with the reason, when the scan throws', async () => {
    writeFile('a.ts', LIVE_PAIR.used)
    commitAll()
    setDeadCodeAnalysisHookForTests(() => {
      throw new RangeError('boom')
    })
    const check = await checkDeadCode({ projectRoot: tmpRoot, touched: ['a.ts'], keeps: [] })
    expect(check.ok).toBe(false)
    if (!check.ok) {
      expect(check.reject_kind).toBe('dead_code_unreadable')
      expect(check.reason).toContain('boom')
    }
  })

  it('refuses the commit and names every path it was asked about when the scan throws', async () => {
    writeFile('a.ts', LIVE_PAIR.used)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    setDeadCodeAnalysisHookForTests(() => {
      throw new RangeError('boom')
    })
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts', 'b.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.paths).toEqual(['a.ts', 'b.ts'])
  })

  it('refuses the commit when git cannot list the index', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    writeFileSync(join(tmpRoot, '.git', 'index'), 'DIRCgarbage')
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(false)
  })
})

describe('the commit gate reads the staged contents in bounded batches', () => {
  afterEach(() => limitBlobReadsForTests(null))

  it('reads every staged file when they must be split across several batches', async () => {
    const filler = `export const pad = '${'x'.repeat(1500)}'\n`
    for (const name of ['c', 'd', 'e', 'f']) writeFile(`${name}.ts`, `${filler}export const ${name}Value = 1\n`)
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    limitBlobReadsForTests({ batchCount: 2, batchBytes: 2000, maxBuffer: 2500 })
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('a.ts:rotting')
  })

  it('withholds verdicts, and names the file, when one staged file is too large to read', async () => {
    writeFile('big.ts', `export const big = '${'x'.repeat(6000)}'\n`)
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    limitBlobReadsForTests({ batchCount: 1000, batchBytes: 3000, maxBuffer: 4000 })
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.hints.find((h) => h.startsWith(UNREADABLE_HINT_PREFIX))).toContain('big.ts')
  })

  it('refuses the commit when a batch holding several files cannot be read', async () => {
    writeFile('a.ts', LIVE_PAIR.withRotting)
    writeFile('b.ts', LIVE_PAIR.caller)
    commitAll()
    limitBlobReadsForTests({ batchCount: 1000, batchBytes: 1_000_000, maxBuffer: 10 })
    const check = await checkStagedDeadCode({ projectRoot: tmpRoot, stagedPaths: ['a.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(false)
  })

  it('never reads a symlink or a submodule entry as text', () => {
    writeFile('a.ts', LIVE_PAIR.used)
    commitAll()
    const link = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: tmpRoot, input: 'a.ts', encoding: 'utf8' }).trim()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRoot, encoding: 'utf8' }).trim()
    git('update-index', '--add', '--cacheinfo', `120000,${link},link.ts`)
    git('update-index', '--add', '--cacheinfo', `160000,${head},sub`)
    const repo = openSweepRepo(tmpRoot)
    if (!repo) throw new Error('expected a repository')
    const index = readIndexEntries(repo)
    expect(index?.paths.has('link.ts')).toBe(true)
    expect(index?.blobs.has('link.ts')).toBe(false)
    expect(index?.blobs.has('sub')).toBe(false)
    expect(index?.blobs.has('a.ts')).toBe(true)
  })
})

describe('keep pruning', () => {
  it('knows an untracked file, so a keep granted on it survives the next REVIEW', () => {
    writeFile('a.ts', LIVE_PAIR.used)
    commitAll()
    writeFile('new.ts', 'export const fresh = 1\n')
    const known = keepPrunePaths(tmpRoot)
    expect(known?.has('new.ts')).toBe(true)
    expect(known?.has('a.ts')).toBe(true)
  })
})

describe('keep records', () => {
  it('drops anything that is not a complete keep record', () => {
    expect(readDeadCodeKeeps('nope')).toEqual([])
    expect(readDeadCodeKeeps([{ path: 'a.ts' }])).toEqual([])
    expect(readDeadCodeKeeps([{ path: 'a.ts', name: 'x', declaration_sha256: 'abc' }])).toEqual([])
  })

  it('keeps a complete record', () => {
    const record = { path: 'a.ts', name: 'x', declaration_sha256: 'abc', note: 'why' }
    expect(readDeadCodeKeeps([record])).toEqual([record])
  })

  it('filters keeps down to those with an audit decision', () => {
    const keeps = [
      { path: 'a.ts', name: 'x', declaration_sha256: 'aa', note: 'decided' },
      { path: 'a.ts', name: 'y', declaration_sha256: 'bb', note: 'forged' },
    ]
    expect(auditBoundKeeps(keeps, decisionsFor([keeps[0]!])).map((k) => k.name)).toEqual(['x'])
  })

  it('carries earlier keeps forward and replaces one granted again for the same bytes', () => {
    const first = mergeDeadCodeKeeps(undefined, [{ path: 'a.ts', name: 'x', declaration_sha256: 'aa', note: 'first' }], 'spec-1', '2026-01-01T00:00:00.000Z', null)
    const second = mergeDeadCodeKeeps(first, [{ path: 'a.ts', name: 'x', declaration_sha256: 'aa', note: 'second' }], 'spec-2', '2026-01-02T00:00:00.000Z', null)
    expect(second).toHaveLength(1)
    expect(second[0]?.note).toBe('second')
    expect(second[0]?.spec_ref).toBe('spec-2')
  })

  it('keeps both when the same symbol is kept for different declaration bytes', () => {
    const first = mergeDeadCodeKeeps(undefined, [{ path: 'a.ts', name: 'x', declaration_sha256: 'aa', note: 'old' }], 'spec-1', '2026-01-01T00:00:00.000Z', null)
    const second = mergeDeadCodeKeeps(first, [{ path: 'a.ts', name: 'x', declaration_sha256: 'bb', note: 'new' }], 'spec-2', '2026-01-02T00:00:00.000Z', null)
    expect(second).toHaveLength(2)
  })

  it('prunes a keep whose file is no longer in the repository', () => {
    const first = mergeDeadCodeKeeps(undefined, [{ path: 'gone.ts', name: 'x', declaration_sha256: 'aa', note: 'n' }], 'spec-1', '2026-01-01T00:00:00.000Z', null)
    const pruned = mergeDeadCodeKeeps(first, [], 'spec-2', '2026-01-02T00:00:00.000Z', new Set(['other.ts']))
    expect(pruned).toEqual([])
  })
})

describe('declarationSha256', () => {
  it('is stable across CRLF, so a checkout setting does not invalidate a keep', () => {
    const lf = 'export function a(): void {\n  return\n}'
    const crlf = 'export function a(): void {\r\n  return\r\n}'
    const symbol = { path: 'a.ts', name: 'a', kind: 'value' as const, exported: true, defaultExport: false, start: 0, end: lf.length }
    expect(declarationSha256(lf, symbol)).toBe(declarationSha256(crlf, { ...symbol, end: crlf.length }))
  })

  it('changes when the declaration body changes', () => {
    const a = 'export function x(): number { return 1 }'
    const b = 'export function x(): number { return 2 }'
    const symbol = { path: 'a.ts', name: 'x', kind: 'value' as const, exported: true, defaultExport: false, start: 0, end: a.length }
    expect(declarationSha256(a, symbol)).not.toBe(declarationSha256(b, { ...symbol, end: b.length }))
  })
})
