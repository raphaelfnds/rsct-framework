import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { bashAvailable, repoRoot } from './lib/bash-lint.js'
import { runBlock, nodeAvailable, assertNodePolicy, readIn, type RunBlockResult } from './lib/block-harness.js'

const ROOT = repoRoot(__dirname)
const BASH = bashAvailable()
const NODE = nodeAvailable()
const S = String.fromCharCode(167)
const BOM = String.fromCharCode(0xfeff)
const FENCE = '`'.repeat(3)
const PROMPT = '01-setup.md'
const CLASSIFY = 'Phase 1.5 classifying the current CLAUDE.md (read-only)'
const STEP_E = 'Phase 4.2 Step E executing canonical CONVENTIONS-REF pointer backfill'
const CREATE = 'Phase 4.3 executing canonical CLAUDE.md CREATE writer'
const TEMPLATE = readFileSync(join(ROOT, 'doc-templates', 'CLAUDE.md.template'), 'utf8')

const dirs: string[] = []
function run(opts: Parameters<typeof runBlock>[1]): RunBlockResult {
  const r = runBlock(ROOT, opts)
  dirs.push(r.dir)
  return r
}
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }) } catch { }
  }
})

const section = (id: string, body: string) =>
  `<!-- RSCT-${S}${id}-BEGIN v=1.0.0 source=inserted -->\n${body}\n<!-- RSCT-${S}${id}-END -->\n`

function classify(content?: string): Record<string, string> {
  const r = run({
    promptBasename: PROMPT,
    anchor: CLASSIFY,
    seedFiles: content === undefined ? {} : { 'CLAUDE.md': content },
  })
  const out: Record<string, string> = {}
  for (const line of r.out.replace(/\r/g, '').split('\n')) {
    const m = line.match(/^(CLAUDE_MD_STATE|CLAUDE_MD_MARKERS)=(.*)$/)
    if (m) out[m[1]!] = m[2]!
    const rule = line.match(new RegExp(`^RULE ${S}([0A-H])=(.*)$`))
    if (rule) out[rule[1]!] = rule[2]!
  }
  return out
}

describe('node policy for the CLAUDE.md setup blocks', () => {
  it('fails instead of skipping when node is required', () => {
    assertNodePolicy(!!process.env.RSCT_REQUIRE_BASH, NODE)
  })
})

describe.skipIf(!BASH)('Phase 1.0 captures the commit before setup', () => {
  const CAPTURE = 'echo "SETUP_COMMIT_SHA_BEFORE=$SETUP_COMMIT_SHA_BEFORE"'
  it('an empty repository gives exactly INITIAL, never a stray HEAD line', () => {
    const r = run({
      promptBasename: PROMPT,
      anchor: CAPTURE,
      preamble: 'git init -q . >/dev/null 2>&1',
    })
    const lines = r.out.replace(/\r/g, '').split('\n').filter((l) => l.startsWith('SETUP_COMMIT_SHA_BEFORE='))
    expect(lines).toEqual(['SETUP_COMMIT_SHA_BEFORE=INITIAL'])
  })

  it('a repository with a commit gives its full hash', () => {
    const r = run({
      promptBasename: PROMPT,
      anchor: CAPTURE,
      preamble: [
        'git init -q . >/dev/null 2>&1',
        'git -c user.email=t@t.t -c user.name=t commit -q --allow-empty -m init >/dev/null 2>&1',
      ].join('\n'),
    })
    expect(r.out).toMatch(/^SETUP_COMMIT_SHA_BEFORE=[0-9a-f]{40}$/m)
  })
})

