import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { appendAuditEntry, type AuditAppendResult } from '../lib/audit-log.js'
import {
  readPhaseState,
  writePhaseState,
  type PhaseState,
} from '../lib/phase-scope.js'
import {
  readToken,
  clearTokenFromState,
} from '../lib/plan-authorization.js'

export const planRevokeInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    reason: z
      .string()
      .optional()
      .describe('Optional human-readable reason; lands in the audit log.'),
  })
  .strict()

export type PlanRevokeInput = z.infer<typeof planRevokeInputSchema>

export type PlanRevokeStatus = 'revoked' | 'no_token' | 'state_write_failed'

export interface PlanRevokeOutput {
  status: PlanRevokeStatus
  revoked_plan_slug: string | null
  audit_path: string | null
  audit_error: string | null
  hints: string[]
}

export interface PlanRevokeInternal {
  now?: Date
  auditWriter?: typeof appendAuditEntry
}

export const planRevokeTool: Tool = {
  name: 'rsct_plan_revoke',
  description:
    'T3: revoke the active plan-scoped batch token (minted by rsct_plan_authorize). NOT §C-gated — revoking only TIGHTENS security, so no dev_approval is needed. After revoke, rsct_request_commit again requires a per-action dev_approval. The token also auto-revokes on branch switch, plan completion/deletion, expiry, or exhaustion, and rsct_phase_abandon clears it too. No-op (status="no_token") when no token is present.',
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      reason: {
        type: 'string',
        description: 'Optional reason; lands in the audit log.',
      },
    },
    additionalProperties: false,
  },
}

function auditFields(audit: AuditAppendResult): {
  audit_path: string | null
  audit_error: string | null
} {
  if (audit.ok) return { audit_path: audit.path, audit_error: null }
  if (audit.reason === 'disabled') return { audit_path: null, audit_error: null }
  return {
    audit_path: audit.path ?? null,
    audit_error: audit.error ?? 'write_failed',
  }
}

export async function planRevokeHandler(
  rawInput: unknown,
  internal: PlanRevokeInternal = {},
): Promise<PlanRevokeOutput> {
  const input = planRevokeInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config = resolution.config
  const now = internal.now ?? new Date()
  const appendAudit = internal.auditWriter ?? appendAuditEntry

  const existing = readPhaseState(projectRoot)
  const token = readToken(existing.state)
  if (!token) {
    return {
      status: 'no_token',
      revoked_plan_slug: null,
      audit_path: null,
      audit_error: null,
      hints: [
        'No active plan token to revoke. rsct_request_commit already requires a per-action dev_approval.',
      ],
    }
  }

  const baseState: PhaseState = existing.state ?? {}
  const newState = clearTokenFromState(baseState)
  const writeResult = writePhaseState(projectRoot, newState)

  if (!writeResult.ok) {
    const reason =
      writeResult.reason === 'locked'
        ? `another session is editing phase-state.json (locked ${writeResult.lock_age_ms}ms ago) — wait and retry`
        : `phase-state.json write failed: ${writeResult.error}`
    const audit = appendAudit(
      projectRoot,
      {
        event: 'plan_revoke.state_write_failed',
        tool: 'rsct_plan_revoke',
        reason,
        plan_slug: token.plan_slug,
      },
      config?.audit,
    )
    return {
      status: 'state_write_failed',
      revoked_plan_slug: token.plan_slug,
      ...auditFields(audit),
      hints: [`⚠ token still active — ${reason}.`],
    }
  }

  const audit = appendAudit(
    projectRoot,
    {
      event: 'plan_revoke.revoked',
      tool: 'rsct_plan_revoke',
      plan_slug: token.plan_slug,
      branch: token.branch,
      actions_used: token.actions_used,
      max_actions: token.max_actions,
      reason: input.reason ?? null,
      revoked_at: now.toISOString(),
    },
    config?.audit,
  )

  return {
    status: 'revoked',
    revoked_plan_slug: token.plan_slug,
    ...auditFields(audit),
    hints: [
      `Plan token for '${token.plan_slug}' revoked (used ${token.actions_used}/${token.max_actions}). rsct_request_commit now requires a per-action dev_approval again.`,
    ],
  }
}
