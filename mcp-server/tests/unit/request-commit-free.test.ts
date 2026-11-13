import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  requestCommitHandler,
  type RequestCommitOutput,
  type RequestCommitInternal,
} from '../../src/tools/request-commit.js'
import type { GitExecutor, GitState } from '../../src/lib/git.js'
import type { PhaseState } from '../../src/lib/phase-scope.js'
import { hashSettingsContent } from '../../src/lib/settings-drift.js'
import { emptyProgramsRead } from './fake-git-programs.js'

let tmpRoot: string
const FIXED_NOW = new Date('2026-07-11T12:00:00.000Z')

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-rcf-'))
  writeFileSync(
    join(tmpRoot, '.rsct.json'),
    JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }),
    'utf8',
  )
  mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
  mkdirSync(join(tmpRoot, '.rsct', 'scripts'), { recursive: true })
  for (const name of ['sanitize-permissions.js', 'edit-scope-guard.js']) {
    writeFileSync(join(tmpRoot, '.rsct', 'scripts', name), '// present\n', 'utf8')
  }
})
afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
})

function gitState(branch: string | null): GitState {
  return { available: branch !== null, branch, head_sha: branch ? 'aaaa111' : null, is_clean: false }
}

const okExec: GitExecutor = (_root, args) => {
  const programs = emptyProgramsRead(args)
  if (programs) return programs
  const key = args.join(' ')
  const stdout = key.startsWith('rev-parse') ? 'bbbb222' : ''
  return { ok: true, stdout, stderr: '', exitCode: 0 }
}

function writePlan(slug = 'p', status = 'in progress'): void {
  writeFileSync(join(tmpRoot, `plan_${slug}.md`), `# Plan\n\n| Status | ${status} |\n`)
}

function writeAudit(lines: Array<Record<string, unknown>>): void {
  const body = lines.map((l) => JSON.stringify({ ...l, ts: FIXED_NOW.toISOString() })).join('\n') + '\n'
  writeFileSync(join(tmpRoot, '.rsct', 'audit.log'), body, 'utf8')
}

function writeState(state: PhaseState): void {
  writeFileSync(join(tmpRoot, '.rsct', 'phase-state.json'), JSON.stringify(state, null, 2), 'utf8')
}

function readAudit(): string {
  return readFileSync(join(tmpRoot, '.rsct', 'audit.log'), 'utf8')
}

const yesPrompt: RequestCommitInternal['promptFn'] = async () => ({ response: 'yes', channel: 'windows' })

const approval = {
  timestamp: FIXED_NOW.toISOString(),
  action_scope: 'commit',
  reason: 'landing the change',
}

function internal(over: Partial<RequestCommitInternal> = {}): RequestCommitInternal {
  return {
    gitStateOverride: gitState('feat/x'),
    gitExecutor: okExec,
    stagedDiffOverride: '',
    promptFn: yesPrompt,
    now: FIXED_NOW,
    ...over,
  }
}

function healthyProject(): void {
  writePlan('p')
  writeAudit([{ event: 'classify.verdict', tier: 'small' }])
  writeState({ last_classify: { tier: 'small', tier_max: 'small', classified_at: FIXED_NOW.toISOString() } })
}

describe('rsct_request_commit — a per-action approval carries the security notice while enforcement is down (#25)', () => {
  function breakEnforcement(): void {
    rmSync(join(tmpRoot, '.rsct', 'scripts'), { recursive: true, force: true })
  }

  it('a per-action approval still lands the commit while enforcement is down', async () => {
    breakEnforcement()
    healthyProject()
    const out = (await requestCommitHandler(
      {
        project_root: tmpRoot,
        message: 'approved by hand',
        dev_approval: {
          timestamp: FIXED_NOW.toISOString(),
          action_scope: 'commit',
          reason: 'approved by hand',
        },
      },
      internal(),
    )) as RequestCommitOutput

    expect(out.status).toBe('committed')
    expect(out.authorized_via).toBe('dev_approval')
    expect(out.hints[0]).toMatch(/SECURITY: RSCT enforcement is not running/)
  })
})

describe('rsct_request_commit — settings.json drift is reported, never gated (#17)', () => {
  function seedBaseline(hash: string): void {
    const line = JSON.stringify({ event: 'settings.baseline', hash, ts: FIXED_NOW.toISOString() })
    appendFileSync(join(tmpRoot, '.rsct', 'audit.log'), line + '\n', 'utf8')
  }

  function writeSettingsJson(allow: string[]): void {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow } }, null, 2) + '\n',
      'utf8',
    )
  }

  it('reports the harness-appended entries and still lets the commit land', async () => {
    writeSettingsJson(['Bash(mvn -version)', 'Bash(echo "exit=$?")'])
    healthyProject()
    seedBaseline('a-different-hash')

    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'feat: unrelated work', dev_approval: approval },
      internal(),
    )) as RequestCommitOutput

    expect(out.status).toBe('committed')
    const hint = out.hints.join('\n')
    expect(hint).toContain('.claude/settings.json has changed')
    expect(hint).toContain('Bash(echo "exit=$?")')
    expect(hint).toContain('never blocks')
    expect(readAudit()).toMatch(/"event":"settings\.drift_detected"/)
  })

  it('says nothing when the file matches the baseline', async () => {
    writeSettingsJson(['Bash(mvn -version)'])
    healthyProject()
    seedBaseline(
      hashSettingsContent(readFileSync(join(tmpRoot, '.claude', 'settings.json'), 'utf8')),
    )

    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval },
      internal(),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.hints.join('\n')).not.toContain('.claude/settings.json has changed')
  })

  it('says nothing when the dev already staged the file — that is ownership taken', async () => {
    writeSettingsJson(['Bash(mvn -version)'])
    healthyProject()
    seedBaseline('a-different-hash')

    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'chore: update settings', dev_approval: approval },
      internal({ stagedPathsOverride: ['.claude/settings.json'] }),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.hints.join('\n')).not.toContain('.claude/settings.json has changed')
  })

  it('degrades silently when no baseline was ever recorded', async () => {
    writeSettingsJson(['Bash(anything)'])
    healthyProject()

    const out = (await requestCommitHandler(
      { project_root: tmpRoot, message: 'feat: x', dev_approval: approval },
      internal(),
    )) as RequestCommitOutput
    expect(out.status).toBe('committed')
    expect(out.hints.join('\n')).not.toContain('.claude/settings.json has changed')
  })
})
