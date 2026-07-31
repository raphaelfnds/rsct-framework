import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  gateRequest,
  type GateChannel,
  type GateRejectKind,
} from '../lib/request-gate.js'
import {
  promptYesNo,
  type DialogOptions,
  type DialogResult,
} from '../lib/os-dialog.js'
import {
  recordConsumedApproval,
  type FabricationSignal,
} from '../lib/dev-approval.js'
import { appendAuditEntry, auditFields } from '../lib/audit-log.js'
import {
  createIssue as ghCreateIssue,
  isGhAvailable,
  readRepoVocabulary,
  type GhCreateIssueResult,
  type GhRepoVocabulary,
} from '../lib/gh.js'

const SEVERITY_VALUES = ['critical', 'high', 'medium', 'low'] as const
type Severity = (typeof SEVERITY_VALUES)[number]

const MODE_VALUES = ['draft', 'create'] as const
type Mode = (typeof MODE_VALUES)[number]

export const captureIssueInputSchema = z
  .object({
    project_root: z.string().optional(),
    title: z
      .string()
      .min(10, 'title must be ≥10 chars')
      .max(200, 'title must be ≤200 chars')
      .describe('Issue title — shown in the GitHub issue list.'),
    body: z
      .string()
      .min(50, 'body must be ≥50 chars')
      .describe(
        'Markdown body of the issue. The tool prepends a severity badge + Affected paths section + captured footer.',
      ),
    severity: z
      .enum(SEVERITY_VALUES)
      .describe(
        'critical / high / medium / low. Surfaced as a badge at the top of the issue.',
      ),
    affected_paths: z
      .array(z.string())
      .optional()
      .describe(
        'Project-relative paths the finding touches. Rendered as a bullet list under "Affected paths".',
      ),
    labels: z
      .array(z.string())
      .optional()
      .describe(
        'GitHub labels to attach (mode=create only). OMIT to let RSCT pick from the labels the host repository actually has (matched by severity); an issue is created unlabeled rather than failing when nothing matches. Supplied labels are honored verbatim; one that does not exist is warned about, and gh will reject it.',
      ),
    mode: z
      .enum(MODE_VALUES)
      .default('draft')
      .describe(
        '"draft" returns the formatted body for manual creation via web (no §C, no external mutation). "create" invokes gh issue create with §C-gate.',
      ),
    dev_approval: z
      .unknown()
      .optional()
      .describe(
        'Required when mode="create". action_scope SHOULD start with "capture_issue:" (INV-2.2).',
      ),
  })
  .strict()

export type CaptureIssueInput = z.infer<typeof captureIssueInputSchema>

export type CaptureIssueStatus =
  | 'drafted'
  | 'created'
  | 'rejected'
  | 'gh_unavailable'
  | 'gh_failed'
  | 'missing_dev_approval'

export type CaptureIssueRejectKind =
  | GateRejectKind
  | 'gh_not_installed'
  | 'gh_not_authenticated'
  | 'gh_no_remote'
  | 'gh_other'

export interface CaptureIssueOutput {
  status: CaptureIssueStatus
  mode: Mode
  channel: GateChannel | null
  reject_kind: CaptureIssueRejectKind | null
  reason: string | null
  fabrication_signals: FabricationSignal[]
  formatted_body: string
  suggested_gh_command: string
  issue_url: string | null
  raw_gh_stdout: string | null
  audit_path: string | null
  audit_error: string | null
  anti_replay_persisted: boolean | null
  anti_replay_error: string | null
  hints: string[]
}

export interface CaptureIssueInternal {
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  auditWriter?: typeof appendAuditEntry
  approvalRecorder?: typeof recordConsumedApproval
  ghCreate?: (input: {
    cwd: string
    title: string
    body: string
    labels?: string[]
    type?: string
  }) => GhCreateIssueResult
  ghAvailable?: () => boolean
  /** Test seam: substitute host-repo discovery. */
  ghVocabulary?: (cwd: string) => GhRepoVocabulary
}

/**
 * Preference order per severity, matched case-insensitively against whatever the
 * host repo actually offers. High-severity findings are defects; low-severity
 * ones are usually hardening. Whichever preference matches first wins, and if
 * NONE matches the issue is created unlabeled — which always succeeds. The
 * framework never creates a label or a type in someone else's repo.
 */
const LABEL_PREFERENCE: Record<Severity, string[]> = {
  critical: ['bug', 'enhancement'],
  high: ['bug', 'enhancement'],
  medium: ['enhancement', 'bug'],
  low: ['enhancement', 'bug'],
}

