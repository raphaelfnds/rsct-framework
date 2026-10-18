import { appendAuditEntry, auditFields } from './audit-log.js'
import { recordConsumedApproval, validateDevApproval } from './dev-approval.js'
import { gateDialogFooter } from './gate-dialog.js'
import { readWorktreeInfo } from './git.js'
import { evaluateInstallAdvisory } from './install-advisory.js'
import { promptYesNo, type DialogOptions, type DialogResult } from './os-dialog.js'
import {
  isStaleVerificationLabel,
  leftoverTaskSlug,
  nextPhase,
  precheckPhaseComplete,
  type CompletePhaseInput,
  type CompletePhaseInternal,
  type CompletePhaseResult,
} from './phase-machine.js'
import {
  readPhaseState,
  writePhaseState,
  type PhaseState,
  type RunAloneBlock,
  type RunAlonePendingEntry,
} from './phase-scope.js'
import type { RsctConfig } from './project-root.js'
import { anchorFor, sameDirectory } from './repo-anchor.js'
import { gateRequest, inferRejectKind, type GateRejectKind } from './request-gate.js'

const SPEC_LABEL_LIMIT = 200

const LINE_BREAKS = new RegExp(`[${String.fromCharCode(10, 11, 12, 13, 0x85, 0x2028, 0x2029)}]+`, 'g')

const PHASE_LABEL: Record<RunAlonePendingEntry['phase'], string> = { code: 'code', test: 'tests' }

export function specLabel(spec: string): string {
  const flat = spec.replace(LINE_BREAKS, ' ')
  return flat.length > SPEC_LABEL_LIMIT ? `${flat.slice(0, SPEC_LABEL_LIMIT - 1)}…` : flat
}

function isPendingEntry(value: unknown): value is RunAlonePendingEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (entry.phase === 'code' || entry.phase === 'test') && typeof entry.completed_at === 'string'
}

export function readRunAlone(state: PhaseState | null | undefined): RunAloneBlock | null {
  const raw = state?.run_alone as unknown
  if (raw === undefined) return null
  const block = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    spec_slug: typeof block.spec_slug === 'string' ? block.spec_slug : '',
    approved_at: typeof block.approved_at === 'string' ? block.approved_at : '',
    active: block.active === true,
    pending: Array.isArray(block.pending) ? block.pending.filter(isPendingEntry) : [],
  }
}

export function describePending(pending: readonly RunAlonePendingEntry[]): string {
  return pending.map((p) => `${PHASE_LABEL[p.phase]} (done ${p.completed_at})`).join(', ')
}

export function runAloneHome(projectRoot: string): string | null {
  if (anchorFor(projectRoot).status !== 'relocated') return null
  const info = readWorktreeInfo(projectRoot)
  if (!info.in_git_repo || info.toplevel === null || sameDirectory(info.toplevel, projectRoot)) return null
  return info.toplevel
}

export function readHomeRunAlone(projectRoot: string): { home: string; block: RunAloneBlock } | null {
  const home = runAloneHome(projectRoot)
  if (home === null) return null
  const block = readRunAlone(readPhaseState(home).state)
  return block === null ? null : { home, block }
}

export function startWouldBeRefused(state: PhaseState, specRef: string, specSlug: string | undefined): boolean {
  if (state.phase && state.phase !== 'code' && !isStaleVerificationLabel(state)) return true
  return leftoverTaskSlug(state, 'code', specRef, specSlug) !== null
}

function runAloneChoiceDialog(projectRoot: string, specSlug: string, warningLine: string | null): DialogOptions {
  return {
    title: 'RSCT — run alone?',
    message:
      'Let the agent run code → tests → review on its own and stop before the commit?' +
      (warningLine ? `\n${warningLine}` : '') +
      '\n\nCode and tests close with no dialog. When you are back, you approve each phase in its own dialog — code, tests, review — before any commit.' +
      gateDialogFooter(projectRoot) +
      `\nSpec: '${specLabel(specSlug)}'`,
  }
}

