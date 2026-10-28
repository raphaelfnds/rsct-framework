import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { requestCommitHandler, type RequestCommitInternal, type RequestCommitOutput } from '../../src/tools/request-commit.js'
import type { DialogOptions, DialogResult } from '../../src/lib/os-dialog.js'
import { defaultGitExecutor, type GitExecutor } from '../../src/lib/git.js'

const GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const SECRET_VALUE = 'sk-AAAAAAAAAAAAAAAAAAAAAAAA'

let root: string
let stamp = 0

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(branch = 'feat/x'): void {
  git('init', '-q', '--template=')
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 't')
  git('config', 'core.autocrlf', 'false')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '.git/hooks')
  writeFileSync(join(root, 'readme.txt'), 'hello\n')
  git('add', 'readme.txt')
  git('commit', '-q', '-m', 'init')
  git('switch', '-q', '-C', branch)
}

function approval(extra: Record<string, unknown> = {}): Record<string, unknown> {
  stamp++
  return { timestamp: new Date(Date.now() - 15_000).toISOString(), action_scope: `commit:${stamp}`, reason: `change ${stamp}`, ...extra }
}

async function commit(
  devApproval: Record<string, unknown>,
  onDialog: (opts: DialogOptions) => void = () => {},
  internal: Partial<RequestCommitInternal> = {},
): Promise<{ out: RequestCommitOutput; dialogs: string[] }> {
  const dialogs: string[] = []
  const out = (await requestCommitHandler(
    { project_root: root, message: 'feat: change', dev_approval: devApproval },
    {
      ...internal,
      now: new Date(),
      promptFn: async (opts: DialogOptions): Promise<DialogResult> => {
        dialogs.push(opts.message)
        onDialog(opts)
        return { response: 'yes', channel: 'windows' }
      },
    },
  )) as RequestCommitOutput
  return { out, dialogs }
}

