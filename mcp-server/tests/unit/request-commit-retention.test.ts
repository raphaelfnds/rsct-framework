import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  requestCommitHandler,
  requestCommitTool,
  type RequestCommitInternal,
  type RequestCommitOutput,
} from '../../src/tools/request-commit.js'
import { decideAuditPath } from '../../src/lib/audit-log.js'
import { AUDIT_RETENTION_DAYS, clearRetentionMemo, pruneAuditLog } from '../../src/lib/audit-retention.js'
import { clearAnchorCache } from '../../src/lib/repo-anchor.js'
import type { GitExecutor } from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

const NOW = new Date('2026-10-10T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const REMOVED = /Audit log retention \(ADR-025\): 2 lines older than 10 days were removed from the audit log/
const DUE_LINE = 'Audit log: 2 lines older than 10 days are due for removal with this commit.'

let root: string
let dialogs: DialogOptions[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-commit-retention-'))
  dialogs = []
  clearRetentionMemo()
  clearAnchorCache()
  if (decideAuditPath(root, undefined).path !== join(root, '.rsct', 'audit.log')) {
    throw new Error('the temp folder sits inside a git repository: these cases would cut that repository log')
  }
  writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }), 'utf8')
  mkdirSync(join(root, '.rsct', 'scripts'), { recursive: true })
  for (const name of ['sanitize-permissions.js', 'edit-scope-guard.js']) {
    writeFileSync(join(root, '.rsct', 'scripts', name), 'export {}\n', 'utf8')
  }
  writeFileSync(join(root, 'plan_p.md'), '# Plan\n\n| Status | in progress |\n', 'utf8')
  writeFileSync(
    join(root, '.rsct', 'phase-state.json'),
    JSON.stringify({ last_classify: { tier: 'small', tier_max: 'small', classified_at: NOW.toISOString() } }),
    'utf8',
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const logPath = (): string => join(root, '.rsct', 'audit.log')

function line(event: string, ageDays: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ event, ...extra, ts: new Date(NOW.getTime() - ageDays * DAY_MS).toISOString() })
}

function seedOldHistory(): void {
  const lines = [
    line('classify.verdict', 90, { tier: 'small' }),
    line('request_commit.committed', 40),
    line('verification.finding', 30),
    line('code.start', 1),
  ]
  writeFileSync(logPath(), lines.map((entry) => `${entry}\n`).join(''), 'utf8')
}

function events(): string[] {
  return readFileSync(logPath(), 'utf8')
    .split('\n')
    .filter((entry) => entry.length > 0)
    .map((entry) => String((JSON.parse(entry) as Record<string, unknown>).event))
}

const okExec: GitExecutor = (_root, args) => ({
  ok: true,
  stdout: args.join(' ').startsWith('rev-parse') ? 'bbbb222' : '',
  stderr: '',
  exitCode: 0,
})

function internal(answer: DialogResult['response'], over: Partial<RequestCommitInternal>): RequestCommitInternal {
  return {
    gitStateOverride: { available: true, branch: 'feat/x', head_sha: 'aaaa111', is_clean: false },
    gitExecutor: okExec,
    stagedDiffOverride: '',
    stagedPathsOverride: [],
    promptFn: async (options) => {
      dialogs.push(options)
      return { response: answer, channel: 'windows' }
    },
    now: NOW,
    ...over,
  }
}

async function commit(
  message: string,
  over: Partial<RequestCommitInternal> = {},
  answer: DialogResult['response'] = 'yes',
): Promise<RequestCommitOutput> {
  return (await requestCommitHandler(
    {
      project_root: root,
      message,
      dev_approval: { timestamp: NOW.toISOString(), action_scope: 'commit', reason: 'landing the reviewed change' },
    },
    internal(answer, over),
  )) as RequestCommitOutput
}

const retentionHints = (out: RequestCommitOutput): string[] => out.hints.filter((hint) => /Audit log retention/.test(hint))

