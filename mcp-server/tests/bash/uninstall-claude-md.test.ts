import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bashAvailable, repoRoot } from './lib/bash-lint.js'
import { nodeAvailable } from './lib/block-harness.js'
import { bashBin } from './lib/resolve-bash.js'
import { chainDir, cleanChains, runBlockIn, runBlocks, type BlockStep, type ChainStep } from './lib/chain-harness.js'
import { SHARED_STATE_IGNORE, anchorFor, canonicalPath, clearAnchorCache, resolveRepositoryAnchor } from '../../src/lib/repo-anchor.js'
import { safeGitRead } from '../../src/lib/git.js'

const ROOT = repoRoot(__dirname)
const BASH = bashAvailable()
const NODE = nodeAvailable()
const READY = BASH && NODE
const S = String.fromCharCode(167)
const BOM = String.fromCharCode(0xfeff)
const P01 = '01-setup.md'
const P03 = '03-uninstall.md'
const TEMPLATE = readFileSync(join(ROOT, 'doc-templates', 'CLAUDE.md.template'), 'utf8')
const A = {
  sections: `Phase 4.2 executing canonical RSCT-${S}X block excision`,
  placeholder: 'Phase 4.2 removing the unfilled canonical-source placeholder',
  canonical: 'Phase 4.3 excising the filled canonical-source section',
  header: 'Phase 4.3b removing the CLAUDE.md header lines and the CONVENTIONS-REF pointer',
  decide: 'Phase 4.3c deciding whether CLAUDE.md itself goes',
  splice: 'Phase 4.6 marking the canonical section as removed in a kept .rsct.json',
  gitignore: 'Phase 4.4b excising the RSCT .gitignore block',
  protect: 'Phase 4.V.c protecting a kept audit log from git',
  prune: 'Phase 4.7 pruning .rsct/ and .claude/ when nothing is left in them',
  leftovers: 'Phase 1.1 listing what an earlier RSCT install left here (read-only)',
  scan: 'Phase 1.3 scanning CLAUDE.md for RSCT text (read-only)',
  shared: 'Phase 1.6 locating the RSCT state this project shares with its repository (read-only)',
  create: 'Phase 4.3 executing canonical CLAUDE.md CREATE writer',
  stepD: 'Phase 4.2 Step D executing canonical RSCT_APP header date update',
  stepE: 'Phase 4.2 Step E executing canonical CONVENTIONS-REF pointer backfill',
}

afterEach(() => cleanChains())

const posix = (p: string) => p.replace(/\\/g, '/')
const read = (dir: string, rel = 'CLAUDE.md') => readFileSync(join(dir, rel), 'utf8')
const put = (dir: string, rel: string, content: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true })
  writeFileSync(join(dir, rel), content)
}
const sec = (id: string, body: string, src: string | null = 'inserted', sha?: string) =>
  `<!-- RSCT-${S}${id}-BEGIN v=1.0.0${src === null ? '' : ` source=${src}`}${sha ? ` sha256-body=${sha}` : ''} -->\n${body}\n<!-- RSCT-${S}${id}-END -->\n`
