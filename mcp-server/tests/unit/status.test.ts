import { describe, it, expect } from 'vitest'
import { resolve, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { statusHandler, type StatusOutput } from '../../src/tools/status.js'
import type { UpdateOptions } from '../../src/lib/update-check.js'
import { RSCT_MCP_VERSION } from '../../src/lib/version.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')
// Has a .rsct.json that omits `protected_branches` — the #50 case.
const RSCT_NO_BRANCH_KEY = resolve(__dirname, '..', 'fixtures', 'sample-rsct-universe')

describe('rsct_status', () => {
  it('reports rsct_installed=true and reads .rsct.json on an rsct project', async () => {
    const out = (await statusHandler({ project_root: SAMPLE_RSCT })) as StatusOutput

    expect(out.rsct_installed).toBe(true)
    expect(out.project.app_name).toBe('sample-app')
    expect(out.project.org_slug).toBe('sample-org')
    expect(out.project.rsct_version).toBe('1.0.0')
    expect(out.project.protected_branches).toEqual(['main', 'test'])
    expect(out.project.test_framework).toBe('JUnit 5')
    expect(out.mcp_server.name).toBe('rsct-mcp')
  })

  it('reports rsct_installed=false and surfaces a setup hint when no .rsct.json', async () => {
    const out = (await statusHandler({ project_root: NO_RSCT })) as StatusOutput

    expect(out.rsct_installed).toBe(false)
    expect(out.project.app_name).toBeNull()
    expect(out.project.protected_branches).toEqual([])
    expect(out.hints.some((h) => h.includes('/rsct-setup'))).toBe(true)
  })

  it('reports the ENFORCED branch list when .rsct.json omits the key (#50)', async () => {
    // Reading the raw config reported [] here while every §C gate was already
    // protecting the four defaults — the status output contradicted the gates.
    // Values pinned literally: changing the defaults must be a deliberate act.
    const out = (await statusHandler({ project_root: RSCT_NO_BRANCH_KEY })) as StatusOutput

    expect(out.rsct_installed).toBe(true)
    expect(out.project.protected_branches).toEqual(['main', 'master', 'test', 'dev'])
  })

  it('always includes mcp_server metadata', async () => {
    const out = (await statusHandler({})) as StatusOutput
    expect(out.mcp_server).toEqual({
      name: 'rsct-mcp',
      version: RSCT_MCP_VERSION,
    })
  })

  it('rejects unknown input keys (zod strict)', async () => {
    await expect(statusHandler({ unknown_key: 'x' })).rejects.toThrow()
  })

  // #38: the update check reaches rsct_status through the `deps.update` seam — never
  // process.env.HOME and never the real fetch, so the suite cannot touch the
  // contributor's ~/.rsct or api.github.com. `env: {}` opts back in past the global
  // RSCT_UPDATE_CHECK=off set in tests/setup.ts.
  const NEWER_TAG = `v${Number(RSCT_MCP_VERSION.split('.')[0]) + 1}.0.0`
  const seedHome = (data: Record<string, unknown>): string => {
    const h = mkdtempSync(join(tmpdir(), 'rsct-status-upd-'))
    mkdirSync(join(h, '.rsct'), { recursive: true })
    writeFileSync(join(h, '.rsct', 'update-check.json'), JSON.stringify(data))
    return h
  }
  const readHome = (h: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(h, '.rsct', 'update-check.json'), 'utf8'))
  const NOW = 1_000_000_000_000
  const FRESH = { last_checked: new Date(NOW).toISOString(), last_attempt: new Date(NOW).toISOString() }
  const upd = (h: string): { update: UpdateOptions } => ({
    update: { home: h, now: NOW, env: {}, fetcher: async () => ({ ok: true, json: async () => ({}) }) },
  })

  it('surfaces an update hint when the cache shows a newer release', async () => {
    const h = seedHome({ consent: 'yes', latest_tag: NEWER_TAG, ...FRESH })
    try {
      const out = (await statusHandler({ project_root: SAMPLE_RSCT }, upd(h))) as StatusOutput
      expect(out.hints.some((x) => /newer RSCT release/.test(x))).toBe(true)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('decline_update records the tag and suppresses the hint in the SAME call', async () => {
    const h = seedHome({ consent: 'yes', latest_tag: NEWER_TAG, ...FRESH })
    try {
      const out = (await statusHandler(
        { project_root: SAMPLE_RSCT, decline_update: NEWER_TAG },
        upd(h),
      )) as StatusOutput
      expect(out.hints.some((x) => /newer RSCT release/.test(x))).toBe(false)
      expect(out.hints.some((x) => /declined — it will not be raised again/.test(x))).toBe(true)
      expect(readHome(h).declined_tags).toEqual([NEWER_TAG.replace(/^v/, '')])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('decline_update for a release that is not on offer is rejected, not recorded', async () => {
    const h = seedHome({ consent: 'yes', latest_tag: NEWER_TAG, ...FRESH })
    try {
      const out = (await statusHandler(
        { project_root: SAMPLE_RSCT, decline_update: 'v99.99.99' },
        upd(h),
      )) as StatusOutput
      expect(out.hints.some((x) => /Decline ignored/.test(x))).toBe(true)
      expect(out.hints.some((x) => /newer RSCT release/.test(x))).toBe(true) // still offered
      expect(readHome(h).declined_tags).toBeUndefined()
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('update_check "off" silences everything without pitching how to undo it', async () => {
    const h = seedHome({ latest_tag: NEWER_TAG, ...FRESH })
    try {
      const out = (await statusHandler(
        { project_root: SAMPLE_RSCT, update_check: 'off' },
        upd(h),
      )) as StatusOutput
      expect(out.hints.some((x) => /newer RSCT release/.test(x))).toBe(false)
      expect(out.hints.some((x) => /update check is OFF on this machine/.test(x))).toBe(false)
      expect(out.hints.some((x) => /Update check turned OFF/.test(x))).toBe(true)
      expect(readHome(h).consent).toBe('no')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  // rsct_status is the session-bootstrap tool: a paraphrased value must not take the
  // whole call down with it (that would also lose git state and the drift hint).
  it('tolerates unrecognized update_check values instead of throwing', async () => {
    const h = seedHome({ consent: 'yes', latest_tag: NEWER_TAG, ...FRESH })
    try {
      // A non-string an agent might infer from an on/off switch must not fail the
      // session-bootstrap tool either — it coerces and lands in the "Ignored" branch.
      for (const value of ['true', 'yes', '', 'garbage', true, 1]) {
        const out = (await statusHandler(
          { project_root: SAMPLE_RSCT, update_check: value },
          upd(h),
        )) as StatusOutput
        expect(out.rsct_installed).toBe(true) // the call still succeeded
        expect(out.hints.some((x) => /Ignored update_check/.test(x))).toBe(true)
      }
      expect(readHome(h).consent).toBe('yes') // untouched by any of them
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  // Seeded 'no' so the assertion cannot pass on the seed: if `.trim().toLowerCase()`
  // were dropped, 'On' would fall into the Ignored branch and consent would stay 'no'.
  it('accepts update_check case-insensitively', async () => {
    const h = seedHome({ consent: 'no', latest_tag: NEWER_TAG, ...FRESH })
    try {
      const out = (await statusHandler(
        { project_root: SAMPLE_RSCT, update_check: ' On ' },
        upd(h),
      )) as StatusOutput
      expect(out.hints.some((x) => /Update check turned ON/.test(x))).toBe(true)
      expect(readHome(h).consent).toBe('yes')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  // The env kill switch outranks the file, so confirming "turned ON" while it is set
  // would tell the dev the opposite of the truth on any CI image that exports it.
  it('says so when RSCT_UPDATE_CHECK overrides the setting it was just asked to change', async () => {
    const h = seedHome({ consent: 'no', latest_tag: NEWER_TAG, ...FRESH })
    try {
      const out = (await statusHandler({ project_root: SAMPLE_RSCT, update_check: 'on' }, {
        update: { home: h, now: NOW, env: { RSCT_UPDATE_CHECK: 'off' } },
      })) as StatusOutput
      expect(out.hints.some((x) => /takes precedence/.test(x))).toBe(true)
      expect(out.hints.some((x) => /newer RSCT release/.test(x))).toBe(false)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('a corrupt cache reports the real cause and never throws out of the tool', async () => {
    const h = mkdtempSync(join(tmpdir(), 'rsct-status-upd-'))
    try {
      mkdirSync(join(h, '.rsct'), { recursive: true })
      writeFileSync(join(h, '.rsct', 'update-check.json'), '{ not valid json')
      const out = (await statusHandler(
        { project_root: SAMPLE_RSCT, decline_update: NEWER_TAG },
        upd(h),
      )) as StatusOutput
      expect(out.rsct_installed).toBe(true)
      expect(out.hints.some((x) => /cannot be read or parsed/.test(x))).toBe(true)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  // tests/setup.ts is the only barrier between this suite and both api.github.com and
  // the contributor's real ~/.rsct. Nothing else fails if it is deleted or renamed.
  it('the global update-check kill switch is actually in force', () => {
    expect(process.env.RSCT_UPDATE_CHECK).toBe('off')
  })

  // T3: status always reports a worktree block, and the linked-worktree hint
  // must track the ACTUAL state.
  //
  // Asserting a literal `false` here made the whole suite unrunnable from a
  // linked worktree — the fixture lives inside the repo, so it genuinely IS in
  // one — while the framework's own rules recommend worktrees for parallel work
  // (rules/C-reauthorize.md:196, rules/B-architect-plan.md:130). Tying hint to
  // state is also STRICTLY STRONGER than the old pair: it catches a hint that
  // fires outside a worktree AND one that fails to fire inside one.
  // `lib/git — readWorktreeInfo` (tests/unit/git.test.ts) pins the detection
  // itself against purpose-built tmpdir repos, both directions.
  it('includes a worktree block and ties the linked-worktree hint to it', async () => {
    const out = (await statusHandler({ project_root: SAMPLE_RSCT })) as StatusOutput
    expect(out.worktree).toBeDefined()
    expect(typeof out.worktree.is_worktree).toBe('boolean')
    expect(out.hints.some((h) => h.includes('linked git worktree'))).toBe(
      out.worktree.is_worktree,
    )
  })

  // Install-drift: local compare of project rsct_version vs the running binary.
  const DRIFT = /was set up with RSCT v/

  it('surfaces an install-drift hint when the project version is behind the binary', async () => {
    // SAMPLE_RSCT is stamped rsct_version "1.0.0" < the running RSCT_MCP_VERSION.
    const out = (await statusHandler({ project_root: SAMPLE_RSCT })) as StatusOutput
    expect(out.hints.some((h) => DRIFT.test(h))).toBe(true)
  })

  it('does NOT surface an install-drift hint when not an rsct project', async () => {
    const out = (await statusHandler({ project_root: NO_RSCT })) as StatusOutput
    expect(out.hints.some((h) => DRIFT.test(h))).toBe(false)
  })

  it('does NOT surface an install-drift hint when the project version equals the binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsct-drift-eq-'))
    try {
      writeFileSync(
        join(dir, '.rsct.json'),
        JSON.stringify({ rsct_version: RSCT_MCP_VERSION, app: { name: 'a', org: 'o' } }),
      )
      const out = (await statusHandler({ project_root: dir })) as StatusOutput
      expect(out.rsct_installed).toBe(true) // guard: the negative isn't masked by a rejected config
      expect(out.hints.some((h) => DRIFT.test(h))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('escalates to a SECURITY hint when the enforcement scripts are absent', async () => {
    // Versions agree, so the version axis is silent — but a project whose
    // `.rsct/scripts/` never landed is running with no sanitizer and no
    // edit-scope guard, which the component axis must surface on its own.
    const dir = mkdtempSync(join(tmpdir(), 'rsct-drift-sec-'))
    try {
      writeFileSync(
        join(dir, '.rsct.json'),
        JSON.stringify({ rsct_version: RSCT_MCP_VERSION, app: { name: 'a', org: 'o' } }),
      )
      const out = (await statusHandler({ project_root: dir })) as StatusOutput
      expect(out.hints.some((h) => DRIFT.test(h))).toBe(false)
      const sec = out.hints.find((h) => h.includes('SECURITY'))
      expect(sec).toBeDefined()
      expect(sec).toContain('sanitize-permissions.js is not installed')
      expect(sec).toContain('edit-scope-guard.js is not installed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does NOT surface an install-drift hint when the project version is newer than the binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsct-drift-new-'))
    try {
      writeFileSync(
        join(dir, '.rsct.json'),
        JSON.stringify({ rsct_version: '999.0.0', app: { name: 'a', org: 'o' } }),
      )
      const out = (await statusHandler({ project_root: dir })) as StatusOutput
      expect(out.rsct_installed).toBe(true) // guard: the negative isn't masked by a rejected config
      expect(out.hints.some((h) => DRIFT.test(h))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
