import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  captureIssueHandler,
  type CaptureIssueOutput,
} from '../../src/tools/capture-issue.js'
import type {
  GhCreateIssueResult,
} from '../../src/lib/gh.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-ci-'))
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({
      rsct_version: '1.0.0',
      app: { name: 'test', org: 'test' },
    }),
    'utf8',
  )
})

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

const FIXED_NOW = new Date('2026-06-07T18:00:00.000Z')
const VALID_TS = '2026-06-07T17:59:45.000Z'

function approval(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: VALID_TS,
    action_scope: 'capture_issue:gh',
    reason: 'logging non-blocking finding from V phase verification sweep',
    ...overrides,
  }
}

function alwaysYes(): (opts: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}

function dialog(r: DialogResult) {
  return async () => r
}

function ghOk(url: string): () => GhCreateIssueResult {
  return () => ({ ok: true, url, raw_stdout: url + '\n' })
}

function ghFail(
  reason: 'not_installed' | 'not_authenticated' | 'no_remote' | 'failed',
  error: string,
): () => GhCreateIssueResult {
  return () => ({ ok: false, reason, error })
}

const SAMPLE = {
  title: 'CAP-X — finding from verification sweep',
  body: 'A finding was discovered during the V phase verification sweep that does not block the current task but should be logged for future resolution. Add full reproduction steps and severity rationale here.',
  severity: 'medium' as const,
}

describe('rsct_capture_issue — mode=draft (default)', () => {
  it('returns drafted with formatted body including severity badge', async () => {
    const r = (await captureIssueHandler(
      {
        project_root: tmpRoot,
        ...SAMPLE,
      },
      { now: FIXED_NOW },
    )) as CaptureIssueOutput
    expect(r.status).toBe('drafted')
    expect(r.mode).toBe('draft')
    expect(r.formatted_body).toContain('Severity')
    expect(r.formatted_body).toContain('medium')
    expect(r.formatted_body).toContain(SAMPLE.body)
    expect(r.issue_url).toBeNull()
  })

  it('includes affected paths section when provided', async () => {
    const r = (await captureIssueHandler(
      {
        project_root: tmpRoot,
        ...SAMPLE,
        affected_paths: ['src/lib/foo.ts', 'src/lib/bar.ts'],
      },
      { now: FIXED_NOW },
    )) as CaptureIssueOutput
    expect(r.formatted_body).toContain('Affected paths')
    expect(r.formatted_body).toContain('src/lib/foo.ts')
    expect(r.formatted_body).toContain('src/lib/bar.ts')
  })

  it('does NOT emit gh command call in draft mode', async () => {
    const r = (await captureIssueHandler(
      {
        project_root: tmpRoot,
        ...SAMPLE,
      },
      {
        now: FIXED_NOW,
        ghCreate: () => {
          throw new Error('gh should NOT be called in draft mode')
        },
      },
    )) as CaptureIssueOutput
    expect(r.status).toBe('drafted')
  })

  it('emits capture_issue.drafted audit', async () => {
    await captureIssueHandler(
      { project_root: tmpRoot, ...SAMPLE },
      { now: FIXED_NOW },
    )
    const lines = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.some((l) => l.event === 'capture_issue.drafted')).toBe(true)
  })
})

describe('rsct_capture_issue — mode=create guards', () => {
  it('returns missing_dev_approval when dev_approval omitted', async () => {
    const r = (await captureIssueHandler(
      {
        project_root: tmpRoot,
        ...SAMPLE,
        mode: 'create',
      },
      { now: FIXED_NOW },
    )) as CaptureIssueOutput
    expect(r.status).toBe('missing_dev_approval')
  })

  it('returns gh_unavailable when gh CLI is not present', async () => {
    const r = (await captureIssueHandler(
      {
        project_root: tmpRoot,
        ...SAMPLE,
        mode: 'create',
        dev_approval: approval(),
      },
      {
        now: FIXED_NOW,
        promptFn: alwaysYes(),
        ghAvailable: () => false,
        ghCreate: ghOk('http://github.com/org/repo/issues/1'),
      },
    )) as CaptureIssueOutput
    expect(r.status).toBe('gh_unavailable')
    expect(r.reject_kind).toBe('gh_not_installed')
  })
})

