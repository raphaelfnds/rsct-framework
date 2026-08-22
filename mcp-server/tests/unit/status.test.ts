import { describe, it, expect, afterEach } from 'vitest'
import { resolve, join } from 'node:path'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs'
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

// #53: rsct_status stamps the bootstrap marker at the top of the handler, so a report
// built from a POST-stamp read is vacuously "fresh" on every call — a report that can
// never fire. These pin the pre-stamp evaluation and the write outcomes.
//
// Every project here is a fresh mkdtemp. The sample-rsct fixture is off-limits for
// bootstrap assertions: its .rsct/phase-state.json is gitignored AND written by the
// suite itself (statusHandler stamps it), so its verdict is `missing` on the first run
// of a clean clone and `fresh`/`stale` afterwards, and test files run in parallel
// workers. There is no stable answer to assert.
describe('rsct_status — the §0 bootstrap report (#53)', () => {
  const roots: string[] = []
  const BOOTSTRAP = /§0|bootstrap/i

  function project(state?: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'rsct-status-bs-'))
    roots.push(root)
    writeFileSync(
      join(root, '.rsct.json'),
      JSON.stringify({ rsct_version: '1.0.0', app: { name: 't', org: 't' } }),
      'utf8',
    )
    mkdirSync(join(root, '.rsct'), { recursive: true })
    if (state !== undefined) {
      writeFileSync(
        join(root, '.rsct', 'phase-state.json'),
        JSON.stringify(state),
        'utf8',
      )
    }
    return root
  }

  const readState = (root: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(root, '.rsct', 'phase-state.json'), 'utf8'))

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true })
    }
  })

  it('reports a MISSING marker on the first call, having recorded one', async () => {
    // Mutation A (the hint half): evaluate after the stamp — the report then reads
    // its own write and goes fresh, so no hint at all.
    const root = project()
    const out = (await statusHandler({ project_root: root })) as StatusOutput
    expect(
      out.hints.some((h) => h.includes('No §0 bootstrap marker was on record')),
    ).toBe(true)

    // Mutation B (the stamp half, a DIFFERENT regression): delete the
    // stampBootstrapMarker call. Reading before writing must not stop the write.
    const stamped = readState(root).bootstrap_at
    expect(typeof stamped).toBe('string')
    const ageMs = Date.now() - new Date(stamped as string).getTime()
    expect(Number.isNaN(ageMs)).toBe(false)
    expect(ageMs).toBeLessThan(60_000)
  })

  it('reports a STALE marker with its age, and stays silent on a fresh one', async () => {
    // One test, two arms. The negative arm alone is worthless: with the evaluate
    // moved after the stamp — or with the whole feature deleted — "no hint" is
    // exactly what you get. The positive arm is its live control.
    //
    // 5 h, not 4: the staleness test is a strict `>` against BOOTSTRAP_STALE_MS,
    // so exactly 4 h is still fresh. Relative to Date.now(), never a literal: a
    // pinned 2026-06-07 date would silently make every arm stale.
    const stale = project({
      bootstrap_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    })
    const staleOut = (await statusHandler({ project_root: stale })) as StatusOutput
    const line = staleOut.hints.find((h) => h.includes('§0 was last recorded'))
    expect(line).toBeDefined()
    expect(line).toContain('this rsct_status call refreshed it')
    const minutes = Number(/last recorded (\d+) min ago/.exec(line ?? '')?.[1])
    expect(minutes).toBeGreaterThanOrEqual(298)
    expect(minutes).toBeLessThanOrEqual(302)
    // "refreshed it" must be a behavioural claim, not a copy-edit tripwire.
    // Mutation: `bootstrap_at: baseState.bootstrap_at ?? now.toISOString()` in
    // stampBootstrapMarker — a plausible "don't clobber what's there" edit. The
    // marker then never moves, the stale report never clears, and the hint above
    // says "refreshed it" forever. Every other assertion in this file survives it.
    expect(Date.now() - new Date(readState(stale).bootstrap_at as string).getTime())
      .toBeLessThan(60_000)

    const fresh = project({ bootstrap_at: new Date().toISOString() })
    const freshOut = (await statusHandler({ project_root: fresh })) as StatusOutput
    expect(freshOut.hints.some((h) => BOOTSTRAP.test(h))).toBe(false)
  })

  it('flags a bootstrap_at that is not a parseable timestamp', async () => {
    // Mutation: collapse the two `missing` branches into one. evaluateBootstrapMarker
    // returns status:'missing' for an unparseable VALUE too, with bootstrap_at set —
    // reported as "never recorded", that reads as a fresh project rather than a
    // corrupt marker.
    const root = project({ bootstrap_at: 'not-a-timestamp' })
    const out = (await statusHandler({ project_root: root })) as StatusOutput
    expect(
      out.hints.some(
        (h) =>
          h.includes('is not a parseable timestamp') && h.includes('not-a-timestamp'),
      ),
    ).toBe(true)
    // …and the corrupt value really was replaced. Without this the hint claims a
    // replacement that the same "don't clobber" mutation would never perform.
    expect(readState(root).bootstrap_at).not.toBe('not-a-timestamp')
  })

  it('never throws or floods hints on a junk bootstrap_at value', async () => {
    // Mutation: `truncateForHint(value: string)` taking a string and calling
    // .slice() directly. The phase-state schema is deliberately forgiving and
    // nothing validates this field, so an object with a numeric `length` reaches
    // .slice() and throws out of a tool documented "always succeeds"; an array
    // slips the length check and interpolates in full. Deleting the truncation
    // altogether also passes every other test in this file.
    const throws = project({ bootstrap_at: { length: 100 } })
    const out = (await statusHandler({ project_root: throws })) as StatusOutput
    expect(out.rsct_installed).toBe(true) // control: it really got that far

    const flood = project({ bootstrap_at: 'x'.repeat(5000) })
    const floodOut = (await statusHandler({ project_root: flood })) as StatusOutput
    const line = floodOut.hints.find((h) => h.includes('not a parseable timestamp'))
    expect(line).toBeDefined()
    expect(line!.length).toBeLessThan(300)
  })

  it('does NOT write over an unparseable phase-state.json, and says why', async () => {
    // Mutation: stamp anyway on parse_error. stampBootstrapMarker builds its write
    // from `existing.state ?? {}`, so an unreadable file is indistinguishable from an
    // empty one: the write lands carrying bootstrap_at and NOTHING else, destroying
    // whatever authorization or budget the file held.
    //
    // Asserting the surviving bytes, not just the hint — a hint-only assertion passes
    // even when the write lands.
    const root = project()
    const corrupt = '{"plan_authorization": {"plan_slug": "feat-x"}, '
    writeFileSync(join(root, '.rsct', 'phase-state.json'), corrupt, 'utf8')

    const out = (await statusHandler({ project_root: root })) as StatusOutput
    expect(readFileSync(join(root, '.rsct', 'phase-state.json'), 'utf8')).toBe(corrupt)
    expect(
      out.hints.some(
        (h) =>
          h.includes('could not be parsed') &&
          h.includes('deliberately NOT written'),
      ),
    ).toBe(true)
  })

  it('reports a locked phase-state without claiming it refreshed anything', async () => {
    // Mutation: drop the `!write.ok` branch. The marker is seeded FRESH so the
    // verdict line is silent and the lock hint is the only bootstrap hint —
    // otherwise "no 'refreshed' claim" could pass because nothing was emitted.
    //
    // The lock must carry a LIVE locked_at: tryAcquireLock overwrites a lock older
    // than 30 s, and a lock with an unparseable locked_at counts as stale, so the
    // house FIXED_NOW idiom would make the write succeed and test nothing.
    const root = project({ bootstrap_at: new Date().toISOString() })
    writeFileSync(
      join(root, '.rsct', 'phase-state.lock'),
      JSON.stringify({ session_id: 'peer', locked_at: new Date().toISOString() }),
      'utf8',
    )
    const out = (await statusHandler({ project_root: root })) as StatusOutput
    const lockHint = out.hints.find((h) => h.includes('holds .rsct/phase-state.lock'))
    expect(lockHint).toBeDefined()
    expect(lockHint).toContain('was not recorded')
    expect(out.hints.some((h) => h.includes('refreshed it'))).toBe(false)
  })

  it('reports a failed write, and does not claim to have recorded the marker', async () => {
    // Mutation: drop the `!write.ok` branch.
    // The lock PATH as a directory is the portable way to force a write failure:
    // 'wx' hits EEXIST, the stale-lock peek cannot read a directory, and the
    // overwrite then throws EISDIR on Windows, Linux and macOS alike. (Making
    // phase-state.json itself a directory would instead take the parse_error path.)
    const root = project()
    mkdirSync(join(root, '.rsct', 'phase-state.lock'), { recursive: true })

    const out = (await statusHandler({ project_root: root })) as StatusOutput
    // A phrase unique to this hint. NOT /⚠/ — the report can carry two of those —
    // and never the errno text, which is OS-specific and embeds an absolute path.
    expect(
      out.hints.some((h) =>
        h.includes('keep reporting bootstrap as missing or stale'),
      ),
    ).toBe(true)
    expect(
      out.hints.some((h) => h.includes('could not record one (see below)')),
    ).toBe(true)
    expect(out.hints.some((h) => h.includes('recorded one, so the session'))).toBe(
      false,
    )
    // The write really failed: nothing was created. (Not readState() — there is
    // no file to parse, which is the point.)
    expect(existsSync(join(root, '.rsct', 'phase-state.json'))).toBe(false)
  })

  it('does not claim downstream gates will warn when the marker is still fresh', async () => {
    // Mutation: make the consequence clause unconditional (drop `markerFresh`).
    // A failed write over a FRESH marker changes nothing the gates can see —
    // phase_code_start and the request_* gates read the same marker and report
    // fresh — so "they keep reporting bootstrap as missing or stale" is false,
    // and it is the ONLY bootstrap hint in that report (a fresh verdict is
    // silent). The write-failure test above covers the missing-marker arm, where
    // the same sentence is true.
    const root = project({ bootstrap_at: new Date().toISOString() })
    mkdirSync(join(root, '.rsct', 'phase-state.lock'), { recursive: true })

    const out = (await statusHandler({ project_root: root })) as StatusOutput
    const line = out.hints.find((h) => h.includes('could not be written'))
    expect(line).toBeDefined()
    expect(line).toContain('still stands')
    expect(
      out.hints.some((h) =>
        h.includes('keep reporting bootstrap as missing or stale'),
      ),
    ).toBe(false)
  })

  it('says nothing about §0 in a project that is not rsct-managed', async () => {
    // Mutation: drop the rsct_installed guard around the evaluate. An unmanaged
    // project has no §0 to report on, and "bootstrap not detected" on top of
    // "no .rsct.json found" is noise pointed at the wrong problem.
    //
    // A FRESH directory, not the shared no-rsct fixture. Written against the
    // fixture this test passed under its own mutation: earlier tests in this file
    // already call statusHandler on it, so the unguarded evaluate stamped the
    // fixture on the first of those calls and this one then read a fresh marker
    // and stayed silent. Verified — the mutated run left a phase-state.json inside
    // tests/fixtures/no-rsct/.
    const root = mkdtempSync(join(tmpdir(), 'rsct-status-nofile-'))
    roots.push(root)
    const out = (await statusHandler({ project_root: root })) as StatusOutput
    expect(out.rsct_installed).toBe(false) // control: the negative isn't vacuous
    expect(out.hints.some((h) => h.includes('/rsct-setup'))).toBe(true)
    expect(out.hints.some((h) => BOOTSTRAP.test(h))).toBe(false)
    // The guard also means nothing is written into an unmanaged project.
    expect(existsSync(join(root, '.rsct', 'phase-state.json'))).toBe(false)
  })
})
