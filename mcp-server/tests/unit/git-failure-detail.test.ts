import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computeWorkingSweep } from '../../src/lib/comment-sweep/review.js'
import { checkDeadCode, checkStagedDeadCode } from '../../src/lib/dead-code/review-gate.js'
import { capturedGitFailures } from '../../src/lib/git.js'

let root: string

const here = (): string => root.split(/[\\/]/).pop() ?? root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-gitdetail-'))
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root, stdio: 'ignore' })
})

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

function breakTheIndex(): void {
  writeFileSync(join(root, '.git', 'index'), 'DIRCgarbage')
}

describe('a refusal names what git said, not only that a read failed', () => {
  it('the comment sweep carries git own message in its detail', async () => {
    breakTheIndex()
    const sweep = await computeWorkingSweep(root, { sqlDialect: null })
    expect(sweep.ok).toBe(false)
    if (sweep.ok) return
    expect(sweep.reason).toBe('git_read_failed')
    expect(sweep.detail).toMatch(/^could not list the touched paths: git /)
    expect(sweep.detail).toMatch(/said: "(fatal|error): /)
    expect(sweep.detail).toContain(here())
  })

  it('the dead-code gate carries it in the REVIEW refusal', async () => {
    breakTheIndex()
    const check = await checkDeadCode({ projectRoot: root, touched: ['src/a.ts'], keeps: [] })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toMatch(/said: "(fatal|error): /)
    expect(check.reason).toContain(here())
  })

  it('the dead-code gate carries it in the commit refusal', async () => {
    breakTheIndex()
    const check = await checkStagedDeadCode({ projectRoot: root, stagedPaths: ['src/a.ts'], keeps: [], keepDecisions: new Set() })
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toMatch(/index file|fatal/i)
  })

  it('says nothing extra when the sweep succeeds, and keeps nothing afterwards', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2\n')
    const sweep = await computeWorkingSweep(root, { sqlDialect: null })
    expect(sweep.ok).toBe(true)
    expect(capturedGitFailures()).toEqual([])
  })

  it('names the repository it was reading when two are swept at once', async () => {
    const other = mkdtempSync(join(tmpdir(), 'rsct-gitdetail-other-'))
    const breakHashing = (where: string): void => {
      writeFileSync(join(where, '.git', 'index'), 'DIRCgarbage')
    }
    try {
      execFileSync('git', ['init', '-q'], { cwd: other, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: other, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: other, stdio: 'ignore' })
      mkdirSync(join(other, 'src'), { recursive: true })
      writeFileSync(join(other, 'src', 'x.ts'), 'export const x = 1\n')
      execFileSync('git', ['add', '-A'], { cwd: other, stdio: 'ignore' })
      execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: other, stdio: 'ignore' })
      breakHashing(root)
      breakHashing(other)
      const [mine, theirs] = await Promise.all([
        computeWorkingSweep(root, { sqlDialect: null }),
        computeWorkingSweep(other, { sqlDialect: null }),
      ])
      expect([mine.ok, theirs.ok]).toEqual([false, false])
      if (mine.ok || theirs.ok) return
      expect(mine.detail).toContain(root.slice(-12))
      expect(mine.detail).not.toContain(other.slice(-12))
      expect(theirs.detail).toContain(other.slice(-12))
      expect(theirs.detail).not.toContain(root.slice(-12))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('keeps nothing after a dead-code check that finished', async () => {
    writeFileSync(join(root, 'src', 'b.ts'), "import { a } from './a.js'\nexport const b = a\n")
    writeFileSync(join(root, 'src', 'main.ts'), "import { b } from './b.js'\nconsole.log(b)\n")
    await checkDeadCode({ projectRoot: root, touched: ['src/a.ts'], keeps: [] })
    expect(capturedGitFailures()).toEqual([])
  })
})