function hook(body: string): void {
  const path = join(root, '.git', 'hooks', 'pre-commit')
  writeFileSync(path, `#!/bin/sh\n${body}`)
  chmodSync(path, 0o755)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rsct-dialog-'))
})
afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!GIT)('the commit dialog shows every exception it is asked to approve', () => {
  it('lists the secret finding and the agent reason, never the value', async () => {
    initRepo()
    writeFileSync(join(root, 'app.env'), `API_KEY=${SECRET_VALUE}\n`)
    git('add', 'app.env')
    const { out, dialogs } = await commit(approval({ override_secrets_check: { reason: 'fixture value, not a real key' } }))
    expect(out.status).toBe('committed')
    expect(dialogs).toHaveLength(1)
    const text = dialogs[0]!
    expect(text).toContain('⚠ The secrets scan found 1 line(s) that look like a credential')
    expect(text).toContain('• "app.env":1 — value-shape')
    expect(text).not.toContain(SECRET_VALUE)
    const reasonAt = text.indexOf(`Agent's reason for the secret findings: "fixture value, not a real key"`)
    expect(reasonAt).toBeGreaterThan(text.indexOf('Folder: ') > -1 ? text.indexOf('Folder: ') : text.indexOf('Repository: '))
    expect(reasonAt).toBeLessThan(text.indexOf('Commit message:'))
  })

  it('refuses a secret with no exception before any dialog opens', async () => {
    initRepo()
    writeFileSync(join(root, 'app.env'), `API_KEY=${SECRET_VALUE}\n`)
    git('add', 'app.env')
    const { out, dialogs } = await commit(approval())
    expect(out.reject_kind).toBe('secrets')
    expect(dialogs).toEqual([])
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('refuses a protected branch with no exception before any dialog, and shows it when asked', async () => {
    initRepo('main')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const refused = await commit(approval())
    expect(refused.out.reject_kind).toBe('protected_branch')
    expect(refused.dialogs).toEqual([])
    const allowed = await commit(approval({ override_protected_branch: { reason: 'solo maintainer flow' } }))
    expect(allowed.out.status).toBe('committed')
    expect(allowed.dialogs[0]).toContain(`⚠ 'main' is a protected branch: committing here needs your exception.`)
    expect(allowed.dialogs[0]).toContain(`Agent's reason for the protected branch: "solo maintainer flow"`)
  })

  it('cuts a long list in the dialog and writes the full list to a report', async () => {
    initRepo()
    writeFileSync(join(root, 'many.env'), Array.from({ length: 12 }, (_, i) => `token.${i}=v${i}`).join('\n') + '\n')
    git('add', 'many.env')
    const { out, dialogs } = await commit(approval({ override_secrets_check: { reason: 'fixtures' } }))
    expect(out.status).toBe('committed')
    expect(dialogs[0]).toContain('… and 2 more')
    const report = /Full list: (\.rsct\/reports\/commit-secrets-[0-9a-f]{16}\.md)/.exec(dialogs[0]!)?.[1]
    expect(report).toBeDefined()
    expect(readFileSync(join(root, report!), 'utf8').match(/^- "many\.env":/gm)).toHaveLength(12)
  })

  it('shows the whole list when the report cannot be written', async () => {
    initRepo()
    mkdirSync(join(root, '.rsct'), { recursive: true })
    writeFileSync(join(root, '.rsct', 'reports'), 'not a folder\n')
    writeFileSync(join(root, 'many.env'), Array.from({ length: 12 }, (_, i) => `token.${i}=v${i}`).join('\n') + '\n')
    git('add', 'many.env')
    const { out, dialogs } = await commit(approval({ override_secrets_check: { reason: 'fixtures' } }))
    expect(out.status).toBe('committed')
    expect(dialogs[0]!.match(/^• "many\.env":/gm)).toHaveLength(12)
    expect(dialogs[0]).not.toMatch(/… and \d+ more/)
    expect(dialogs[0]).not.toContain('Full list')
  })

  it('shows nothing extra when there is nothing to approve beyond the commit', async () => {
    initRepo()
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { dialogs } = await commit(approval())
    expect(dialogs[0]).not.toContain('⚠')
    expect(dialogs[0]).not.toContain("Agent's reason")
  })
})

describe.skipIf(!GIT)('the commit is exactly what the developer approved', () => {
  it('refuses when something is staged while the dialog is open', async () => {
    initRepo()
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval(), () => {
      writeFileSync(join(root, 'late.env'), `API_KEY=${SECRET_VALUE}\n`)
      git('add', 'late.env')
    })
    expect(out.reject_kind).toBe('staged_changed')
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('refuses when HEAD moves while the dialog is open', async () => {
    initRepo()
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval(), () => {
      git('commit', '-q', '--allow-empty', '-m', 'sneaked in')
    })
    expect(out.reject_kind).toBe('staged_changed')
  })

  it('reports a hook that adds a file with a secret, and how to undo the commit', async () => {
    initRepo()
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test-app', org: 'test-org' } }))
    writeFileSync(join(root, 'late.env'), `API_KEY=${SECRET_VALUE}\n`)
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\ngit add -f late.env\n')
    chmodSync(hook, 0o755)
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const first = await commit(approval())
    expect(first.out.status).toBe('committed_with_drift')
    expect(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['b.txt', 'late.env'])
    const hint = first.out.hints.find((h) => h.includes('late.env changed after the approval, with 1 secret finding(s)'))
    expect(hint).toContain('git reset --soft HEAD~1')
    const audit = readdirSync(join(root, '.rsct')).includes('audit.log') ? readFileSync(join(root, '.rsct', 'audit.log'), 'utf8') : ''
    expect(audit).toContain('"event":"request_commit.tree_drift"')
  })

  it('does not lock later commits after a formatting hook rewrote a non-code file', async () => {
    initRepo()
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test-app', org: 'test-org' } }))
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nprintf "# Title\\n" > README.md\ngit add README.md\n')
    chmodSync(hook, 0o755)
    writeFileSync(join(root, 'README.md'), '#   Title\n')
    git('add', 'README.md')
    const first = await commit(approval())
    expect(first.out.status).toBe('committed_with_drift')
    rmSync(hook)
    writeFileSync(join(root, 'c.txt'), 'c\n')
    git('add', 'c.txt')
    const second = await commit(approval())
    expect(second.out.status).toBe('committed')
  })

  it('refuses when the branch is switched while the dialog is open', async () => {
    initRepo()
    git('branch', '-f', 'main', 'HEAD')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval(), () => {
      git('switch', '-q', 'main')
    })
    expect(out.reject_kind).toBe('staged_changed')
    expect(git('log', '--oneline', 'main').trim().split('\n')).toHaveLength(1)
  })

  it('reports a hook that adds a file with no secret in it too', async () => {
    initRepo()
    writeFileSync(join(root, 'extra.txt'), 'nothing secret\n')
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\ngit add -f extra.txt\n')
    chmodSync(hook, 0o755)
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval())
    expect(out.status).toBe('committed_with_drift')
    expect(out.hints.some((h) => h.includes('extra.txt changed after the approval') && !h.includes('secret finding'))).toBe(true)
  })

  it('accepts a hook that changes nothing', async () => {
    initRepo()
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    chmodSync(hook, 0o755)
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval())
    expect(out.status).toBe('committed')
  })
})

