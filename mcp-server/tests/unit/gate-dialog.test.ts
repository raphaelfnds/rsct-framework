import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gateDialogFooter, anchorHints } from '../../src/lib/gate-dialog.js'
import { repositoryDialogLine, clearAnchorCache, canonicalPath } from '../../src/lib/repo-anchor.js'
import {
  effectiveProtectedList,
  narrowedProtectionNotice,
  DEFAULT_PROTECTED_BRANCHES,
} from '../../src/lib/branch-protection.js'

/**
 * #92 defects A + F. The dialog is the one channel an agent cannot forge — but
 * MEASURED, it never named the repository, so it could be AIMED: the developer
 * read a true, complete and useless sentence about a branch while the anchors
 * sat somewhere else.
 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const GIT = hasGit()

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 't@t.t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'README.md'), '# app\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-qm', 'init'])
}

let box: string
beforeEach(() => {
  box = canonicalPath(mkdtempSync(join(tmpdir(), 'rsct-dialog-')))
  clearAnchorCache()
})
afterEach(() => {
  clearAnchorCache()
  if (existsSync(box)) rmSync(box, { recursive: true, force: true })
})

describe.runIf(GIT)('the dialog names the repository', () => {
  it('a plain repo is named', () => {
    // Mutation that reddens: return an empty string from repositoryDialogLine.
    const repo = join(box, 'repo')
    initRepo(repo)
    expect(repositoryDialogLine(repo)).toContain(repo.replace(/\\/g, '/'))
  })

  it('a crafted subdirectory names the REPOSITORY and warns that it is not the folder passed', () => {
    // Mutation that reddens: drop the `relocated` branch, so the dialog would
    // name only one directory and the developer could not tell them apart.
    const repo = join(box, 'repo')
    initRepo(repo)
    const crafted = join(repo, 'docs', 'scratch')
    mkdirSync(crafted, { recursive: true })

    const line = repositoryDialogLine(crafted)
    expect(line).toContain(repo.replace(/\\/g, '/'))
    expect(line).toContain(crafted.replace(/\\/g, '/'))
    expect(line).toContain('NOT at the folder you passed')
  })

  it('a non-git folder says so rather than claiming a repository', () => {
    // Mutation that reddens: label every status `Repository:`.
    const plain = join(box, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(repositoryDialogLine(plain)).toContain('not a git repository')
  })
})

describe('the narrowed-protection notice', () => {
  it('says nothing when the config protects at least the default', () => {
    // Mutation that reddens: emit the notice unconditionally.
    expect(narrowedProtectionNotice(effectiveProtectedList(undefined))).toBe('')
    expect(
      narrowedProtectionNotice(
        effectiveProtectedList({ protected_branches: [...DEFAULT_PROTECTED_BRANCHES, 'release'] }),
      ),
    ).toBe('')
  })

  it('names the branches a narrowed config dropped', () => {
    // Mutation that reddens: compute `narrowed` from the config instead of from
    // DEFAULT_PROTECTED_BRANCHES. MEASURED: `["release/*"]` drops main, master,
    // test and dev, and the schema `.min(1)` guard only ever caught the EMPTY
    // array — a non-empty list that merely omits `main` passes it.
    const notice = narrowedProtectionNotice(
      effectiveProtectedList({ protected_branches: ['release/*'] }),
    )
    expect(notice).toContain('main')
    expect(notice).toContain('master')
    expect(notice).toContain('FEWER branches')
  })

  it('narrowing stays LEGAL — the list still resolves to what the config asked for', () => {
    // Mutation that reddens: make the list additive. That would remove a
    // capability the design documents on purpose (`.rsct.json` REPLACES the
    // default), which is why the fix surfaces the fact instead of forbidding it.
    expect(effectiveProtectedList({ protected_branches: ['release/*'] }).list).toEqual([
      'release/*',
    ])
  })
})

describe.runIf(GIT)('gateDialogFooter', () => {
  it('omits the protection notice when no config is passed', () => {
    // Mutation that reddens: always compute the notice, so tools that do not
    // gate on branch protection would carry irrelevant text.
    const repo = join(box, 'repo')
    initRepo(repo)
    expect(gateDialogFooter(repo)).not.toContain('FEWER branches')
  })

  it('carries both facts when the config narrows protection', () => {
    // Mutation that reddens: return only the repository line.
    const repo = join(box, 'repo')
    initRepo(repo)
    const footer = gateDialogFooter(repo, { protected_branches: ['release/*'] })
    expect(footer).toContain('Repository:')
    expect(footer).toContain('FEWER branches')
  })
})

describe.runIf(GIT)('the relocation is reported in the OUTPUT, not only the dialog', () => {
  it('a relocated root produces a hint naming the repository', () => {
    // Mutation that reddens: return [] from anchorHints. `gateRequest` falls
    // back to the `trust` channel when no dialog channel exists, and on that
    // path the dialog footer is never rendered — so a relocation announced only
    // in a dialog is invisible exactly where nobody is watching.
    const repo = join(box, 'repo')
    initRepo(repo)
    const crafted = join(repo, 'docs', 'scratch')
    mkdirSync(crafted, { recursive: true })

    const hints = anchorHints(crafted)
    expect(hints.length).toBeGreaterThan(0)
    expect(hints.join('\n')).toContain(repo.replace(/\\/g, '/'))
  })

  it('a plain repo produces NO hint — the common case must stay quiet', () => {
    // Mutation that reddens: emit the hint on every status.
    const repo = join(box, 'repo')
    initRepo(repo)
    expect(anchorHints(repo)).toEqual([])
  })

  it('an audit.path escaping the project is reported and says why it matters', () => {
    // Mutation that reddens: drop the `escaped` hint, leaving the developer
    // silently redirected to a different log than they configured.
    const repo = join(box, 'repo')
    initRepo(repo)
    const hints = anchorHints(repo, { path: join(box, 'elsewhere', 'a.log') })
    expect(hints.join('\n')).toContain('resolves OUTSIDE')
    expect(hints.join('\n')).toContain('swapped for a blank one')
  })
})

describe('D1 is pinned — a relocation must never become a refusal', () => {
  // This test exists because the spec CONTRADICTED ITSELF and the contradiction
  // was caught with the code half-written: an audit note said the gated tools
  // should "fail closed on relocated", while D1 — the developer's decision —
  // says relocate and say so. Implementing the note would have refused a
  // monorepo package and a project nested in an unrelated repo, both MEASURED
  // legitimate. Relocation is the fix, not the fault.
  const GATED = [
    'request-commit',
    'request-push',
    'request-merge',
    'request-rebase',
    'plan-authorize',
  ]
  for (const tool of GATED) {
    it(`${tool} does not reject on a relocated anchor`, () => {
      // Mutation that reddens: add `if (anchor.status === 'relocated') return reject(...)`.
      const src = readFileSync(join(process.cwd(), 'src', 'tools', `${tool}.ts`), 'utf8')
      expect(src).not.toMatch(/status\s*===\s*['"]relocated['"]/)
      expect(src).toContain('anchorHints(projectRoot')
    })
  }
})

describe('every §C-gated tool carries the footer', () => {
  // A structural guard, in the spirit of tool-registration.test.ts: without it,
  // removing the footer from ONE tool leaves that tool's dialog anonymous again
  // and no behavioural test would notice.
  const GATED = [
    'request-commit',
    'request-push',
    'request-merge',
    'request-rebase',
    'plan-authorize',
  ]
  for (const tool of GATED) {
    it(`${tool} appends gateDialogFooter to its dialog message`, () => {
      // Mutation that reddens: delete the call from that tool.
      const src = readFileSync(join(process.cwd(), 'src', 'tools', `${tool}.ts`), 'utf8')
      expect(src).toContain('gateDialogFooter(projectRoot')
    })
  }
})
