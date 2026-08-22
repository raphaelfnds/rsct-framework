import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

import {
  loadContextHandler,
  type LoadContextOutput,
} from '../../src/tools/load-context.js'
import { statusHandler, type StatusOutput } from '../../src/tools/status.js'

const SAMPLE_RSCT = resolve(__dirname, '..', 'fixtures', 'sample-rsct')
const NO_RSCT = resolve(__dirname, '..', 'fixtures', 'no-rsct')
// Has a .rsct.json that omits `protected_branches` — the #50 case.
const RSCT_NO_BRANCH_KEY = resolve(__dirname, '..', 'fixtures', 'sample-rsct-universe')

describe('rsct_load_context', () => {
  it('returns a structured snapshot for an rsct project', async () => {
    const out = (await loadContextHandler({ project_root: SAMPLE_RSCT })) as LoadContextOutput

    expect(out.rsct_installed).toBe(true)
    expect(out.project.app_name).toBe('sample-app')
    expect(out.decisions.file_exists).toBe(true)
    expect(out.decisions.premises_count).toBeGreaterThanOrEqual(3)
    expect(out.decisions.adrs_count).toBeGreaterThanOrEqual(5)
    expect(out.decisions.recent_premises[0]?.id).toBe('#3')
    expect(out.decisions.recent_adrs[0]?.id).toBe('ADR-007')
    expect(out.project.protected_branches).toEqual(['main', 'test'])
  })

  it('reports the ENFORCED branch list when .rsct.json omits the key (#50)', async () => {
    // Must agree with rsct_status and with the §C gates. Pinned literally so a
    // change to the defaults is a deliberate act, not a silent follow-along.
    const out = (await loadContextHandler({
      project_root: RSCT_NO_BRANCH_KEY,
    })) as LoadContextOutput

    expect(out.rsct_installed).toBe(true)
    expect(out.project.protected_branches).toEqual(['main', 'master', 'test', 'dev'])
  })

  it('reports no protected branches when the project is not rsct-managed (#50)', async () => {
    const out = (await loadContextHandler({ project_root: NO_RSCT })) as LoadContextOutput

    expect(out.rsct_installed).toBe(false)
    expect(out.project.protected_branches).toEqual([])
  })

  it('detects active plan and parses metadata', async () => {
    const out = (await loadContextHandler({ project_root: SAMPLE_RSCT })) as LoadContextOutput

    expect(out.active_plan).not.toBeNull()
    expect(out.active_plan?.slug).toBe('sample-task')
    expect(out.active_plan?.status).toBe('approved')
    expect(out.active_plan?.branch).toBe('feat/sample-task')
  })

  it('reports knowledge category coverage', async () => {
    const out = (await loadContextHandler({ project_root: SAMPLE_RSCT })) as LoadContextOutput

    expect(out.knowledge.directory_exists).toBe(true)
    expect(out.knowledge.categories_present).toContain('business-rules')
    expect(out.knowledge.categories_missing.length).toBeGreaterThan(0)
  })

  it('produces a setup hint when no rsct', async () => {
    const out = (await loadContextHandler({ project_root: NO_RSCT })) as LoadContextOutput

    expect(out.rsct_installed).toBe(false)
    expect(out.active_plan).toBeNull()
    expect(out.decisions.file_exists).toBe(false)
    expect(out.next_action_hints.some((h) => h.includes('/rsct-setup'))).toBe(true)
  })

  it('surfaces the install-drift hint in next_action_hints (parity with rsct_status)', async () => {
    // SAMPLE_RSCT is stamped rsct_version "1.0.0" < the running RSCT_MCP_VERSION.
    const out = (await loadContextHandler({ project_root: SAMPLE_RSCT })) as LoadContextOutput
    expect(out.next_action_hints.some((h) => /was set up with RSCT v/.test(h))).toBe(true)
  })

  it('does NOT surface the install-drift hint when not an rsct project', async () => {
    const out = (await loadContextHandler({ project_root: NO_RSCT })) as LoadContextOutput
    expect(out.next_action_hints.some((h) => /was set up with RSCT v/.test(h))).toBe(false)
  })

  it('emits the SAME drift hint text as rsct_status (byte-for-byte parity)', async () => {
    const DRIFT = /was set up with RSCT v/
    const lc = (await loadContextHandler({ project_root: SAMPLE_RSCT })) as LoadContextOutput
    const st = (await statusHandler({ project_root: SAMPLE_RSCT })) as StatusOutput
    const lcHint = lc.next_action_hints.find((h) => DRIFT.test(h))
    const stHint = st.hints.find((h) => DRIFT.test(h))
    expect(lcHint).toBeDefined()
    expect(stHint).toBeDefined()
    expect(lcHint).toBe(stHint)
  })

  it('honors decisions_excerpt_count', async () => {
    const out = (await loadContextHandler({
      project_root: SAMPLE_RSCT,
      decisions_excerpt_count: 1,
    })) as LoadContextOutput

    expect(out.decisions.recent_premises.length).toBe(1)
    expect(out.decisions.recent_adrs.length).toBe(1)
  })

  it('rejects out-of-range decisions_excerpt_count', async () => {
    await expect(
      loadContextHandler({ project_root: SAMPLE_RSCT, decisions_excerpt_count: 999 }),
    ).rejects.toThrow()
  })

  it('active_phase is null for the sample fixture (no phase-state.json)', async () => {
    const out = (await loadContextHandler({
      project_root: SAMPLE_RSCT,
    })) as LoadContextOutput
    expect(out.active_phase).toBeNull()
  })
})