describe.skipIf(!GIT)('the commit dialog cuts a long contract list', () => {
  const pad = (i: number): string => String(i).padStart(2, '0')

  async function contractCommit(
    contracts: Array<{ id: string; dirs: number[]; consumers: string[] }>,
    reportsBlocked = false,
  ): Promise<{ text: string; report: string | null }> {
    initRepo()
    if (reportsBlocked) {
      mkdirSync(join(root, '.rsct'), { recursive: true })
      writeFileSync(join(root, '.rsct', 'reports'), 'not a folder\n')
    }
    const universe = mkdtempSync(join(tmpdir(), 'rsct-dialog-uni-'))
    try {
      mkdirSync(join(universe, 'applications', 'registered-app'), { recursive: true })
      writeFileSync(join(universe, '.universe.json'), JSON.stringify({ name: 'x', registered_apps: ['registered-app'] }))
      const graph = contracts.map((c) => ({ id: c.id, producer: 'registered-app', surface: c.dirs.map((d) => `api/c${d}/**`), consumers: c.consumers }))
      writeFileSync(join(universe, 'contracts.json'), JSON.stringify({ contract_version: '1.0.0', contracts: graph }))
      writeFileSync(
        join(root, '.rsct.json'),
        JSON.stringify({ rsct_version: '1.0.0', app: { name: 'registered-app', org: 'acme' }, topology: { mode: 'multi-repo' }, universe: { local: universe } }),
      )
      for (const d of contracts.flatMap((c) => c.dirs)) {
        mkdirSync(join(root, 'api', `c${d}`), { recursive: true })
        writeFileSync(join(root, 'api', `c${d}`, 'spec.yaml'), `v: ${d}\n`)
      }
      git('add', 'api')
      const { out, dialogs } = await commit(approval({ override_contract_surface: { reason: 'coordinated bump' } }))
      expect(out.status).toBe('committed')
      const text = dialogs[0]!
      const rel = /Full list: (\.rsct\/reports\/commit-contracts-[0-9a-f]{16}\.md)/.exec(text)?.[1]
      return { text, report: rel === undefined ? null : readFileSync(join(root, rel), 'utf8') }
    } finally {
      rmSync(universe, { recursive: true, force: true })
    }
  }

  it('shows ten contract surfaces and ten consumers, and writes the full lists to a report', async () => {
    const { text, report } = await contractCommit(Array.from({ length: 12 }, (_, i) => ({ id: `surface-${pad(i)}`, dirs: [i], consumers: [`consumer-${pad(i)}`] })))
    expect(text).toContain('"surface-09" … and 2 more; declared consumers: ')
    expect(text).not.toContain('"surface-10"')
    expect(text).toContain('"consumer-09" … and 2 more.')
    expect(report?.match(/^- surface "surface-\d+"$/gm)).toHaveLength(12)
    expect(report?.match(/^- consumer "consumer-\d+"$/gm)).toHaveLength(12)
  })

  it('writes the report when only the consumers are too many', async () => {
    const { text, report } = await contractCommit([{ id: 'one-surface', dirs: [0], consumers: Array.from({ length: 12 }, (_, i) => `consumer-${pad(i)}`) }])
    expect(text).toContain('contract surface "one-surface"; declared consumers: ')
    expect(text).toContain('"consumer-09" … and 2 more.')
    expect(report?.match(/^- consumer "consumer-\d+"$/gm)).toHaveLength(12)
  })

  it('shows every surface and consumer when the report cannot be written', async () => {
    const { text, report } = await contractCommit(
      Array.from({ length: 12 }, (_, i) => ({ id: `surface-${pad(i)}`, dirs: [i], consumers: [`consumer-${pad(i)}`] })),
      true,
    )
    expect(report).toBeNull()
    expect(text).not.toContain('Full list')
    expect(text).toContain('"surface-11"; declared consumers: ')
    expect(text).toContain('"consumer-11".')
    expect(text).not.toMatch(/… and \d+ more/)
  })

  it('writes no report when every name fits', async () => {
    const { text, report } = await contractCommit([{ id: 'one-surface', dirs: [0], consumers: ['web'] }])
    expect(text).toContain('⚠ This commit changes contract surface "one-surface"; declared consumers: "web".')
    expect(report).toBeNull()
  })
})