const TYPE_PREFERENCE: Record<Severity, string[]> = {
  critical: ['bug', 'task'],
  high: ['bug', 'task'],
  medium: ['task', 'feature'],
  low: ['task', 'feature'],
}

export interface LabelResolution {
  labels: string[]
  type: string | null
  /** Why these were chosen — surfaced so the mapping is visible, not inferred. */
  decision: string
  warnings: string[]
}

/** Case-insensitive lookup that returns the repo's own spelling. */
function matchFirst(preferences: string[], available: string[]): string | null {
  const byLower = new Map(available.map((a) => [a.toLowerCase(), a]))
  for (const p of preferences) {
    const hit = byLower.get(p.toLowerCase())
    if (hit) return hit
  }
  return null
}

export function resolveLabels(args: {
  requested: string[] | undefined
  severity: Severity
  vocabulary: GhRepoVocabulary
}): LabelResolution {
  const { requested, severity, vocabulary } = args
  const warnings: string[] = []

  const type = matchFirst(TYPE_PREFERENCE[severity], vocabulary.types)

  // An explicit request is honored verbatim — the dev may know about a label
  // discovery could not see. An unknown one is WARNED, never silently dropped:
  // dropping it would hide a typo, and `gh` will report the real error.
  if (requested !== undefined) {
    if (vocabulary.discovered) {
      const known = new Set(vocabulary.labels.map((l) => l.toLowerCase()))
      for (const l of requested) {
        if (!known.has(l.toLowerCase())) {
          warnings.push(
            `label '${l}' does not exist in this repository — gh will reject it. Create it first, or omit labels to let RSCT pick from what the repo offers.`,
          )
        }
      }
    }
    return {
      labels: requested,
      type,
      decision: `labels supplied by the caller (${requested.length === 0 ? 'none' : requested.join(', ')})`,
      warnings,
    }
  }

  if (!vocabulary.discovered) {
    return {
      labels: [],
      type,
      decision: 'unlabeled — the host repository\'s labels could not be read',
      warnings,
    }
  }

  const picked = matchFirst(LABEL_PREFERENCE[severity], vocabulary.labels)
  if (picked === null) {
    return {
      labels: [],
      type,
      decision: `unlabeled — none of the preferred labels for severity=${severity} (${LABEL_PREFERENCE[severity].join(', ')}) exist in this repository`,
      warnings,
    }
  }
  return {
    labels: [picked],
    type,
    decision: `'${picked}' matched from the repository's labels for severity=${severity}`,
    warnings,
  }
}

export const captureIssueTool: Tool = {
  name: 'rsct_capture_issue',
  description:
    'Capture a non-blocking finding as a GitHub issue. mode="draft" (default) returns a formatted markdown body for manual creation via web — no external mutation, no §C-gate. mode="create" requires dev_approval (action_scope starting with "capture_issue:") and invokes `gh issue create` via Bash with §C-gate. Use during verification sweeps, scan analyses, and post-task reviews to log "we should fix this later" items without scope-creeping the current task.',
  inputSchema: {
    type: 'object',
    required: ['title', 'body', 'severity'],
    properties: {
      project_root: { type: 'string' },
      title: { type: 'string', minLength: 10, maxLength: 200 },
      body: { type: 'string', minLength: 50 },
      severity: { type: 'string', enum: [...SEVERITY_VALUES] },
      affected_paths: { type: 'array', items: { type: 'string' } },
      labels: { type: 'array', items: { type: 'string' } },
      mode: {
        type: 'string',
        enum: [...MODE_VALUES],
        default: 'draft',
      },
      dev_approval: {
        type: 'object',
        description: 'Required when mode="create".',
      },
    },
    additionalProperties: false,
  },
}

function formatBody(input: {
  body: string
  severity: Severity
  affected_paths?: string[]
  now: Date
}): string {
  const sevBadge = `> **Severity:** \`${input.severity}\``
  const pathsSection =
    input.affected_paths && input.affected_paths.length > 0
      ? `\n\n## Affected paths\n\n${input.affected_paths
          .map((p) => `- \`${p}\``)
          .join('\n')}`
      : ''
  const captured = `_Captured via \`rsct_capture_issue\` on ${input.now.toISOString()}._`
  return `${sevBadge}\n\n${input.body}${pathsSection}\n\n---\n\n${captured}`
}

function suggestedGhCommand(title: string, labels: string[]): string {
  const labelArgs = labels.map((l) => `--label ${JSON.stringify(l)}`).join(' ')
  return `gh issue create --title ${JSON.stringify(title)} --body-file <(cat) ${labelArgs}`.trim()
}

