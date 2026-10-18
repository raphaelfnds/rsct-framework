import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AuditEntry } from '../../src/lib/audit-log.js'
import { evaluateInstallAdvisory } from '../../src/lib/install-advisory.js'
import type { GitExecutor, GitState } from '../../src/lib/git.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import {
  EDIT_GUARD_HOOK,
  TERMINAL_GUARD_HOOK,
  getInstallDriftNotice,
  readHooksDisabled,
} from '../../src/lib/version-drift.js'
import { planAuthorizeHandler, type PlanAuthorizeOutput } from '../../src/tools/plan-authorize.js'
import { requestRebaseHandler, type RequestRebaseOutput } from '../../src/tools/request-rebase.js'

const DIST = resolve(__dirname, '..', '..', 'dist', 'scripts')
const WARNING = '⚠ RSCT enforcement is NOT running in this project (see hints).'
const roots: string[] = []

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  roots.push(d)
  return d
}

function settingsFiles(root: string, files: { local?: unknown; project?: unknown }): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  if (files.local !== undefined) writeFileSync(join(root, '.claude', 'settings.local.json'), typeof files.local === 'string' ? files.local : JSON.stringify(files.local))
  if (files.project !== undefined) writeFileSync(join(root, '.claude', 'settings.json'), typeof files.project === 'string' ? files.project : JSON.stringify(files.project))
}

function userDir(value: unknown | undefined): string {
  const home = temp('rsct-user-home-')
  mkdirSync(join(home, '.claude'), { recursive: true })
  if (value !== undefined) writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: value }))
  return home
}

describe('readHooksDisabled — the value Claude Code ends up with', () => {
  it('reads the local file first, then the project file, then the user file', () => {
    const a = temp('rsct-hooks-off-')
    settingsFiles(a, { local: { disableAllHooks: true } })
    expect(readHooksDisabled(a, userDir(undefined))).toEqual({ file: '.claude/settings.local.json' })

    const b = temp('rsct-hooks-off-')
    settingsFiles(b, { project: { disableAllHooks: true } })
    expect(readHooksDisabled(b, userDir(undefined))).toEqual({ file: '.claude/settings.json' })

    const c = temp('rsct-hooks-off-')
    expect(readHooksDisabled(c, userDir(true))).toEqual({ file: '~/.claude/settings.json' })
  })

  it('lets a false nearer the project win over a true further away', () => {
    const a = temp('rsct-hooks-off-')
    settingsFiles(a, { local: { disableAllHooks: false }, project: { disableAllHooks: true } })
    expect(readHooksDisabled(a, userDir(true))).toBeNull()
    const b = temp('rsct-hooks-off-')
    settingsFiles(b, { project: { disableAllHooks: false } })
    expect(readHooksDisabled(b, userDir(true))).toBeNull()
  })

  it('skips a file that does not parse or does not hold a boolean, and reads through a BOM', () => {
    const a = temp('rsct-hooks-off-')
    settingsFiles(a, { local: '{ broken', project: { disableAllHooks: 'yes' } })
    expect(readHooksDisabled(a, userDir(true))).toEqual({ file: '~/.claude/settings.json' })
    const b = temp('rsct-hooks-off-')
    settingsFiles(b, { local: '﻿{"disableAllHooks": true}' })
    expect(readHooksDisabled(b, userDir(undefined))).toEqual({ file: '.claude/settings.local.json' })
  })

  it('is null when nothing switches hooks off', () => {
    expect(readHooksDisabled(temp('rsct-hooks-off-'), userDir(undefined))).toBeNull()
  })
})

describe('getInstallDriftNotice — hooks switched off', () => {
  it('raises the security notice with its own sentence and field', () => {
    const n = getInstallDriftNotice({ projectRoot: temp('rsct-hooks-off-'), projectVersion: null, mcpVersion: '9.9.9', evidence: [], hooksDisabled: { file: '.claude/settings.local.json' } })
    expect(n.severity).toBe('security')
    expect(n.hooks_disabled).toEqual({ file: '.claude/settings.local.json' })
    expect(n.hint).toBe(
      '⚠ SECURITY: RSCT enforcement is not running in this project — every Claude Code hook is switched off ' +
        '("disableAllHooks": true in .claude/settings.local.json). Remove that setting yourself, then restart the IDE. ' +
        'See docs/troubleshooting.md. (never blocks)',
    )
  })

  it('reads the project when the caller does not say, and adds nothing when hooks are on', () => {
    const root = temp('rsct-hooks-off-')
    settingsFiles(root, { local: { disableAllHooks: true } })
    expect(getInstallDriftNotice({ projectRoot: root, projectVersion: null, mcpVersion: '9.9.9', evidence: [] }).hooks_disabled).toEqual({
      file: '.claude/settings.local.json',
    })
    const on = getInstallDriftNotice({ projectRoot: temp('rsct-hooks-off-'), projectVersion: null, mcpVersion: '9.9.9', evidence: [] })
    expect(on).toEqual({ hint: null, severity: 'normal', affected_components: [] })
  })

  it('records the file in the audit entry the gated tools write', () => {
    const root = temp('rsct-hooks-off-')
    settingsFiles(root, { local: { disableAllHooks: true } })
    const written: AuditEntry[] = []
    const advisory = evaluateInstallAdvisory({
      projectRoot: root,
      rsctInstalled: true,
      projectVersion: null,
      auditConfig: undefined,
      tool: 'rsct_request_commit',
      auditWriter: (_root, entry) => {
        written.push(entry as AuditEntry)
        return { ok: true, path: 'x' }
      },
    })
    expect(advisory.dialogLine).toBe(WARNING)
    expect(written[0]).toMatchObject({ event: 'install.drift_detected', hooks_disabled: { file: '.claude/settings.local.json' } })
  })
})

