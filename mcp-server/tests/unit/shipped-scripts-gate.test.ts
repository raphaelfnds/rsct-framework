import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requestCommitHandler, type RequestCommitOutput } from '../../src/tools/request-commit.js'
import { computeWorkingSweep } from '../../src/lib/comment-sweep/review.js'
import { RSCT_MCP_VERSION } from '../../src/lib/version.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { commitAll, git, initSweepRepo } from '../sweep-repo.js'
import { bashAvailable, repoRoot } from '../bash/lib/bash-lint.js'
import { runBlock } from '../bash/lib/block-harness.js'

const ROOT = repoRoot(join(__dirname, '..', 'bash'))
const BASH = bashAvailable()
const SANITIZER = 'sanitize-permissions.js'
const GUARD = 'edit-scope-guard.js'
const DIST_BODY = "// node_modules/zod/v3/external.js\nexport const s = 1 // bundled comment\n"
const DIST_FILE = `#!/usr/bin/env node\n${DIST_BODY}`

let root: string
let dist: string
let tick = 0
const cleanup: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-shipped-'))
  dist = mkdtempSync(join(tmpdir(), 'rsct-shipped-dist-'))
  writeFileSync(join(dist, SANITIZER), DIST_FILE)
  writeFileSync(join(dist, GUARD), DIST_FILE.replace('s = 1', 'g = 2'))
  initSweepRepo(root)
  write('.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
  write('README.md', 'fixture\n')
  commitAll(root, 'init')
  git(root, 'checkout', '-q', '-b', 'feat/sweep')
})

afterEach(() => {
  for (const p of [root, dist, ...cleanup.splice(0)]) if (existsSync(p)) rmSync(p, { recursive: true, force: true })
})

function write(rel: string, content: string | Buffer): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function installedCopy(name: string, version = RSCT_MCP_VERSION): string {
  const body = readFileSync(join(dist, name), 'utf8').split('\n').slice(1).join('\n').replace(/\n+$/, '')
  return `#!/usr/bin/env node\n// rsct-mcp v=${version} — installed by /rsct-setup\n${body}\n`
}

function stageScript(rel: string, content: string | Buffer): void {
  write(rel, content)
  git(root, 'add', '-f', rel)
}

function prompts(): (o: DialogOptions) => Promise<DialogResult> {
  return async () => ({ response: 'yes', channel: 'windows' })
}

async function commit(shippedScriptsDir: string | null = dist, projectRoot = root): Promise<RequestCommitOutput> {
  tick++
  return requestCommitHandler(
    {
      project_root: projectRoot,
      message: 'chore: rsct setup',
      dev_approval: {
        timestamp: new Date(Date.now() - 5_000 - tick).toISOString(),
        action_scope: 'commit:feat/sweep:setup',
        reason: `shipped scripts gate test approval number ${tick}`,
      },
    },
    { promptFn: prompts(), shippedScriptsDir },
  )
}

function stateDrift(): unknown {
  const p = join(root, '.rsct', 'phase-state.json')
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>).review_drift : undefined
}

describe.skipIf(!BASH)('shipped scripts — the copies /rsct-setup writes commit without a REVIEW', () => {
  it('the real setup blocks produce copies the gate accepts, with no drift, and the next commit passes', async () => {
    const preamble = `SANITIZER_SRC="$(pwd)/fake-dist/${SANITIZER}"\nRSCT_MCP_VERSION=${RSCT_MCP_VERSION}`
    const seedFiles = {
      [`fake-dist/${SANITIZER}`]: readFileSync(join(dist, SANITIZER), 'utf8'),
      [`fake-dist/${GUARD}`]: readFileSync(join(dist, GUARD), 'utf8'),
    }
    const b = runBlock(ROOT, { promptBasename: '01-setup.md', anchor: 'CHECKPOINT: Phase 4.V.b executing canonical sanitizer script copy', preamble, seedFiles })
    const d = runBlock(ROOT, { promptBasename: '01-setup.md', anchor: 'CHECKPOINT: Phase 4.V.d executing canonical edit-scope guard install', preamble, seedFiles })
    cleanup.push(b.dir, d.dir)
    for (const [dir, name] of [[b.dir, SANITIZER], [d.dir, GUARD]] as const) {
      stageScript(`.rsct/scripts/${name}`, readFileSync(join(dir, '.rsct', 'scripts', name)))
    }
    write('CLAUDE.md', '# project\n')
    git(root, 'add', 'CLAUDE.md')

    const out = await commit()
    expect(out.status).toBe('committed')
    expect(stateDrift()).toBeUndefined()

    write('NOTES.md', 'next\n')
    git(root, 'add', 'NOTES.md')
    expect((await commit()).status).toBe('committed')
  }, 90_000)
})

