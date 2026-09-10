import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateDevApproval, recordConsumedApproval } from '../../src/lib/dev-approval.js'
import { clearAnchorCache } from '../../src/lib/repo-anchor.js'
import { clearAuditMigrationMemo } from '../../src/lib/audit-log.js'

/**
 * #92 D4 — "one approval, one action" has to survive deleting a file.
 *
 * MEASURED before this existed: `loadStore` returns an empty store for an ABSENT
 * file with `corrupt: false`, so `rm .rsct/approvals-seen.json` was
 * indistinguishable from a fresh project and a spent approval became valid
 * again. The union with the append-only audit log is what closes it.
 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const GIT = hasGit()

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 't@t.t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'README.md'), '# app\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-qm', 'init'])
}

const NOW = new Date('2026-09-10T12:00:00.000Z')
const approval = {
  timestamp: '2026-09-10T11:59:30.000Z',
  action_scope: 'commit:src/app.ts',
  reason: 'a sufficiently long developer reason for the record',
}

let box: string

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'rsct-union-'))
  clearAnchorCache()
  clearAuditMigrationMemo()
})
afterEach(() => {
  clearAnchorCache()
  clearAuditMigrationMemo()
  if (existsSync(box)) rmSync(box, { recursive: true, force: true })
})

describe.runIf(GIT)('the anti-reuse union', () => {
  it('a spent approval stays spent after the store is DELETED', () => {
    // Mutation that reddens: drop the audit half of the union in
    // `validateDevApproval`. This is the reachable form — it needs no crafted
    // root, just `rm` on one file.
    const repo = join(box, 'repo')
    initRepo(repo)

    expect(
      validateDevApproval(approval, { projectRoot: repo, now: NOW }).status,
    ).toBe('valid')
    recordConsumedApproval(approval, { projectRoot: repo, now: NOW })

    rmSync(join(repo, '.rsct', 'approvals-seen.json'), { force: true })

    const second = validateDevApproval(approval, { projectRoot: repo, now: NOW })
    expect(second.status).toBe('rejected')
    if (second.status === 'rejected') expect(second.reason).toContain('reused')
  })

  it('a spent approval stays spent when re-validated from a CRAFTED subdirectory', () => {
    // Mutation that reddens: base `resolveStorePath` on `projectRoot` again.
    const repo = join(box, 'repo')
    initRepo(repo)
    const crafted = join(repo, 'docs', 'scratch')
    mkdirSync(crafted, { recursive: true })

    recordConsumedApproval(approval, { projectRoot: repo, now: NOW })

    const fromCrafted = validateDevApproval(approval, { projectRoot: crafted, now: NOW })
    expect(fromCrafted.status).toBe('rejected')
  })

  it('the consumption record carries scope and timestamp, and NEVER the reason', () => {
    // Mutation that reddens: add `reason` to the entry. The store already omits
    // it and it is free developer text that may carry secrets.
    const repo = join(box, 'repo')
    initRepo(repo)
    recordConsumedApproval(approval, { projectRoot: repo, now: NOW })

    const log = readFileSync(join(repo, '.rsct', 'audit.log'), 'utf8')
    expect(log).toContain('approval.consumed')
    expect(log).toContain(approval.action_scope)
    expect(log).toContain(approval.timestamp)
    expect(log).not.toContain(approval.reason)
  })

  it('an unrelated approval is NOT rejected — the union must not over-match', () => {
    // Mutation that reddens: compare only `action_scope`, ignoring the
    // timestamp, so a second approval for the same scope would read as reused.
    const repo = join(box, 'repo')
    initRepo(repo)
    recordConsumedApproval(approval, { projectRoot: repo, now: NOW })

    const other = { ...approval, timestamp: '2026-09-10T11:59:45.000Z' }
    expect(validateDevApproval(other, { projectRoot: repo, now: NOW }).status).toBe('valid')
  })
})

describe.runIf(GIT)('the absent-store signal distinguishes deleted from fresh', () => {
  it('a FRESH project raises no signal — otherwise every first approval forces a dialog', () => {
    // Mutation that reddens: raise `approvals_store_absent` on absence alone.
    // MEASURED: that broke the headless `trust` fallback, because any signal
    // forces the dialog and a new project never has the store.
    const repo = join(box, 'repo')
    initRepo(repo)

    const result = validateDevApproval(approval, { projectRoot: repo, now: NOW })
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).not.toContain('approvals_store_absent')
    }
  })

  it('a DELETED store raises the signal, because the log proves consumptions existed', () => {
    // Mutation that reddens: drop the `anyEverRecorded` half of the condition.
    const repo = join(box, 'repo')
    initRepo(repo)
    recordConsumedApproval(approval, { projectRoot: repo, now: NOW })
    rmSync(join(repo, '.rsct', 'approvals-seen.json'), { force: true })

    const fresh = { ...approval, timestamp: '2026-09-10T11:59:50.000Z' }
    const result = validateDevApproval(fresh, { projectRoot: repo, now: NOW })
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.fabrication_signals).toContain('approvals_store_absent')
    }
  })
})
