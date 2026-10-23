import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadPromptBlocks, repoRoot } from './lib/bash-lint.js'
import { LOCAL_ANCHORS, SHARED_ANCHORS } from '../../src/lib/repo-anchor.js'

const ROOT = repoRoot(__dirname)
const S = String.fromCharCode(167)
const prompt = (name: string) => readFileSync(join(ROOT, 'prompts', name), 'utf8').replace(/\r/g, '')
const UNINSTALL = prompt('03-uninstall.md')
const EXAMPLES = new Set(['Phase X.Y executing canonical bash', 'Phase X.Y executing'])

function checkpoints(name: string): string[] {
  const found: string[] = []
  for (const b of loadPromptBlocks(ROOT).filter((x) => x.source === name)) {
    for (const m of b.code.matchAll(/echo "  CHECKPOINT: ([^"]+)"/g)) if (!EXAMPLES.has(m[1]!)) found.push(m[1]!)
  }
  return found
}

interface Row { artefact: string; writtenBy: string; disposition: string; block: string; proof: string; label: string }

const ROWS: Row[] = (() => {
  const start = UNINSTALL.indexOf('### Artefact inventory')
  const end = UNINSTALL.indexOf('\n---\n', start)
  return UNINSTALL.slice(start, end).split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Artefact |'))
    .map((l) => {
      const cells = l.slice(1, -1).split(' | ').map((c) => c.trim())
      expect(cells, l).toHaveLength(6)
      const bare = cells.map((c) => (c.startsWith('`') && c.endsWith('`') && c.split('`').length === 3 ? c.slice(1, -1) : c))
      return { artefact: bare[0]!, writtenBy: bare[1]!, disposition: bare[2]!, block: bare[3]!, proof: bare[4]!, label: bare[5]! }
    })
})()

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [])
}
const SERVER_SOURCE = sourceFiles(join(ROOT, 'mcp-server', 'src')).map((f) => readFileSync(f, 'utf8')).join('\n')

function reportText(): string {
  const phase3 = UNINSTALL.slice(UNINSTALL.indexOf('## Phase 3'), UNINSTALL.indexOf('## Phase 4'))
  const phase6 = UNINSTALL.slice(UNINSTALL.indexOf('## Phase 6'), UNINSTALL.indexOf('## Idempotency note'))
  const kept = UNINSTALL.slice(UNINSTALL.indexOf('**Category K'), UNINSTALL.indexOf('### Artefact inventory'))
  return `${phase3}\n${phase6}\n${kept}`
}

describe('the uninstall artefact inventory', () => {
  it('has rows to check', () => {
    expect(ROWS.length).toBeGreaterThan(40)
  })

  it('every CHECKPOINT block of the setup prompts has a row', () => {
    for (const name of ['01-setup.md', '02-canonical-source.md']) {
      const cps = checkpoints(name)
      expect(cps.length, name).toBeGreaterThan(5)
      for (const cp of cps) expect(ROWS.some((r) => r.writtenBy === `${name}: ${cp}`), `${name}: ${cp}`).toBe(true)
    }
  })

  it('every row names a writer that exists', () => {
    const known = {
      '01-setup.md': new Set(checkpoints('01-setup.md')),
      '02-canonical-source.md': new Set(checkpoints('02-canonical-source.md')),
    }
    for (const r of ROWS) {
      const [who, ...rest] = r.writtenBy.split(': ')
      const what = rest.join(': ')
      if (who === 'rsct-mcp') expect(SERVER_SOURCE, r.writtenBy).toMatch(new RegExp(`function ${what}\\b`))
      else expect(known[who as keyof typeof known]?.has(what), r.writtenBy).toBe(true)
    }
  })

  it('every row names an uninstall block, a test and a report label that exist', () => {
    const uninstallCheckpoints = new Set(checkpoints('03-uninstall.md'))
    const report = reportText()
    for (const r of ROWS) {
      if (r.block.startsWith('agent step ')) {
        const id = r.block.slice('agent step '.length)
        expect(UNINSTALL.includes(`### ${id} `) || UNINSTALL.includes(`**${id} `), r.block).toBe(true)
      } else if (r.block !== 'none') {
        expect(uninstallCheckpoints.has(r.block), r.block).toBe(true)
      }
      if (r.proof !== 'none') expect(existsSync(join(ROOT, 'mcp-server', 'tests', r.proof)), r.proof).toBe(true)
      if (r.artefact === 'read-only') {
        expect(r.disposition, r.writtenBy).toBe('read-only')
        expect(r.label, r.writtenBy).toBe('-')
      } else {
        expect(r.disposition, r.artefact).not.toBe('read-only')
        expect(report, `label "${r.label}" of ${r.artefact}`).toContain(r.label)
      }
    }
  })

  it('every file the server writes under .rsct/ has a row', () => {
    for (const name of [...SHARED_ANCHORS, ...LOCAL_ANCHORS, '.gitignore']) {
      expect(ROWS.some((r) => r.artefact.includes(`.rsct/${name}`)), name).toBe(true)
    }
  })
})