function pendingDialog(projectRoot: string, entry: RunAlonePendingEntry, specSlug: string): DialogOptions {
  return {
    title: `RSCT — approve ${PHASE_LABEL[entry.phase]} done on its own`,
    message:
      `Approve the ${PHASE_LABEL[entry.phase]} phase the agent completed on its own at ${entry.completed_at}?` +
      '\n\nYes = approve it. No = the work goes back to this phase; it and every later phase are redone, with dialogs.' +
      gateDialogFooter(projectRoot) +
      `\nSpec: '${specLabel(specSlug)}'`,
  }
}

type RunAloneChoice =
  | { status: 'approved'; approved_at: string }
  | { status: 'rejected'; reject_kind: GateRejectKind; reason: string }

export async function gateRunAloneChoice(args: {
  projectRoot: string
  config: RsctConfig | null
  rsctInstalled: boolean
  specSlug: string
  devApproval: unknown
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  auditWriter?: typeof appendAuditEntry
}): Promise<RunAloneChoice> {
  const advisory = evaluateInstallAdvisory({
    projectRoot: args.projectRoot,
    rsctInstalled: args.rsctInstalled,
    projectVersion: args.config?.rsct_version ?? null,
    auditConfig: args.config?.audit,
    tool: 'rsct_phase_code_start',
    ...(args.auditWriter !== undefined && { auditWriter: args.auditWriter }),
  })
  const gate = await gateRequest({
    toolName: 'rsct_phase_code_start',
    approval: args.devApproval,
    forceDialog: true,
    forceDialogReason: "running code, tests and review with no dialog is the developer's choice alone",
    dialog: runAloneChoiceDialog(args.projectRoot, args.specSlug, advisory.dialogLine),
    projectRoot: args.projectRoot,
    ...(args.config?.approval_modes !== undefined && { approvalModes: args.config.approval_modes }),
    auditConfig: args.config?.audit,
    ...(args.promptFn !== undefined && { promptFn: args.promptFn }),
    ...(args.now !== undefined && { now: args.now }),
  })
  if (gate.status === 'rejected') return { status: 'rejected', reject_kind: gate.reject_kind, reason: gate.reason }
  return { status: 'approved', approved_at: (args.now ?? new Date()).toISOString() }
}

export function deferPhaseComplete(
  input: CompletePhaseInput & { phase: 'code' | 'test' },
  config: RsctConfig | null,
  internal: CompletePhaseInternal = {},
): CompletePhaseResult | null {
  const read = readPhaseState(input.projectRoot)
  const state = read.state
  const block = readRunAlone(state)
  if (!state || !block || !block.active || block.spec_slug !== state.spec_slug) return null

  const precheck = precheckPhaseComplete(input, config, internal)
  if (precheck) return precheck

  const appendAudit = internal.auditWriter ?? appendAuditEntry
  const recordApproval = internal.approvalRecorder ?? recordConsumedApproval
  const now = internal.now ?? new Date()
  const tool = `rsct_phase_${input.phase}_complete`

  const validation = validateDevApproval(input.devApproval, {
    projectRoot: input.projectRoot,
    toolName: tool,
    now,
    ...(config?.approval_modes !== undefined && { approvalModes: config.approval_modes }),
    auditConfig: config?.audit,
  })
  if (validation.status === 'rejected') {
    const rejectKind = inferRejectKind(validation.reason)
    const audit = appendAudit(
      input.projectRoot,
      {
        event: `${input.phase}.complete.rejected`,
        tool,
        spec_ref: input.specRef,
        reject_kind: rejectKind,
        reason: validation.reason,
        fabrication_signals: validation.fabrication_signals,
        run_alone: true,
      },
      config?.audit,
    )
    const fields = auditFields(audit)
    return {
      status: 'rejected',
      phase: input.phase,
      channel: null,
      reject_kind: rejectKind,
      reason: validation.reason,
      fabrication_signals: validation.fabrication_signals,
      spec_ref: input.specRef,
      cleared: false,
      next_recommended_phase: null,
      audit_path: fields.audit_path,
      audit_error: fields.audit_error,
      anti_replay_persisted: null,
      anti_replay_error: null,
      hints: [`Approval rejected (${rejectKind}): ${validation.reason}`],
    }
  }

  const completedAt = now.toISOString()
  const next: PhaseState = { ...state }
  delete next.phase
  delete next.scope_globs
  delete next.started_at
  next.run_alone = { ...block, pending: [...block.pending, { phase: input.phase, completed_at: completedAt }] }
  const writeResult = writePhaseState(input.projectRoot, next)
  const record = writeResult.ok
    ? recordApproval(validation.approval, { projectRoot: input.projectRoot, now, auditConfig: config?.audit })
    : null
  const recommended = nextPhase(input.phase)

  const audit = appendAudit(
    input.projectRoot,
    {
      event: `${input.phase}.complete.deferred`,
      tool,
      spec_ref: input.specRef,
      completed_at: completedAt,
      fabrication_signals: validation.fabrication_signals,
      next_recommended_phase: recommended,
      phase_state_written: writeResult.ok,
    },
    config?.audit,
  )
  const fields = auditFields(audit)

  const hints: string[] = []
  if (writeResult.ok) {
    hints.push(
      `${input.phase} closed with no dialog (run alone): the developer approves it in its own dialog when back, before any commit. Next: rsct_phase_${recommended}_start.`,
    )
    if (input.phase === 'test') hints.push(stopPointHint())
  } else if (writeResult.reason === 'locked') {
    hints.push(`⚠ another session is editing phase-state.json (locked ${writeResult.lock_age_ms}ms ago). Nothing was closed; retry.`)
  } else {
    hints.push(`⚠ phase-state.json write failed: ${writeResult.error}. Nothing was closed.`)
  }
  if (record !== null && !record.ok) {
    hints.push(`⚠ I could not record this approval as used: ${record.error}. Use a fresh dev_approval next time.`)
  }
  if (fields.audit_error !== null) hints.push(`⚠ ${input.phase}.complete.deferred audit write failed: ${fields.audit_error}.`)

  return {
    status: writeResult.ok ? 'deferred' : 'state_write_failed',
    phase: input.phase,
    channel: null,
    reject_kind: null,
    reason: null,
    fabrication_signals: validation.fabrication_signals,
    spec_ref: input.specRef,
    cleared: writeResult.ok,
    next_recommended_phase: recommended,
    audit_path: fields.audit_path,
    audit_error: fields.audit_error,
    anti_replay_persisted: record === null ? null : record.ok,
    anti_replay_error: record === null || record.ok ? null : (record.error ?? null),
    hints,
  }
}

