import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { baseTreeOf, getStagedPaths, gitRepoStatus, readStagedTreeState, streamGitLines } from '../../src/lib/git.js'
import { scanGitDiff, scanTreeDiff } from '../../src/lib/staged-scan.js'
import { requestCommitHandler, type RequestCommitOutput } from '../../src/tools/request-commit.js'
import { checkSecretsHandler } from '../../src/tools/check-secrets.js'

const GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const SECRET = 'API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA'

let root: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(): void {
  git('init', '-q', '--template=')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 't')
  git('config', 'core.autocrlf', 'false')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '.git/no-hooks')
  writeFileSync(join(root, 'readme.txt'), 'hello\n')
  git('add', 'readme.txt')
  git('commit', '-q', '-m', 'init')
}

async function stagedFiles(): Promise<string[]> {
  const scan = await scanGitDiff(root, 'staged')
  expect(scan.ok).toBe(true)
  return scan.ok ? scan.findings.map((f) => f.file) : []
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-scan-'))
})
afterEach(() => {
  delete process.env.GIT_EXTERNAL_DIFF
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe.skipIf(!GIT)('the staged scan reads what git will commit, whatever the repo config says', () => {
  it('sees a file a staged .gitattributes marks -diff', async () => {
    initRepo()
    writeFileSync(join(root, '.gitattributes'), 'notes.txt -diff\n')
    writeFileSync(join(root, 'notes.txt'), `${SECRET}\n`)
    git('add', '.')
    expect(await stagedFiles()).toEqual(['notes.txt'])
  })

  it('sees a file git would call binary because of a NUL byte', async () => {
    initRepo()
    writeFileSync(join(root, 'zero.bin'), `x\0y\n${SECRET}\n`)
    git('add', 'zero.bin')
    expect(await stagedFiles()).toEqual(['zero.bin'])
  })

  it('sees content when diff.external is set in the repo config', async () => {
    initRepo()
    git('config', 'diff.external', 'true')
    writeFileSync(join(root, 'a.txt'), `${SECRET}\n`)
    git('add', 'a.txt')
    expect(await stagedFiles()).toEqual(['a.txt'])
  })

  it('sees content when GIT_EXTERNAL_DIFF is in the environment', async () => {
    initRepo()
    writeFileSync(join(root, 'a.txt'), `${SECRET}\n`)
    git('add', 'a.txt')
    process.env.GIT_EXTERNAL_DIFF = 'true'
    expect(await stagedFiles()).toEqual(['a.txt'])
  })

  it('sees the raw content when a textconv driver would rewrite it', async () => {
    initRepo()
    git('config', 'diff.hide.textconv', 'true')
    writeFileSync(join(root, '.gitattributes'), '*.cfg diff=hide\n')
    writeFileSync(join(root, 'app.cfg'), `${SECRET}\n`)
    git('add', '.')
    expect(await stagedFiles()).toEqual(['app.cfg'])
  })

  it('sees the whole repository when diff.relative is set and the project is a subfolder', async () => {
    initRepo()
    git('config', 'diff.relative', 'true')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'keep.txt'), 'ok\n')
    writeFileSync(join(root, 'outside.txt'), `${SECRET}\n`)
    git('add', '.')
    const scan = await scanGitDiff(join(root, 'sub'), 'staged')
    expect(scan.ok && scan.findings.map((f) => f.file)).toEqual(['outside.txt'])
  })

  it('reports the real file name under diff.mnemonicPrefix and with non-ASCII names', async () => {
    initRepo()
    git('config', 'diff.mnemonicPrefix', 'true')
    writeFileSync(join(root, 'café.txt'), `${SECRET}\n`)
    git('add', '.')
    expect(await stagedFiles()).toEqual(['café.txt'])
  })

  it('scans the tree it will commit against the tree of HEAD', async () => {
    initRepo()
    writeFileSync(join(root, 'a.env'), `${SECRET}
`)
    git('add', 'a.env')
    const state = await readStagedTreeState(root)
    const base = baseTreeOf(root, state!.head)
    expect(base).toBe(git('rev-parse', 'HEAD^{tree}').trim())
    const scan = await scanTreeDiff(root, base!, state!.tree!)
    expect(scan.ok && scan.findings.map((f) => f.file)).toEqual(['a.env'])
  })

  it('scans the first commit of a repository against the empty tree', async () => {
    git('init', '-q')
    git('config', 'core.autocrlf', 'false')
    writeFileSync(join(root, 'a.env'), `${SECRET}
`)
    git('add', 'a.env')
    const state = await readStagedTreeState(root)
    expect(state?.head).toBeNull()
    const base = baseTreeOf(root, null)
    expect(base).toBe(execFileSync('git', ['hash-object', '-t', 'tree', '--stdin'], { cwd: root, input: '', encoding: 'utf8' }).trim())
    const scan = await scanTreeDiff(root, base!, state!.tree!)
    expect(scan.ok && scan.findings.map((f) => f.file)).toEqual(['a.env'])
  })

  it('refuses to scan anything that is not a pair of tree ids', async () => {
    initRepo()
    expect(await scanTreeDiff(root, 'HEAD', '--output=x')).toEqual({ ok: false, reason: 'not a pair of tree ids' })
  })

  it('waits for another git process to release the index', async () => {
    initRepo()
    const lock = join(root, '.git', 'index.lock')
    writeFileSync(lock, '')
    setTimeout(() => rmSync(lock, { force: true }), 300)
    const state = await readStagedTreeState(root)
    expect(state?.tree).toBe(git('write-tree').trim())
  })

  it('gives up when the index stays locked', async () => {
    initRepo()
    writeFileSync(join(root, '.git', 'index.lock'), '')
    expect(await readStagedTreeState(root)).toBeNull()
  })

  it('never runs an fsmonitor command from the repository config', async () => {
    initRepo()
    writeFileSync(join(root, 'a.env'), `${SECRET}\n`)
    git('add', 'a.env')
    git('config', 'core.fsmonitor', 'echo ran >> fsmonitor-ran.txt; exit 1; :')
    expect(await stagedFiles()).toEqual(['a.env'])
    expect(getStagedPaths(root)).toEqual(['a.env'])
    expect((await readStagedTreeState(root))?.tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(existsSync(join(root, 'fsmonitor-ran.txt'))).toBe(false)
  })

  it('lists both sides of a staged rename', () => {
    initRepo()
    git('mv', 'readme.txt', 'moved.txt')
    expect(getStagedPaths(root)?.sort()).toEqual(['moved.txt', 'readme.txt'])
  })
})

describe.skipIf(!GIT)('a read that fails is a refusal, never an empty scan', () => {
  it('tells a folder that is not a repository apart from a git failure', async () => {
    expect(gitRepoStatus(root)).toBe('not_a_repo')
    expect(getStagedPaths(root)).toEqual([])
    expect(await scanGitDiff(root, 'staged')).toEqual({ ok: true, findings: [] })
  })

  it('fails when git cannot tell whether the folder is a repository', async () => {
    initRepo()
    const insideGitDir = join(root, '.git')
    expect(gitRepoStatus(insideGitDir)).toBe('unknown')
    expect(getStagedPaths(insideGitDir)).toBeNull()
    expect(await scanGitDiff(insideGitDir, 'staged')).toEqual({ ok: false, reason: expect.stringContaining('could not tell') })
  })

  it('treats a git that cannot run as unknown, never as "not a repository"', async () => {
    initRepo()
    const saved = process.env.PATH
    process.env.PATH = join(root, 'no-such-bin')
    try {
      expect(gitRepoStatus(root)).toBe('unknown')
      expect((await scanGitDiff(root, 'staged')).ok).toBe(false)
    } finally {
      process.env.PATH = saved
    }
  })

  it('refuses the commit when the staged files cannot be listed', async () => {
    initRepo()
    git('switch', '-q', '-C', 'feat/x')
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test-app', org: 'test-org' } }))
    writeFileSync(join(root, 'a.txt'), 'plain\n')
    git('add', 'a.txt')
    writeFileSync(join(root, '.git', 'index'), 'not an index')
    const now = new Date()
    const out = (await requestCommitHandler(
      {
        project_root: root,
        message: 'feat: x',
        dev_approval: { timestamp: new Date(now.getTime() - 15_000).toISOString(), action_scope: 'commit:a', reason: 'add a' },
      },
      { now, promptFn: async () => ({ response: 'yes', channel: 'windows' }) },
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('staged_paths_unreadable')
  })

  it('rsct_check_secrets reports a read it could not make instead of "no findings"', async () => {
    initRepo()
    writeFileSync(join(root, 'a.txt'), `${SECRET}\n`)
    git('add', 'a.txt')
    writeFileSync(join(root, '.git', 'index'), 'not an index')
    const out = await checkSecretsHandler({ project_root: root })
    expect(out.read_error).toMatch(/^staged changes: /)
    expect(out.findings).toEqual([])
    expect(out.hints.some((h) => h.startsWith('The scan could NOT read'))).toBe(true)
    expect(out.hints).not.toContain('No secret patterns matched the scanned diff.')
  })

  it('fails when git exits with an error, and says what git said', async () => {
    initRepo()
    const read = await streamGitLines(root, ['diff', '--no-such-flag-rsct'], () => {})
    expect(read.ok).toBe(false)
    expect(!read.ok && read.reason).toMatch(/git said|exited/)
  })

  it('fails when git does not finish in time', async () => {
    initRepo()
    const started = performance.now()
    const read = await streamGitLines(root, ['-c', 'alias.slow=!sleep 2', 'slow'], () => {}, 300)
    expect(read).toEqual({ ok: false, reason: 'git did not finish reading within 300 ms' })
    if (process.platform === 'win32') expect(performance.now() - started).toBeLessThan(1800)
  })

  it('fails when the line consumer throws, even once', async () => {
    initRepo()
    let calls = 0
    const read = await streamGitLines(root, ['log', '--oneline'], () => {
      calls++
      if (calls === 1) throw new Error('boom')
    })
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('boom') })
  })

  it('refuses the commit when the staged changes cannot be read in time', async () => {
    initRepo()
    git('switch', '-q', '-C', 'feat/x')
    writeFileSync(join(root, 'a.txt'), `${SECRET}\n`)
    git('add', 'a.txt')
    const now = new Date()
    const out = (await requestCommitHandler(
      {
        project_root: root,
        message: 'feat: x',
        dev_approval: { timestamp: new Date(now.getTime() - 15_000).toISOString(), action_scope: 'commit:a', reason: 'add a' },
      },
      { now, secretsScanTimeoutMs: 0, promptFn: async () => ({ response: 'yes', channel: 'windows' }) },
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('secrets_unreadable')
    expect(out.sha_after).toBeNull()
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('refuses a commit that hides a secret behind a staged .gitattributes', async () => {
    initRepo()
    git('switch', '-q', '-C', 'feat/x')
    writeFileSync(join(root, '.gitattributes'), 'notes.txt -diff\n')
    writeFileSync(join(root, 'notes.txt'), `${SECRET}\n`)
    git('add', '.')
    const now = new Date()
    const out = (await requestCommitHandler(
      {
        project_root: root,
        message: 'docs: notes',
        dev_approval: { timestamp: new Date(now.getTime() - 15_000).toISOString(), action_scope: 'commit:notes', reason: 'add notes' },
      },
      { now, promptFn: async () => ({ response: 'yes', channel: 'windows' }) },
    )) as RequestCommitOutput
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('secrets')
    expect(out.secrets_check.findings.map((f) => f.file)).toEqual(['notes.txt'])
  })
})
