import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { headStaleness } from '../../src/lib/phase-scope.js'
import { getHeadSha } from '../../src/lib/git.js'
import { phaseReviewStartHandler } from '../../src/tools/phase-review-start.js'
import { phaseReviewCompleteHandler } from '../../src/tools/phase-review-complete.js'

/**
 * #75 Part C. A claim about repository state carries the commit it was made
 * against, and a tool receiving one MARKS it stale rather than acting on it.
 */

let tmpRoot: string
const FIXED_NOW = new Date('2026-06-07T18:00:00.000Z')
const VALID_TS = '2026-06-07T17:59:45.000Z'

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-hs-'))
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  writeFileSync(join(tmpRoot, '.rsct.json'), JSON.stringify({ version: '1' }), 'utf8')
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

describe('getHeadSha — a full sha, because an abbreviation is not an identifier', () => {
  // MUTATION: put `--short` back into the argv.
  //
  // A short sha's length tracks the object count and honours core.abbrev, so it
  // is not stable across machines — and this feeds a stamp whose whole premise is
  // that only a commit is immutable.
  it('T-sha — asks git for the full HEAD, never the abbreviation', () => {
    const seen: string[][] = []
    const sha = getHeadSha('/anywhere', (_root, args) => {
      seen.push(args)
      return { ok: true, stdout: `${SHA_A}\n`, stderr: '', exitCode: 0 }
    })
    expect(seen).toEqual([['rev-parse', 'HEAD']])
    expect(sha).toBe(SHA_A)
    expect(sha).toHaveLength(40)
  })

  // MUTATION: return `''` instead of null on failure.
  it('T-sha-b — degrades to null outside a repo, never to an empty string', () => {
    expect(getHeadSha('/x', () => ({ ok: false, stdout: '', stderr: 'fatal', exitCode: 128 }))).toBeNull()
    expect(getHeadSha('/x', () => ({ ok: true, stdout: '\n', stderr: '', exitCode: 0 }))).toBeNull()
  })

  // ONE spawn, not four. readGitState costs four (isGitRepo + 3) and this rides a
  // path that spawned zero before Part C, so the count is the design.
  it('T-sha-c — costs exactly one git invocation', () => {
    let calls = 0
    getHeadSha('/x', () => {
      calls++
      return { ok: true, stdout: SHA_A, stderr: '', exitCode: 0 }
    })
    expect(calls).toBe(1)
  })
})

describe('headStaleness — marks, never rejects', () => {
  // MUTATION: return `true` when the stamp is missing.
  it('T18 — an unknown is null, never true: no stamp, or no git, means "cannot tell"', () => {
    expect(headStaleness(undefined, SHA_A).head_stale).toBeNull()
    expect(headStaleness(SHA_A, null).head_stale).toBeNull()
    expect(headStaleness(undefined, null).head_stale).toBeNull()
  })

  // MUTATION: compare with `===` inverted, or coerce a missing sha to ''.
  it('T18b — equal is false, different is true, and both shas are reported back', () => {
    expect(headStaleness(SHA_A, SHA_A)).toEqual({
      head_stale: false,
      head_sha_at_start: SHA_A,
      head_sha_now: SHA_A,
    })
    expect(headStaleness(SHA_A, SHA_B).head_stale).toBe(true)
  })
})

describe('the REVIEW phase stamps and compares', () => {
  async function start() {
    return phaseReviewStartHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        findings: [{ id: 'r-1', category: 'bug', title: 'x' }],
      },
      { now: FIXED_NOW },
    )
  }
  async function complete() {
    return phaseReviewCompleteHandler(
      {
        project_root: tmpRoot,
        spec_ref: 'feat-foo',
        findings_actions: [{ finding_id: 'r-1', action: 'accept' }],
        dev_approval: {
          timestamp: VALID_TS,
          action_scope: 'review_complete:spec_ref=feat-foo',
          reason: 'ok',
        },
      },
      { now: FIXED_NOW, promptFn: async () => ({ response: 'yes', channel: 'env-override' }) },
    )
  }

  function statePath(): string {
    return join(tmpRoot, '.rsct/phase-state.json')
  }

  // MUTATION: turn a stale HEAD into a `rejected` status.
  //
  // The guard AGAINST over-enforcement, written first for that reason. HEAD moving
  // between declaring a finding and completing the phase is the NORMAL case — you
  // commit the fixes the review found — so rejecting would make the phase
  // uncompletable for doing the right thing.
  it('T17 — a moved HEAD is reported, and the phase still completes', async () => {
    // A REAL repository, not a stubbed sha. The one failure class no control
    // catches is a fixture returning output the real thing cannot produce, and
    // this path runs `git rev-parse HEAD` for real — so the test has to give it a
    // real HEAD to read. An earlier version of this test stamped a sha into a
    // non-repo and asserted `true`; it got `null`, correctly, because there was
    // no current sha to differ from.
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: tmpRoot })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tmpRoot })
    writeFileSync(join(tmpRoot, 'f.txt'), 'one', 'utf8')
    execFileSync('git', ['add', '-A'], { cwd: tmpRoot })
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: tmpRoot })

    await start()
    const stamped = JSON.parse(readFileSync(statePath(), 'utf8')).review_findings.head_sha
    expect(stamped).toMatch(/^[0-9a-f]{40}$/)

    // A real second commit — exactly what "you committed the fixes this review
    // found" looks like.
    writeFileSync(join(tmpRoot, 'f.txt'), 'two', 'utf8')
    execFileSync('git', ['add', '-A'], { cwd: tmpRoot })
    execFileSync('git', ['commit', '-qm', 'two'], { cwd: tmpRoot })
    expect(getHeadSha(tmpRoot)).not.toBe(stamped)

    const out = await complete()
    expect(out.status).toBe('completed')
    expect(out.head_stale).toBe(true)
    expect(out.hints.some((h) => h.includes('HEAD moved'))).toBe(true)
  })

  it('T17b — an unmoved HEAD reports false, and is not confused with "cannot tell"', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: tmpRoot })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tmpRoot })
    writeFileSync(join(tmpRoot, 'f.txt'), 'one', 'utf8')
    execFileSync('git', ['add', '-A'], { cwd: tmpRoot })
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: tmpRoot })

    await start()
    const out = await complete()
    expect(out.head_stale).toBe(false)
    expect(out.hints.some((h) => h.includes('HEAD moved'))).toBe(false)
  })

  // MUTATION: drop the `if (headSha !== null)` guard and write `head_sha: null`.
  it('T18c — outside a git repo nothing is stamped and staleness stays null', async () => {
    // tmpRoot is a bare temp dir with no .git, so getHeadSha returns null.
    await start()
    const state = JSON.parse(readFileSync(statePath(), 'utf8'))
    expect(state.review_findings.head_sha).toBeUndefined()
    expect(state.review_findings.observed_at).toBe(FIXED_NOW.toISOString())

    const out = await complete()
    expect(out.head_stale).toBeNull()
    expect(out.hints.some((h) => h.includes('HEAD moved'))).toBe(false)
  })

  // MUTATION: stamp at _complete instead of at _start.
  it('T18d — the stamp records when the findings were DECLARED, not when closed', async () => {
    await start()
    const state = JSON.parse(readFileSync(statePath(), 'utf8'))
    expect(state.review_findings.observed_at).toBe(state.review_findings.declared_at)
  })
})