function mapGhReason(reason: GhCreateIssueResult & { ok: false }): {
  reject_kind: CaptureIssueRejectKind
  status: CaptureIssueStatus
} {
  switch (reason.reason) {
    case 'not_installed':
      return { reject_kind: 'gh_not_installed', status: 'gh_unavailable' }
    case 'not_authenticated':
      return { reject_kind: 'gh_not_authenticated', status: 'gh_failed' }
    case 'no_remote':
      return { reject_kind: 'gh_no_remote', status: 'gh_failed' }
    default:
      return { reject_kind: 'gh_other', status: 'gh_failed' }
  }
}

export async function captureIssueHandler(
  rawInput: unknown,
  internal: CaptureIssueInternal = {},
): Promise<CaptureIssueOutput> {
  const input = captureIssueInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config = resolution.config
  const promptFn = internal.promptFn ?? promptYesNo
  const now = internal.now ?? new Date()
  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval
  const ghCreate = internal.ghCreate ?? ghCreateIssue
  const ghAvailableFn = internal.ghAvailable ?? isGhAvailable
  const ghVocabulary = internal.ghVocabulary ?? readRepoVocabulary

  // Host-repo discovery is deferred until the call is BOTH create-mode and
  // carrying a dev_approval — see `resolveVocabulary` below. It shells out to
  // `gh` (including two authenticated GitHub API reads), and no §C-gated tool
  // may produce an external effect before its gate: an unapproved call would
  // otherwise trigger real network reads and hand back the repository's label
  // vocabulary in `suggested_gh_command`. Draft mode never discovers at all —
  // it is documented as "no external mutation", and a `gh label list` per draft
  // would be a surprising cost.
  const noVocabulary: GhRepoVocabulary = { labels: [], types: [], discovered: false }
  const resolveVocabulary = (): GhRepoVocabulary =>
    ghAvailableFn() ? ghVocabulary(projectRoot) : noVocabulary

  // Pre-authorization paths (draft, missing approval, gh unavailable) describe
  // only what the caller asked for — nothing discovered, nothing invented.
  const requestedLabels = input.labels ?? []
  const formattedBody = formatBody({
    body: input.body,
    severity: input.severity,
    ...(input.affected_paths !== undefined && {
      affected_paths: input.affected_paths,
    }),
    now,
  })
  const preAuthGhCmd = suggestedGhCommand(input.title, requestedLabels)

  if (input.mode === 'draft') {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'capture_issue.drafted',
        tool: 'rsct_capture_issue',
        title: input.title,
        severity: input.severity,
        affected_paths_count: input.affected_paths?.length ?? 0,
        labels: requestedLabels,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'drafted',
      mode: 'draft',
      channel: null,
      reject_kind: null,
      reason: null,
      fabrication_signals: [],
      formatted_body: formattedBody,
      suggested_gh_command: preAuthGhCmd,
      issue_url: null,
      raw_gh_stdout: null,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        'Draft mode — paste formatted_body into a new issue on GitHub web, or use the suggested gh command piped from a file.',
      ],
    }
  }

  if (input.dev_approval === undefined) {
    return {
      status: 'missing_dev_approval',
      mode: 'create',
      channel: null,
      reject_kind: null,
      reason: 'mode="create" requires dev_approval',
      fabrication_signals: [],
      formatted_body: formattedBody,
      suggested_gh_command: preAuthGhCmd,
      issue_url: null,
      raw_gh_stdout: null,
      audit_path: null,
      audit_error: null,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        'Pass a dev_approval payload (timestamp / action_scope=capture_issue:... / reason) to enable mode=create.',
      ],
    }
  }

  if (!ghAvailableFn()) {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'capture_issue.gh_unavailable',
        tool: 'rsct_capture_issue',
        title: input.title,
        severity: input.severity,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'gh_unavailable',
      mode: 'create',
      channel: null,
      reject_kind: 'gh_not_installed',
      reason: 'gh CLI not found in PATH',
      fabrication_signals: [],
      formatted_body: formattedBody,
      suggested_gh_command: preAuthGhCmd,
      issue_url: null,
      raw_gh_stdout: null,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        'gh CLI is not installed. Install from https://cli.github.com/ then retry, or fall back to mode="draft".',
      ],
    }
  }

  // Past both guards: the call is create-mode, carries an approval payload and
  // gh is present. Only now is it legitimate to read the host repo, so the §C
  // dialog can name the labels the issue will actually get.
  const resolved = resolveLabels({
    requested: input.labels,
    severity: input.severity,
    vocabulary: resolveVocabulary(),
  })
  const labels = resolved.labels
  const ghCmd = suggestedGhCommand(input.title, labels)

  const gate = await gateRequest({
    toolName: 'rsct_capture_issue',
    approval: input.dev_approval,
    dialog: {
      title: 'RSCT — create GitHub issue',
      message:
        `Create issue '${input.title}' (severity=${input.severity})?\n\n` +
        `Labels: ${labels.length > 0 ? labels.join(', ') : '(none — no matching label in this repository)'}\n` +
        // A label gh is about to reject belongs in the dialog, not only in the
        // hints afterwards: approving a call already known to fail spends the
        // dev's single-use approval on nothing.
        (resolved.warnings.length > 0 ? `\n⚠ ${resolved.warnings.join('\n⚠ ')}\n` : '') +
        `GH CLI will run in '${projectRoot}'.`,
    },
    projectRoot,
    ...(config?.approval_modes !== undefined && {
      approvalModes: config.approval_modes,
    }),
    promptFn,
    now,
  })

  if (gate.status === 'rejected') {
    const audit = appendAudit(
      projectRoot,
      {
        event: 'capture_issue.create.rejected',
        tool: 'rsct_capture_issue',
        title: input.title,
        severity: input.severity,
        reject_kind: gate.reject_kind,
        reason: gate.reason,
        fabrication_signals: gate.fabrication_signals,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'rejected',
      mode: 'create',
      channel: null,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      fabrication_signals: gate.fabrication_signals,
      formatted_body: formattedBody,
      suggested_gh_command: ghCmd,
      issue_url: null,
      raw_gh_stdout: null,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`Approval rejected (${gate.reject_kind}): ${gate.reason}`],
    }
  }

  const ghResult = ghCreate({
    cwd: projectRoot,
    title: input.title,
    body: formattedBody,
    labels,
    ...(resolved.type !== null && { type: resolved.type }),
  })

  if (!ghResult.ok) {
    const mapped = mapGhReason(ghResult)
    const audit = appendAudit(
      projectRoot,
      {
        event: 'capture_issue.create_failed',
        tool: 'rsct_capture_issue',
        title: input.title,
        severity: input.severity,
        reject_kind: mapped.reject_kind,
        gh_reason: ghResult.reason,
        gh_error: ghResult.error,
        channel: gate.channel,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: mapped.status,
      mode: 'create',
      channel: gate.channel,
      reject_kind: mapped.reject_kind,
      reason: ghResult.error,
      fabrication_signals: gate.fabrication_signals,
      formatted_body: formattedBody,
      suggested_gh_command: ghCmd,
      issue_url: null,
      raw_gh_stdout: null,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [
        `gh issue create failed (${ghResult.reason}). ${ghResult.error}`,
        // A caller-supplied label that does not exist is the most likely cause
        // of a `failed` here, so RSCT names it rather than leaving gh's raw
        // error as the only clue.
        ...resolved.warnings,
      ],
    }
  }

  const record = recordApproval(gate.approval, { projectRoot, now })

  const createdAudit = appendAudit(
    projectRoot,
    {
      event: 'capture_issue.created',
      tool: 'rsct_capture_issue',
      title: input.title,
      severity: input.severity,
      affected_paths_count: input.affected_paths?.length ?? 0,
      labels,
      issue_type: resolved.type,
      label_decision: resolved.decision,
      issue_url: ghResult.url,
      channel: gate.channel,
      fabrication_signals: gate.fabrication_signals,
    },
    config?.audit,
  )
  const fields = auditFields(createdAudit)

  const hints: string[] = [`Issue created: ${ghResult.url}`]
  // State the mapping rather than leaving the dev to infer it from the issue.
  hints.push(
    `Labels: ${resolved.decision}${resolved.type ? `; issue type '${resolved.type}' matched` : ''}.`,
  )
  hints.push(...resolved.warnings)
  if (!record.ok) {
    hints.push(
      `⚠ I could not record this approval as used: ${record.error}. The dev_approval could be accepted again by mistake for a short time — use a fresh one next time, or repair .rsct/approvals-seen.json.`,
    )
  }
  if (fields.audit_error !== null) {
    hints.push(`⚠ capture_issue.created audit write failed: ${fields.audit_error}.`)
  }

  return {
    status: 'created',
    mode: 'create',
    channel: gate.channel,
    reject_kind: null,
    reason: null,
    fabrication_signals: gate.fabrication_signals,
    formatted_body: formattedBody,
    suggested_gh_command: ghCmd,
    issue_url: ghResult.url,
    raw_gh_stdout: ghResult.raw_stdout,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    anti_replay_persisted: record.ok,
    anti_replay_error: record.ok ? null : (record.error ?? null),
    hints,
  }
}