function healthyManaged(): string {
  const root = temp('rsct-hooks-dialog-')
  writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
  mkdirSync(join(root, '.rsct', 'scripts'), { recursive: true })
  for (const name of ['sanitize-permissions.js', 'edit-scope-guard.js', 'terminal-guard.js']) {
    const body = readFileSync(join(DIST, name), 'utf8').split('\n').slice(1).join('\n').replace(/\n+$/, '')
    writeFileSync(join(root, '.rsct', 'scripts', name), `#!/usr/bin/env node\n// rsct-mcp v=9.9.9 — installed by /rsct-setup\n${body}\n`)
  }
  settingsFiles(root, {
    project: {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.rsct/scripts/sanitize-permissions.js"' }] }],
        PreToolUse: [
          { matcher: EDIT_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: EDIT_GUARD_HOOK.command }] },
          { matcher: TERMINAL_GUARD_HOOK.matcher, hooks: [{ type: 'command', command: TERMINAL_GUARD_HOOK.command }] },
        ],
      },
    },
  })
  return root
}

function capture(dialogs: string[]): (o: DialogOptions) => Promise<DialogResult> {
  return async (o) => {
    dialogs.push(o.message)
    return { response: 'no', channel: 'windows' }
  }
}

const NOW = new Date('2026-07-11T12:00:00.000Z')
const TS = '2026-07-11T11:59:45.000Z'
const branch = (b: string): GitState => ({ available: true, branch: b, head_sha: 'aaaa111', is_clean: false })
const okExec: GitExecutor = (_r, args) => ({ ok: true, stdout: args[0] === 'rev-parse' ? 'bbbb222' : '', stderr: '', exitCode: 0 })

async function rebaseDialog(root: string): Promise<string[]> {
  const dialogs: string[] = []
  ;(await requestRebaseHandler(
    {
      project_root: root,
      ref: 'main',
      dev_approval: { timestamp: TS, action_scope: 'rebase:feat/x', reason: 'rebase feat/x onto main for a clean history' },
      pre_merge_ack: { plan_complete: true, adr_confirmed: true, issues_resolved: true, hygiene_swept: true, note: 'ADR-1; issue #2 closed; swept' },
    },
    { gitStateOverride: branch('feat/x'), gitExecutor: okExec, promptFn: capture(dialogs), now: NOW, rangeReader: () => ({ status: 'ok', paths: [] }) },
  )) as RequestRebaseOutput
  return dialogs
}

async function authorizeDialog(root: string): Promise<string[]> {
  writeFileSync(join(root, 'plan_t3.md'), '# Plan\n\n| Status | in progress |\n')
  const dialogs: string[] = []
  ;(await planAuthorizeHandler(
    { project_root: root, dev_approval: { timestamp: TS, action_scope: 'plan_authorize:t3', reason: 'authorize a batch of commits for the t3 plan run' } },
    { gitStateOverride: branch('feat/t3'), promptFn: capture(dialogs), now: NOW },
  )) as PlanAuthorizeOutput
  return dialogs
}

describe('the not-running line reaches the rebase and the batch-authorization dialogs', () => {
  it('shows it when hooks are switched off, once, right after the question', async () => {
    const off = healthyManaged()
    settingsFiles(off, { local: { disableAllHooks: true } })
    for (const dialogs of [await rebaseDialog(off), await authorizeDialog(off)]) {
      expect(dialogs).toHaveLength(1)
      const lines = dialogs[0]!.split('\n')
      expect(lines[1]).toBe(WARNING)
      expect(lines.filter((l) => l === WARNING)).toHaveLength(1)
    }
  })

  it('keeps both dialogs plain when enforcement is running', async () => {
    const healthy = healthyManaged()
    for (const dialogs of [await rebaseDialog(healthy), await authorizeDialog(healthy)]) {
      expect(dialogs).toHaveLength(1)
      expect(dialogs[0]).not.toContain('RSCT enforcement')
    }
  })
})

describe('getInstallDriftNotice — a guard entry in another form', () => {
  it('is enforcement not running, and says the entry is not in the installed form', () => {
    const n = getInstallDriftNotice({
      projectRoot: temp('rsct-hooks-off-'),
      projectVersion: null,
      mcpVersion: '9.9.9',
      hooksDisabled: null,
      evidence: [{ name: 'terminal-guard.js', state: 'current', security_relevant: true, stamp_version: '9.9.9', registration: 'altered' }],
    })
    expect(n.severity).toBe('security')
    expect(n.hint).toContain('terminal-guard.js is installed, but its hook entry is not in the form this rsct-mcp installs')
    expect(n.hint).toContain('Run /rsct-setup to repair it')
  })
})
