import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { bashAvailable, repoRoot } from './lib/bash-lint.js'
import { nodeAvailable, assertNodePolicy } from './lib/block-harness.js'
import { runBlocks, chainDir, cleanChains, type BlockOutcome } from './lib/chain-harness.js'

const ROOT = repoRoot(__dirname)
const BASH = bashAvailable()
const NODE = nodeAvailable()
const S = String.fromCharCode(167)
const BOM = String.fromCharCode(0xfeff)
const PROMPT = '01-setup.md'
const SWITCH = 'Phase 4.4c executing canonical conduct-rules switch'
const RECONCILE = 'Phase 4.3b executing canonical rule-section reconciliation'
const CONDUCT = ['I', 'J', 'K', 'L', 'M']
const BASE = ['0', 'B', 'A', 'C', 'D', 'E', 'F', 'G', 'H']
const RULE_FILES = readdirSync(join(ROOT, 'rules')).filter((f) => f.endsWith('.md'))

const ruleFile = (id: string): string => RULE_FILES.find((f) => f.startsWith(`${id}-`))!
const rule = (id: string): string => readFileSync(join(ROOT, 'rules', ruleFile(id)), 'utf8')
const canon = (t: string): string => t.replace(/\r/g, '').replace(/\n+$/, '')
const sha = (t: string): string => createHash('sha256').update(`${canon(t)}\n`).digest('hex')

function section(id: string, body: string): string[] {
  return [
    `<!-- RSCT-${S}${id}-BEGIN v=1.0.0 source=inserted sha256-body=${sha(body)} -->`,
    ...canon(body).split('\n'),
    `<!-- RSCT-${S}${id}-END -->`,
  ]
}

function claudeMd(ids: string[] = BASE): string {
  const lines = ['# CLAUDE.md', '', 'dev prose before', '']
  for (const id of ids) lines.push(...section(id, rule(id)), '')
  lines.push('dev prose after', '')
  return lines.join('\n')
}

const CONFIG = '{\n  "app": { "name": "demo" }\n}\n'

function project(files: { claude?: string; config?: string } = {}): string {
  const dir = chainDir()
  mkdirSync(join(dir, '.rsct', 'rules'), { recursive: true })
  for (const f of RULE_FILES) writeFileSync(join(dir, '.rsct', 'rules', f), readFileSync(join(ROOT, 'rules', f), 'utf8'))
  writeFileSync(join(dir, 'CLAUDE.md'), files.claude ?? claudeMd())
  writeFileSync(join(dir, '.rsct.json'), files.config ?? CONFIG)
  return dir
}

function toggle(dir: string, env: Record<string, string> = {}): BlockOutcome {
  return runBlocks(ROOT, [{ prompt: PROMPT, anchor: SWITCH, env: { CONDUCT_APPLY: '1', ...env } }], { dir }).last
}

function reconcile(dir: string): BlockOutcome {
  return runBlocks(ROOT, [{ prompt: PROMPT, anchor: RECONCILE }], { dir }).last
}

const readClaude = (dir: string): string => readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
const readConfig = (dir: string): string => readFileSync(join(dir, '.rsct.json'), 'utf8')
const offList = (dir: string): unknown => {
  const raw = readConfig(dir)
  return JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw).conduct_rules_off
}
const begins = (text: string): string[] =>
  text.split(/\r?\n/).filter((l) => l.startsWith(`<!-- RSCT-${S}`) && l.includes('-BEGIN')).map((l) => l.charAt(10 + S.length))
const present = (text: string): string[] => CONDUCT.filter((id) => begins(text).includes(id))

function unchanged(dir: string, claude: string, config: string): void {
  expect(readClaude(dir)).toBe(claude)
  expect(readConfig(dir)).toBe(config)
}

const canSymlink = (() => {
  const dir = chainDir()
  try {
    writeFileSync(join(dir, 't'), 'x')
    symlinkSync(join(dir, 't'), join(dir, 'l'))
    return lstatSync(join(dir, 'l')).isSymbolicLink()
  } catch {
    return false
  }
})()

afterEach(() => cleanChains())