describe('rsct_capture_issue — mode=create §C path', () => {
  it('rejects with dialog_no when dev says no', async () => {
    const r = (await captureIssueHandler(
      {
        project_root: tmpRoot,
        ...SAMPLE,
        mode: 'create',
        dev_approval: approval(),
      },
      {
        now: FIXED_NOW,
        promptFn: dialog({ response: 'no', channel: 'windows' }),
        ghAvailable: () => true,
        ghCreate: ghOk('http://github.com/org/repo/issues/1'),
      },
    )) as CaptureIssueOutput
    expect(r.status).toBe('rejected')
    expect(r.reject_kind).toBe('dialog_no')
  })

  it('returns gh_failed when gh exits with not_authenticated', async () => {
    const r = (await captureIssueHandler(
      {
        project_root: tmpRoot,
        ...SAMPLE,
        mode: 'create',
        dev_approval: approval(),
      },
      {
        now: FIXED_NOW,
        promptFn: alwaysYes(),
        ghAvailable: () => true,
        ghCreate: ghFail('not_authenticated', 'gh auth login required'),
      },
    )) as CaptureIssueOutput
    expect(r.status).toBe('gh_failed')
    expect(r.reject_kind).toBe('gh_not_authenticated')
  })

  it('returns gh_failed when gh has no remote', async () => {
    const r = (await captureIssueHandler(
      {
        project_root: tmpRoot,
        ...SAMPLE,
        mode: 'create',
        dev_approval: approval(),
      },
      {
        now: FIXED_NOW,
        promptFn: alwaysYes(),
        ghAvailable: () => true,
        ghCreate: ghFail('no_remote', 'no git remote configured'),
      },
    )) as CaptureIssueOutput
    expect(r.status).toBe('gh_failed')
    expect(r.reject_kind).toBe('gh_no_remote')
  })

  it('happy path: creates issue and returns URL', async () => {
    const expectedUrl = 'https://github.com/example-org/example-repo/issues/42'
    const r = (await captureIssueHandler(
      {
        project_root: tmpRoot,
        ...SAMPLE,
        mode: 'create',
        dev_approval: approval(),
      },
      {
        now: FIXED_NOW,
        promptFn: alwaysYes(),
        ghAvailable: () => true,
        ghCreate: ghOk(expectedUrl),
      },
    )) as CaptureIssueOutput
    expect(r.status).toBe('created')
    expect(r.issue_url).toBe(expectedUrl)
    expect(r.anti_replay_persisted).toBe(true)

    const lines = readFileSync(join(tmpRoot, '.rsct/audit.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const created = lines.find((l) => l.event === 'capture_issue.created')
    expect(created).toBeDefined()
    expect(created.issue_url).toBe(expectedUrl)
  })
})

describe('rsct_capture_issue — input validation', () => {
  it('rejects title < 10 chars', async () => {
    await expect(
      captureIssueHandler({
        project_root: tmpRoot,
        title: 'short',
        body: SAMPLE.body,
        severity: 'low',
      }),
    ).rejects.toThrow()
  })

  it('rejects body < 50 chars', async () => {
    await expect(
      captureIssueHandler({
        project_root: tmpRoot,
        title: SAMPLE.title,
        body: 'too short',
        severity: 'low',
      }),
    ).rejects.toThrow()
  })

  it('rejects invalid severity', async () => {
    await expect(
      captureIssueHandler({
        project_root: tmpRoot,
        title: SAMPLE.title,
        body: SAMPLE.body,
        severity: 'whatever',
      }),
    ).rejects.toThrow()
  })

  it('rejects unknown keys (zod strict)', async () => {
    await expect(
      captureIssueHandler({
        project_root: tmpRoot,
        ...SAMPLE,
        bogus: 'x',
      }),
    ).rejects.toThrow()
  })
})
