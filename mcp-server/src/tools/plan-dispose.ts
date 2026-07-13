import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectRoot } from '../lib/project-root.js'
import { appendAuditEntry, type AuditAppendResult } from '../lib/audit-log.js'
import { stampPlanDisposition } from '../lib/phase-scope.js'
import { planCleanupReport, type PlanArtifact } from '../lib/plan-cleanup.js'

export const planDisposeInputSchema = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe('Optional absolute path to override project root detection.'),
    plan_slug: z
      .string()
      .min(1)
      .describe('The plan slug (as in plan_<slug>.md) whose artifacts to dispose.'),
    decision: z
      .enum(['keep', 'delete'])
      .describe("'keep' retains the plan artifacts; 'delete' advises removing the loose ones."),
  })
  .strict()

export type PlanDisposeInput = z.infer<typeof planDisposeInputSchema>
export type PlanDisposeStatus = 'recorded' | 'state_write_failed'

export interface PlanDisposeOutput {
  status: PlanDisposeStatus
  plan_slug: string
  decision: 'keep' | 'delete'
  artifacts: PlanArtifact[]
  /** True only when the plan's progress shows positive completion (all_closed). */
  can_suggest_delete: boolean
  audit_path: string | null
  audit_error: string | null
  hints: string[]
}

export interface PlanDisposeInternal {
  now?: Date
  auditWriter?: typeof appendAuditEntry
}

export const planDisposeTool: Tool = {
  name: 'rsct_plan_dispose',
  description:
    'plan-lifecycle-v2: record the keep|delete disposition for a plan slug and surface the ADVISORY artifact-cleanup report. Flow-INDEPENDENT — use it after ANY integration terminal, INCLUDING a GitHub PR merge/squash/rebase that never ran rsct_request_merge/_push (the blind spot those tools cannot see). ADVISORY-ONLY (Fork 2/A): decision:"delete" NEVER auto-deletes — it lists the loose gitignored plan_/progress_/spec_ files for YOU to remove, and flags any TRACKED ones for a deliberate `git rm`. The decision is recorded once (keyed by plan_slug, with a read-side slug guard) so a later action does not re-prompt. NOT §C-gated — it records intent and prints advice; it performs no git or filesystem mutation.',
  inputSchema: {
    type: 'object',
    properties: {
      project_root: {
        type: 'string',
        description: 'Optional absolute path to override project root detection.',
      },
      plan_slug: {
        type: 'string',
        description: 'The plan slug (as in plan_<slug>.md) whose artifacts to dispose.',
      },
      decision: {
        type: 'string',
        enum: ['keep', 'delete'],
        description: "'keep' retains the artifacts; 'delete' advises removing the loose ones.",
      },
    },
    required: ['plan_slug', 'decision'],
    additionalProperties: false,
  },
}

function auditFields(audit: AuditAppendResult): {
  audit_path: string | null
  audit_error: string | null
} {
  if (audit.ok) return { audit_path: audit.path, audit_error: null }
  if (audit.reason === 'disabled') return { audit_path: null, audit_error: null }
  return { audit_path: audit.path ?? null, audit_error: audit.error ?? 'write_failed' }
}

export async function planDisposeHandler(
  rawInput: unknown,
  internal: PlanDisposeInternal = {},
): Promise<PlanDisposeOutput> {
  const input = planDisposeInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config = resolution.config
  const now = internal.now ?? new Date()
  const appendAudit = internal.auditWriter ?? appendAuditEntry

  // Record the decision (ask-once, keyed by plan_slug) and build the advisory
  // cleanup report. The report is computed regardless of the write outcome so
  // the dev always sees what the artifacts are.
  const write = stampPlanDisposition(projectRoot, {
    plan_slug: input.plan_slug,
    decision: input.decision,
    decided_at: now.toISOString(),
  })
  const report = planCleanupReport(projectRoot, input.plan_slug, config ?? null)

  if (!write.ok) {
    const reason =
      write.reason === 'locked'
        ? `another session is editing phase-state.json (locked ${write.lock_age_ms}ms ago) — wait and retry`
        : `phase-state.json write failed: ${write.error}`
    const audit = appendAudit(
      projectRoot,
      {
        event: 'plan_dispose.state_write_failed',
        tool: 'rsct_plan_dispose',
        plan_slug: input.plan_slug,
        decision: input.decision,
        reason,
      },
      config?.audit,
    )
    return {
      status: 'state_write_failed',
      plan_slug: input.plan_slug,
      decision: input.decision,
      artifacts: report.artifacts,
      can_suggest_delete: report.can_suggest_delete,
      ...auditFields(audit),
      hints: [`⚠ disposition NOT recorded — ${reason}. ${report.hint}`],
    }
  }

  const audit = appendAudit(
    projectRoot,
    {
      event: 'plan_dispose.recorded',
      tool: 'rsct_plan_dispose',
      plan_slug: input.plan_slug,
      decision: input.decision,
      decided_at: now.toISOString(),
    },
    config?.audit,
  )

  const hints: string[] = []
  if (input.decision === 'delete') {
    hints.push(
      report.can_suggest_delete
        ? `Disposition 'delete' recorded for '${input.plan_slug}'. ${report.hint}`
        : `Disposition 'delete' recorded, but the plan is NOT confirmed complete (progress='${report.completion}') — double-check before removing anything. ${report.hint}`,
    )
  } else {
    hints.push(`Disposition 'keep' recorded for '${input.plan_slug}' — artifacts retained. ${report.hint}`)
  }

  return {
    status: 'recorded',
    plan_slug: input.plan_slug,
    decision: input.decision,
    artifacts: report.artifacts,
    can_suggest_delete: report.can_suggest_delete,
    ...auditFields(audit),
    hints,
  }
}
