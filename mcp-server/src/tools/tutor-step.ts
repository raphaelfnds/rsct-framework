import { existsSync, readFileSync } from 'node:fs'

import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { resolveProjectRoot } from '../lib/project-root.js'
import {
  appendAuditEntry,
  resolveAuditPath,
  type AuditAppendResult,
} from '../lib/audit-log.js'

const STEP_KIND_VALUES = [
  'propose',
  'execute',
  'read-batch',
  'observe',
  'complete',
] as const
type StepKind = (typeof STEP_KIND_VALUES)[number]

export const tutorStepInputSchema = z
  .object({
    project_root: z.string().optional(),
    spec_ref: z
      .string()
      .min(3, 'spec_ref required (≥3 chars)')
      .describe(
        'Free-form identifier correlating steps of one Tutor session. Typically a plan slug or task name.',
      ),
    step_description: z
      .string()
      .min(10, 'step_description must be ≥10 chars')
      .describe(
        'What this step is. For step_kind=propose: the action to take next. For execute/observe: a one-line description of what happened. For complete: the close-out summary.',
      ),
    step_kind: z
      .enum(STEP_KIND_VALUES)
      .describe(
        'propose = Claude suggests next step; execute = step was executed (by dev or Claude with consent); read-batch = multiple read-only commands in one beat; observe = recording a finding; complete = end the Tutor session for this spec_ref.',
      ),
    result: z
      .string()
      .optional()
      .describe(
        'Outcome of the step. For propose: usually omitted. For execute/observe/read-batch/complete: a short summary of the result the dev observed.',
      ),
    batch_commands: z
      .array(z.string())
      .optional()
      .describe(
        'Only meaningful when step_kind=read-batch. List of read-only commands run in one beat (e.g., ["df -h","free -m","systemctl status nginx"]).',
      ),
  })
  .strict()

export type TutorStepInput = z.infer<typeof tutorStepInputSchema>

export interface TutorStepOutput {
  spec_ref: string
  step_kind: StepKind
  step_number: number
  is_complete: boolean
  audit_path: string | null
  audit_error: string | null
  resume_block: string
  hints: string[]
}

export const tutorStepTool: Tool = {
  name: 'rsct_tutor_step',
  description:
    'Log one step of an interactive Tutor session. Tutor (the 6th persona) walks the dev through a task ONE step at a time: propose → consent → execute → observe → next. Each call appends a `tutor.step` event to .rsct/audit.log so the session is auditable and can resume after /clear. The tool returns a resume_block — a markdown snippet the dev can paste in a new chat to continue from the last step. NOT §C-gated (audit append only). Opt-in: rsct_auto_persona never recommends Tutor; the dev must choose it explicitly via rsct_persona_review with slug="tutor".',
  inputSchema: {
    type: 'object',
    required: ['spec_ref', 'step_description', 'step_kind'],
    properties: {
      project_root: { type: 'string' },
      spec_ref: { type: 'string', minLength: 3 },
      step_description: { type: 'string', minLength: 10 },
      step_kind: { type: 'string', enum: [...STEP_KIND_VALUES] },
      result: { type: 'string' },
      batch_commands: { type: 'array', items: { type: 'string' } },
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

function countPriorSteps(auditPath: string, specRef: string): number {
  if (!existsSync(auditPath)) return 0
  let raw: string
  try {
    raw = readFileSync(auditPath, 'utf8')
  } catch {
    return 0
  }
  let count = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: { event?: string; spec_ref?: string }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.event === 'tutor.step' && entry.spec_ref === specRef) count++
  }
  return count
}

function buildResumeBlock(input: {
  specRef: string
  stepKind: StepKind
  stepDescription: string
  stepNumber: number
  result: string | undefined
  isComplete: boolean
}): string {
  const resultLine =
    input.result !== undefined
      ? `\n> Last result: ${input.result.length > 200 ? `${input.result.slice(0, 200)}…` : input.result}`
      : ''
  const status = input.isComplete ? 'completed' : `at step ${input.stepNumber}`
  return [
    `> Resume Tutor session for spec '${input.specRef}' (${status}).`,
    `> Last step (${input.stepKind}): ${input.stepDescription}`,
    resultLine.trim() ? resultLine.replace(/^\n/, '') : '',
    `> Next: ${input.isComplete ? 'session is complete — start a new spec or session' : 'propose the next step deliberately; do not chain ahead'}.`,
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

export async function tutorStepHandler(
  rawInput: unknown,
): Promise<TutorStepOutput> {
  const input = tutorStepInputSchema.parse(rawInput ?? {})
  const resolution = resolveProjectRoot(input.project_root)
  const projectRoot = resolution.root
  const config = resolution.config

  if (input.step_kind === 'read-batch' && !input.batch_commands) {
    // not a hard error — just hint; some Tutor sessions log batch in description
  }

  const auditPath = resolveAuditPath(projectRoot, config?.audit)
  const priorCount = countPriorSteps(auditPath, input.spec_ref)
  const stepNumber = priorCount + 1
  const isComplete = input.step_kind === 'complete'

  const baseEntry = {
    event: 'tutor.step',
    tool: 'rsct_tutor_step',
    spec_ref: input.spec_ref,
    step_kind: input.step_kind,
    step_number: stepNumber,
    step_description: input.step_description,
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.batch_commands !== undefined
      ? { batch_commands: input.batch_commands }
      : {}),
  }

  const audit = appendAuditEntry(projectRoot, baseEntry, config?.audit)
  const fields = auditFields(audit)

  const resume = buildResumeBlock({
    specRef: input.spec_ref,
    stepKind: input.step_kind,
    stepDescription: input.step_description,
    stepNumber,
    result: input.result,
    isComplete,
  })

  const hints: string[] = []
  if (isComplete) {
    hints.push(
      `Tutor session for '${input.spec_ref}' marked complete after ${stepNumber} step(s). To start a new session, call rsct_tutor_step with a new spec_ref + step_kind='propose'.`,
    )
  } else {
    hints.push(
      `Step ${stepNumber} logged (${input.step_kind}). Continue with the NEXT step only after the dev has executed/observed this one — never chain ahead in Tutor mode.`,
    )
  }
  if (
    input.step_kind === 'read-batch' &&
    input.batch_commands &&
    input.batch_commands.length > 5
  ) {
    hints.push(
      `${input.batch_commands.length} commands in one batch is generous — consider splitting at the next opportunity so the dev keeps tracking the output between groups.`,
    )
  }
  if (fields.audit_error !== null) {
    hints.push(`⚠ tutor.step audit write failed: ${fields.audit_error}.`)
  }

  return {
    spec_ref: input.spec_ref,
    step_kind: input.step_kind,
    step_number: stepNumber,
    is_complete: isComplete,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    resume_block: resume,
    hints,
  }
}