export function stopPointHint(): string {
  return 'Run alone: when the review work is done, STOP and tell the developer. Do not call rsct_phase_review_complete before the developer says they are back — its dialogs block every RSCT tool until they are answered, and it first asks for each phase closed on its own.'
}

type PendingApprovalRejectKind = GateRejectKind | 'run_alone_rejected' | 'run_alone_state_write_failed' | 'run_alone_pending'

type PendingApproval =
  | { ok: true; approved: RunAlonePendingEntry[] }
  | { ok: false; reject_kind: PendingApprovalRejectKind; reason: string; hints: string[]; approved: RunAlonePendingEntry[] }

export async function approvePendingPhases(args: {
  projectRoot: string
  config: RsctConfig | null
  devApproval: unknown
  promptFn?: (options: DialogOptions) => Promise<DialogResult>
  now?: Date
  auditWriter?: typeof appendAuditEntry
}): Promise<PendingApproval> {
  const appendAudit = args.auditWriter ?? appendAuditEntry
  const promptFn = args.promptFn ?? promptYesNo
  const approved: RunAlonePendingEntry[] = []

  const atHome = readHomeRunAlone(args.projectRoot)
  if (atHome !== null) {
    const reason = `a run-alone record waits at the repository root (${atHome.home.replace(/\\/g, '/')}), not at the folder this REVIEW names — run the REVIEW from that root`
    return { ok: false, reject_kind: 'run_alone_pending', reason, hints: [reason], approved }
  }

  for (;;) {
    const state = readPhaseState(args.projectRoot).state
    const block = readRunAlone(state)
    if (!state || !block || block.pending.length === 0) return { ok: true, approved }
    const entry = block.pending[0]!
    const gate = await gateRequest({
      toolName: 'rsct_phase_review_complete',
      approval: args.devApproval,
      forceDialog: true,
      forceDialogReason: 'a phase the agent closed on its own waits for the developer',
      dialog: pendingDialog(args.projectRoot, entry, block.spec_slug),
      projectRoot: args.projectRoot,
      ...(args.config?.approval_modes !== undefined && { approvalModes: args.config.approval_modes }),
      auditConfig: args.config?.audit,
      promptFn,
      ...(args.now !== undefined && { now: args.now }),
    })

    const fresh = readPhaseState(args.projectRoot).state ?? {}
    const freshBlock = readRunAlone(fresh)
    if (!freshBlock) return { ok: true, approved }
    const at = freshBlock.pending.findIndex((p) => p.phase === entry.phase && p.completed_at === entry.completed_at)
    if (at < 0) continue

    if (gate.status === 'approved') {
      const next: PhaseState = {
        ...fresh,
        run_alone: { ...freshBlock, pending: [...freshBlock.pending.slice(0, at), ...freshBlock.pending.slice(at + 1)] },
      }
      const w = writePhaseState(args.projectRoot, next)
      appendAudit(
        args.projectRoot,
        { event: 'run_alone.pending_approved', tool: 'rsct_phase_review_complete', spec_slug: freshBlock.spec_slug, phase: entry.phase, completed_at: entry.completed_at, channel: gate.channel, phase_state_written: w.ok },
        args.config?.audit,
      )
      if (!w.ok) {
        const reason = `the approval of ${PHASE_LABEL[entry.phase]} could not be saved (${w.reason}) — call again`
        return { ok: false, reject_kind: 'run_alone_state_write_failed', reason, hints: [reason], approved }
      }
      approved.push(entry)
      continue
    }

    if (gate.reject_kind === 'dialog_no') {
      const next: PhaseState = { ...fresh, run_alone: { ...freshBlock, active: false, pending: freshBlock.pending.slice(0, at) } }
      delete next.phase
      delete next.scope_globs
      delete next.started_at
      const w = writePhaseState(args.projectRoot, next)
      appendAudit(
        args.projectRoot,
        {
          event: 'run_alone.pending_declined',
          tool: 'rsct_phase_review_complete',
          spec_slug: freshBlock.spec_slug,
          phase: entry.phase,
          dropped: freshBlock.pending.slice(at).map((p) => p.phase),
          phase_state_written: w.ok,
        },
        args.config?.audit,
      )
      if (!w.ok) {
        const reason = `the developer declined the ${PHASE_LABEL[entry.phase]} done on its own, but that answer could not be saved (${w.reason}) — nothing changed; call again`
        return { ok: false, reject_kind: 'run_alone_state_write_failed', reason, hints: [reason], approved }
      }
      const reason = `the developer did not approve the ${PHASE_LABEL[entry.phase]} done on its own — the work goes back to that phase`
      return {
        ok: false,
        reject_kind: 'run_alone_rejected',
        reason,
        hints: [
          `${reason}. Run alone is over for this task. Start ${entry.phase} again (rsct_phase_${entry.phase}_start), then the later phases, each closed with its dialog. Commits stay refused until a REVIEW is approved.`,
        ],
        approved,
      }
    }

    return {
      ok: false,
      reject_kind: gate.reject_kind,
      reason: gate.reason,
      hints: [`The phases closed on its own still wait for the developer (${describePending(freshBlock.pending)}): ${gate.reason}`],
      approved,
    }
  }
}

export function closeRunAlone(args: {
  projectRoot: string
  config: RsctConfig | null
  specRef: string
  auditWriter?: typeof appendAuditEntry
}): string | null {
  const read = readPhaseState(args.projectRoot)
  const block = readRunAlone(read.state)
  if (!read.state || !block || block.pending.length > 0) return null
  const next: PhaseState = { ...read.state }
  delete next.run_alone
  const w = writePhaseState(args.projectRoot, next)
  ;(args.auditWriter ?? appendAuditEntry)(
    args.projectRoot,
    { event: 'run_alone.closed', tool: 'rsct_phase_review_complete', spec_ref: args.specRef, spec_slug: block.spec_slug, phase_state_written: w.ok },
    args.config?.audit,
  )
  return w.ok
    ? 'Run alone finished: every phase is approved. Commits go through rsct_request_commit as usual.'
    : `⚠ the review is approved, but the run-alone record could not be cleared (${w.reason}) — rsct_request_commit keeps refusing until a REVIEW completes with it cleared.`
}
