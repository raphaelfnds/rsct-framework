import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  coverageHints,
  diskProbe,
  memoProbe,
  walkReverseDeps,
  ZERO_IMPORTER_HINT_PREFIX,
  type ResolveProbe,
} from '../../src/lib/reverse-dep-walk.js'
import { readImpactCorpus } from '../../src/lib/impact-scope.js'
import { openSweepRepo } from '../../src/lib/comment-sweep/git-reads.js'
import { runVerificationChecklist } from '../../src/lib/verification-checklist.js'
import { getTopologyHandler } from '../../src/tools/get-topology.js'
import { phaseVerificationStartHandler } from '../../src/tools/phase-verification-start.js'
import { commitAll, git, initSweepRepo } from '../sweep-repo.js'

const c = (...codes: number[]): string => String.fromCharCode(...codes)

const CASE_HINT = 'reach a file only when letter case is ignored'

const caseInsensitiveDisk = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'rsct-case-probe-'))
  try {
    return existsSync(probe.toUpperCase()) && existsSync(probe.toLowerCase())
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-blast-radius-'))
})

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function write(rel: string, content: string, base = root): void {
  const full = join(base, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function gitInput(cwd: string, input: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function caseCount(project: string, seed: string): { count: number; hints: string[] } {
  const out = walkReverseDeps({ projectRoot: project, seedPaths: [seed] })
  return { count: out.stats.case_inexact_specifiers, hints: out.hints }
}

describe('8.1 — the walk remembers what it asked the disk, within one walk', () => {
  it('asks once per path and question, and answers exactly as a walk that remembers nothing', () => {
    write('src/shared.ts', 'export const s = 1\n')
    write('src/lib/index.ts', 'export const l = 1\n')
    for (const name of ['a', 'b', 'c', 'd']) {
      write(`src/${name}.ts`, "import { s } from './shared.js'\nimport { l } from './lib'\nimport { m } from './missing.js'\n")
    }
    const counts = new Map<string, number>()
    const base = diskProbe(root, new Map())
    const count = (kind: string, abs: string): void => {
      counts.set(`${kind} ${abs}`, (counts.get(`${kind} ${abs}`) ?? 0) + 1)
    }
    const counting: ResolveProbe = {
      exists: (abs) => (count('exists', abs), base.exists(abs)),
      isFile: (abs) => (count('isFile', abs), base.isFile(abs)),
      isDirectory: (abs) => (count('isDirectory', abs), base.isDirectory(abs)),
      hasExactPath: (abs) => base.hasExactPath(abs),
    }
    const remembered = walkReverseDeps({ projectRoot: root, seedPaths: ['src/shared.ts', 'src/lib/index.ts'], probe: counting })
    const fresh = walkReverseDeps({ projectRoot: root, seedPaths: ['src/shared.ts', 'src/lib/index.ts'] })
    expect(counts.size).toBeGreaterThan(0)
    expect(Math.max(...counts.values())).toBe(1)
    expect(remembered).toEqual(fresh)
    expect(remembered.by_seed.map((s) => [s.seed, s.importers.length])).toEqual([
      ['src/shared.ts', 4],
      ['src/lib/index.ts', 4],
    ])
    expect(remembered.stats.unresolved_js_specifiers).toBe(4)
  })

  it('memoProbe forwards each question once per path and never remembers the case check', () => {
    const asked: string[] = []
    const probe = memoProbe({
      exists: (abs) => (asked.push(`exists ${abs}`), abs === 'x'),
      isFile: (abs) => (asked.push(`isFile ${abs}`), false),
      isDirectory: (abs) => (asked.push(`isDirectory ${abs}`), true),
      hasExactPath: (abs) => (asked.push(`hasExactPath ${abs}`), true),
    })
    for (let i = 0; i < 3; i++) {
      expect(probe.exists('x')).toBe(true)
      expect(probe.exists('y')).toBe(false)
      expect(probe.isFile('x')).toBe(false)
      expect(probe.isDirectory('x')).toBe(true)
      expect(probe.hasExactPath('x')).toBe(true)
    }
    expect(asked).toEqual([
      'exists x',
      'exists y',
      'isFile x',
      'isDirectory x',
      'hasExactPath x',
      'hasExactPath x',
      'hasExactPath x',
    ])
  })
})

describe('8.2 — imports that resolve only by ignoring letter case, the same count on every system', () => {
  it('counts a wrongly cased file name, with and without an extension, and names it in a hint', () => {
    write('src/widget.js', 'export const w = 1\n')
    write('src/a.js', "import { w } from './Widget.js'\n")
    const withExtension = caseCount(root, 'src/widget.js')
    expect(withExtension.count).toBe(1)
    expect(withExtension.hints.join('\n')).toContain(`${CASE_HINT}, or reach a different file when it is not: src/a.js -> './Widget.js'`)

    const other = join(root, 'other')
    write('src/widget.ts', 'export const w = 1\n', other)
    write('src/a.ts', "import { w } from './Widget'\n", other)
    const bare = caseCount(other, 'src/widget.ts')
    expect(bare.count).toBe(1)
    expect(bare.hints.some((h) => h.startsWith(ZERO_IMPORTER_HINT_PREFIX))).toBe(true)
  })

  it('counts an import whose first case-folded match differs from the file it reaches on a case-keeping disk', () => {
    write('src/Foo.ts', 'export const F = 1\n')
    write('src/foo.js', 'export const f = 1\n')
    write('src/a.js', "import { f } from './foo'\n")
    expect(caseCount(root, 'src/foo.js').count).toBe(1)
  })

  it('counts a wrongly cased folder inside the root, and an index file reached through one', () => {
    write('src/lib/x.js', 'export const x = 1\n')
    write('src/util/index.ts', 'export const u = 1\n')
    write('src/a.js', "import { x } from './Lib/x.js'\nimport { u } from './Util'\n")
    expect(caseCount(root, 'src/lib/x.js').count).toBe(2)
  })

  it('compares the path leaving the root by exact segments, never by a case-blind relative path', () => {
    const project = join(root, 'proj')
    write('src/b.js', 'export const b = 1\n', project)
    write('src/n.ts', 'export const n = 1\n', project)
    write('src/sub/a.js', "import { b } from '../../../Proj/src/b.js'\nimport { n } from '../../../Proj/src/n.js'\n", project)
    expect(caseCount(project, 'src/b.js').count).toBe(2)
  })

  it('does not count an exact import that leaves the root', () => {
    const project = join(root, 'proj')
    write('src/b.ts', 'export const b = 1\n', project)
    write('src/a.ts', "import { b } from './b.js'\n", project)
    write('outside/o.ts', 'export const o = 1\n')
    write('src/c.ts', "import { o } from '../../outside/o.js'\n", project)
    expect(caseCount(project, 'src/b.ts').count).toBe(0)
  })

  it.skipIf(!caseInsensitiveDisk)('never compares the spelling of the root itself (a disk that ignores letter case)', () => {
    const project = join(root, 'proj')
    write('src/b.ts', 'export const b = 1\n', project)
    write('src/a.ts', "import { b } from './b.js'\n", project)
    write('outside/o.ts', 'export const o = 1\n')
    write('src/c.ts', "import { o } from '../../outside/o.js'\n", project)
    const respelled = join(root, 'PROJ')
    expect(existsSync(respelled)).toBe(true)
    expect(caseCount(respelled, 'src/b.ts').count).toBe(0)
  })

  it('does not count exact imports, nor a name that differs only by Unicode normalisation', () => {
    write('src/widget.js', 'export const w = 1\n')
    write('src/widget2.ts', 'export const w = 1\n')
    write('src/dir/index.ts', 'export const d = 1\n')
    write('src/m.ts', 'export const m = 1\n')
    write(`src/caf${c(0xe9)}.ts`, 'export const k = 1\n')
    write(
      'src/a.ts',
      [
        "import { w } from './widget.js'",
        "import { w2 } from './widget2'",
        "import { d } from './dir'",
        "import { m } from './m.js'",
        `import { k } from './cafe${c(0x301)}'`,
        "import x from 'react'",
      ].join('\n') + '\n',
    )
    const out = caseCount(root, 'src/m.ts')
    expect(out.count).toBe(0)
    expect(out.hints.join('\n')).not.toContain(CASE_HINT)
  })

  it('keeps the zero-importer and incomplete-graph hints alongside the new one', () => {
    write('src/widget.ts', 'export const w = 1\n')
    write('src/a.ts', "import { w } from './Widget'\nimport { g } from './gone.js'\n")
    const out = walkReverseDeps({ projectRoot: root, seedPaths: ['src/widget.ts'] })
    expect(out.stats.case_inexact_specifiers).toBe(1)
    expect(out.hints.some((h) => h.includes('resolved to nothing, so this import graph is INCOMPLETE'))).toBe(true)
    expect(out.hints.some((h) => h.includes(CASE_HINT))).toBe(true)
  })

  it('names five examples and counts the rest', () => {
    write('src/widget.ts', 'export const w = 1\n')
    for (let i = 0; i < 7; i++) write(`src/a${i}.ts`, "import { w } from './Widget'\n")
    const out = caseCount(root, 'src/widget.ts')
    expect(out.count).toBe(7)
    expect(out.hints.join('\n')).toContain(', and 2 more.')
  })
})

describe('V adjustment 11 — every declared path lists every importer it reaches', () => {
  beforeEach(() => {
    write('src/a.ts', 'export const a = 1\n')
    write('src/b.ts', 'export const b = 1\n')
    write('src/c.ts', 'export const c = 1\n')
    write('src/x.ts', "import { a } from './a'\nimport { b } from './b'\nimport { c } from './c'\n")
    write('src/y.ts', "import { b } from './b'\n")
  })

  it('lists a shared importer under each declared path, and leaves the shared walk as it was', () => {
    const out = walkReverseDeps({ projectRoot: root, seedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] })
    expect(out.discovered.map((d) => `${d.file}<-${d.via_paths[0]}`)).toEqual(['src/x.ts<-src/a.ts', 'src/y.ts<-src/b.ts'])
    expect(out.by_seed.map((s) => [s.seed, s.importers.map((i) => i.file)])).toEqual([
      ['src/a.ts', ['src/x.ts']],
      ['src/b.ts', ['src/x.ts', 'src/y.ts']],
      ['src/c.ts', ['src/x.ts']],
    ])
  })

  it('V gives the full list to each finding and adds the path that had none at the end, every earlier id unchanged', () => {
    const walk = walkReverseDeps({ projectRoot: root, seedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] })
    const input = { projectRoot: root, declaredPaths: walk.declared, discoveredImporters: walk.discovered, specTier: 'complex' as const }
    const before = runVerificationChecklist(input)
    const after = runVerificationChecklist({ ...input, importersBySeed: walk.by_seed })
    expect(after.findings.slice(0, before.findings.length).map((f) => f.id)).toEqual(before.findings.map((f) => f.id))
    expect(after.findings).toHaveLength(before.findings.length + 1)
    expect(after.findings.find((f) => f.affected_paths[0] === 'src/b.ts')?.title).toBe('Edits to src/b.ts affect 2 importer(s) (2 direct, 0 transitive)')
    expect(after.findings.at(-1)).toMatchObject({
      source: 'reverse-dep-walk',
      title: 'Edits to src/c.ts affect 1 importer(s) (1 direct, 0 transitive)',
      affected_paths: ['src/c.ts', 'src/x.ts'],
    })
  })

  it('the V start passes the full lists on and records the case count in its output and audit entry', async () => {
    write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    write('src/widget.ts', 'export const w = 1\n')
    write('src/w.ts', "import { w } from './Widget'\n")
    const out = await phaseVerificationStartHandler({
      project_root: root,
      spec_ref: 'feat-blast',
      declared_paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      spec_tier: 'standard',
    })
    expect(out.findings?.map((f) => f.title)).toContain('Edits to src/c.ts affect 1 importer(s) (1 direct, 0 transitive)')
    expect(out.walk_stats?.case_inexact_specifiers).toBe(1)
    const start = readFileSync(join(root, '.rsct/audit.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === 'verification.start')
    expect(start?.case_inexact_specifiers).toBe(1)
  })

  it('the coverage hint calls a declared path reached through a shared importer found, not unavailable', () => {
    write('src/data.json', '{}\n')
    write('src/z.ts', "import { a } from './a'\nimport d from './data.json'\n")
    const out = walkReverseDeps({ projectRoot: root, seedPaths: ['src/a.ts', 'src/data.json'] })
    const hint = coverageHints(out).join('\n')
    expect(hint).toContain('Importers of src/data.json were still found')
    expect(hint).not.toContain('UNAVAILABLE')
  })
})

const IMPACT = 'documentation/impact'

function impactDoc(line: string | null): string {
  return ['# Impact: billing', '', ...(line === null ? [] : [line]), '', '## Non-obvious couplings', '', '- the nightly job reads the ledger', ''].join('\n')
}

function checklist(declaredPaths: string[], specTier: 'trivial' | 'small' | 'standard' | 'complex' = 'complex', projectRoot = root) {
  return runVerificationChecklist({ projectRoot, declaredPaths, discoveredImporters: [], specTier })
}

describe('8.3 — impact docs bound to code, read at HEAD and in the working tree', () => {
  beforeEach(() => {
    initSweepRepo(root)
    write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    write('src/billing/invoice.ts', 'export const i = 1\n')
    write('src/billing/tax.ts', 'export const t = 1\n')
    write('src/orders.ts', 'export const o = 1\n')
  })

  it('a doc bound by its "Applies to" line raises its own finding, last, every earlier id unchanged', () => {
    write(`${IMPACT}/billing.md`, impactDoc(null))
    commitAll(root, 'docs')
    const unbound = checklist(['src/billing/invoice.ts'])
    write(`${IMPACT}/billing.md`, impactDoc('**Applies to**: `src/billing/**`'))
    commitAll(root, 'bind')
    const bound = checklist(['src/billing/invoice.ts'])
    expect(bound.findings.slice(0, -1).map((f) => f.id)).toEqual(unbound.findings.map((f) => f.id))
    expect(bound.findings.at(-1)).toMatchObject({
      category: 'breakage',
      severity: 'address-now',
      source: 'impact-doc',
      title: `Impact doc bound to the declared paths: ${IMPACT}/billing.md`,
      affected_paths: ['src/billing/invoice.ts', `${IMPACT}/billing.md`],
      evidence: { kind: 'reported', source: `${IMPACT}/billing.md`, verified_against: 'working_tree' },
    })
    expect(bound.findings.at(-1)?.detail).toContain('- src/billing/invoice.ts ("Applies to" src/billing/**)')
    expect(bound.stats.impact_docs_consulted).toBe(1)
  })

  it('a declared folder reaches the doc through the files under it', () => {
    write(`${IMPACT}/ledger.md`, impactDoc('**Applies to**: src/billing/tax.ts'))
    const r = checklist(['src/billing'])
    expect(r.findings.at(-1)?.affected_paths).toEqual(['src/billing/tax.ts', `${IMPACT}/ledger.md`])
  })

  it('the file-name rule is untouched and the same doc is not raised twice', () => {
    write(`${IMPACT}/invoice.md`, impactDoc('**Applies to**: src/billing/**'))
    const r = checklist(['src/billing/invoice.ts'])
    const impact = r.findings.filter((f) => f.source === 'impact-doc')
    expect(impact.map((f) => f.title)).toEqual(['Impact doc exists for invoice'])
  })

  it('a doc removed with git rm, or only from the disk, still raises its finding from HEAD', () => {
    write(`${IMPACT}/orders.md`, impactDoc(null))
    const head = commitAll(root, 'docs')
    git(root, 'rm', '-q', `${IMPACT}/orders.md`)
    const removed = checklist(['src/orders.ts'])
    expect(removed.findings.at(-1)).toMatchObject({
      source: 'impact-doc',
      title: `Impact doc bound to the declared paths: ${IMPACT}/orders.md (deleted in the working tree)`,
      evidence: { kind: 'reported', verified_against: 'commit', commit_sha: head },
    })
    expect(removed.findings.at(-1)?.detail).toContain('- src/orders.ts (the same file name)')
    git(root, 'reset', '-q', '--', `${IMPACT}/orders.md`)
    expect(existsSync(join(root, IMPACT, 'orders.md'))).toBe(false)
    expect(checklist(['src/orders.ts']).findings.at(-1)?.title).toBe(`Impact doc bound to the declared paths: ${IMPACT}/orders.md (deleted in the working tree)`)
  })

  it('a rename that only changes letter case does not hide the file-name finding', () => {
    write(`${IMPACT}/orders.md`, impactDoc(null))
    commitAll(root, 'docs')
    unlinkSync(join(root, IMPACT, 'orders.md'))
    write(`${IMPACT}/Orders.md`, impactDoc(null))
    const r = checklist(['src/orders.ts'])
    expect(r.findings.map((f) => f.title)).toContain(`Impact doc bound to the declared paths: ${IMPACT}/orders.md (deleted in the working tree)`)
  })

  it('a line removed in the working tree still binds from HEAD, and a new doc is marked as added', () => {
    write(`${IMPACT}/billing.md`, impactDoc('**Applies to**: src/billing/**'))
    commitAll(root, 'docs')
    write(`${IMPACT}/billing.md`, impactDoc(null))
    write(`${IMPACT}/ledger.md`, impactDoc('**Applies to**: src/billing/tax.ts'))
    const r = checklist(['src/billing/tax.ts'])
    expect(r.findings.slice(-2).map((f) => f.title)).toEqual([
      `Impact doc bound to the declared paths: ${IMPACT}/billing.md (line removed or changed since HEAD)`,
      `Impact doc bound to the declared paths: ${IMPACT}/ledger.md (added since HEAD)`,
    ])
  })

  it('orders the new findings by doc path in code-unit order, after the decision-scope finding', () => {
    write('documentation/decisions.md', `# d\n\n## Firm premises (non-negotiable)\n\n### #1 ${c(0x2014)} Cents\n**Applies to**: src/billing/**\nAmounts are cents.\n`)
    write(`${IMPACT}/billing.md`, impactDoc('**Applies to**: src/billing/**'))
    write(`${IMPACT}/Zeta.md`, impactDoc('**Applies to**: src/billing/**'))
    const r = checklist(['src/billing/tax.ts'])
    expect(r.findings.slice(-3).map((f) => f.source)).toEqual(['decision-scope', 'impact-doc', 'impact-doc'])
    expect(r.findings.slice(-2).map((f) => f.title.split(': ')[1])).toEqual([`${IMPACT}/Zeta.md`, `${IMPACT}/billing.md`])
  })

  it('README.md is not a doc, and bad lines or unmatched globs are hints, never findings', () => {
    write(`${IMPACT}/readme.MD`, impactDoc('**Applies to**: src/**'))
    write(`${IMPACT}/billing.md`, impactDoc('**Applies to**: src/nowhere/**, src/billing/**\n**Applies to**: two words'))
    const r = checklist(['src/billing/tax.ts'])
    expect(readImpactCorpus(root, openSweepRepo(root)).docs.map((d) => d.path)).toEqual([`${IMPACT}/billing.md`])
    const hint = r.hints.find((h) => h.startsWith(`"Applies to" problems in ${IMPACT}`)) ?? ''
    expect(hint).toContain(`${IMPACT}/billing.md: src/nowhere/** matches no file`)
    expect(hint).toContain(`${IMPACT}/billing.md: "two words" binds nothing`)
    expect(hint).toContain('the impact doc is still matched by its file name')
    expect(hint).not.toContain('still applies everywhere')
    expect(r.findings.filter((f) => f.source === 'impact-doc')).toHaveLength(1)
  })

  it('a doc, or the impact folder, that is a link at HEAD makes the HEAD side unreadable', () => {
    write(`${IMPACT}/billing.md`, impactDoc(null))
    commitAll(root, 'docs')
    const fileLink = gitInput(root, '../real.md', 'hash-object', '-w', '--stdin').trim()
    git(root, 'update-index', '--add', '--cacheinfo', `120000,${fileLink},${IMPACT}/orders.md`)
    git(root, 'commit', '-qm', 'link doc')
    expect(readImpactCorpus(root, openSweepRepo(root))).toMatchObject({ head: 'unreadable', head_notes: [`${IMPACT}/orders.md`] })
    expect(checklist(['src/billing/tax.ts']).hints).toContain(`${c(0x26a0)} ${IMPACT}/orders.md could not be read at HEAD: those impact docs come from the working tree only.`)
    git(root, 'rm', '-rq', '--cached', 'documentation')
    const folderLink = gitInput(root, 'real', 'hash-object', '-w', '--stdin').trim()
    git(root, 'update-index', '--add', '--cacheinfo', `120000,${folderLink},documentation`)
    git(root, 'commit', '-qm', 'link folder')
    expect(readImpactCorpus(root, openSweepRepo(root))).toMatchObject({ head: 'unreadable', head_notes: [IMPACT] })
  })

  it('a project in a subfolder reads HEAD under its prefix', () => {
    const web = join(root, 'apps', 'web')
    write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'web', org: 'o' } }), web)
    write('src/orders.ts', 'x\n', web)
    write(`${IMPACT}/orders.md`, impactDoc(null), web)
    commitAll(root, 'web')
    unlinkSync(join(web, IMPACT, 'orders.md'))
    expect(checklist(['src/orders.ts'], 'complex', web).findings.at(-1)?.title).toBe(
      `Impact doc bound to the declared paths: ${IMPACT}/orders.md (deleted in the working tree)`,
    )
  })

  it('trivial and small tiers get none', () => {
    write(`${IMPACT}/billing.md`, impactDoc('**Applies to**: src/billing/**'))
    expect(checklist(['src/billing/tax.ts'], 'small').findings).toEqual([])
  })
})

