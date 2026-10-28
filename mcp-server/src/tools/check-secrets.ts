import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { readGitState } from '../lib/git.js'
import {
  compileExtraPatterns,
  scanDiffForSecrets,
  type SecretFinding,
} from '../lib/secrets.js'
import { scanGitDiff } from '../lib/staged-scan.js'

export const checkSecretsInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.'),
    staged_only: z
      .boolean()
      .optional()
      .describe(
        'When true (default), scan only `git diff --cached`. When false, scan unstaged changes too.',
      ),
    diff_override: z
      .string()
      .optional()
      .describe(
        'For testing/programmatic use: provide a unified diff string directly instead of reading from git. Bypasses `staged_only`.',
      ),
  })
  .strict()

export type CheckSecretsInput = z.infer<typeof checkSecretsInputSchema>

export interface CheckSecretsOutput {
  rsct_installed: boolean
  in_git_repo: boolean
  staged_only: boolean
  findings: SecretFinding[]
  read_error: string | null
  scanned_extra_patterns: number
  invalid_extra_patterns: Array<{ index: number; pattern: string; error: string }>
  hints: string[]
}

export const checkSecretsTool: Tool = {
  name: 'rsct_check_secrets',
  description:
    'Pure query (INV-6): scan staged diff for credentials. Reports findings without blocking — rsct_request_commit will actually refuse the commit unless dev_approval.override_secrets_check is provided. Patterns come from the framework defaults plus optional `secrets_extra_patterns[]` regexes in .rsct.json. Excerpts are masked. It reads with the flags rsct_request_commit uses (attributes, diff drivers and repository config cannot hide content). Outside a git repository it returns no findings; when git cannot be read it reports read_error, never "no findings".',
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection. The SHARED anchors (audit log, approval anti-reuse store) resolve at the GIT REPOSITORY this path sits in, not at the path itself — a subdirectory cannot present its own budget, lock or history for commits that land in the parent.',
      },
      staged_only: {
        type: 'boolean',
        description:
          'When true (default), scan only `git diff --cached`. When false, scan unstaged changes too.',
      },
      diff_override: {
        type: 'string',
        description:
          'For testing/programmatic use: provide a unified diff string directly. Bypasses staged_only.',
      },
    },
    additionalProperties: false,
  },
}

export async function checkSecretsHandler(
  rawInput: unknown,
): Promise<CheckSecretsOutput> {
  const input = checkSecretsInputSchema.parse(rawInput ?? {})
  const staged_only = input.staged_only ?? true
  const resolution = resolveProjectRoot(input.project_root)
  const git = readGitState(resolution.root)

  const extras = compileExtraPatterns(resolution.config?.secrets_extra_patterns ?? [])

  let findings: SecretFinding[] = []
  let readError: string | null = null
  const diffPresent = input.diff_override !== undefined || git.available
  if (input.diff_override !== undefined) {
    findings = scanDiffForSecrets(input.diff_override, extras.compiled)
  } else {
    for (const which of staged_only ? (['staged'] as const) : (['staged', 'unstaged'] as const)) {
      const scan = await scanGitDiff(resolution.root, which, extras.compiled)
      if (!scan.ok) {
        readError = `${which} changes: ${scan.reason}`
        break
      }
      findings.push(...scan.findings)
    }
  }

  return {
    rsct_installed: resolution.rsct_installed,
    in_git_repo: git.available,
    staged_only,
    findings,
    read_error: readError,
    scanned_extra_patterns: extras.compiled.length,
    invalid_extra_patterns: extras.invalid,
    hints: buildHints({
      rsct_installed: resolution.rsct_installed,
      in_git_repo: git.available,
      diff_present: diffPresent,
      read_error: readError,
      findings_count: findings.length,
      invalid_extras: extras.invalid.length,
    }),
  }
}

interface HintInputs {
  rsct_installed: boolean
  in_git_repo: boolean
  diff_present: boolean
  read_error: string | null
  findings_count: number
  invalid_extras: number
}

function buildHints(input: HintInputs): string[] {
  const hints: string[] = []
  if (input.read_error !== null) {
    hints.push(
      `The scan could NOT read the changes (${input.read_error}). This is not "no findings": rsct_request_commit refuses a commit it cannot read.`,
    )
  }
  if (!input.rsct_installed) {
    hints.push(
      'No .rsct.json — running secrets scan with framework default patterns only.',
    )
  }
  if (!input.in_git_repo && !input.diff_present) {
    hints.push(
      'Not inside a git repository — secrets scan returned empty. Pass `diff_override` for what-if checks.',
    )
  }
  if (input.findings_count > 0) {
    hints.push(
      `${input.findings_count} secret finding(s). rsct_request_commit will reject this commit unless dev_approval includes override_secrets_check: { reason }.`,
    )
  } else if (input.read_error === null && (input.in_git_repo || input.diff_present)) {
    hints.push('No secret patterns matched the scanned diff.')
  }
  if (input.invalid_extras > 0) {
    hints.push(
      `${input.invalid_extras} entry/entries in secrets_extra_patterns failed to compile as regex — they were skipped. See invalid_extra_patterns for details.`,
    )
  }
  return hints
}
