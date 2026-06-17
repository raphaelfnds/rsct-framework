import { execFileSync } from 'node:child_process'

/**
 * Thin wrapper around the `gh` (GitHub CLI) — used by
 * `rsct_capture_issue` to materialize draft issues as real GitHub
 * issues without an external HTTP dep. Failures degrade gracefully
 * (the tool returns `{ ok: false, reason }`) so the dev sees the
 * specific failure mode (gh missing / not authenticated / no remote
 * / other) and can take the right action.
 *
 * Future tools (e.g., capture_pr_comment, link_issue_to_phase) can
 * reuse this lib. Multi-provider support (GitLab, Bitbucket) is
 * deferred — the `provider` field in `.rsct.json` is the planned
 * extension point.
 */

export type GhCreateIssueFailure =
  | { ok: false; reason: 'not_installed'; error: string }
  | { ok: false; reason: 'not_authenticated'; error: string }
  | { ok: false; reason: 'no_remote'; error: string }
  | { ok: false; reason: 'failed'; error: string }

export type GhCreateIssueResult =
  | { ok: true; url: string; raw_stdout: string }
  | GhCreateIssueFailure

export interface GhCreateIssueInput {
  cwd: string
  title: string
  body: string
  labels?: string[]
}

export function isGhAvailable(): boolean {
  try {
    execFileSync('gh', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export function createIssue(input: GhCreateIssueInput): GhCreateIssueResult {
  if (!isGhAvailable()) {
    return {
      ok: false,
      reason: 'not_installed',
      error:
        'gh CLI not found in PATH. Install from https://cli.github.com/ or use mode=draft to get the issue body for manual creation.',
    }
  }

  const args = ['issue', 'create', '--title', input.title, '--body', input.body]
  for (const label of input.labels ?? []) {
    args.push('--label', label)
  }

  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf8',
      cwd: input.cwd,
      stdio: 'pipe',
    })
    const url =
      stdout
        .trim()
        .split('\n')
        .find((line) => /^https?:\/\//.test(line)) ?? stdout.trim()
    return { ok: true, url, raw_stdout: stdout }
  } catch (err) {
    const errObj = err as { message?: string; stderr?: Buffer | string }
    const stderr = errObj?.stderr ? String(errObj.stderr) : ''
    const errorText = errObj?.message ?? 'gh issue create failed'

    if (
      stderr.toLowerCase().includes('authentication') ||
      stderr.toLowerCase().includes('not logged in') ||
      stderr.toLowerCase().includes('gh auth login')
    ) {
      return {
        ok: false,
        reason: 'not_authenticated',
        error: stderr || errorText,
      }
    }
    if (
      stderr.toLowerCase().includes('no git remote') ||
      stderr.toLowerCase().includes('gh_repo') ||
      stderr.toLowerCase().includes('not a git repository')
    ) {
      return { ok: false, reason: 'no_remote', error: stderr || errorText }
    }
    return { ok: false, reason: 'failed', error: stderr || errorText }
  }
}
