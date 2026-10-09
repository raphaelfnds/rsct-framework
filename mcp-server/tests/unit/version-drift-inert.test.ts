import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuditEntry } from '../../src/lib/audit-log.js'
import type { GitExecutor } from '../../src/lib/git.js'
import { evaluateInstallAdvisory } from '../../src/lib/install-advisory.js'
import type { DialogOptions } from '../../src/lib/os-dialog.js'
import { getInstallDriftNotice, readScriptEvidence } from '../../src/lib/version-drift.js'
import { requestCommitHandler, type RequestCommitOutput } from '../../src/tools/request-commit.js'
import { statusHandler } from '../../src/tools/status.js'

const DIST = resolve(__dirname, '..', '..', 'dist', 'scripts')
const GUARD = 'edit-scope-guard.js'
const SANITIZER = 'sanitize-permissions.js'
const INERT_LINE = 'if (isCliEntry()) {'

const RELEASED_2_12_3_GUARD_FRAGMENT = [
  'function isCliEntry() {',
  '  if (!process.argv[1]) return false;',
  '  try {',
  '    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);',
  '  } catch {',
  '    return false;',
  '  }',
  '}',
  INERT_LINE,
  '  const exitCode = main({',
  '    argv: process.argv.slice(2),',
  '    env: process.env,',
  '    cwd: process.cwd(),',
  '    stderr: (msg) => process.stderr.write(msg + "\\n")',
  '  });',
  '  process.exit(exitCode);',
  '}',
  '',
  'function isMain() {',
  '  if (!process.argv[1]) return false;',
  '}',
].join('\n')

const HOOKS =
  JSON.stringify(
    {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.rsct/scripts/sanitize-permissions.js"' }] },
        ],
        PreToolUse: [
          {
            matcher: '^(Edit|Write|MultiEdit|NotebookEdit)$',
            hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.rsct/scripts/edit-scope-guard.js"' }],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n'

const INERT_SENTENCE =
  'edit-scope-guard.js is installed, but it is a build that cannot block an edit ' +
  '(every rsct-mcp from 2.2.0 to 2.12.3 shipped it that way)'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function stamped(body: string): string {
  return `#!/usr/bin/env node\n// rsct-mcp v=2.12.3 — installed by /rsct-setup\n${body}\n`
}

function builtBody(name: string): string {
  return readFileSync(join(DIST, name), 'utf8').split('\n').slice(1).join('\n').replace(/\n+$/, '')
}

function project(guard: string, opts: { registered?: boolean; sanitizer?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'rsct-inert-'))
  dirs.push(root)
  mkdirSync(join(root, '.rsct', 'scripts'), { recursive: true })
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), opts.registered === false ? '{}\n' : HOOKS)
  writeFileSync(join(root, '.rsct', 'scripts', GUARD), guard)
  writeFileSync(join(root, '.rsct', 'scripts', SANITIZER), opts.sanitizer ?? stamped(builtBody(SANITIZER)))
  return root
}

function stateOf(root: string, name: string, shipped: string | null = DIST): string | undefined {
  return readScriptEvidence(root, shipped).find((e) => e.name === name)?.state
}

