import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listCommits } from '../../src/lib/git.js'
import { scanCommits } from '../../src/lib/staged-scan.js'
import { scanDiffForSecrets } from '../../src/lib/secrets.js'

const GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const SECRET = 'API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA'
const OTHER = 'password = "hunter2hunter2hunter2"'

describe('the diff scanner reads combined (merge) diffs', () => {
  const combined = [
    'diff --cc s.txt',
    'index 1111111,2222222..3333333',
    '--- a/s.txt',
    '+++ b/s.txt',
    '@@@ -2,1 -2,1 +2,3 @@@',
    '- l2',
    ' -SIDE',
    `++${OTHER}`,
    ` +${SECRET}`,
    `+ ${SECRET}`,
    '@@@ -9,0 -9,0 +11,1 @@@',
    `++${SECRET}`,
  ].join('\n')

  it('reports only the lines the merge itself adds, at their line in the result', () => {
    const findings = scanDiffForSecrets(combined)
    expect(findings.map((f) => [f.file, f.line_number, f.reason])).toEqual([
      ['s.txt', 2, 'key-name'],
      ['s.txt', 11, 'value-shape'],
    ])
  })

  it('names the commit each finding comes from when the diff carries commit ids', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const text = [a, 'diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -0,0 +1 @@', `+${SECRET}`, b, combined].join('\n')
    expect(scanDiffForSecrets(text).map((f) => f.commit)).toEqual([a, b, b])
  })

  it('leaves a plain two-way diff unchanged, with no commit named', () => {
    const plain = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ` ${SECRET}`, `-${SECRET}`, `+${OTHER}`, '+tail'].join('\n')
    expect(scanDiffForSecrets(plain)).toEqual([{ file: 'x', line_number: 2, reason: 'key-name', excerpt: 'password = "***MASKED***"' }])
  })
})

let root: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function commitFile(name: string, text: string, message: string): string {
  writeFileSync(join(root, name), text)
  git('add', name)
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD').trim()
}

function initRepo(): string {
  git('init', '-q', '--template=')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 't')
  git('config', 'core.autocrlf', 'false')
  git('config', 'commit.gpgsign', 'false')
  commitFile('readme.txt', 'hello\n', 'init')
  return git('symbolic-ref', '--short', 'HEAD').trim()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-commit-scan-'))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe.skipIf(!GIT)('scanCommits reads each commit a range carries', () => {
  it('finds a secret added in one commit and removed in the next', async () => {
    initRepo()
    const base = git('rev-parse', 'HEAD').trim()
    const added = commitFile('s.env', `${SECRET}\n`, 'add')
    const removed = commitFile('s.env', 'clean\n', 'remove')
    const scan = await scanCommits(root, { tips: [removed], exclude: [base] })
    expect(scan.ok && scan.commits).toBe(2)
    expect(scan.ok && scan.findings.map((f) => [f.file, f.commit])).toEqual([['s.env', added]])
  })

  it('skips commits reachable from what it excludes', async () => {
    initRepo()
    commitFile('s.env', `${SECRET}\n`, 'add')
    const known = git('rev-parse', 'HEAD').trim()
    const next = commitFile('b.txt', 'b\n', 'next')
    const scan = await scanCommits(root, { tips: [next], exclude: [known] })
    expect(scan.ok && [scan.commits, scan.findings.length]).toEqual([1, 0])
  })

  it('excludes the tracking refs of one named remote only', async () => {
    initRepo()
    const secret = commitFile('s.env', `${SECRET}\n`, 'add')
    git('update-ref', 'refs/remotes/upstream/main', secret)
    const tip = commitFile('b.txt', 'b\n', 'next')
    const viaOrigin = await scanCommits(root, { tips: [tip], exclude: [], excludeRemote: 'origin' })
    expect(viaOrigin.ok && viaOrigin.findings.length).toBe(1)
    const viaUpstream = await scanCommits(root, { tips: [tip], exclude: [], excludeRemote: 'upstream' })
    expect(viaUpstream.ok && [viaUpstream.commits, viaUpstream.findings.length]).toEqual([1, 0])
  })

  it('finds what a merge commit itself adds, and not what it took from an excluded parent', async () => {
    const main = initRepo()
    commitFile('s.txt', 'l1\nl2\nl3\n', 'base')
    git('checkout', '-q', '-b', 'side')
    commitFile('s.txt', `l1\nl2\nl3\n${SECRET}\n`, 'side')
    const side = git('rev-parse', 'HEAD').trim()
    git('checkout', '-q', main)
    commitFile('m.txt', 'm\n', 'main')
    const before = git('rev-parse', 'HEAD').trim()
    git('merge', '-q', '--no-ff', '--no-commit', 'side')
    writeFileSync(join(root, 's.txt'), `l1\n${OTHER}\nl3\n${SECRET}\n`)
    git('add', 's.txt')
    git('commit', '-q', '-m', 'evil merge')
    const merge = git('rev-parse', 'HEAD').trim()
    const scan = await scanCommits(root, { tips: [merge], exclude: [before, side] })
    expect(scan.ok && scan.commits).toBe(1)
    expect(scan.ok && scan.findings.map((f) => [f.file, f.line_number, f.commit])).toEqual([['s.txt', 2, merge]])
  })

  it('reads the root commit whatever log.showRoot and format.pretty say', async () => {
    git('init', '-q', '--template=')
    git('config', 'user.email', 't@example.invalid')
    git('config', 'user.name', 't')
    git('config', 'core.autocrlf', 'false')
    git('config', 'log.showRoot', 'false')
    git('config', 'format.pretty', 'format:@@ -1 +1 @@ fake')
    const first = commitFile('s.env', `${SECRET}\n`, 'root')
    const scan = await scanCommits(root, { tips: [first], exclude: [] })
    expect(scan.ok && scan.findings.map((f) => f.commit)).toEqual([first])
  })

  it('lists the real commits when the tip was replaced by one that skips a commit', () => {
    initRepo()
    const base = git('rev-parse', 'HEAD').trim()
    commitFile('s.env', `${SECRET}\n`, 'hidden')
    const tip = commitFile('b.txt', 'b\n', 'tip')
    const tree = git('rev-parse', `${tip}^{tree}`).trim()
    const fake = execFileSync('git', ['commit-tree', tree, '-p', base, '-m', 'tip'], { cwd: root, encoding: 'utf8' }).trim()
    git('replace', tip, fake)
    expect(git('rev-list', tip, '--not', base).trim().split('\n'), 'control: plain git follows the replacement').toHaveLength(1)
    const listed = listCommits(root, { tips: [tip], exclude: [base] })
    expect(listed.ok && listed.commits.length).toBe(2)
  })

  it('refuses a revision or remote name git would read as an option', () => {
    initRepo()
    expect(listCommits(root, { tips: ['--all'], exclude: [] }).ok).toBe(false)
    expect(listCommits(root, { tips: ['HEAD'], exclude: ['--remotes'] }).ok).toBe(false)
    expect(listCommits(root, { tips: ['HEAD'], exclude: [], excludeRemote: '*' }).ok).toBe(false)
  })

  it('fails closed when the scan runs out of time', async () => {
    initRepo()
    const tip = commitFile('b.txt', 'b\n', 'next')
    const scan = await scanCommits(root, { tips: [tip], exclude: [] }, [], 0)
    expect(scan.ok).toBe(false)
  })
})