describe('shipped scripts — only the exact shipped copy is exempt', () => {
  it('the exact copy commits; the REVIEW sweep does not list it', async () => {
    stageScript(`.rsct/scripts/${SANITIZER}`, installedCopy(SANITIZER))
    const sweep = await computeWorkingSweep(root, { shippedScriptsDir: dist })
    expect(sweep.ok && sweep.files.map((f) => f.path)).toEqual([])
    expect((await commit()).status).toBe('committed')
    expect(stateDrift()).toBeUndefined()
  })

  it('a CRLF working copy with an LF index is still the shipped copy', async () => {
    git(root, 'config', 'core.autocrlf', 'true')
    stageScript(`.rsct/scripts/${GUARD}`, installedCopy(GUARD).replace(/\n/g, '\r\n'))
    const sweep = await computeWorkingSweep(root, { shippedScriptsDir: dist })
    expect(sweep.ok && sweep.files.map((f) => f.path)).toEqual([])
    expect((await commit()).status).toBe('committed')
  })

  it('a project in a subdirectory is matched on its own .rsct/scripts', async () => {
    write('app/.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    write(`app/.rsct/scripts/${SANITIZER}`, installedCopy(SANITIZER))
    git(root, 'add', '-f', `app/.rsct/scripts/${SANITIZER}`)
    expect((await commit(dist, join(root, 'app'))).status).toBe('committed')
  })

  it('a project in a subdirectory does not exempt a copy under another directory', async () => {
    write('app/.rsct.json', JSON.stringify({ rsct_version: '1.0.0', app: { name: 'a', org: 'o' } }))
    write(`lib/.rsct/scripts/${SANITIZER}`, installedCopy(SANITIZER))
    git(root, 'add', '-f', `lib/.rsct/scripts/${SANITIZER}`)
    expect((await commit(dist, join(root, 'app'))).status).toBe('rejected')
  })

  const refused: Array<[string, () => void]> = [
    ['one byte changed', () => stageScript(`.rsct/scripts/${SANITIZER}`, installedCopy(SANITIZER).replace('s = 1', 's = 7'))],
    ['code hidden after the stamp with U+2028', () =>
      stageScript(`.rsct/scripts/${SANITIZER}`, installedCopy(SANITIZER).replace('/rsct-setup\n', `/rsct-setup${String.fromCharCode(0x2028)}process.exit(0)\n`))],
    ['code hidden after the stamp with a lone CR', () =>
      stageScript(`.rsct/scripts/${SANITIZER}`, installedCopy(SANITIZER).replace('/rsct-setup\n', '/rsct-setup\rprocess.exit(0)\n'))],
    ['a lone CR inside a comment of the body', () =>
      stageScript(`.rsct/scripts/${SANITIZER}`, installedCopy(SANITIZER).replace('zod/v3', 'zod\r/v3'))],
    ['the exact copy behind a git filter attribute', () => {
      write('.gitattributes', `.rsct/scripts/${SANITIZER} filter=rsctprobe\n`)
      git(root, 'add', '.gitattributes')
      stageScript(`.rsct/scripts/${SANITIZER}`, installedCopy(SANITIZER))
    }],
    ['a stamp from another version', () => stageScript(`.rsct/scripts/${SANITIZER}`, installedCopy(SANITIZER, '0.0.1'))],
    ['the copy under another name', () => stageScript('.rsct/scripts/other.js', installedCopy(SANITIZER))],
    ['the copy outside .rsct/scripts', () => stageScript(`tools/${SANITIZER}`, installedCopy(SANITIZER))],
  ]
  for (const [label, stage] of refused) {
    it(`refuses ${label}`, async () => {
      stage()
      const out = await commit()
      expect(out.status).toBe('rejected')
      expect(['comments_present', 'review_missing']).toContain(out.reject_kind)
    })
  }

  it('without a resolvable shipped directory the exact copy takes the REVIEW path, as before', async () => {
    stageScript(`.rsct/scripts/${SANITIZER}`, installedCopy(SANITIZER))
    expect((await commit(null)).status).toBe('rejected')
  })

  it('a copy whose shipped source is missing is not exempt', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'rsct-shipped-empty-'))
    cleanup.push(empty)
    copyFileSync(join(dist, GUARD), join(empty, GUARD))
    stageScript(`.rsct/scripts/${SANITIZER}`, installedCopy(SANITIZER))
    expect((await commit(empty)).status).toBe('rejected')
  })
})