describe('readScriptEvidence — a guard copy that cannot block (#114)', () => {
  it('reports a copy of a released guard as inert, with or without a reference to compare against', () => {
    const root = project(stamped(RELEASED_2_12_3_GUARD_FRAGMENT))
    expect(stateOf(root, GUARD)).toBe('inert')
    expect(stateOf(root, GUARD, null)).toBe('inert')
    expect(stateOf(root, GUARD, join(root, 'no-such-dir'))).toBe('inert')
  })

  it('reads a CRLF copy the same way', () => {
    const root = project(stamped(RELEASED_2_12_3_GUARD_FRAGMENT).replace(/\n/g, '\r\n'))
    expect(stateOf(root, GUARD)).toBe('inert')
  })

  it('counts the whole line only', () => {
    const indented = project(stamped(RELEASED_2_12_3_GUARD_FRAGMENT.replace(INERT_LINE, `  ${INERT_LINE}`)))
    expect(stateOf(indented, GUARD)).toBe('stale')
    const longer = project(stamped(RELEASED_2_12_3_GUARD_FRAGMENT.replace(INERT_LINE, `${INERT_LINE} main()`)))
    expect(stateOf(longer, GUARD)).toBe('stale')
  })

  it('does not call an old sanitizer copy inert, although it carries the same line', () => {
    const root = project(stamped(builtBody(GUARD)), { sanitizer: stamped(RELEASED_2_12_3_GUARD_FRAGMENT) })
    expect(stateOf(root, SANITIZER)).toBe('stale')
    expect(stateOf(root, GUARD)).toBe('current')
  })

  it('finds the built guard current, and stale — never inert — once a byte changes', () => {
    expect(builtBody(GUARD).split('\n')).not.toContain(INERT_LINE)
    expect(stateOf(project(stamped(builtBody(GUARD))), GUARD)).toBe('current')
    expect(stateOf(project(stamped(`${builtBody(GUARD)}\nconst extra = 1`)), GUARD)).toBe('stale')
  })
})

describe('getInstallDriftNotice — an inert guard is enforcement that is not running (#114)', () => {
  it('raises the security notice with the reason, read from the project itself', () => {
    const root = project(stamped(RELEASED_2_12_3_GUARD_FRAGMENT))
    const notice = getInstallDriftNotice({ projectRoot: root, projectVersion: '2.12.3', mcpVersion: '9.9.9' })
    expect(notice.severity).toBe('security')
    expect(notice.hint).toBe(
      `⚠ SECURITY: RSCT enforcement is not running in this project — ${INERT_SENTENCE}. ` +
        'Run /rsct-setup to repair it, then restart the IDE. See docs/troubleshooting.md. (never blocks)',
    )
    expect(notice.affected_components.map((c) => `${c.name}=${c.state}`)).toContain(`${GUARD}=inert`)
  })

  it('stays at the normal tier for a guard that merely differs', () => {
    const root = project(stamped(`${builtBody(GUARD)}\nconst extra = 1`))
    const notice = getInstallDriftNotice({
      projectRoot: root,
      projectVersion: '9.9.9',
      mcpVersion: '9.9.9',
      evidence: readScriptEvidence(root, DIST),
    })
    expect(notice.severity).toBe('normal')
  })

  it('gives the inert reason, not the registration one, when the copy is unregistered too', () => {
    const root = project(stamped(RELEASED_2_12_3_GUARD_FRAGMENT), { registered: false })
    const hint = getInstallDriftNotice({ projectRoot: root, projectVersion: '2.12.3', mcpVersion: '9.9.9' }).hint ?? ''
    expect(hint).toContain(INERT_SENTENCE)
    expect(hint).not.toContain('edit-scope-guard.js is installed, but no PreToolUse entry')
  })
})

describe('an inert guard reaches the dialogs and the audit log (#114)', () => {
  it('marks the advisory as security and writes one drift line', () => {
    const root = project(stamped(RELEASED_2_12_3_GUARD_FRAGMENT))
    const written: AuditEntry[] = []
    const advisory = evaluateInstallAdvisory({
      projectRoot: root,
      rsctInstalled: true,
      projectVersion: '2.12.3',
      auditConfig: undefined,
      tool: 'rsct_request_commit',
      auditWriter: (_root, entry) => {
        written.push(entry)
        return { ok: true, path: '' }
      },
    })
    expect(advisory.isSecurity).toBe(true)
    expect(advisory.dialogLine).toBe('⚠ RSCT enforcement is NOT running in this project (see hints).')
    expect(written.map((e) => e.event)).toEqual(['install.drift_detected'])
  })

  it('raises nothing for a guard copy that does not carry the line', () => {
    const root = project(stamped(builtBody(GUARD)))
    const advisory = evaluateInstallAdvisory({
      projectRoot: root,
      rsctInstalled: true,
      projectVersion: '9.9.9',
      auditConfig: undefined,
      tool: 'rsct_request_commit',
      auditWriter: () => ({ ok: true, path: '' }),
    })
    expect(advisory.isSecurity).toBe(false)
    expect(advisory.dialogLine).toBeNull()
  })
})

