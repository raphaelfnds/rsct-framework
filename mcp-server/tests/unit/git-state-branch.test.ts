import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { branchRef, readGitState } from '../../src/lib/git.js'
import { loadContextHandler, type LoadContextOutput } from '../../src/tools/load-context.js'

const GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let root: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(): string {
  git('init', '-q', '--template=')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'readme.txt'), 'hello\n')
  git('add', 'readme.txt')
  git('commit', '-q', '-m', 'init')
  return git('symbolic-ref', '--short', 'HEAD').trim()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-branch-'))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe.skipIf(!GIT)('readGitState names a branch only when HEAD is a local branch', () => {
  it('names the checked-out branch', () => {
    const main = initRepo()
    expect(readGitState(root).branch).toBe(main)
  })

  it('names a branch that has no commit yet', () => {
    git('init', '-q', '--template=')
    git('symbolic-ref', 'HEAD', 'refs/heads/first')
    const state = readGitState(root)
    expect(state.branch).toBe('first')
    expect(state.head_sha).toBeNull()
  })

  it('gives no branch on a detached HEAD, where git itself answers "HEAD"', () => {
    initRepo()
    git('checkout', '-q', '--detach', 'HEAD')
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'control: git names it HEAD').toBe('HEAD')
    expect(readGitState(root).branch).toBeNull()
  })

  it('gives no branch when HEAD points at a remote-tracking ref, which a commit would move', () => {
    initRepo()
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('symbolic-ref', 'HEAD', 'refs/remotes/origin/main')
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'control: git names it like a branch').toBe('origin/main')
    expect(readGitState(root).branch).toBeNull()
  })
})

describe.skipIf(!GIT)('rsct_load_context still says the plan branch differs when HEAD is not on a branch', () => {
  function withPlan(): void {
    initRepo()
    const plan = ['# Plan: x', '', '| Field | Value |', '|---|---|', '| Slug | x |', '| Branch | feat/x |', '| Status | approved |', '']
    writeFileSync(join(root, 'plan_x.md'), plan.join('\n'))
    writeFileSync(join(root, 'progress_x.md'), '# Progress: x\n\n**Branch:** `feat/x`\n')
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test', org: 'test' } }))
  }
  const differs = (hints: string[]): string | undefined => hints.find((h) => h.startsWith("Plan branch 'feat/x' differs"))

  it('names the current branch when there is one', async () => {
    withPlan()
    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    expect(differs(out.next_action_hints) ?? '').toContain(`the current branch '${readGitState(root).branch}'`)
  })

  it('says HEAD is not on a branch when it is detached', async () => {
    withPlan()
    git('checkout', '-q', '--detach', 'HEAD')
    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    expect(differs(out.next_action_hints) ?? '').toContain('the current HEAD, which is not on a branch')
  })
})

describe('branchRef', () => {
  it('maps a branch name to its ref, and no branch to no ref', () => {
    expect(branchRef('feat/x')).toBe('refs/heads/feat/x')
    expect(branchRef(null)).toBeNull()
  })
})