describe('rsct_load_context — active_phase block (CAP-2)', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rsct-lc-phase-'))
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
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  function writePhaseStateFile(state: Record<string, unknown>): void {
    mkdirSync(join(tmpRoot, '.rsct'), { recursive: true })
    writeFileSync(
      join(tmpRoot, '.rsct', 'phase-state.json'),
      JSON.stringify(state),
      'utf8',
    )
  }

  it('returns null when phase-state.json is absent', async () => {
    const out = (await loadContextHandler({
      project_root: tmpRoot,
    })) as LoadContextOutput
    expect(out.active_phase).toBeNull()
  })

  it('returns null when phase-state.json has no phase field', async () => {
    writePhaseStateFile({ spec_slug: 'foo' })
    const out = (await loadContextHandler({
      project_root: tmpRoot,
    })) as LoadContextOutput
    expect(out.active_phase).toBeNull()
  })

  it('populates active_phase when phase-state has a phase (no verification)', async () => {
    writePhaseStateFile({
      phase: 'spec',
      spec_slug: 'feat-foo',
      started_at: '2026-06-07T10:00:00.000Z',
      scope_globs: ['src/**/*.ts'],
    })
    const out = (await loadContextHandler({
      project_root: tmpRoot,
    })) as LoadContextOutput
    expect(out.active_phase).not.toBeNull()
    expect(out.active_phase?.phase).toBe('spec')
    expect(out.active_phase?.spec_slug).toBe('feat-foo')
    expect(out.active_phase?.scope_globs).toEqual(['src/**/*.ts'])
    expect(out.active_phase?.verification).toBeNull()
  })

  it('populates active_phase.verification when phase=verification', async () => {
    writePhaseStateFile({
      phase: 'verification',
      spec_slug: 'feat-bar',
      verification: {
        spec_ref: 'feat-bar',
        spec_tier: 'standard',
        declared_paths: ['src/a.ts'],
        findings: [
          { id: 'v-gap-1', severity: 'address-now' },
          { id: 'v-forgotten-1', severity: 'defer' },
        ],
        started_at: '2026-06-07T11:00:00.000Z',
      },
    })
    const out = (await loadContextHandler({
      project_root: tmpRoot,
    })) as LoadContextOutput
    expect(out.active_phase?.verification).not.toBeNull()
    expect(out.active_phase?.verification?.spec_ref).toBe('feat-bar')
    expect(out.active_phase?.verification?.spec_tier).toBe('standard')
    expect(out.active_phase?.verification?.findings_count).toBe(2)
    expect(out.active_phase?.verification?.started_at).toBe(
      '2026-06-07T11:00:00.000Z',
    )
  })

  it('emits a hint when the verification phase is active', async () => {
    writePhaseStateFile({
      phase: 'verification',
      spec_slug: 'feat-baz',
      verification: {
        spec_ref: 'feat-baz',
        spec_tier: 'complex',
        findings: [{ id: 'v-1' }],
      },
    })
    const out = (await loadContextHandler({
      project_root: tmpRoot,
    })) as LoadContextOutput
    expect(
      out.next_action_hints.some(
        (h) =>
          h.includes('Active phase: verification') &&
          h.includes('feat-baz'),
      ),
    ).toBe(true)
  })
})

