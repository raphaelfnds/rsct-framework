import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { baseTreeOf, defaultGitExecutor, gitIsTracked, gitMerge, gitRebase, readStagedTreeState, safeGitBuffer, streamGitLines } from '../../src/lib/git.js'
import { spawnGitSync } from '../../src/lib/git-launch.js'
import { scanTreeDiff } from '../../src/lib/staged-scan.js'

const GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const SRC = resolve(__dirname, '..', '..', 'src')
const LAUNCHER = join('lib', 'git-launch.ts')
const DIRECT_GIT_START = /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*['"`]git(?:['"`]|\s)/

function directGitStarts(dir: string): string[] {
  const hits: string[] = []
  for (const rel of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const abs = join(dir, rel)
    if (!statSync(abs).isFile() || !/\.(ts|js|mjs|cjs)$/.test(rel) || rel === LAUNCHER) continue
    readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      if (DIRECT_GIT_START.test(line)) hits.push(`${rel}:${i + 1} ${line.trim().slice(0, 100)}`)
    })
  }
  return hits
}

describe('every git RSCT starts goes through lib/git-launch', () => {
  it('no source file starts git on its own', () => {
    expect(directGitStarts(SRC)).toEqual([])
  })

  it('positive control: the scan finds each way of starting git in a seeded tree', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'rsct-launch-src-'))
    try {
      mkdirSync(join(fixture, 'lib'))
      const forms = ["execFileSync('git', a)", 'spawnSync("git", a)', 'spawn(`git`, a)', "execSync('git status')", "execFile( 'git', a)"]
      forms.forEach((f, i) => writeFileSync(join(fixture, 'lib', `f${i}.ts`), `const r = ${f}\n`))
      writeFileSync(join(fixture, 'lib', 'git-launch.ts'), "execFileSync('git', a)\n")
      writeFileSync(join(fixture, 'lib', 'other.ts'), "execFileSync('gh', a)\n")
      expect(directGitStarts(fixture).length).toBe(forms.length)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

let root: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(): string {
  git('init', '-q', '--template=')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 't')
  git('config', 'core.autocrlf', 'false')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '.git/no-hooks')
  writeFileSync(join(root, 'readme.txt'), 'hello\n')
  git('add', 'readme.txt')
  git('commit', '-q', '-m', 'init')
  return git('symbolic-ref', '--short', 'HEAD').trim()
}