describe.skipIf(!GIT)('the branch, the first commit and a commit a hook makes on its own', () => {
  function unborn(branch: string): void {
    git('init', '-q', '--template=')
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    git('config', 'user.email', 't@example.invalid')
    git('config', 'user.name', 't')
    git('config', 'core.autocrlf', 'false')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.hooksPath', '.git/hooks')
    git('symbolic-ref', 'HEAD', `refs/heads/${branch}`)
  }

  it('refuses when the branch that was checked is not the branch git would commit on', async () => {
    initRepo('main')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out, dialogs } = await commit(approval(), () => {}, {
      gitStateOverride: { available: true, branch: 'feat/x', head_sha: null, is_clean: false },
    })
    expect(out.reject_kind).toBe('staged_changed')
    expect(dialogs).toEqual([])
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('still commits on a detached HEAD', async () => {
    initRepo()
    git('checkout', '-q', '--detach')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval())
    expect(out.status).toBe('committed')
  })

  it('treats the first commit on a protected branch as a protected-branch commit', async () => {
    unborn('main')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const refused = await commit(approval())
    expect(refused.out.reject_kind).toBe('protected_branch')
    expect(refused.dialogs).toEqual([])
    const allowed = await commit(approval({ override_protected_branch: { reason: 'first publication' } }))
    expect(allowed.out.status).toBe('committed')
    expect(allowed.dialogs[0]).toContain(`⚠ 'main' is a protected branch`)
  })

  it('names the undo of a first commit that a hook changed', async () => {
    unborn('feat/x')
    writeFileSync(join(root, 'extra.txt'), 'extra\n')
    hook('git add -f extra.txt\n')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval())
    expect(out.status).toBe('committed_with_drift')
    const hint = out.hints.find((h) => h.includes('extra.txt changed after the approval'))
    expect(hint).toContain('`git update-ref -d HEAD` undoes this first commit')
  })

  it('reports a commit a hook made on its own when git commit then fails', async () => {
    initRepo()
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test-app', org: 'test-org' } }))
    writeFileSync(join(root, 'sneaked.txt'), 'x\n')
    hook('git add -f sneaked.txt\ngit commit -q --no-verify -m sneaked\n')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval())
    expect(out.status).toBe('mutation_failed')
    const sneaked = git('rev-parse', 'HEAD').trim()
    expect(git('log', '-1', '--format=%s').trim()).toBe('sneaked')
    expect(out.hints.some((h) => h.includes(`HEAD moved to ${sneaked.slice(0, 12)}`))).toBe(true)
    expect(readFileSync(join(root, '.rsct', 'audit.log'), 'utf8')).toContain(`"head_moved_to":"${sneaked}"`)
  })

  it('reports a commit it could not read back as drift', async () => {
    initRepo()
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval(), () => {}, {
      gitExecutor: () => ({ ok: true, stdout: 'aaaa111\n', stderr: '', exitCode: 0 }),
    })
    expect(out.status).toBe('committed_with_drift')
    expect(out.hints.some((h) => h.includes('could not compare the commit'))).toBe(true)
  })
})