// load_context is the surface the #49 symptom was reported on — `adrs_count: 0` at
// bootstrap on a project full of ADRs. The parser cases live in get-decisions.test.ts;
// these drive the whole tool end to end, which is what the report was about.
describe('rsct_load_context — decisions at bootstrap (#49)', () => {
  let root: string

  const writeDecisions = (content: string): void => {
    mkdirSync(join(root, 'documentation'), { recursive: true })
    writeFileSync(join(root, 'documentation', 'decisions.md'), content, 'utf8')
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rsct-lc-dec-'))
    writeFileSync(
      join(root, '.rsct.json'),
      JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test', org: 'test' } }),
      'utf8',
    )
  })
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('returns the ADRs of a project whose file uses `##` and a colon', async () => {
    writeDecisions(
      [
        '# Architectural decisions',
        '',
        '## Durable architectural decisions (ADRs)',
        '',
        '## ADR-001: Postgres over Mongo',
        'Relational integrity outweighed schema flexibility.',
        '',
        '## ADR-002 – Tenants never share a schema',
        'Hard multi-tenancy boundary.',
        '',
        '## #1 — Append-only ledger',
        'Financial events are immutable once committed.',
      ].join('\n'),
    )

    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    expect(out.decisions.file_exists).toBe(true)
    expect(out.decisions.adrs_count).toBe(2)
    expect(out.decisions.premises_count).toBe(1)
    expect(out.decisions.recent_adrs.map((a) => a.id)).toContain('ADR-001')
    expect(out.next_action_hints.some((h) => h.includes('no premise or ADR heading'))).toBe(false)
  })

  it('flags a file that mentions decision ids but parses to nothing', async () => {
    writeDecisions('# Decisions\n\n#### ADR-001 -- wrong level, wrong separator\nBody.\n')

    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    expect(out.decisions.adrs_count).toBe(0)
    expect(out.next_action_hints.some((h) => h.includes('mentions decision ids'))).toBe(true)
  })

  it('flags a decisions.md that exists but cannot be read', async () => {
    mkdirSync(join(root, 'documentation', 'decisions.md'), { recursive: true })

    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    expect(out.decisions.file_exists).toBe(true)
    expect(out.next_action_hints.some((h) => h.includes('could not be read'))).toBe(true)
  })

  it('stays silent on a scaffold with prose but no decision ids', async () => {
    writeDecisions('# Architectural decisions\n\n## Firm premises\n\n## ADRs\n')

    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    expect(out.next_action_hints.some((h) => h.includes('mentions decision ids'))).toBe(false)
  })
})

// #50 — the report field and the HINT are two separate reads of the list. Covering
// only the field lets the hint be reverted to the raw config with the suite green.
describe.skipIf(!hasGit())('rsct_load_context — protected-branch hint (#50)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rsct-lc-branch-'))
    const git = (args: string[]): void => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git(['init', '-q'])
    git(['config', 'user.email', 't@t.t'])
    git(['config', 'user.name', 't'])
    writeFileSync(join(root, 'README.md'), '# app\n')
    git(['add', 'README.md'])
    git(['commit', '-qm', 'init'])
    git(['branch', '-M', 'main'])
    // No `protected_branches` key — the enforced list has to come from the defaults.
    writeFileSync(
      join(root, '.rsct.json'),
      JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test', org: 'test' } }),
      'utf8',
    )
  })
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('warns on `main` even though .rsct.json declares no protected branches', async () => {
    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    expect(out.git.branch).toBe('main')
    expect(out.next_action_hints.some((h) => h.includes("On the protected branch 'main'"))).toBe(
      true,
    )
  })
})