const SECRET = 'API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA'
const MARKER = 'fsmonitor-ran.txt'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-launch-'))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe.skipIf(!GIT)('RSCT git calls never run the repository fsmonitor command', () => {
  function armMonitor(): void {
    git('config', 'core.fsmonitor', `echo ran >> ${MARKER}; exit 1; :`)
  }

  it('commit, merge, rebase, ls-files, status and a streamed read run without it', async () => {
    const main = initRepo()
    git('checkout', '-q', '-b', 'side')
    writeFileSync(join(root, 'side.txt'), 'side\n')
    git('add', 'side.txt')
    git('commit', '-q', '-m', 'side')
    git('checkout', '-q', main)
    git('init', '-q', '--bare', 'remote.git')
    git('remote', 'add', 'origin', join(root, 'remote.git'))
    armMonitor()

    writeFileSync(join(root, 'a.txt'), 'a\n')
    expect(defaultGitExecutor(root, ['add', 'a.txt']).ok).toBe(true)
    expect(defaultGitExecutor(root, ['commit', '-q', '-m', 'a']).ok).toBe(true)
    expect(gitMerge(root, 'side', { no_ff: true, allow_unrelated_histories: false }).ok).toBe(true)
    expect(defaultGitExecutor(root, ['checkout', '-q', 'side']).ok).toBe(true)
    expect(gitRebase(root, main).ok).toBe(true)
    expect(gitIsTracked(root, 'readme.txt')).toBe(true)
    expect(safeGitBuffer(root, ['ls-files', '-s', '-z'])).not.toBeNull()
    expect(spawnGitSync(['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).status).toBe(0)
    expect(await streamGitLines(root, ['diff', '--name-only'], () => {})).toEqual({ ok: true })
    expect(existsSync(join(root, MARKER))).toBe(false)

    git('status', '--porcelain')
    expect(existsSync(join(root, MARKER)), 'control: plain git does run the monitor here').toBe(true)
  })
})

describe.skipIf(!GIT)('the launcher keeps what each read gives git and gets back', () => {
  it('a buffer read that sends text on stdin returns bytes', () => {
    initRepo()
    const out = safeGitBuffer(root, ['hash-object', '--stdin'], 'hello\n')
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(out?.toString('utf8').trim()).toBe(git('rev-parse', 'HEAD:readme.txt').trim())
  })

  it('a text read that sends text on stdin returns text', () => {
    initRepo()
    expect(baseTreeOf(root, null)).toMatch(/^[0-9a-f]{40,64}$/)
  })
})

describe.skipIf(!GIT)('RSCT git calls read the real objects, never a git replace', () => {
  it('the commit scan sees a staged secret whose blob was replaced by a clean one', async () => {
    initRepo()
    writeFileSync(join(root, 's.env'), `${SECRET}\n`)
    git('add', 's.env')
    const real = git('rev-parse', ':s.env').trim()
    const clean = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'nothing\n', encoding: 'utf8' }).trim()
    git('replace', real, clean)
    expect(git('cat-file', '-p', real), 'control: plain git reads the replacement').toBe('nothing\n')

    const state = await readStagedTreeState(root)
    const base = baseTreeOf(root, state!.head)
    const scan = await scanTreeDiff(root, base!, state!.tree!)
    expect(scan.ok && scan.findings.map((f) => f.file)).toEqual(['s.env'])
    expect(safeGitBuffer(root, ['cat-file', '-p', real])?.toString('utf8')).toBe(`${SECRET}\n`)
  })

  it('the base tree is the real HEAD tree when HEAD itself was replaced', async () => {
    initRepo()
    const realTree = git('rev-parse', 'HEAD^{tree}').trim()
    writeFileSync(join(root, 's.env'), `${SECRET}\n`)
    git('add', 's.env')
    const staged = git('write-tree').trim()
    const head = git('rev-parse', 'HEAD').trim()
    const fake = execFileSync('git', ['commit-tree', staged, '-m', 'fake'], { cwd: root, encoding: 'utf8' }).trim()
    git('replace', head, fake)
    expect(git('rev-parse', 'HEAD^{tree}').trim(), 'control: plain git follows the replacement').toBe(staged)

    expect(baseTreeOf(root, head)).toBe(realTree)
  })

  it('a content merge through a replaced blob writes the real content', () => {
    const main = initRepo()
    writeFileSync(join(root, 's.txt'), 'l1\nl2\nl3\nl4\nl5\n')
    git('add', 's.txt')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'side')
    writeFileSync(join(root, 's.txt'), 'l1\nSIDE\nl3\nl4\nl5\n')
    git('commit', '-q', '-am', 'side')
    git('checkout', '-q', main)
    writeFileSync(join(root, 's.txt'), 'l1\nl2\nl3\nl4\nMAIN\n')
    git('commit', '-q', '-am', 'main')
    const sideBlob = git('rev-parse', 'side:s.txt').trim()
    const evil = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: `l1\n${SECRET}\nl3\nl4\nl5\n`, encoding: 'utf8' }).trim()
    git('replace', sideBlob, evil)

    expect(gitMerge(root, 'side', { no_ff: true, allow_unrelated_histories: false }).ok).toBe(true)
    expect(git('--no-replace-objects', 'cat-file', '-p', 'HEAD:s.txt')).toBe('l1\nSIDE\nl3\nl4\nMAIN\n')
  })
})