describe('rsct_request_commit — only a commit that landed cuts the audit log (#93)', () => {
  it('announces the cut in the approval dialog, cuts after the commit lands, and reports it', async () => {
    seedOldHistory()
    const out = await commit('feat: a change')
    expect(out.status).toBe('committed')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]?.message.split('\n')).toContain(DUE_LINE)
    expect(retentionHints(out)).toHaveLength(1)
    expect(retentionHints(out)[0]).toMatch(REMOVED)
    expect(events()).not.toContain('verification.finding')
    expect(events().filter((event) => event === 'request_commit.committed')).toHaveLength(1)
    expect(events()).toContain('audit.pruned')
    expect(events()[0]).toBe('classify.verdict')
    expect(existsSync(join(root, '.rsct', 'reports'))).toBe(false)
  })

  it('a commit refused before the dialog removes nothing and says nothing', async () => {
    seedOldHistory()
    const out = await commit(Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n'))
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('message_too_long')
    expect(dialogs).toHaveLength(0)
    expect(retentionHints(out)).toEqual([])
    expect(events()).toContain('verification.finding')
    expect(events()).not.toContain('audit.pruned')
  })

  it('a commit the developer declines in the dialog removes nothing', async () => {
    seedOldHistory()
    const out = await commit('feat: a change', {}, 'no')
    expect(out.status).toBe('rejected')
    expect(dialogs[0]?.message.split('\n')).toContain(DUE_LINE)
    expect(retentionHints(out)).toEqual([])
    expect(events()).toContain('verification.finding')
    expect(events()).not.toContain('audit.pruned')
  })

  it('says nothing and writes nothing extra when there is nothing old', async () => {
    writeFileSync(logPath(), `${line('classify.verdict', 3, { tier: 'small' })}\n${line('code.start', 1)}\n`, 'utf8')
    const out = await commit('feat: a change')
    expect(out.status).toBe('committed')
    expect(retentionHints(out)).toEqual([])
    expect(dialogs[0]?.message).not.toMatch(/Audit log:/)
    expect(events()).not.toContain('audit.pruned')
  })

  it('never lets a failing cut undo or hide the commit', async () => {
    seedOldHistory()
    const out = await commit('feat: a change', {
      retention: () => {
        throw new Error('the cut blew up')
      },
    })
    expect(out.status).toBe('committed')
    expect(retentionHints(out)).toEqual([
      'Audit log retention (ADR-025): the cut did not run (the cut blew up); a later commit retries it.',
    ])
    expect(events().filter((event) => event === 'request_commit.committed')).toHaveLength(2)
  })

  it('says in the tool description when the log is cut and when the dialog warns', () => {
    const text = requestCommitTool.description ?? ''
    expect(text).toContain(`a commit that LANDED also removes audit-log lines older than ${AUDIT_RETENTION_DAYS} days`)
    expect(text).toContain('a refused or unapproved call removes nothing')
    expect(text).toContain('The approval dialog forecasts the cut only when it reaches entries older than 20 days')
    expect(text).toContain('a commit under a plan token, or one approved with no dialog channel (trust_allowed_for), shows no dialog')
  })

  it('does not cut, or announce a cut for, a project whose config is absent', async () => {
    seedOldHistory()
    rmSync(join(root, '.rsct.json'))
    let calls = 0
    const out = await commit('feat: a change', {
      retention: (...args) => {
        calls++
        return pruneAuditLog(...args)
      },
    })
    expect(out.status).toBe('committed')
    expect(calls).toBe(0)
    expect(dialogs[0]?.message).not.toMatch(/Audit log:/)
    expect(events()).toContain('verification.finding')
  })

  it('cuts once, after the commit, with the clock the handler was given', async () => {
    seedOldHistory()
    const committed = (): number => events().filter((event) => event === 'request_commit.committed').length
    expect(committed()).toBe(1)
    const seen: Array<{ now: Date; committed: number }> = []
    await commit('feat: a change', {
      retention: (projectRoot, config, now, seams) => {
        seen.push({ now, committed: committed() })
        return pruneAuditLog(projectRoot, config, now, seams)
      },
    })
    expect(seen).toEqual([{ now: NOW, committed: 2 }])
  })

  it('cuts under a plan token too, where no dialog exists to forecast it', async () => {
    seedOldHistory()
    writeFileSync(
      join(root, '.rsct', 'phase-state.json'),
      JSON.stringify({
        last_classify: { tier: 'small', tier_max: 'small', classified_at: NOW.toISOString() },
        plan_authorization: {
          plan_slug: 'p',
          branch: 'feat/x',
          covers: ['commit'],
          authorized_at: NOW.toISOString(),
          expires_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
          max_actions: 5,
          actions_used: 0,
          approval_ref: { action_scope: 'plan_authorize:p', timestamp: NOW.toISOString() },
        },
      }),
      'utf8',
    )
    const out = (await requestCommitHandler(
      { project_root: root, message: 'feat: a change' },
      internal('yes', {}),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.authorized_via).toBe('plan_token')
    expect(dialogs).toHaveLength(0)
    expect(retentionHints(out)).toHaveLength(1)
    expect(retentionHints(out)[0]).toMatch(REMOVED)
    expect(events()).not.toContain('verification.finding')
  })

  it('cuts when the approval was trusted with no dialog channel', async () => {
    seedOldHistory()
    writeFileSync(
      join(root, '.rsct.json'),
      JSON.stringify({
        rsct_version: '1.0.0',
        app: { name: 'a', org: 'o' },
        approval_modes: { trust_allowed_for: ['rsct_request_commit'] },
      }),
      'utf8',
    )
    const out = (await requestCommitHandler(
      {
        project_root: root,
        message: 'feat: a change',
        dev_approval: { timestamp: NOW.toISOString(), action_scope: 'commit', reason: 'landing the reviewed change' },
      },
      internal('yes', { promptFn: async () => ({ response: 'no-channel', channel: 'none' }) }),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.channel).toBe('trust')
    expect(retentionHints(out)[0]).toMatch(REMOVED)
    expect(events()).not.toContain('verification.finding')
  })

  it('reports a small cut in the hints without forecasting it in the dialog', async () => {
    const lines = [line('request_commit.committed', 15), line('verification.finding', 12), line('code.start', 1)]
    writeFileSync(logPath(), lines.map((entry) => `${entry}\n`).join(''), 'utf8')
    const out = await commit('feat: a change')
    expect(out.status).toBe('committed')
    expect(dialogs[0]?.message).not.toMatch(/Audit log:/)
    expect(retentionHints(out)[0]).toMatch(REMOVED)
    expect(events()).not.toContain('verification.finding')
  })

  it('forecasts and cuts both logs of a project that moved its log', async () => {
    writeFileSync(
      join(root, '.rsct.json'),
      JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' }, audit: { path: 'logs/audit.log' } }),
      'utf8',
    )
    seedOldHistory()
    mkdirSync(join(root, 'logs'), { recursive: true })
    const moved = join(root, 'logs', 'audit.log')
    writeFileSync(moved, `${line('spec.start', 50)}\n${line('code.start', 1)}\n`, 'utf8')
    const out = await commit('feat: a change')
    expect(out.status).toBe('committed')
    expect(dialogs[0]?.message.split('\n')).toContain(
      'Audit log: 3 lines older than 10 days are due for removal with this commit.',
    )
    expect(retentionHints(out)[0]).toMatch(/: 3 lines older than 10 days were removed from the audit log/)
    expect(events()).toEqual(['classify.verdict', 'code.start', 'audit.pruned'])
    const movedEvents = readFileSync(moved, 'utf8')
      .split('\n')
      .filter((entry) => entry.length > 0)
      .map((entry) => String((JSON.parse(entry) as Record<string, unknown>).event))
    expect(movedEvents).not.toContain('spec.start')
    expect(movedEvents.indexOf('request_commit.committed')).toBeGreaterThan(-1)
    expect(movedEvents.indexOf('audit.pruned')).toBeGreaterThan(movedEvents.indexOf('request_commit.committed'))
  })
})