// #53: the twin of the rsct_status block. Both tools stamp the same marker and both
// discarded the result, so fixing one would have left the two reporting differently
// about the same file. Fresh mkdtemp projects only — the sample fixture's phase-state
// is written by the suite itself and has no stable verdict to assert.
describe('rsct_load_context — the §0 bootstrap report (#53)', () => {
  const roots: string[] = []
  const BOOTSTRAP = /§0|bootstrap/i

  function project(state?: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'rsct-lc-bs-'))
    roots.push(dir)
    writeFileSync(
      join(dir, '.rsct.json'),
      JSON.stringify({ rsct_version: '1.0.0', app: { name: 't', org: 't' } }),
      'utf8',
    )
    mkdirSync(join(dir, '.rsct'), { recursive: true })
    if (state !== undefined) {
      writeFileSync(
        join(dir, '.rsct', 'phase-state.json'),
        JSON.stringify(state),
        'utf8',
      )
    }
    return dir
  }

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true })
    }
  })

  it('reports a MISSING marker on the first call, having established the baseline', async () => {
    // Mutation: evaluate after the stamp — load_context reads its own write and
    // reports fresh, on every call, forever.
    const root = project()
    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    expect(
      out.next_action_hints.some((h) =>
        h.includes('No §0 bootstrap marker was on record'),
      ),
    ).toBe(true)
    const stamped = JSON.parse(
      readFileSync(join(root, '.rsct', 'phase-state.json'), 'utf8'),
    ).bootstrap_at
    // Mutation (separate): delete the stampBootstrapMarker call.
    expect(Date.now() - new Date(stamped).getTime()).toBeLessThan(60_000)
  })

  it('reports a STALE marker with its age, and stays silent on a fresh one', async () => {
    // Two arms in one test: the silent arm is worthless without a live positive
    // control beside it — deleting the feature outright would satisfy it alone.
    const stale = project({
      bootstrap_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    })
    const staleOut = (await loadContextHandler({
      project_root: stale,
    })) as LoadContextOutput
    const line = staleOut.next_action_hints.find((h) =>
      h.includes('§0 was last recorded'),
    )
    expect(line).toBeDefined()
    expect(line).toContain('re-read plan, decisions and knowledge')
    // Mutation: `bootstrap_at: baseState.bootstrap_at ?? now.toISOString()` in
    // stampBootstrapMarker. The marker never moves and "refreshed it" is false
    // forever, while every hint assertion stays green.
    const stamped = JSON.parse(
      readFileSync(join(stale, '.rsct', 'phase-state.json'), 'utf8'),
    ).bootstrap_at
    expect(Date.now() - new Date(stamped).getTime()).toBeLessThan(60_000)

    const fresh = project({ bootstrap_at: new Date().toISOString() })
    const freshOut = (await loadContextHandler({
      project_root: fresh,
    })) as LoadContextOutput
    expect(freshOut.next_action_hints.some((h) => BOOTSTRAP.test(h))).toBe(false)
  })

  it('does NOT write over an unparseable phase-state.json, and says the flag stayed', async () => {
    // Mutation: stamp anyway on parse_error — the file is replaced by a lone
    // bootstrap_at and everything it held is gone. Assert the surviving bytes: a
    // hint-only assertion passes even when the write lands.
    const root = project()
    const corrupt = '{"plan_authorization": {"plan_slug": "feat-x"}, '
    writeFileSync(join(root, '.rsct', 'phase-state.json'), corrupt, 'utf8')

    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    expect(readFileSync(join(root, '.rsct', 'phase-state.json'), 'utf8')).toBe(corrupt)
    expect(
      out.next_action_hints.some(
        (h) =>
          h.includes('could not be parsed') && h.includes('was NOT cleared'),
      ),
    ).toBe(true)
  })

  it('says context_stale was NOT cleared when the write does not land', async () => {
    // Mutation: drop the context_stale branch from the write-failure path.
    // D4: `clearStale` rides in the SAME write as the marker, so a failed write
    // leaves the re-bootstrap obligation undischarged while the rest of the report
    // reads exactly like a successful re-load. The dev is then told context was
    // reloaded while every managed edit stays blocked.
    //
    // The lock PATH as a directory is the portable forced write failure (EEXIST on
    // 'wx', then EISDIR on the stale-lock overwrite) — on all three OSes.
    const root = project({
      context_stale: { since: '2026-06-07T12:00:00.000Z', reason: 'plan_closed' },
    })
    mkdirSync(join(root, '.rsct', 'phase-state.lock'), { recursive: true })

    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    expect(
      out.next_action_hints.some(
        (h) =>
          h.includes('re-bootstrap flag (context_stale) was NOT cleared') &&
          h.includes('managed edits stay blocked'),
      ),
    ).toBe(true)
    // Control: the flag really is still on disk, so the hint is true.
    const after = JSON.parse(
      readFileSync(join(root, '.rsct', 'phase-state.json'), 'utf8'),
    )
    expect(after.context_stale).toBeDefined()
  })

  it('clears context_stale on a successful load — the D4 obligation is discharged', async () => {
    // The positive control for the whole #53 story, and it was missing.
    // Mutation: `stampBootstrapMarker(projectRoot)` inside readThenStampBootstrap,
    // dropping `opts`. `clearStale` is then lost and NOTHING clears the flag —
    // while #53 has just made abandon preserve it — so every managed edit is
    // blocked permanently. 83 tests across four files stayed green under it.
    // This is also what makes the commit's "it cannot deadlock" claim checkable.
    const root = project({
      phase: 'code',
      context_stale: { since: '2026-06-07T12:00:00.000Z', reason: 'plan_closed' },
    })
    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    const after = JSON.parse(
      readFileSync(join(root, '.rsct', 'phase-state.json'), 'utf8'),
    )
    expect(after.context_stale).toBeUndefined()
    expect(after.phase).toBe('code') // control: the rest of the state survived
    expect(
      out.next_action_hints.some((h) => h.includes('re-bootstrap flag')),
    ).toBe(false)
  })

  it('does NOT claim a re-bootstrap block when no flag was set', async () => {
    // Mutation: `if (true)` on the context_stale sub-hint. The existing test only
    // proves it fires when the flag IS set; a false "managed edits stay blocked"
    // is as damaging as a missed one, and would fire on every failed write.
    const root = project()
    mkdirSync(join(root, '.rsct', 'phase-state.lock'), { recursive: true })

    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    expect(
      out.next_action_hints.some((h) => h.includes('could not be written')),
    ).toBe(true) // control: the write really failed, so the branch was reached
    expect(
      out.next_action_hints.some((h) => h.includes('re-bootstrap flag')),
    ).toBe(false)
  })

  it('reports a locked phase-state in its own voice', async () => {
    // The load-context twin of the status locked test. Mutation: copy-paste the
    // status wording (it names the retry tool), or drop the branch. Untested,
    // the two copies could name the wrong tool and nothing would notice.
    const root = project({ bootstrap_at: new Date().toISOString() })
    writeFileSync(
      join(root, '.rsct', 'phase-state.lock'),
      JSON.stringify({ session_id: 'peer', locked_at: new Date().toISOString() }),
      'utf8',
    )
    const out = (await loadContextHandler({ project_root: root })) as LoadContextOutput
    const line = out.next_action_hints.find((h) =>
      h.includes('holds .rsct/phase-state.lock'),
    )
    expect(line).toBeDefined()
    expect(line).toContain('the next rsct_load_context records it')
  })

  it('says nothing about §0 in a project that is not rsct-managed', async () => {
    // Mutation: drop the rsct_installed guard around the evaluate.
    //
    // A FRESH directory, not the shared no-rsct fixture: earlier tests in this file
    // already call loadContextHandler on it, so an unguarded evaluate stamps the
    // fixture on the first of those calls and this one reads a fresh marker and
    // stays silent — the test would pass under its own mutation. Measured on the
    // status.ts twin, which did exactly that.
    const root = mkdtempSync(join(tmpdir(), 'rsct-lc-nofile-'))
    roots.push(root)
    const out = (await loadContextHandler({
      project_root: root,
    })) as LoadContextOutput
    expect(out.rsct_installed).toBe(false) // control: the negative isn't vacuous
    expect(out.next_action_hints.some((h) => BOOTSTRAP.test(h))).toBe(false)
    expect(existsSync(join(root, '.rsct', 'phase-state.json'))).toBe(false)
  })

  it('agrees with rsct_status on the same state — same verdict, different voice', async () => {
    // The parity the dev asked for, and the only shape it can take: both tools stamp,
    // so running them against ONE project means the second always reads the first's
    // write and reports fresh. Two identical projects, one handler each.
    //
    // Compares the VERDICT (both report stale, at the same age), never the text —
    // the wording is deliberately per-call-site, so a byte-for-byte comparison would
    // fail for the wrong reason.
    // Mutation: change the order or the threshold in one tool only.
    const seed = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
    const a = project({ bootstrap_at: seed })
    const b = project({ bootstrap_at: seed })

    const statusOut = (await statusHandler({ project_root: a })) as StatusOutput
    const loadOut = (await loadContextHandler({ project_root: b })) as LoadContextOutput

    const age = (hints: string[]): number => {
      const line = hints.find((h) => h.includes('§0 was last recorded'))
      expect(line, 'both tools must report the stale marker').toBeDefined()
      return Number(/last recorded (\d+) min ago/.exec(line ?? '')?.[1])
    }
    const statusAge = age(statusOut.hints)
    const loadAge = age(loadOut.next_action_hints)
    expect(statusAge).toBeGreaterThanOrEqual(298)
    expect(statusAge).toBeLessThanOrEqual(302)
    expect(Math.abs(statusAge - loadAge)).toBeLessThanOrEqual(1)
  })
})
