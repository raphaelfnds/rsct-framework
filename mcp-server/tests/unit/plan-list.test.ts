import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listPlans, findActivePlan } from '../../src/lib/plan.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rsct-plan-list-'))
})

afterEach(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
})

/** A plan file carrying the full template metadata table. */
const planBody = (fields: Record<string, string>): string =>
  `# Plan: x\n\n## Metadata\n\n| Field | Value |\n|---|---|\n` +
  Object.entries(fields)
    .map(([k, v]) => `| ${k} | ${v} |`)
    .join('\n') +
  '\n\n## Goal\n'

const setMtime = (path: string, epochSeconds: number): void =>
  utimesSync(path, epochSeconds, epochSeconds)

describe('lib/plan — listPlans (#55)', () => {
  it('returns [] for an empty root and for an unreadable one', () => {
    expect(listPlans(tmp)).toEqual([])
    expect(listPlans(join(tmp, 'does-not-exist'))).toEqual([])
  })

  it('enumerates BOTH plan_ and spec_ files', () => {
    writeFileSync(join(tmp, 'plan_alpha.md'), planBody({ Status: 'draft' }))
    writeFileSync(join(tmp, 'spec_beta.md'), planBody({ Status: 'draft' }))
    // Mutation that reddens this: narrow the filter to /^plan_/.
    expect(listPlans(tmp).map((p) => p.slug).sort()).toEqual(['alpha', 'beta'])
  })

  it('ignores files that are not plan_/spec_ markdown', () => {
    writeFileSync(join(tmp, 'plan_ok.md'), planBody({ Status: 'draft' }))
    writeFileSync(join(tmp, 'progress_ok.md'), 'log\n')
    writeFileSync(join(tmp, 'README.md'), '# no\n')
    writeFileSync(join(tmp, 'plan_.md'), 'no slug\n')
    expect(listPlans(tmp).map((p) => p.slug)).toEqual(['ok'])
  })

  it('orders by plan-file mtime, most recent first', () => {
    writeFileSync(join(tmp, 'plan_old.md'), planBody({ Status: 'draft' }))
    writeFileSync(join(tmp, 'plan_mid.md'), planBody({ Status: 'draft' }))
    writeFileSync(join(tmp, 'plan_new.md'), planBody({ Status: 'draft' }))
    setMtime(join(tmp, 'plan_old.md'), 1_000_000)
    setMtime(join(tmp, 'plan_mid.md'), 2_000_000)
    setMtime(join(tmp, 'plan_new.md'), 3_000_000)
    // Mutation that reddens this: flip the sort comparator.
    expect(listPlans(tmp).map((p) => p.slug)).toEqual(['new', 'mid', 'old'])
    // plan_mtime is the recency source the whole module is built around, and it
    // had no assertion at all — replacing it with `new Date().toISOString()`
    // destroyed its meaning while every test stayed green.
    expect(listPlans(tmp).map((p) => p.plan_mtime)).toEqual([
      new Date(3_000_000_000).toISOString(),
      new Date(2_000_000_000).toISOString(),
      new Date(1_000_000_000).toISOString(),
    ])
  })

  it('does NOT order by the table\'s `Last update` row', () => {
    // `plan_stale-file` claims the newest Last update but has the OLDEST mtime.
    // Recency has exactly one source, and it is the file — not dev-written prose.
    writeFileSync(
      join(tmp, 'plan_stale-file.md'),
      planBody({ Status: 'draft', 'Last update': '2099-01-01' }),
    )
    writeFileSync(
      join(tmp, 'plan_fresh-file.md'),
      planBody({ Status: 'draft', 'Last update': '1999-01-01' }),
    )
    setMtime(join(tmp, 'plan_stale-file.md'), 1_000_000)
    setMtime(join(tmp, 'plan_fresh-file.md'), 2_000_000)
    expect(listPlans(tmp).map((p) => p.slug)).toEqual(['fresh-file', 'stale-file'])
  })

  it('parses Slug and Last update from the metadata table (#57)', () => {
    writeFileSync(
      join(tmp, 'plan_parsed.md'),
      planBody({
        Slug: 'parsed',
        Branch: 'feat/parsed',
        Created: '2026-08-01',
        Status: 'in-progress',
        'Last update': '2026-08-30',
      }),
    )
    // Mutation that reddens this: drop either new field from extractPlanMetadata.
    const [p] = listPlans(tmp)
    expect(p?.declared_slug).toBe('parsed')
    expect(p?.last_update).toBe('2026-08-30')
    expect(p?.status).toBe('in-progress')
    expect(p?.branch).toBe('feat/parsed')
    expect(p?.created).toBe('2026-08-01')
  })

  it('reports null for the new fields when the template rows are absent', () => {
    writeFileSync(join(tmp, 'plan_bare.md'), planBody({ Status: 'draft' }))
    const [p] = listPlans(tmp)
    expect(p?.declared_slug).toBeNull()
    expect(p?.last_update).toBeNull()
  })

  it('NEVER lets the table Slug override the filename-derived slug', () => {
    // The filename slug is the resolution identity that plan-authorization
    // validates against; the table row is dev-written prose. Mutation that
    // reddens this: assign metadata.declared_slug to `slug`.
    writeFileSync(
      join(tmp, 'plan_real-name.md'),
      planBody({ Slug: 'a-completely-different-slug', Status: 'draft' }),
    )
    const [p] = listPlans(tmp)
    expect(p?.slug).toBe('real-name')
    expect(p?.declared_slug).toBe('a-completely-different-slug')
  })

  it('reports progress state and idle days, and null when there is no progress file', () => {
    writeFileSync(join(tmp, 'plan_withp.md'), planBody({ Status: 'draft' }))
    writeFileSync(join(tmp, 'progress_withp.md'), '- [x] done\n- [ ] open\n')
    writeFileSync(join(tmp, 'plan_nop.md'), planBody({ Status: 'draft' }))

    const now = new Date('2026-08-30T00:00:00Z')
    setMtime(join(tmp, 'progress_withp.md'), Date.parse('2026-08-20T00:00:00Z') / 1000)

    const byslug = Object.fromEntries(
      listPlans(tmp, { now }).map((p) => [p.slug, p]),
    )
    expect(byslug.withp?.progress_state).toBe('has_open')
    expect(byslug.withp?.progress_idle_days).toBe(10)
    // The POPULATED case, not only the null one: hardcoding progress_path to
    // null left progress_state and idle_days working, so the mutant was invisible.
    expect(byslug.withp?.progress_path).toContain('progress_withp.md')
    expect(byslug.withp?.progress_mtime).toBe('2026-08-20T00:00:00.000Z')
    expect(byslug.nop?.progress_mtime).toBeNull()
    expect(byslug.nop?.progress_path).toBeNull()
    expect(byslug.nop?.progress_state).toBe('no_file')
    expect(byslug.nop?.progress_idle_days).toBeNull()
  })

  it('leaves findActivePlan behaving exactly as before (#57 guard rail)', () => {
    // listPlans must not have changed the mtime winner that plan-authorization
    // resolution depends on.
    writeFileSync(join(tmp, 'plan_old.md'), planBody({ Status: 'draft' }))
    writeFileSync(join(tmp, 'spec_new.md'), planBody({ Status: 'approved' }))
    setMtime(join(tmp, 'plan_old.md'), 1_000_000)
    setMtime(join(tmp, 'spec_new.md'), 3_000_000)

    const active = findActivePlan(tmp)
    expect(active?.slug).toBe('new')
    expect(active?.status).toBe('approved')
    expect(listPlans(tmp)[0]?.slug).toBe('new')
  })
})