describe.skipIf(!BASH || !NODE)('Phase 1.5 classifies the current CLAUDE.md', () => {
  it('absent, empty and BOM-plus-blank are told apart from content', () => {
    expect(classify().CLAUDE_MD_STATE).toBe('absent')
    expect(classify('').CLAUDE_MD_STATE).toBe('empty')
    expect(classify(`${BOM}\n  \r\n\t\n`).CLAUDE_MD_STATE).toBe('empty')
    expect(classify('# Mine\n').CLAUDE_MD_STATE).toBe('content')
  })

  it('a CLAUDE.md the developer wrote, with no rules, is content with every rule missing', () => {
    const got = classify('# Acme API\n\nHow we work here.\n')
    expect(got.CLAUDE_MD_STATE).toBe('content')
    for (const id of ['0', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) expect(got[id], id).toBe('missing')
    expect(got.CLAUDE_MD_MARKERS).toBeUndefined()
  })

  it('a marker pair decides presence, even with CRLF line endings', () => {
    const body = `# CLAUDE.md\n\n${section('D', 'nothing that matches a keyword')}`
    const got = classify(body.replace(/\n/g, '\r\n'))
    expect(got.D).toBe('present-en (markers)')
    expect(got.A).toBe('missing')
  })

  it('the framework text left by the template never reads as a rule already present', () => {
    expect(TEMPLATE).toContain('decisions.md')
    const leftovers = TEMPLATE.replace(/\[APP_NAME\]/g, 'demo')
    const got = classify(leftovers)
    expect(got.H).toBe('missing')
    expect(got.CLAUDE_MD_MARKERS).toBeUndefined()
  })

  it('the same keyword in the developer text, outside every RSCT block, still counts', () => {
    const got = classify('# Acme\n\nWe record every choice in decisions.md.\n')
    expect(got.H).toBe('present-en')
  })

  it('a legacy Portuguese rule is found through the accented keyword', () => {
    const got = classify(`# Projeto\n\n## Plano obrigat${String.fromCharCode(243)}rio\n`)
    expect(got.B).toBe('present-ptbr')
  })

  it('a marker quoted mid-line is not a marker', () => {
    const got = classify(`# Mine\n\nWe saw \`<!-- RSCT-${S}D-BEGIN\` once.\n`)
    expect(got.D).toBe('missing')
    expect(got.CLAUDE_MD_MARKERS).toBeUndefined()
  })

  it('nested, stray and unterminated markers are reported, never guessed', () => {
    const nested = `<!-- RSCT-${S}A-BEGIN v=1.0.0 -->\n<!-- RSCT-${S}B-BEGIN v=1.0.0 -->\n<!-- RSCT-${S}B-END -->\n<!-- RSCT-${S}A-END -->\n`
    expect(classify(nested).CLAUDE_MD_MARKERS).toMatch(/^malformed nested-BEGIN-line-2$/)
    expect(classify(`# x\n<!-- RSCT-${S}C-END -->\n`).CLAUDE_MD_MARKERS).toMatch(/^malformed stray-END-line-2$/)
    expect(classify(`# x\n<!-- RSCT-${S}C-BEGIN v=1.0.0 -->\nbody\n`).CLAUDE_MD_MARKERS).toBe('malformed unterminated-BEGIN')
  })
})

describe.skipIf(!BASH || !NODE)('Phase 4.2 Step E places the CONVENTIONS-REF pointer', () => {
  const stepE = (content: string, runs = 1) =>
    run({ promptBasename: PROMPT, anchor: STEP_E, seedFiles: { 'CLAUDE.md': content }, runs })
  const lines = (r: RunBlockResult) => readIn(r, 'CLAUDE.md').replace(/\r/g, '').split('\n')
  const at = (r: RunBlockResult, needle: string) => lines(r).findIndex((l) => l.startsWith(needle))

  it('after the RSCT_APP header in a CLAUDE.md that RSCT created', () => {
    const r = stepE('<!-- RSCT_VERSION: 2.0.0 -->\n<!-- RSCT_APP: demo | updated: 2026-01-01 -->\n# CLAUDE.md — demo\n')
    expect(at(r, '<!-- RSCT-CONVENTIONS-REF')).toBe(3)
    expect(r.out).toContain('after the RSCT_APP header')
  })

  it('after the first heading of a CLAUDE.md the developer wrote', () => {
    const r = stepE('# Acme API\n\nOur rules.\n')
    const heading = at(r, '# Acme API')
    const pointer = at(r, '<!-- RSCT-CONVENTIONS-REF')
    expect(heading).toBe(0)
    expect(pointer).toBeGreaterThan(heading)
    expect(lines(r)).toContain('Our rules.')
    expect(r.out).toContain('after the first heading of the file')
  })

  it('a hash line inside a code fence is not a heading', () => {
    const r = stepE(`${FENCE}bash\n# not a heading\n${FENCE}\n\n# Real Title\n`)
    expect(at(r, '<!-- RSCT-CONVENTIONS-REF')).toBeGreaterThan(at(r, '# Real Title'))
  })

  it('RSCT_APP quoted in the developer prose is not the header', () => {
    const r = stepE('# Mine\n\nThe line RSCT_APP: x is written by RSCT.\n')
    expect(at(r, '<!-- RSCT-CONVENTIONS-REF')).toBe(2)
  })

  it('at the top only when the file has no heading at all', () => {
    const r = stepE('just text\n')
    expect(lines(r)[0]).toBe('<!-- RSCT-CONVENTIONS-REF v=1.0.0 -->')
    expect(lines(r)).toContain('just text')
    expect(r.out).toContain('at the top (the file has no heading)')
  })

  it('keeps the byte-order mark at byte 0 and anchors on the heading behind it', () => {
    const r = stepE(`${BOM}# Acme\n\ntext\n`)
    const written = readIn(r, 'CLAUDE.md')
    expect(written.charCodeAt(0)).toBe(0xfeff)
    expect(written.slice(1).startsWith('# Acme\n')).toBe(true)
    expect(written.indexOf(BOM, 1)).toBe(-1)
  })

  it('keeps CRLF line endings and is a no-op on a second run', () => {
    const r = stepE('# Acme\r\n\r\ntext\r\n', 2)
    const written = readIn(r, 'CLAUDE.md')
    expect(written.match(/RSCT-CONVENTIONS-REF v=/g)).toHaveLength(1)
    expect(written.replace(/\r\n/g, '')).not.toContain('\n')
    expect(r.out).toContain('already present')
  })
})

describe.skipIf(!BASH || !NODE)('Phase 4.3 refuses to replace a CLAUDE.md that has content', () => {
  const seedTemplate = { '.rsct/doc-templates/CLAUDE.md.template': TEMPLATE }
  const create = (claudeMd?: string, preamble = '') =>
    run({
      promptBasename: PROMPT,
      anchor: CREATE,
      preamble: `APP_NAME=demo\n${preamble}`,
      seedFiles: claudeMd === undefined ? seedTemplate : { ...seedTemplate, 'CLAUDE.md': claudeMd },
    })

  it('a CLAUDE.md the developer wrote is left byte for byte, and the block stops', () => {
    const mine = '# Mine\r\n\r\nmy own rules\r\n'
    const r = create(mine)
    expect(r.exit).not.toBe(0)
    expect(r.out).toContain('already has content')
    expect(readFileSync(join(r.dir, 'CLAUDE.md'), 'utf8')).toBe(mine)
  })

  it('no CLAUDE.md, an empty one, or one with only a BOM and blank lines is created', () => {
    for (const seed of [undefined, '', `${BOM}\n\n   \n`]) {
      const r = create(seed)
      expect(r.exit, r.out).toBe(0)
      const written = readIn(r, 'CLAUDE.md')
      expect(written).toContain('<!-- RSCT_APP: demo | updated:')
      expect(written).toContain('# CLAUDE.md — demo')
    }
  })

  it('without node, a blank but non-empty file is refused rather than guessed', () => {
    const noNode = 'command() { if [ "$1" = -v ] && [ "$2" = node ]; then return 1; fi; builtin command "$@"; }'
    const r = create('\n\n', noNode)
    expect(r.exit).not.toBe(0)
    expect(readFileSync(join(r.dir, 'CLAUDE.md'), 'utf8')).toBe('\n\n')
    const zero = create('', noNode)
    expect(zero.exit, zero.out).toBe(0)
  })

  it('a folder named CLAUDE.md is refused', () => {
    const r = run({
      promptBasename: PROMPT,
      anchor: CREATE,
      preamble: 'APP_NAME=demo\nmkdir CLAUDE.md',
      seedFiles: seedTemplate,
    })
    expect(r.exit).not.toBe(0)
    expect(r.out).toContain('already has content')
  })
})