const REF_BLOCK = (() => {
  const lines = TEMPLATE.replace(/\r/g, '').split('\n')
  const a = lines.findIndex((l) => l.startsWith('<!-- RSCT-CONVENTIONS-REF'))
  const b = lines.findIndex((l) => l.startsWith('<!-- /RSCT-CONVENTIONS-REF'))
  return `${lines.slice(a, b + 1).join('\n')}\n`
})()

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function repo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@t.t')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.hooksPath', '.no-hooks')
}
function commit(dir: string, message = 'c'): string {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--allow-empty', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

function homeWithTemplate(): string {
  const home = chainDir()
  put(home, '.rsct/doc-templates/CLAUDE.md.template', TEMPLATE)
  return home
}

const fillSections = (cwd: string) => {
  const text = read(cwd)
  writeFileSync(join(cwd, 'CLAUDE.md'), text.replace(new RegExp(`^\\[${S}([0A-H]) — [^\\n]* inserted here\\]$`, 'gm'), (_m, id: string) => sec(id, `rule ${id} body`).trimEnd()))
}

const block = (anchor: string, env: Record<string, string> = {}, cwd?: string): BlockStep => ({ prompt: P03, anchor, env, cwd })

function uninstallChain(env: Record<string, string>, cwd?: string): ChainStep[] {
  return [
    ...[A.sections, A.placeholder, A.canonical, A.header].map((a) => block(a, env, cwd)),
    block(A.decide, { ...env, CLAUDE_MD_APPLY: '1' }, cwd),
  ]
}

function createSteps(home: string, cwd?: string): ChainStep[] {
  return [
    { prompt: P01, anchor: A.create, preamble: 'APP_NAME=demo', env: { HOME: posix(home) }, cwd },
    { node: (dir) => fillSections(cwd ? join(dir, cwd) : dir) },
  ]
}

const decision = (out: string) => (out.replace(/\r/g, '').match(/^CLAUDE_MD_DECISION=(.*)$/m) ?? [])[1] ?? ''

function sh(cwd: string, script: string): string {
  return execFileSync(bashBin(), ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MSYS: 'winsymlinks:sys' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
const link = (cwd: string, target: string, name: string) => sh(cwd, `ln -s '${target}' '${name}'`)
const isLink = (cwd: string, name: string) => sh(cwd, `if [ -L '${name}' ]; then echo yes; else echo no; fi`) === 'yes'

describe.skipIf(!READY)('Phase 4.2 excises sections by column-1 marker pairs', () => {
  const excise = (content: string, env: Record<string, string> = {}) => {
    const dir = chainDir()
    put(dir, 'CLAUDE.md', content)
    const r = runBlockIn(ROOT, dir, block(A.sections, env))
    return { dir, r }
  }

  it('framework sections go whole, hashed or not, and the text around them stays', () => {
    const { dir, r } = excise(`# Mine\n\nbefore\n\n${sec('A', 'rule a')}\n${sec('B', 'rule b', 'migrated-from-ptbr', 'a'.repeat(64))}\nafter\n`)
    expect(r.exit, r.out).toBe(0)
    expect(read(dir)).toBe('# Mine\n\nbefore\n\n\n\nafter\n')
  })

  it('a body that is the developer text keeps its lines, only the markers go', () => {
    const body = `${sec('C', 'kept c', 'migrated-from-ptbr-preserved')}${sec('D', 'kept d', 'hand-merged')}${sec('E', 'kept e', null)}${sec('F', 'kept f', 'future-kind')}`
    const { dir, r } = excise(`# Mine\n${body}`)
    expect(r.exit, r.out).toBe(0)
    expect(read(dir)).toBe('# Mine\nkept c\nkept d\nkept e\nkept f\n')
    expect(r.out).toContain(`KEPT_BODY ${S}C (source=migrated-from-ptbr-preserved`)
    expect(r.out).toContain(`KEPT_BODY ${S}E (source=<none>`)
  })

  it('a narrowed scope leaves the other sections with their markers', () => {
    const original = `# Mine\n${sec('F', 'f')}${sec('G', 'g')}`
    const { dir } = excise(original, { SECTIONS_TO_REMOVE: 'F' })
    expect(read(dir)).toBe(`# Mine\n${sec('G', 'g')}`)
  })

  it.each([
    ['a BEGIN inside another section', `x\n<!-- RSCT-${S}A-BEGIN v=1.0.0 source=inserted -->\n<!-- RSCT-${S}B-BEGIN v=1.0.0 source=inserted -->\nb\n<!-- RSCT-${S}B-END -->\n<!-- RSCT-${S}A-END -->\nDEV TAIL\n`],
    ['an END with no BEGIN', `x\n<!-- RSCT-${S}A-END -->\nDEV TAIL\n`],
    ['a BEGIN never closed', `x\n<!-- RSCT-${S}A-BEGIN v=1.0.0 source=inserted -->\nDEV TAIL\nMORE DEV\n`],
  ])('%s stops the block and leaves the file byte for byte', (_name, content) => {
    const { dir, r } = excise(content)
    expect(r.exit).not.toBe(0)
    expect(r.out).toContain('NOT touched')
    expect(read(dir)).toBe(content)
  })

  it('a marker quoted mid-line is the developer text', () => {
    const content = `# Mine\nWe once saw <!-- RSCT-${S}A-BEGIN v=1.0.0 source=inserted --> in a diff.\n`
    const { dir, r } = excise(content)
    expect(r.exit, r.out).toBe(0)
    expect(read(dir)).toBe(content)
  })

  it('keeps CRLF line endings and a byte-order mark, and a second run changes nothing', () => {
    const content = `${BOM}# Mine\r\n${sec('A', 'rule a').replace(/\n/g, '\r\n')}tail\r\n`
    const dir = chainDir()
    put(dir, 'CLAUDE.md', content)
    runBlocks(ROOT, [block(A.sections), block(A.sections)], { dir })
    expect(read(dir)).toBe(`${BOM}# Mine\r\ntail\r\n`)
  })

  it('leaves a symlinked CLAUDE.md and the file it points to as they are', () => {
    const dir = chainDir()
    const target = `# Shared\n${sec('A', 'rule a')}`
    put(dir, 'shared.md', target)
    link(dir, 'shared.md', 'CLAUDE.md')
    expect(isLink(dir, 'CLAUDE.md')).toBe(true)
    const r = runBlockIn(ROOT, dir, block(A.sections))
    expect(r.out).toContain('is a symbolic link')
    expect(isLink(dir, 'CLAUDE.md')).toBe(true)
    expect(read(dir, 'shared.md')).toBe(target)
  })
})

describe.skipIf(!READY)('Phase 4.2 removes the legacy placeholder of a pre-#66 install that was linked and refreshed', () => {
  it('the heading inside the filled section no longer hides the orphan placeholder below it', () => {
    const filled = '<!-- RSCT-CANONICAL-SOURCE-BEGIN v=1.0.0 -->\n## 0. Canonical architectural source\n\nlinked text\n<!-- RSCT-CANONICAL-SOURCE-END -->\n'
    const legacy = '## 0. Canonical architectural source\n\n<!-- Populated by prompts/02-canonical-source.md -->\n\n<TODO: run 02-canonical-source.md to generate this section>\n'
    const dir = chainDir()
    put(dir, 'CLAUDE.md', `# CLAUDE.md — demo\n\n${REF_BLOCK}\n${filled}\n---\n\n${legacy}\n---\n\nDEV TAIL\n`)
    runBlockIn(ROOT, dir, block(A.placeholder))
    const text = read(dir)
    expect(text).not.toContain('<TODO')
    expect(text).not.toContain('Populated by')
    expect(text).toContain('linked text')
    expect(text.match(/^## 0\. Canonical architectural source$/gm)).toHaveLength(1)
    expect(text).toContain('DEV TAIL')
  })

  it('slot and canonical markers quoted mid-line are the developer text', () => {
    const content = '# Mine\n\nWe write `<!-- RSCT-CANONICAL-SOURCE-SLOT-BEGIN` and\nmy own line\n`<!-- RSCT-CANONICAL-SOURCE-SLOT-END -->` here, and `<!-- RSCT-CANONICAL-SOURCE-BEGIN`\nmore of mine\n`<!-- RSCT-CANONICAL-SOURCE-END -->` too.\n'
    const dir = chainDir()
    put(dir, 'CLAUDE.md', content)
    runBlocks(ROOT, [block(A.placeholder), block(A.canonical)], { dir })
    expect(read(dir)).toBe(content)
  })
})

describe.skipIf(!READY)('Phase 4.3b removes the header lines and the CONVENTIONS-REF pointer', () => {
  const header = (content: string, env: Record<string, string> = {}) => {
    const dir = chainDir()
    put(dir, 'CLAUDE.md', content)
    const r = runBlockIn(ROOT, dir, block(A.header, env))
    return { dir, r }
  }
  const HEAD = '<!-- RSCT_VERSION: 2.20.0 -->\n<!-- RSCT_APP: demo | updated: 2026-10-22 -->\n<!-- Generated by RSCT Framework v1.0.0 -->\n\n'

  it('a CREATE file loses its header and pointer and starts at its heading', () => {
    const { dir, r } = header(`${HEAD}# CLAUDE.md — demo\n\nAI agent operational protocol for this repository.\n\n${REF_BLOCK}\n---\n`)
    expect(r.out).toContain('removed 3 header line(s) and 1 CONVENTIONS-REF pointer(s)')
    expect(read(dir)).toBe('# CLAUDE.md — demo\n\nAI agent operational protocol for this repository.\n\n---\n')
  })

  it.each([
    ['LF', '# Acme API\n\nOur rules.\n'],
    ['CRLF', '# Acme API\r\n\r\nOur rules.\r\n'],
    ['BOM', `${BOM}# Acme API\n\nOur rules.\n`],
    ['no heading', 'just our text\n'],
  ])('undoes the setup pointer byte for byte (%s)', (_name, original) => {
    const dir = chainDir()
    put(dir, 'CLAUDE.md', original)
    runBlocks(ROOT, [{ prompt: P01, anchor: A.stepE }], { dir })
    expect(read(dir)).toContain('<!-- RSCT-CONVENTIONS-REF')
    runBlockIn(ROOT, dir, block(A.header))
    expect(read(dir)).toBe(original)
  })

  it('leaves both while an RSCT section is still in the file', () => {
    const content = `${HEAD}# CLAUDE.md — demo\n\n${REF_BLOCK}${sec('C', 'kept')}`
    const { dir, r } = header(content)
    expect(read(dir)).toBe(content)
    expect(r.out).toContain('kept with them')
  })

  it('keeps a pointer whose text was edited, and says so', () => {
    const edited = REF_BLOCK.replace('consult it before writing new code', 'read it first')
    const { dir, r } = header(`# Mine\n\n${edited}`)
    expect(read(dir)).toBe(`# Mine\n\n${edited}`)
    expect(r.out).toContain('REF_KEPT 1')
  })

  it('a header line quoted later in the file is the developer text', () => {
    const content = '# Mine\n\n<!-- RSCT_VERSION: 2.20.0 -->\n'
    const { dir } = header(content)
    expect(read(dir)).toBe(content)
  })

  it('leaves a symlinked CLAUDE.md and its target as they are, even with no section left', () => {
    const dir = chainDir()
    const target = `${HEAD}# CLAUDE.md — demo\n\n${REF_BLOCK}`
    put(dir, 'shared.md', target)
    link(dir, 'shared.md', 'CLAUDE.md')
    const r = runBlockIn(ROOT, dir, block(A.header))
    expect(r.out).toContain('is a symbolic link')
    expect(isLink(dir, 'CLAUDE.md')).toBe(true)
    expect(read(dir, 'shared.md')).toBe(target)
  })

  it('does nothing when the CLAUDE.md sections are out of scope', () => {
    const content = `${HEAD}# CLAUDE.md — demo\n`
    const { dir } = header(content, { CLAUDE_MD_IN_SCOPE: 'no' })
    expect(read(dir)).toBe(content)
  })
})

describe.skipIf(!READY)('Phase 4.3c decides by git whether CLAUDE.md itself goes', () => {
  function created(mode = 'CREATE', cwd?: string) {
    const dir = chainDir()
    repo(dir)
    if (cwd) put(dir, join(cwd, '.keep'), '')
    put(dir, 'README.md', '# app\n')
    const sha = commit(dir)
    const home = homeWithTemplate()
    runBlocks(ROOT, createSteps(home, cwd), { dir })
    return { dir, sha, env: { SETUP_COMMIT_SHA_BEFORE: sha, MODE_AT_INSTALL: mode } }
  }

  it('a CLAUDE.md that setup created is deleted once only framework text is left', () => {
    const { dir, env } = created()
    const r = runBlocks(ROOT, uninstallChain(env), { dir })
    expect(decision(r.last.out)).toMatch(/^delete \(setup created it/)
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false)
  })

  it('the Phase 1 dry run names the deletion and changes nothing', () => {
    const { dir, env } = created()
    const before = read(dir)
    const r = runBlockIn(ROOT, dir, block(A.decide, env))
    expect(decision(r.out)).toMatch(/^delete /)
    expect(read(dir)).toBe(before)
  })

  it('keeps the file while a section the developer kept is still in it', () => {
    const { dir, env } = created()
    const r = runBlocks(ROOT, uninstallChain({ ...env, SECTIONS_TO_REMOVE: '0 A B D E F G H' }), { dir })
    expect(decision(r.last.out)).toMatch(/^keep \(RSCT text you kept/)
    expect(read(dir)).toContain(`<!-- RSCT-${S}C-BEGIN`)
  })

  it('keeps the file when setup_commit_sha_before is not a readable commit', () => {
    for (const sha of ['INITIAL', 'not-a-hash', 'f'.repeat(40)]) {
      const { dir, env } = created()
      const r = runBlocks(ROOT, uninstallChain({ ...env, SETUP_COMMIT_SHA_BEFORE: sha }), { dir })
      expect(decision(r.last.out), sha).toMatch(/^keep \(git cannot prove/)
      expect(existsSync(join(dir, 'CLAUDE.md')), sha).toBe(true)
    }
  })

  it('keeps the text a developer added after setup', () => {
    const { dir, env } = created()
    writeFileSync(join(dir, 'CLAUDE.md'), `${read(dir)}\nOur own rule.\n`)
    const r = runBlocks(ROOT, uninstallChain(env), { dir })
    expect(decision(r.last.out)).toMatch(/^keep \(your text is in it\)/)
    expect(read(dir)).toContain('Our own rule.')
    expect(read(dir)).not.toContain('RSCT')
  })

  it('in UPDATE mode a heading the developer wrote is the developer text', () => {
    const dir = chainDir()
    repo(dir)
    const sha = commit(dir)
    put(dir, 'CLAUDE.md', `# CLAUDE.md\n\n${sec('A', 'rule a')}`)
    const r = runBlocks(ROOT, uninstallChain({ SETUP_COMMIT_SHA_BEFORE: sha, MODE_AT_INSTALL: 'UPDATE' }), { dir })
    expect(decision(r.last.out)).toMatch(/^keep /)
    expect(read(dir)).toBe('# CLAUDE.md\n\n')
  })

  it('offers to restore a CLAUDE.md that an older CREATE replaced, and restores it on request', () => {
    const mine = '# Our project\n\nOur rules, written before RSCT.\n'
    for (const choice of ['keep', 'restore']) {
      const dir = chainDir()
      repo(dir)
      put(dir, 'CLAUDE.md', mine)
      const sha = commit(dir)
      rmSync(join(dir, 'CLAUDE.md'))
      runBlocks(ROOT, createSteps(homeWithTemplate()), { dir })
      const r = runBlocks(ROOT, uninstallChain({ SETUP_COMMIT_SHA_BEFORE: sha, MODE_AT_INSTALL: 'CREATE', CLAUDE_MD_RESTORE: choice }), { dir })
      expect(decision(r.last.out), choice).toMatch(/^restore-offer /)
      if (choice === 'restore') expect(read(dir)).toBe(mine)
      else expect(read(dir)).not.toContain('Our rules')
    }
  })

  it('a CLAUDE.md the developer had, made of template-like lines only, is not mistaken for leftovers', () => {
    const dir = chainDir()
    repo(dir)
    put(dir, 'CLAUDE.md', '# CLAUDE.md\n\n---\n')
    const sha = commit(dir)
    writeFileSync(join(dir, 'CLAUDE.md'), `# CLAUDE.md\n\n---\n${sec('A', 'rule a')}`)
    const r = runBlocks(ROOT, uninstallChain({ SETUP_COMMIT_SHA_BEFORE: sha, MODE_AT_INSTALL: 'UPDATE' }), { dir })
    expect(decision(r.last.out)).toMatch(/^keep \(you had a CLAUDE.md before setup\)/)
    expect(read(dir)).toBe('# CLAUDE.md\n\n---\n')
  })

  it('never deletes a CLAUDE.md that existed before an UPDATE setup', () => {
    const dir = chainDir()
    repo(dir)
    put(dir, 'CLAUDE.md', '# Ours\n')
    const sha = commit(dir)
    writeFileSync(join(dir, 'CLAUDE.md'), `# Ours\n${sec('A', 'rule a')}`)
    const r = runBlocks(ROOT, uninstallChain({ SETUP_COMMIT_SHA_BEFORE: sha, MODE_AT_INSTALL: 'UPDATE' }), { dir })
    expect(decision(r.last.out)).toMatch(/^keep \(/)
    expect(read(dir)).toBe('# Ours\n')
  })

  it('in a monorepo package it reads the package CLAUDE.md at that commit, never the root one', () => {
    const dir = chainDir()
    repo(dir)
    put(dir, 'CLAUDE.md', '# Root rules of the monorepo\n')
    put(dir, 'packages/api/package.json', '{}\n')
    const sha = commit(dir)
    runBlocks(ROOT, createSteps(homeWithTemplate(), 'packages/api'), { dir })
    const r = runBlocks(ROOT, uninstallChain({ SETUP_COMMIT_SHA_BEFORE: sha, MODE_AT_INSTALL: 'CREATE' }, 'packages/api'), { dir })
    expect(decision(r.last.out)).toMatch(/^delete \(setup created it/)
    expect(existsSync(join(dir, 'packages/api/CLAUDE.md'))).toBe(false)
    expect(read(dir)).toBe('# Root rules of the monorepo\n')
  })

  it('in a monorepo package it judges the package leftovers at that commit, not the root file of the same name', () => {
    const dir = chainDir()
    repo(dir)
    put(dir, 'CLAUDE.md', '# Root rules of the monorepo\n')
    put(dir, 'packages/api/CLAUDE.md', `<!-- RSCT_VERSION: 2.0.0 -->\n<!-- RSCT_APP: demo | updated: 2026-01-01 -->\n<!-- Generated by RSCT Framework v1.0.0 -->\n\n# CLAUDE.md — demo\n\n${REF_BLOCK}\n---\n`)
    const sha = commit(dir)
    writeFileSync(join(dir, 'packages/api/CLAUDE.md'), `${read(dir, 'packages/api/CLAUDE.md')}\n${sec('A', 'rule a')}`)
    const r = runBlocks(ROOT, uninstallChain({ SETUP_COMMIT_SHA_BEFORE: sha, MODE_AT_INSTALL: 'UPDATE' }, 'packages/api'), { dir })
    expect(decision(r.last.out)).toMatch(/^delete \(it held only framework text before setup/)
    expect(existsSync(join(dir, 'packages/api/CLAUDE.md'))).toBe(false)
    expect(read(dir)).toBe('# Root rules of the monorepo\n')
  })

  it('in a linked worktree it reads the commit through the shared repository', () => {
    const main = chainDir()
    repo(main)
    put(main, 'README.md', '# app\n')
    const sha = commit(main)
    const linked = join(chainDir(), 'linked')
    git(main, 'worktree', 'add', '-q', '-b', 'side', linked)
    runBlocks(ROOT, createSteps(homeWithTemplate()), { dir: linked })
    const r = runBlocks(ROOT, uninstallChain({ SETUP_COMMIT_SHA_BEFORE: sha, MODE_AT_INSTALL: 'CREATE' }), { dir: linked })
    expect(decision(r.last.out)).toMatch(/^delete /)
    expect(existsSync(join(linked, 'CLAUDE.md'))).toBe(false)
  })

  it('no block of the chain changes, replaces or deletes a symlinked CLAUDE.md', () => {
    const { dir, env } = created()
    const target = `${read(dir)}\n<!-- RSCT-CANONICAL-SOURCE-BEGIN v=1.0.0 -->\n## 0. Canonical architectural source\n\nlinked\n<!-- RSCT-CANONICAL-SOURCE-END -->\n`
    writeFileSync(join(dir, 'real.md'), target)
    rmSync(join(dir, 'CLAUDE.md'))
    link(dir, 'real.md', 'CLAUDE.md')
    const r = runBlocks(ROOT, uninstallChain(env), { dir })
    expect(decision(r.last.out)).toMatch(/^keep \(a symbolic link/)
    expect(isLink(dir, 'CLAUDE.md')).toBe(true)
    expect(read(dir, 'real.md')).toBe(target)
  })

  it('keeps the file when git cannot hand over the CLAUDE.md it has at that commit', () => {
    const dir = chainDir()
    repo(dir)
    put(dir, 'CLAUDE.md', '# Ours\nour rules\n')
    const sha = commit(dir)
    rmSync(join(dir, 'CLAUDE.md'))
    runBlocks(ROOT, createSteps(homeWithTemplate()), { dir })
    const env = { SETUP_COMMIT_SHA_BEFORE: sha, MODE_AT_INSTALL: 'CREATE', TMPDIR: posix(join(dir, 'missing', 'tmp')) }
    const r = runBlocks(ROOT, uninstallChain(env), { dir })
    expect(decision(r.last.out)).toMatch(/^keep \(git cannot prove/)
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true)
  })
})

describe.skipIf(!READY)('an upgrade cleans what an older uninstall left behind', () => {
  function leftovers(extra = '') {
    const dir = chainDir()
    repo(dir)
    runBlocks(ROOT, [...createSteps(homeWithTemplate()), block(A.sections), block(A.placeholder), block(A.canonical)], { dir })
    if (extra) writeFileSync(join(dir, 'CLAUDE.md'), `${read(dir)}${extra}`)
    const sha = commit(dir, 'left by an older uninstall')
    expect(read(dir)).toContain('<!-- RSCT_VERSION:')
    expect(read(dir)).toContain('<!-- RSCT-CONVENTIONS-REF')
    runBlocks(ROOT, [
      { prompt: P01, anchor: A.stepD, preamble: 'APP_NAME=demo' },
      { prompt: P01, anchor: A.stepE },
      { node: (d) => writeFileSync(join(d, 'CLAUDE.md'), `${read(d)}\n${sec('A', 'rule a')}${sec('B', 'rule b')}`) },
    ], { dir })
    return { dir, env: { SETUP_COMMIT_SHA_BEFORE: sha, MODE_AT_INSTALL: 'UPDATE' } }
  }

  it('a file that held only those leftovers goes once the new setup is uninstalled', () => {
    const { dir, env } = leftovers()
    const r = runBlocks(ROOT, uninstallChain(env), { dir })
    expect(decision(r.last.out)).toMatch(/^delete \(it held only framework text before setup/)
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false)
  })

  it('the developer text written into those leftovers stays, and every RSCT line goes', () => {
    const { dir, env } = leftovers('\nOur own rule.\n')
    const r = runBlocks(ROOT, uninstallChain(env), { dir })
    expect(decision(r.last.out)).toMatch(/^keep /)
    const text = read(dir)
    expect(text).toContain('Our own rule.')
    expect(text).not.toMatch(/RSCT/)
  })
})

describe.skipIf(!READY)('Phase 4.6 turns canonical_source_added off in a kept .rsct.json', () => {
  const splice = (content: string) => {
    const dir = chainDir()
    put(dir, '.rsct.json', content)
    const r = runBlockIn(ROOT, dir, block(A.splice))
    return { dir, r }
  }

  it('changes that one value and keeps every other byte, CRLF and BOM included', () => {
    const content = `${BOM}{\r\n  "install": {\r\n    "mode":   "CREATE",\r\n    "canonical_source_added" :  true,\r\n    "x": 1\r\n  }\r\n}\r\n`
    const { dir, r } = splice(content)
    expect(r.out).toContain('set to false')
    expect(read(dir, '.rsct.json')).toBe(content.replace('"canonical_source_added" :  true', '"canonical_source_added" :  false'))
  })

  it.each([
    ['absent', '{ "install": { "canonical_source_added": false } }\n'],
    ['twice', '{ "a": { "canonical_source_added": true }, "b": { "canonical_source_added": true } }\n'],
  ])('refuses when the true value is %s', (_name, content) => {
    const { dir, r } = splice(content)
    expect(read(dir, '.rsct.json')).toBe(content)
    expect(r.out).toContain('NOT changed')
  })
})

describe.skipIf(!READY)('a kept audit log stays out of git after the .gitignore block goes', () => {
  const INSTALLED_BLOCK = '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b\nplan_*.md\n.rsct/audit.log\n# RSCT-END\n'

  it('writes the same ignore file the server writes, and git then sees nothing under .rsct/', () => {
    const dir = chainDir()
    repo(dir)
    put(dir, '.gitignore', `node_modules/\n\n${INSTALLED_BLOCK}`)
    put(dir, '.rsct/audit.log', '{"event":"x"}\n')
    commit(dir)
    expect(git(dir, 'ls-files', '.rsct')).toBe('')
    runBlocks(ROOT, [block(A.gitignore), block(A.protect)], { dir })
    expect(read(dir, '.gitignore')).toBe('node_modules/\n')
    expect(read(dir, '.rsct/.gitignore')).toBe(SHARED_STATE_IGNORE)
    const status = git(dir, 'status', '--porcelain', '--untracked-files=all')
    expect(status).not.toContain('.rsct')
  })

  it('never replaces an ignore file that is already there, and writes none without a log', () => {
    const dir = chainDir()
    put(dir, '.rsct/audit.log', 'x\n')
    put(dir, '.rsct/.gitignore', 'mine\n')
    runBlockIn(ROOT, dir, block(A.protect))
    expect(read(dir, '.rsct/.gitignore')).toBe('mine\n')
    const empty = chainDir()
    mkdirSync(join(empty, '.rsct'))
    runBlockIn(ROOT, empty, block(A.protect))
    expect(existsSync(join(empty, '.rsct', '.gitignore'))).toBe(false)
  })
})

describe.skipIf(!READY)('Phase 4.7 prunes only what is empty', () => {
  it('removes the RSCT ignore file when it is the last file, then .rsct/ and an empty .claude/', () => {
    const dir = chainDir()
    put(dir, '.rsct/.gitignore', SHARED_STATE_IGNORE)
    mkdirSync(join(dir, '.claude'))
    runBlockIn(ROOT, dir, block(A.prune))
    expect(existsSync(join(dir, '.rsct'))).toBe(false)
    expect(existsSync(join(dir, '.claude'))).toBe(false)
  })

  it('keeps the ignore file next to a kept log, an edited ignore file, and a .claude/ with files', () => {
    const dir = chainDir()
    put(dir, '.rsct/.gitignore', SHARED_STATE_IGNORE)
    put(dir, '.rsct/audit.log', 'x\n')
    put(dir, '.claude/commands/mine.md', 'x\n')
    runBlockIn(ROOT, dir, block(A.prune))
    expect(read(dir, '.rsct/.gitignore')).toBe(SHARED_STATE_IGNORE)
    expect(existsSync(join(dir, '.claude/commands/mine.md'))).toBe(true)
    const edited = chainDir()
    put(edited, '.rsct/.gitignore', `${SHARED_STATE_IGNORE}mine\n`)
    runBlockIn(ROOT, edited, block(A.prune))
    expect(read(edited, '.rsct/.gitignore')).toBe(`${SHARED_STATE_IGNORE}mine\n`)
  })
})

describe.skipIf(!READY)('Phase 4.4b of the uninstall removes only the RSCT block', () => {
  it('keeps the developer lines of a CRLF .gitignore', () => {
    const dir = chainDir()
    put(dir, '.gitignore', 'dist/\r\n\r\n# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b\r\nplan_*.md\r\n# RSCT-END\r\nmine.txt\r\n')
    runBlockIn(ROOT, dir, block(A.gitignore))
    const text = read(dir, '.gitignore').replace(/\r/g, '')
    expect(text).toBe('dist/\nmine.txt\n')
  })
})

describe.skipIf(!READY)('Phase 1.1 lists what an earlier install left, and writes nothing', () => {
  it('counts each leftover and leaves every file as it was', () => {
    const dir = chainDir()
    put(dir, 'CLAUDE.md', `<!-- RSCT_VERSION: 2.0.0 -->\n# CLAUDE.md — demo\n${REF_BLOCK}`)
    put(dir, 'documentation/decisions.md', '<!-- RSCT-GENERATED v=1.0.0 -->\nbody\n')
    put(dir, 'documentation/mine.md', 'mine\n')
    put(dir, '.rsct/audit.log', 'x\n')
    put(dir, '.gitignore', '# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b\n# RSCT-END\n')
    const snapshot = () => readdirSync(dir, { recursive: true }).map(String).sort().map((f) => {
      const p = join(dir, f)
      return lstatSync(p).isFile() ? `${f}:${readFileSync(p, 'utf8')}` : f
    })
    const before = snapshot()
    const r = runBlockIn(ROOT, dir, block(A.leftovers))
    expect(r.out).toMatch(/^LEFTOVERS=4$/m)
    expect(r.out).toContain('LEFT CLAUDE.md: 1 RSCT marker line(s), 1 RSCT header line(s)')
    expect(r.out).not.toContain('mine.md')
    expect(snapshot()).toEqual(before)
  })

  it('reports nothing in a project with no leftovers', () => {
    const dir = chainDir()
    put(dir, 'CLAUDE.md', '# Mine\n')
    expect(runBlockIn(ROOT, dir, block(A.leftovers)).out).toMatch(/^LEFTOVERS=0$/m)
  })
})

describe.skipIf(!READY)('Phase 1.3 says whether git keeps a copy of what goes', () => {
  const scan = (dir: string, env: Record<string, string> = {}) =>
    (runBlockIn(ROOT, dir, block(A.scan, env)).out.match(/^CLAUDE_MD_GIT=(\S+)/m) ?? [])[1]

  it('committed, uncommitted, untracked, ignored and no git', () => {
    const dir = chainDir()
    repo(dir)
    put(dir, 'CLAUDE.md', `# Mine\n${sec('C', 'c', 'hand-merged')}`)
    expect(scan(dir)).toBe('untracked')
    commit(dir)
    expect(scan(dir)).toBe('committed')
    writeFileSync(join(dir, 'CLAUDE.md'), '# Mine, edited\n')
    expect(scan(dir)).toBe('uncommitted')
    const ignored = chainDir()
    repo(ignored)
    put(ignored, '.gitignore', 'CLAUDE.md\n')
    put(ignored, 'CLAUDE.md', '# Mine\n')
    expect(scan(ignored)).toBe('ignored')
    const plain = chainDir()
    put(plain, 'CLAUDE.md', '# Mine\n')
    expect(scan(plain, { GIT_CEILING_DIRECTORIES: posix(dirname(plain)) })).toBe('no-git')
  })

  it('names the sections whose body is the developer text', () => {
    const dir = chainDir()
    put(dir, 'CLAUDE.md', `${sec('A', 'a')}${sec('C', 'c', 'hand-merged')}`)
    const out = runBlockIn(ROOT, dir, block(A.scan)).out
    expect(out).toContain(`SECTION ${S}A source=inserted — framework text, removed whole`)
    expect(out).toContain(`SECTION ${S}C source=hand-merged — your text: markers removed, body kept`)
  })
})

describe.skipIf(!READY)('Phase 1.6 finds the shared state where the server puts it', () => {
  function bashAnchor(project: string, preamble = '', env: Record<string, string> = {}) {
    const r = runBlockIn(ROOT, chainDir(), { ...block(A.shared, env), preamble: `${preamble}\ncd '${posix(project)}' || exit 9` })
    const out = r.out
    const m = out.replace(/\r/g, '').match(/^SHARED_STATE=(\S+)(?: (.+))?$/m)
    if (!m) throw new Error(`no SHARED_STATE line in:\n${out}`)
    expect(r.exit, out).toBe(0)
    return { status: m[1]!, root: m[2] ?? null }
  }
  function expectSame(project: string, env: Record<string, string> = {}) {
    clearAnchorCache()
    const saved = process.env.GIT_CEILING_DIRECTORIES
    if (env.GIT_CEILING_DIRECTORIES) process.env.GIT_CEILING_DIRECTORIES = env.GIT_CEILING_DIRECTORIES
    try {
      const server = anchorFor(project)
      const shell = bashAnchor(project, '', env)
      expect(shell.status, project).toBe(server.status)
      if (server.status === 'relocated') expect(canonicalPath(shell.root!)).toBe(canonicalPath(server.root))
      return server.status
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = saved
      clearAnchorCache()
    }
  }

  it('agrees with lib/repo-anchor.ts on every layout', () => {
    const box = chainDir()
    const plain = join(box, 'plain')
    repo(plain)
    commit(plain)
    expect(expectSame(plain)).toBe('same')

    const mono = join(box, 'mono')
    repo(mono)
    put(mono, 'packages/api/package.json', '{}\n')
    commit(mono)
    expect(expectSame(join(mono, 'packages/api'))).toBe('relocated')

    const host = join(box, 'host')
    repo(host)
    put(host, 'tools/proj/.rsct.json', '{}\n')
    commit(host)
    expect(expectSame(join(host, 'tools/proj'))).toBe('relocated')

    const inner = join(host, 'vendor', 'own')
    repo(inner)
    commit(inner)
    expect(expectSame(inner)).toBe('same')

    const linked = join(box, 'linked')
    git(plain, 'worktree', 'add', '-q', '-b', 'side', linked)
    expect(expectSame(linked)).toBe('relocated')

    const loose = join(box, 'loose')
    mkdirSync(loose)
    expect(expectSame(loose, { GIT_CEILING_DIRECTORIES: posix(box) })).toBe('not-applicable')

    const named = join(box, 'worktrees', 'app')
    repo(named)
    commit(named)
    expect(expectSame(named)).toBe('same')
  })

  it('reports unavailable when git cannot name the repository, like the server', () => {
    const dir = chainDir()
    repo(dir)
    commit(dir)
    const server = resolveRepositoryAnchor(dir, {
      gitRead: (cwd, args) => (args.includes('--git-common-dir') ? null : safeGitRead(cwd, args)),
    })
    const shell = bashAnchor(dir, 'git() { case "$*" in *--git-common-dir*) return 1 ;; esac; command git "$@"; }')
    expect(server.status).toBe('unavailable')
    expect(shell.status).toBe('unavailable')
  })

  it('names the shared files and the old project copy, and removes nothing', () => {
    const mono = chainDir()
    repo(mono)
    put(mono, 'packages/api/.rsct/audit.log', 'old\n')
    put(mono, '.rsct/audit.log', 'shared\n')
    put(mono, '.rsct/approvals-seen.json', '{}\n')
    commit(mono)
    const r = runBlockIn(ROOT, mono, block(A.shared, {}, 'packages/api'))
    const out = r.out.replace(/\r/g, '')
    expect(r.exit, out).toBe(0)
    expect(out).toMatch(/^\s*SHARED_FILE \S*\/\.rsct\/audit\.log$/m)
    expect(out).toMatch(/^\s*SHARED_FILE \S*\/\.rsct\/approvals-seen\.json$/m)
    expect(out).toMatch(/^\s*OLD_COPY .*packages\/api\/\.rsct\/audit\.log$/m)
    expect(read(mono, '.rsct/audit.log')).toBe('shared\n')
    expect(read(mono, '.rsct/approvals-seen.json')).toBe('{}\n')
    expect(read(mono, 'packages/api/.rsct/audit.log')).toBe('old\n')
  })

  it('in the main worktree of a repository with linked worktrees it says the folder is shared', () => {
    const main = chainDir()
    repo(main)
    commit(main)
    git(main, 'worktree', 'add', '-q', '-b', 'side', join(chainDir(), 'linked'))
    const r = runBlockIn(ROOT, main, block(A.shared))
    expect(r.exit).toBe(0)
    expect(r.out).toMatch(/^SHARED_STATE=same$/m)
    expect(r.out).toMatch(/^\s*SHARED_WITH_WORKTREES=1 /m)
    const alone = chainDir()
    repo(alone)
    commit(alone)
    expect(runBlockIn(ROOT, alone, block(A.shared)).out).not.toContain('SHARED_WITH_WORKTREES')
  })
})

describe.skipIf(!READY)('Phase 4.V.c removes the approval store only when no linked worktree uses it', () => {
  const STORE = 'Phase 4.V.c removing the approval store unless linked worktrees use it'

  it('keeps it in a main worktree with a linked worktree, removes it (and its temporary file) elsewhere', () => {
    const main = chainDir()
    repo(main)
    commit(main)
    git(main, 'worktree', 'add', '-q', '-b', 'side', join(chainDir(), 'linked'))
    put(main, '.rsct/approvals-seen.json', '{}\n')
    const kept = runBlockIn(ROOT, main, block(STORE))
    expect(kept.out).toContain('kept .rsct/approvals-seen.json')
    expect(existsSync(join(main, '.rsct/approvals-seen.json'))).toBe(true)
    const alone = chainDir()
    repo(alone)
    commit(alone)
    put(alone, '.rsct/approvals-seen.json', '{}\n')
    put(alone, '.rsct/approvals-seen.json.tmp', '{}\n')
    runBlockIn(ROOT, alone, block(STORE))
    expect(existsSync(join(alone, '.rsct/approvals-seen.json'))).toBe(false)
    expect(existsSync(join(alone, '.rsct/approvals-seen.json.tmp'))).toBe(false)
  })
})
