import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { COMMIT_PATCH_ARGS, STAGED_DIFF_ARGS, baseTreeOf, readStagedTreeState, treeDiffArgs } from '../../src/lib/git.js'
import { scanGitDiff, scanTreeDiff } from '../../src/lib/staged-scan.js'
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
let root: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-hunk-'))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('an empty line inside a hunk is a blank context line', () => {
  it('keeps reading the hunk after it', () => {
    const diff = ['diff --git a/f.txt b/f.txt', '--- a/f.txt', '+++ b/f.txt', '@@ -2,3 +2,3 @@', '-b', '+X', '', '-d', `+${SECRET}`].join('\n')
    expect(scanDiffForSecrets(diff).map((f) => [f.file, f.line_number])).toEqual([['f.txt', 4]])
  })
})

describe('the gate reads turn off the settings that merge hunks or print blank context lines empty', () => {
  it('passes the overrides on every content read', () => {
    for (const args of [STAGED_DIFF_ARGS, treeDiffArgs('a'.repeat(40), 'b'.repeat(40))!, COMMIT_PATCH_ARGS]) {
      const joined = args.join(' ')
      expect(joined).toContain('-c diff.interHunkContext=0')
      expect(joined).toContain('-c diff.suppressBlankEmpty=false')
    }
  })
})

describe.skipIf(!GIT)('the commit scans find a secret whatever interHunkContext and suppressBlankEmpty say', () => {
  it('finds it in the staged diff and in the tree diff the commit gate reads', async () => {
    git('init', '-q', '--template=')
    git('config', 'user.email', 't@example.invalid')
    git('config', 'user.name', 't')
    git('config', 'core.autocrlf', 'false')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(root, 'f.txt'), 'a\nb\n\nd\ne\n')
    git('add', 'f.txt')
    git('commit', '-q', '-m', 'base')
    writeFileSync(join(root, 'f.txt'), `a\nX\n\n${SECRET}\ne\n`)
    git('add', 'f.txt')
    git('config', 'diff.interHunkContext', '5')
    git('config', 'diff.suppressBlankEmpty', 'true')
    expect(git('diff', '--cached', '-U0').split('\n'), 'control: git prints the blank context line empty').toContain('')

    const staged = await scanGitDiff(root, 'staged')
    expect(staged.ok && staged.findings.map((f) => f.file)).toEqual(['f.txt'])
    const state = await readStagedTreeState(root)
    const tree = await scanTreeDiff(root, baseTreeOf(root, state!.head)!, state!.tree!)
    expect(tree.ok && tree.findings.map((f) => f.file)).toEqual(['f.txt'])
  })
})