describe.skipIf(!BASH || !NODE)('Phase 4.4c conduct-rules switch (01-setup, #129)', () => {
  assertNodePolicy(!!process.env.RSCT_REQUIRE_BASH, NODE)

  it('without CONDUCT_APPLY it only reports, and changes nothing', () => {
    const dir = project()
    const r = toggle(dir, { CONDUCT_APPLY: '0' })
    expect(r.out).toMatch(/dry run/)
    expect(r.out).toContain(`${S}I: on — will be added`)
    unchanged(dir, claudeMd(), CONFIG)
  }, 60_000)

  it('a project without the key gets the five sections after §H, in order, and records []', () => {
    const dir = project()
    const r = toggle(dir)
    expect(r.out).toMatch(/OK: conduct rules switched/)
    const text = readClaude(dir)
    expect(begins(text)).toEqual([...BASE, ...CONDUCT])
    expect(text.startsWith('# CLAUDE.md\n\ndev prose before\n')).toBe(true)
    expect(text.endsWith('\ndev prose after\n')).toBe(true)
    expect(offList(dir)).toEqual([])
    expect(readConfig(dir)).toContain('"app": { "name": "demo" }')
  }, 60_000)

  it('4.3b reads what it wrote as up to date, and updates it when the shipped rule changes', () => {
    const dir = project()
    toggle(dir)
    const first = reconcile(dir)
    for (const id of CONDUCT) expect(first.out).toMatch(new RegExp(`SKIP\\s+${S}${id}`))
    writeFileSync(join(dir, '.rsct', 'rules', ruleFile('I')), `${rule('I')}\nOne more line.\n`)
    const second = reconcile(dir)
    expect(second.out).toMatch(new RegExp(`UPDATE\\s+${S}I`))
    expect(readClaude(dir)).toContain('One more line.')
  }, 90_000)

  it('switching off removes the sections, a rerun changes nothing, and switching back on restores the same bytes', () => {
    const dir = project()
    toggle(dir)
    const allOn = readClaude(dir)
    const off = toggle(dir, { CONDUCT_RULES_OFF: 'j,m' })
    expect(off.out).toMatch(/\[\] -> \[J M\]/)
    expect(off.out).toMatch(/OK: conduct rules switched/)
    expect(off.out).not.toContain('edited after install')
    expect(present(readClaude(dir))).toEqual(['I', 'K', 'L'])
    expect(readConfig(dir)).toBe('{\n  "conduct_rules_off": ["J", "M"],\n  "app": { "name": "demo" }\n}\n')
    const offText = readClaude(dir)
    const offConfig = readConfig(dir)
    const again = toggle(dir, { CONDUCT_RULES_OFF: 'M J' })
    expect(again.out).toContain(`⏸ ${S}J: off`)
    expect(again.out).toMatch(/OK: nothing to change — off: \[J M\]/)
    unchanged(dir, offText, offConfig)
    toggle(dir)
    unchanged(dir, offText, offConfig)
    toggle(dir, { CONDUCT_RULES_OFF: 'none' })
    expect(readClaude(dir)).toBe(allOn)
    expect(offList(dir)).toEqual([])
  }, 120_000)

  it('an id outside I–M stops the block and changes nothing, so the switch never removes §0 or §A–§H', () => {
    for (const ask of ['A', '0', 'H J', 'none J', 'keep I', 'I X']) {
      const dir = project()
      const r = toggle(dir, { CONDUCT_RULES_OFF: ask })
      expect(r.out, ask).toMatch(/STOP: .* is not a conduct rule/)
      unchanged(dir, claudeMd(), CONFIG)
    }
  }, 120_000)

  it('a stored value that is not a list of I–M ids, or a .rsct.json that is not JSON, stops the block and changes nothing', () => {
    for (const config of [
      '{ "conduct_rules_off": ["A"] }\n',
      '{ "conduct_rules_off": ["j"] }\n',
      '{ "conduct_rules_off": "J" }\n',
      '{ "conduct_rules_off": ["J", 1] }\n',
      '{ "conduct_rules_off": ["J"],\n',
    ]) {
      const dir = project({ config })
      const r = toggle(dir)
      expect(r.out, config).toMatch(/STOP: invalid: /)
      unchanged(dir, claudeMd(), config)
    }
  }, 120_000)

  it('a stored list spread over several lines is read as that list, never as all on', () => {
    const config = '{\n  "conduct_rules_off": [\n    "J"\n  ],\n  "app": { "name": "demo" }\n}\n'
    const dir = project({ config })
    toggle(dir)
    expect(present(readClaude(dir))).toEqual(['I', 'K', 'L', 'M'])
    expect(readConfig(dir)).toBe(config)
  }, 60_000)

  it('a second conduct_rules_off key stops it before CLAUDE.md is touched', () => {
    const config = '{ "conduct_rules_off": ["J"], "conduct_rules_off": ["K"] }\n'
    const dir = project({ config })
    const r = toggle(dir, { CONDUCT_RULES_OFF: 'J' })
    expect(r.out).toMatch(/STOP: .rsct.json cannot take the new list \(the value read back is not the one written/)
    unchanged(dir, claudeMd(), config)
  }, 60_000)

  it('malformed RSCT markers stop it before any write, and the key is not recorded', () => {
    const doubled = claudeMd().replace(`<!-- RSCT-${S}C-END -->\n`, `<!-- RSCT-${S}C-END -->\n<!-- RSCT-${S}C-BEGIN v=1.0.0 source=inserted -->\nx\n<!-- RSCT-${S}C-END -->\n`)
    const open = `${claudeMd()}<!-- RSCT-${S}J-BEGIN v=1.0.0 source=inserted -->\nnever closed\n`
    for (const claude of [doubled, open]) {
      const dir = project({ claude })
      const r = toggle(dir)
      expect(r.out).toMatch(/STOP: RSCT section markers in CLAUDE.md are malformed/)
      unchanged(dir, claude, CONFIG)
    }
  }, 90_000)

  it('a CRLF CLAUDE.md with a byte-order mark keeps both, in and out', () => {
    const claude = BOM + claudeMd().replace(/\n/g, '\r\n')
    const dir = project({ claude })
    toggle(dir)
    const on = readClaude(dir)
    expect(on.startsWith(BOM)).toBe(true)
    expect(on.replace(/\r\n/g, '')).not.toContain('\n')
    expect(present(on)).toEqual(CONDUCT)
    expect(reconcile(dir).out).toMatch(new RegExp(`SKIP\\s+${S}M`))
    toggle(dir, { CONDUCT_RULES_OFF: 'none' })
    toggle(dir, { CONDUCT_RULES_OFF: 'K' })
    toggle(dir, { CONDUCT_RULES_OFF: 'none' })
    expect(readClaude(dir)).toBe(on)
  }, 120_000)

  it('a line ending in LF inside a CRLF file never carries the developer text away with a section', () => {
    const dir = project({ claude: claudeMd().replace(/\n/g, '\r\n') })
    toggle(dir)
    const endM = `<!-- RSCT-${S}M-END -->\r\n`
    const mixed = readClaude(dir).replace(endM, `<!-- RSCT-${S}M-END -->\n\nTeam notes\nDeploy only on Fridays.\n`)
    writeFileSync(join(dir, 'CLAUDE.md'), mixed)
    const r = toggle(dir, { CONDUCT_RULES_OFF: 'M' })
    expect(r.out).toMatch(/OK: conduct rules switched/)
    const text = readClaude(dir)
    expect(text).toContain('Team notes\nDeploy only on Fridays.\n')
    expect(text).toContain('dev prose after\r\n')
    expect(present(text)).toEqual(['I', 'J', 'K', 'L'])
  }, 90_000)

  it('a section written with LF inside a CRLF file is found, not added twice', () => {
    const dir = project({ claude: claudeMd().replace(/\n/g, '\r\n') })
    toggle(dir)
    const text = readClaude(dir)
    const b = text.indexOf(`<!-- RSCT-${S}I-BEGIN`)
    const e = text.indexOf(`<!-- RSCT-${S}I-END -->\r\n`) + `<!-- RSCT-${S}I-END -->\r\n`.length
    writeFileSync(join(dir, 'CLAUDE.md'), text.slice(0, b) + text.slice(b, e).replace(/\r\n/g, '\n') + text.slice(e))
    const r = toggle(dir)
    expect(r.out).toContain(`✅ ${S}I: on`)
    expect(begins(readClaude(dir)).filter((id) => id === 'I')).toHaveLength(1)
    expect(reconcile(dir).out).toMatch(new RegExp(`SKIP\\s+${S}I`))
  }, 90_000)

  it('a CLAUDE.md that ends without a newline keeps that ending through on, off and on again', () => {
    for (const eol of ['\n', '\r\n']) {
      const lines = ['# CLAUDE.md', '', ...BASE.flatMap((id) => [...section(id, rule(id)), ''])]
      lines.pop()
      const claude = lines.join(eol)
      const dir = project({ claude })
      toggle(dir)
      const on = readClaude(dir)
      expect(on.endsWith(`<!-- RSCT-${S}M-END -->`), JSON.stringify(eol)).toBe(true)
      toggle(dir, { CONDUCT_RULES_OFF: 'none' })
      toggle(dir, { CONDUCT_RULES_OFF: 'I J K L M' })
      expect(readClaude(dir), JSON.stringify(eol)).toBe(claude)
      toggle(dir, { CONDUCT_RULES_OFF: 'none' })
      expect(readClaude(dir), JSON.stringify(eol)).toBe(on)
    }
  }, 120_000)

  it('one CRLF line in an LF file does not hide the sections, and new lines follow their neighbour', () => {
    const claude = claudeMd().replace('dev prose before\n', 'dev prose before\r\n')
    const dir = project({ claude })
    const r = toggle(dir)
    expect(r.out).toMatch(/OK: conduct rules switched/)
    const text = readClaude(dir)
    expect(present(text)).toEqual(CONDUCT)
    expect(text.split('\r\n')).toHaveLength(2)
  }, 60_000)

  it('a section whose source= is the developer text stops the switch, and nothing is written', () => {
    const own = 'Our team writes answers in Portuguese and keeps them long.'
    const claude = claudeMd().replace('dev prose after\n', `<!-- RSCT-${S}J-BEGIN v=1.0.0 source=hand-merged -->\n${own}\n<!-- RSCT-${S}J-END -->\n\ndev prose after\n`)
    for (const apply of ['0', '1']) {
      const dir = project({ claude })
      const r = toggle(dir, { CONDUCT_RULES_OFF: 'J', CONDUCT_APPLY: apply })
      expect(r.out, apply).toContain(`STOP: ${S}J holds text marked as your own (source=hand-merged)`)
      unchanged(dir, claude, CONFIG)
    }
    const kept = project({ claude })
    expect(toggle(kept).out).toContain(`✅ ${S}J: on`)
    expect(begins(readClaude(kept)).filter((id) => id === 'J')).toHaveLength(1)
  }, 90_000)

  it('a section with no source= or another developer mark stops the switch too; migrated-from-ptbr is framework text', () => {
    const withSource = (src: string) =>
      claudeMd().replace('dev prose after\n', `<!-- RSCT-${S}J-BEGIN v=1.0.0${src} -->\nour own J\n<!-- RSCT-${S}J-END -->\n\ndev prose after\n`)
    for (const [src, label] of [
      ['', '<none>'],
      [' source=migrated-from-ptbr-preserved', 'migrated-from-ptbr-preserved'],
      [' source=inserted.bak', 'inserted.bak'],
      [' source=inserted source=hand-merged', 'several'],
    ]) {
      const claude = withSource(src!)
      const dir = project({ claude })
      const r = toggle(dir, { CONDUCT_RULES_OFF: 'J', CONDUCT_APPLY: '0' })
      expect(r.out, label).toContain(`STOP: ${S}J holds text marked as your own (source=${label})`)
      unchanged(dir, claude, CONFIG)
    }
    const nul = withSource(` source=inserted${String.fromCharCode(0)}`)
    const nulDir = project({ claude: nul })
    toggle(nulDir)
    const settled = readClaude(nulDir)
    const stop = toggle(nulDir, { CONDUCT_RULES_OFF: 'I J' })
    expect(stop.out).toContain(`STOP: ${S}J holds text marked as your own`)
    unchanged(nulDir, settled, '{\n  "conduct_rules_off": [],\n  "app": { "name": "demo" }\n}\n')
    const dir = project({ claude: withSource(' source=migrated-from-ptbr') })
    toggle(dir, { CONDUCT_RULES_OFF: 'J' })
    expect(readClaude(dir)).not.toContain('our own J')
    expect(present(readClaude(dir))).toEqual(['I', 'K', 'L', 'M'])
  }, 90_000)

  it('a CLAUDE.md that is not valid UTF-8 text stops the switch and 4.3b, and is left byte for byte', () => {
    const dir = project()
    toggle(dir)
    const bytes = Buffer.concat([Buffer.from(readClaude(dir), 'utf8'), Buffer.from([0x43, 0x6f, 0x72, 0x61, 0xe7, 0xe3, 0x0a])])
    writeFileSync(join(dir, 'CLAUDE.md'), bytes)
    expect(toggle(dir, { CONDUCT_RULES_OFF: 'J' }).out).toMatch(/STOP: CLAUDE.md is not valid UTF-8 text/)
    expect(readFileSync(join(dir, 'CLAUDE.md')).equals(bytes)).toBe(true)
    writeFileSync(join(dir, '.rsct', 'rules', ruleFile('I')), `${rule('I')}\nOne more line.\n`)
    const rec = reconcile(dir).out
    expect(rec).toMatch(/SKIP=13 STAMP=0 UPDATE=0/)
    expect(rec).not.toMatch(new RegExp(`(UPDATE|SKIP)\\s+${S}I\\b`))
    expect(readFileSync(join(dir, 'CLAUDE.md')).equals(bytes)).toBe(true)
  }, 90_000)

  it('4.3b updates a section this block wrote into a file with mixed line endings', () => {
    const claude = claudeMd().replace(/\n/g, '\r\n').replace(`<!-- RSCT-${S}H-END -->\r\n`, `<!-- RSCT-${S}H-END -->\n`)
    const dir = project({ claude })
    toggle(dir)
    const before = readClaude(dir)
    writeFileSync(join(dir, '.rsct', 'rules', ruleFile('I')), `${rule('I')}\nOne more line.\n`)
    const r = reconcile(dir)
    expect(r.out).toMatch(new RegExp(`UPDATE\\s+${S}I`))
    const after = readClaude(dir)
    expect(after).toContain('One more line.\n')
    const head = before.slice(0, before.indexOf(`<!-- RSCT-${S}I-BEGIN`))
    const tail = before.slice(before.indexOf(`<!-- RSCT-${S}I-END -->`))
    expect(after.startsWith(head)).toBe(true)
    expect(after.endsWith(tail)).toBe(true)
  }, 90_000)

  it('the key name written as a value elsewhere in .rsct.json is not taken for the key', () => {
    const dir = project({ config: '{\n  "note": "conduct_rules_off",\n  "app": 1\n}\n' })
    toggle(dir, { CONDUCT_RULES_OFF: 'K' })
    expect(readConfig(dir)).toBe('{\n  "conduct_rules_off": ["K"],\n  "note": "conduct_rules_off",\n  "app": 1\n}\n')
  }, 60_000)

  it('a .rsct.json written with CRLF or another indent gets the key in its own style', () => {
    const cases: Array<[string, string]> = [
      ['{\r\n  "app": { "name": "demo" }\r\n}\r\n', '{\r\n  "conduct_rules_off": [],\r\n  "app": { "name": "demo" }\r\n}\r\n'],
      ['{\n    "app": 1\n}\n', '{\n    "conduct_rules_off": [],\n    "app": 1\n}\n'],
      ['{ "app": 1 }\n', '{ "conduct_rules_off": [], "app": 1 }\n'],
    ]
    for (const [config, expected] of cases) {
      const dir = project({ config })
      toggle(dir)
      expect(readConfig(dir), config).toBe(expected)
    }
  }, 120_000)

  it('a key already in a CRLF .rsct.json is replaced in place, byte for byte', () => {
    const dir = project({ config: '{\r\n  "conduct_rules_off": ["J"],\r\n  "app": 1\r\n}\r\n' })
    toggle(dir, { CONDUCT_RULES_OFF: 'J M' })
    expect(readConfig(dir)).toBe('{\r\n  "conduct_rules_off": ["J", "M"],\r\n  "app": 1\r\n}\r\n')
  }, 60_000)

  it('a blank or comma-only CONDUCT_RULES_OFF keeps the stored list', () => {
    for (const ask of [' ', ',', ' , ']) {
      const config = '{ "conduct_rules_off": ["J"] }\n'
      const dir = project({ config })
      toggle(dir)
      const settled = readClaude(dir)
      const r = toggle(dir, { CONDUCT_RULES_OFF: ask })
      expect(r.out, JSON.stringify(ask)).toMatch(/OK: nothing to change — off: \[J\]/)
      unchanged(dir, settled, config)
    }
  }, 120_000)

  it('a marker hash left from an older release is not reported as an edit', () => {
    const stale = claudeMd().replace('dev prose after\n', `${section('J', rule('J'))[0]!.replace(/sha256-body=[a-f0-9]{64}/, `sha256-body=${'a'.repeat(64)}`)}\n${canon(rule('J'))}\n<!-- RSCT-${S}J-END -->\n\ndev prose after\n`)
    const dir = project({ claude: stale })
    const dry = toggle(dir, { CONDUCT_RULES_OFF: 'J', CONDUCT_APPLY: '0' })
    expect(dry.out).toContain(`${S}J: off — will be removed`)
    expect(dry.out).not.toContain('edited after install')
  }, 60_000)

  it('a stored list in another order is the same list, and nothing is rewritten', () => {
    const config = '{ "conduct_rules_off": ["M", "J"] }\n'
    const dir = project({ config })
    toggle(dir)
    const settled = readClaude(dir)
    const r = toggle(dir)
    expect(r.out).toMatch(/OK: nothing to change — off: \[J M\]/)
    unchanged(dir, settled, config)
  }, 90_000)

  it('a byte-order mark in .rsct.json does not stop it, and the file it writes has none, so it parses', () => {
    const dir = project({ config: BOM + CONFIG })
    toggle(dir, { CONDUCT_RULES_OFF: 'L' })
    expect(offList(dir)).toEqual(['L'])
    expect(() => JSON.parse(readConfig(dir))).not.toThrow()
  }, 60_000)

  it('a rule file missing from ~/.rsct/rules stops it before any write', () => {
    const dir = project()
    rmSync(join(dir, '.rsct', 'rules', ruleFile('K')))
    const r = toggle(dir)
    expect(r.out).toMatch(new RegExp(`STOP: ${S}K is on but .* is missing`))
    unchanged(dir, claudeMd(), CONFIG)
  }, 60_000)

  it('a CLAUDE.md with no RSCT section, or a missing .rsct.json, stops it', () => {
    const bare = '# CLAUDE.md\n\nonly the developer text\n'
    const dir = project({ claude: bare })
    expect(toggle(dir).out).toMatch(/STOP: CLAUDE.md has no RSCT section/)
    unchanged(dir, bare, CONFIG)
    const noConfig = project()
    rmSync(join(noConfig, '.rsct.json'))
    expect(toggle(noConfig).out).toMatch(/STOP: run this from the project root/)
    expect(readClaude(noConfig)).toBe(claudeMd())
  }, 60_000)

  it.skipIf(!canSymlink)('a CLAUDE.md that is a symbolic link is never written through', () => {
    const dir = project()
    const target = join(dir, 'shared-CLAUDE.md')
    writeFileSync(target, claudeMd())
    rmSync(join(dir, 'CLAUDE.md'))
    symlinkSync(target, join(dir, 'CLAUDE.md'))
    expect(toggle(dir).out).toMatch(/STOP: CLAUDE.md or .rsct.json is a symbolic link/)
    expect(readFileSync(target, 'utf8')).toBe(claudeMd())
    expect(readConfig(dir)).toBe(CONFIG)
  }, 60_000)

  it.skipIf(!canSymlink)('a .rsct.json that is a symbolic link is never written through', () => {
    const dir = project()
    const target = join(dir, 'shared.rsct.json')
    writeFileSync(target, CONFIG)
    rmSync(join(dir, '.rsct.json'))
    symlinkSync(target, join(dir, '.rsct.json'))
    expect(toggle(dir).out).toMatch(/STOP: CLAUDE.md or .rsct.json is a symbolic link/)
    expect(readFileSync(target, 'utf8')).toBe(CONFIG)
    expect(readClaude(dir)).toBe(claudeMd())
  }, 60_000)

  it('a section edited after install is named before it is switched off', () => {
    const dir = project()
    toggle(dir)
    writeFileSync(join(dir, 'CLAUDE.md'), readClaude(dir).replace('More detail only when the developer asks for it.', 'OUR TEAM: always detailed.'))
    const dry = toggle(dir, { CONDUCT_RULES_OFF: 'J', CONDUCT_APPLY: '0' })
    expect(dry.out).toContain(`${S}J: off — will be removed; its body was edited after install`)
    expect(dry.out).not.toContain(`${S}I: off`)
  }, 60_000)

  it('a section added before one already present lands in its place in the order', () => {
    const dir = project({ claude: claudeMd([...BASE, 'K']) })
    toggle(dir, { CONDUCT_RULES_OFF: 'M' })
    expect(begins(readClaude(dir))).toEqual([...BASE, 'I', 'J', 'K', 'L'])
  }, 60_000)

  it('the rule files it adds are the shipped rules/ files, and §I–§M are the five that exist', () => {
    const text = readFileSync(join(ROOT, 'prompts', PROMPT), 'utf8').replace(/\r/g, '')
    const start = text.indexOf('CONDUCT_RULES="') + 'CONDUCT_RULES="'.length
    expect(text.slice(start, text.indexOf('"', start)).split('\n')).toEqual(CONDUCT.map((id) => `${id}|${ruleFile(id)}`))
    expect(RULE_FILES.map((f) => f.charAt(0)).sort()).toEqual([...BASE, ...CONDUCT].sort())
  }, 10_000)
})
