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
  /** GitHub issue type, when the host repo exposes any. Omitted otherwise. */
  type?: string
}

export function isGhAvailable(): boolean {
  try {
    execFileSync('gh', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Labels and issue types the HOST repository actually offers.
 *
 * The framework must fit the repo's triage vocabulary, never impose its own:
 * `gh issue create` errors on an unknown `--label`, so a hardcoded default made
 * the create path fail on any repo that had not been pre-seeded by hand — the
 * exact friction the tool exists to remove.
 *
 * Both lists degrade to empty on ANY failure (gh missing, unauthenticated, no
 * remote, an older gh without `--json`, a personal repo where issue types are
 * not a feature). Empty means "attach nothing", which always succeeds — never a
 * hardcoded fallback that is known to error.
 */
export interface GhRepoVocabulary {
  labels: string[]
  types: string[]
  /** False when discovery could not run at all (gh absent / repo unreachable). */
  discovered: boolean
}

function ghJson(cwd: string, args: string[]): unknown {
  try {
    const stdout = execFileSync('gh', args, { encoding: 'utf8', cwd, stdio: 'pipe' })
    return JSON.parse(stdout) as unknown
  } catch {
    return null
  }
}

export function readRepoVocabulary(cwd: string): GhRepoVocabulary {
  if (!isGhAvailable()) return { labels: [], types: [], discovered: false }

  const rawLabels = ghJson(cwd, ['label', 'list', '--limit', '200', '--json', 'name'])
  const labels = Array.isArray(rawLabels)
    ? rawLabels
        .map((l) => (l as { name?: unknown })?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
    : []

  // Issue types are an organization-level feature; a personal repo simply has
  // none, and the endpoint 404s. Absence is normal, not an error.
  const rawTypes = ghJson(cwd, [
    'api',
    'repos/{owner}/{repo}/issues/types',
    '--jq',
    '[.[].name]',
  ])
  const types = Array.isArray(rawTypes)
    ? rawTypes.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : []

  return { labels, types, discovered: rawLabels !== null }
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

  const baseArgs = ['issue', 'create', '--title', input.title, '--body', input.body]
  for (const label of input.labels ?? []) {
    baseArgs.push('--label', label)
  }
  const args = input.type ? [...baseArgs, '--type', input.type] : baseArgs

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

    // `--type` needs gh ≳2.60, while the API endpoint that discovers types works
    // on every version — so a repo WITH issue types plus an older gh would fail
    // every create. Retry once without it: the type is a nicety, the issue is not.
    if (input.type && /unknown flag: --type/i.test(stderr)) {
      const { type: _dropped, ...withoutType } = input
      return createIssue(withoutType)
    }

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