describe('the tools a developer meets, in a project that holds an inert guard (#114)', () => {
  const NOW = new Date('2026-07-11T12:00:00.000Z')
  const WARNING = '⚠ RSCT enforcement is NOT running in this project (see hints).'
  const commitOk: GitExecutor = (_root, args) => ({
    ok: true,
    stdout: args.join(' ').startsWith('rev-parse') ? 'bbbb222' : '',
    stderr: '',
    exitCode: 0,
  })

  function managed(guard: string): string {
    const root = project(guard)
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '2.12.3', app: { name: 'a', org: 'o' } }))
    writeFileSync(join(root, 'plan_p.md'), '# Plan\n\n| Status | in progress |\n')
    writeFileSync(
      join(root, '.rsct', 'audit.log'),
      `${JSON.stringify({ event: 'classify.verdict', tier: 'small', ts: NOW.toISOString() })}\n`,
    )
    writeFileSync(
      join(root, '.rsct', 'phase-state.json'),
      JSON.stringify({ last_classify: { tier: 'small', tier_max: 'small', classified_at: NOW.toISOString() } }),
    )
    return root
  }

  async function commit(root: string, approved: boolean): Promise<{ out: RequestCommitOutput; dialogs: string[] }> {
    const dialogs: string[] = []
    const out = (await requestCommitHandler(
      {
        project_root: root,
        message: 'checkpoint',
        ...(approved && {
          dev_approval: { timestamp: NOW.toISOString(), action_scope: 'commit', reason: 'approved by hand' },
        }),
      },
      {
        gitStateOverride: { available: true, branch: 'feat/x', head_sha: 'aaaa111', is_clean: false },
        gitExecutor: commitOk,
        stagedDiffOverride: '',
        now: NOW,
        promptFn: async (opts: DialogOptions) => {
          dialogs.push(opts.message)
          return { response: 'yes', channel: 'windows' }
        },
      },
    )) as RequestCommitOutput
    return { out, dialogs }
  }

  it('rsct_request_commit refuses an unapproved commit without a dialog, carrying the notice', async () => {
    const { out, dialogs } = await commit(managed(stamped(RELEASED_2_12_3_GUARD_FRAGMENT)), false)
    expect(out.status).toBe('rejected')
    expect(out.reject_kind).toBe('plan_token_invalid')
    expect(out.hints[0]).toContain(INERT_SENTENCE)
    expect(dialogs).toEqual([])
  })

  it('rsct_request_commit shows the warning, once, in the approval dialog', async () => {
    const { out, dialogs } = await commit(managed(stamped(RELEASED_2_12_3_GUARD_FRAGMENT)), true)
    expect(out.status).toBe('committed')
    expect(dialogs).toHaveLength(1)
    const lines = dialogs[0]!.split('\n')
    expect(lines.slice(0, 4)).toEqual(["Approve commit on 'feat/x'?", WARNING, '', 'message: checkpoint'])
    expect(lines.filter((line) => line === WARNING)).toHaveLength(1)
  })

  it('rsct_request_commit shows a plain dialog when the guard does not carry the line', async () => {
    const healthy = stamped(builtBody(GUARD))
    const approved = await commit(managed(healthy), true)
    expect(approved.out.status).toBe('committed')
    expect(approved.dialogs).toHaveLength(1)
    expect(approved.dialogs[0]).not.toContain('RSCT enforcement')
    expect(approved.dialogs[0]!.startsWith("Approve commit on 'feat/x'?\n\nmessage: checkpoint")).toBe(true)
  })

  it('rsct_status carries the notice with the reason', async () => {
    const inert = (await statusHandler({ project_root: managed(stamped(RELEASED_2_12_3_GUARD_FRAGMENT)) })) as {
      hints: string[]
    }
    expect(inert.hints.join('\n')).toContain(INERT_SENTENCE)
    const healthy = (await statusHandler({ project_root: managed(stamped(builtBody(GUARD))) })) as { hints: string[] }
    expect(healthy.hints.join('\n')).not.toContain('RSCT enforcement is not running')
  })
})