describe('8.3 — without git', () => {
  it('reads the working tree only and marks nothing', () => {
    write('src/billing/tax.ts', 'x\n')
    write(`${IMPACT}/billing.md`, impactDoc('**Applies to**: src/billing/**'))
    const corpus = readImpactCorpus(root, null)
    expect(corpus.head).toBe('no_git')
    expect(checklist(['src/billing/tax.ts']).findings.at(-1)?.title).toBe(`Impact doc bound to the declared paths: ${IMPACT}/billing.md`)
  })
})

describe('8.4 — rsct_get_topology lists importers and impact docs outside a phase', () => {
  beforeEach(() => {
    write('src/a.ts', 'export const a = 1\n')
    write('src/b.ts', 'export const b = 1\n')
    write('src/x.ts', "import { a } from './a'\nimport { b } from './b'\n")
    write('src/billing/tax.ts', 'export const t = 1\n')
    write(`${IMPACT}/ledger.md`, impactDoc('**Applies to**: src/billing/*.ts'))
    write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
  })

  it('without impact the fields are unchanged and the hint names the flag', async () => {
    const out = await getTopologyHandler({ project_root: root, paths: ['src/a.ts'] })
    expect(out.paths_impact).toBeUndefined()
    expect(out.hints).toContain('Pass impact: true to also list the files that import these paths and the impact docs bound to them.')
    expect(out.hints.join('\n')).not.toContain('stay in the V phase')
    const asked = await getTopologyHandler({ project_root: root, paths: ['src/a.ts'], impact: true })
    expect(asked.hints.join('\n')).not.toContain('Pass impact: true')
  })

  it('with impact: importers per file, shared ones under each, and the impact docs of files and folders', async () => {
    const out = await getTopologyHandler({ project_root: root, paths: ['src/a.ts', 'src/b.ts', 'src/billing'], impact: true })
    expect(out.paths_impact?.importers).toEqual([
      { path: 'src/a.ts', count: 1, direct: 1, listed: [{ file: 'src/x.ts', depth: 1 }] },
      { path: 'src/b.ts', count: 1, direct: 1, listed: [{ file: 'src/x.ts', depth: 1 }] },
    ])
    expect(out.paths_impact?.walk_coverage).toBe('analyzed')
    expect(out.paths_impact?.truncated).toBe(false)
    expect(out.paths_impact?.impact_docs).toEqual([
      { doc: `${IMPACT}/ledger.md`, mark: '', matches: [{ path: 'src/billing/tax.ts', via: '"Applies to" src/billing/*.ts' }] },
    ])
    expect(out.paths_impact?.hints).toContain('Importers are listed per file; the 1 folder(s) given were used only to match impact docs.')
    expect(out.hints.join('\n')).toContain('paths_impact: 2 importer(s) across 2 file(s); 1 impact doc(s) bound to the paths. Walk coverage: analyzed.')
  })

  it('impact without paths runs no walk and says why', async () => {
    const out = await getTopologyHandler({ project_root: root, impact: true })
    expect(out.paths_impact).toBeUndefined()
    expect(out.hints).toContain('impact: true needs paths: pass the files you plan to change. No import walk ran.')
  })

  it('lists ten importers per file and two hundred in total, and counts the rest', async () => {
    const seeds: string[] = []
    for (let s = 0; s < 25; s++) {
      write(`big/t${s}.ts`, `export const t${s} = ${s}\n`)
      seeds.push(`big/t${s}.ts`)
    }
    for (let i = 0; i < 11; i++) {
      write(`big/i${i}.ts`, seeds.map((_, s) => `import { t${s} } from './t${s}'`).join('\n') + '\n')
    }
    const out = await getTopologyHandler({ project_root: root, paths: seeds, impact: true })
    const impact = out.paths_impact!
    expect(impact.importers.every((entry) => entry.count === 11)).toBe(true)
    expect(impact.importers.reduce((sum, entry) => sum + entry.listed.length, 0)).toBe(200)
    expect(impact.importers[0]?.listed).toHaveLength(10)
    expect(impact.importers.at(-1)?.listed).toHaveLength(0)
    expect(impact.truncated).toBe(true)
  })

  it('writes nothing in the project', async () => {
    const before = readdirSync(root, { recursive: true }).map(String).sort()
    await getTopologyHandler({ project_root: root, paths: ['src/a.ts'], impact: true })
    expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before)
  })
})