describe.skipIf(!GIT)('what lands is checked after git commit too', () => {
  it('reports a hook that switches the branch during the commit', async () => {
    initRepo()
    writeFileSync(join(root, '.rsct.json'), JSON.stringify({ rsct_version: '1.0.0', app: { name: 'test-app', org: 'test-org' } }))
    git('branch', '-f', 'main', 'HEAD')
    hook('git symbolic-ref HEAD refs/heads/main\n')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const { out } = await commit(approval())
    expect(out.status).toBe('committed_with_drift')
    expect(git('log', '--oneline', 'main').trim().split('\n')).toHaveLength(2)
    expect(out.hints.some((h) => h.includes('landed with HEAD on refs/heads/main, not on the approved refs/heads/feat/x'))).toBe(true)
    expect(readFileSync(join(root, '.rsct', 'audit.log'), 'utf8')).toContain('"event":"request_commit.branch_drift"')
  })

  it('reports a commit whose id cannot be read back after it landed', async () => {
    initRepo()
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    let headReads = 0
    const executor: GitExecutor = (cwd, args) => {
      if (args[0] === 'rev-parse' && ++headReads > 1) return { ok: false, stdout: '', stderr: 'boom', exitCode: 1 }
      return defaultGitExecutor(cwd, args)
    }
    const { out } = await commit(approval(), () => {}, { gitExecutor: executor })
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(2)
    expect(out.status).toBe('committed_with_drift')
    expect(out.hints.some((h) => h.includes('could not compare the commit'))).toBe(true)
  })

  it('says nothing about HEAD when a failed commit left it where it was', async () => {
    initRepo()
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const executor: GitExecutor = (cwd, args) =>
      args[0] === 'commit' ? { ok: false, stdout: '', stderr: 'nothing happened', exitCode: 1 } : defaultGitExecutor(cwd, args)
    const { out } = await commit(approval(), () => {}, { gitExecutor: executor })
    expect(out.status).toBe('mutation_failed')
    expect(out.hints.join('\n')).not.toContain('HEAD moved')
    expect(out.hints.some((h) => h.includes('approval NOT consumed'))).toBe(true)
  })

  it('says the branch was switched, not that a commit landed, when a hook moved HEAD to another branch', async () => {
    initRepo()
    git('update-ref', 'refs/heads/other', git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'other').trim())
    hook('git symbolic-ref HEAD refs/heads/other\n')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const before = git('rev-parse', 'refs/heads/other').trim()
    const { out } = await commit(approval())
    expect(out.status).toBe('mutation_failed')
    expect(git('rev-parse', 'refs/heads/other').trim()).toBe(before)
    const text = out.hints.join('\n')
    expect(text).toContain('HEAD now points at refs/heads/other instead of the approved refs/heads/feat/x')
    expect(text).not.toContain('a commit landed')
  })

  it('treats the approval as used once a hook committed during the attempt', async () => {
    initRepo()
    writeFileSync(join(root, 'sneaked.txt'), 'x\n')
    hook('git add -f sneaked.txt\ngit commit -q --no-verify -m sneaked\n')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    const used = approval()
    const first = await commit(used)
    expect(first.out.status).toBe('mutation_failed')
    expect(first.out.anti_replay_persisted).toBe(true)
    expect(first.out.hints.join('\n')).not.toContain('retry with the same dev_approval')
    expect(first.out.hints.join('\n')).not.toContain('token action')
    rmSync(join(root, '.git', 'hooks', 'pre-commit'))
    writeFileSync(join(root, 'c.txt'), 'c\n')
    git('add', 'c.txt')
    const again = await commit(used)
    expect(again.out.reject_kind).toBe('reused')
    expect(again.dialogs).toEqual([])
  })
})