describe('the lists the uninstall shares with setup and the server agree', () => {
  it('the default sections to remove are the sections setup reconciles', () => {
    const setup = prompt('01-setup.md')
    const rules = setup.slice(setup.indexOf('SECTION_RULES="'), setup.indexOf('"', setup.indexOf('SECTION_RULES="') + 15))
    const ids = [...rules.matchAll(/^(?:SECTION_RULES=")?([0A-Z])[|]/gm)].map((m) => m[1]).sort()
    const fallback = (UNINSTALL.match(/SECTIONS_TO_REMOVE="\$\{SECTIONS_TO_REMOVE:-([^}]+)\}"/) ?? [])[1]!.split(' ').sort()
    expect(ids).toEqual(['0', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'])
    expect(fallback).toEqual(ids)
  })

  it('every section id list in setup and uninstall is the list setup reconciles', () => {
    const setup = prompt('01-setup.md')
    const start = setup.indexOf('SECTION_RULES="')
    const ids = [...setup.slice(start, setup.indexOf('"', start + 15)).matchAll(/^(?:SECTION_RULES=")?([0A-Z])[|]/gm)].map((m) => m[1]!)
    const arrays = [...`${setup}\n${UNINSTALL}`.matchAll(/var ids = \[([^\]]*)\];/g)].map((m) => m[1]!.split(',').map((x) => x.trim().replace(/"/g, '')))
    expect(arrays).toHaveLength(3)
    for (const list of arrays) expect(list).toEqual(ids)
    const scan = (UNINSTALL.match(/^for SECTION in ([0A-Z ]+); do$/m) ?? [])[1]!.split(' ')
    expect(scan).toEqual(ids)
    const order = (setup.match(/var order = \[([^\]]*)\];/) ?? [])[1]!.split(',').map((x) => x.trim().replace(/"/g, ''))
    expect([...order].sort()).toEqual([...ids].sort())
    const fileOf = (id: string) => (setup.match(new RegExp(`^(?:SECTION_RULES=")?${id}[|]([^"\\s]+)`, 'm')) ?? [])[1] ?? 'missing'
    for (const id of ids) expect(existsSync(join(ROOT, 'rules', fileOf(id))), id).toBe(true)
  })

  it('the .gitignore block of setup ignores the state files the server writes, except the temporary file of the store and the scripts folder', () => {
    const install = loadPromptBlocks(ROOT).find((b) => b.source === '01-setup.md' && b.code.includes('CHECKPOINT: Phase 4.4b executing canonical .gitignore RSCT block install'))!
    const ignored = [...install.code.matchAll(/^\.rsct\/(\S+)$/gm)].map((m) => m[1]).sort()
    const expected = [...SHARED_ANCHORS, ...LOCAL_ANCHORS].filter((n) => n !== 'approvals-seen.json.tmp' && n !== 'scripts').sort()
    expect(ignored).toEqual(expected)
  })

  it('the ignore file the uninstall writes and removes has the bytes the server writes', () => {
    const shell = ['audit.log', 'approvals-seen.json', 'approvals-seen.json.tmp', 'reports/', '.gitignore']
    const protect = loadPromptBlocks(ROOT).find((b) => b.source === '03-uninstall.md' && b.code.includes('CHECKPOINT: Phase 4.V.c protecting a kept audit log from git'))!
    const prune = loadPromptBlocks(ROOT).find((b) => b.source === '03-uninstall.md' && b.code.includes('CHECKPOINT: Phase 4.7 pruning'))!
    const listed = `printf '%s\\n' ${shell.join(' ')}`
    expect(protect.code).toContain(listed)
    expect(prune.code).toContain(listed)
    expect([...SHARED_ANCHORS, '.gitignore']).toEqual(shell)
  })

  it('the pointer hash in the uninstall is the hash of the pointer setup writes', () => {
    const lines = readFileSync(join(ROOT, 'doc-templates', 'CLAUDE.md.template'), 'utf8').replace(/\r/g, '').split('\n')
    const a = lines.findIndex((l) => l.startsWith('<!-- RSCT-CONVENTIONS-REF'))
    const b = lines.findIndex((l) => l.startsWith('<!-- /RSCT-CONVENTIONS-REF'))
    const sha = createHash('sha256').update(lines.slice(a + 1, b).join('\n'), 'utf8').digest('hex')
    const users = loadPromptBlocks(ROOT).filter((x) => x.source === '03-uninstall.md' && x.code.includes('RSCT-CONVENTIONS-REF'))
    expect(users.length).toBeGreaterThanOrEqual(2)
    for (const u of users) expect(u.code).toContain(sha)
    expect(lines.slice(a + 1, b).join('\n')).toContain(`See ${S}B (plan)`)
  })
})
