import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function initSweepRepo(root: string): void {
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'sweep@test.invalid')
  git(root, 'config', 'user.name', 'sweep')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.hooksPath', '.no-hooks')
  appendFileSync(join(root, '.gitignore'), '.rsct/\n')
}

export function commitAll(root: string, message = 'fixture'): string {
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', message, '--allow-empty')
  return git(root, 'rev-parse', 'HEAD').trim()
}
