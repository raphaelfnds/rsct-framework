import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readPhaseState } from './phase-scope.js'
import { resolveAuditPath } from './audit-log.js'
import type { RsctConfig } from './project-root.js'

/**
 * Mirrors phase-scope.ts's advisory-lock stale window (30s). A lock older
 * than this is a crashed-writer artifact — the state file may be torn, so
 * the mechanical layer is not trustworthy until the next clean write.
 */
const LOCK_STALE_MS = 30_000

export interface McpHealth {
  healthy: boolean
  reasons: string[]
}

/**
 * Point-in-time health of the RSCT mechanical layer for THIS project
 * (plan-lifecycle-v2, Bloco 0).
 *
 * Purpose: the dialog-free "free commit" path (Bloco 1) is a PRIVILEGE that
 * only exists when the mechanical enforcement layer is trustworthy.
 * `evaluateMcpHealth` is the fail-CLOSED guard in front of it — any
 * missing/ambiguous signal ⇒ `healthy: false`, and the commit handler then
 * drops the request to the strict per-action §C path. It NEVER opens a gate;
 * it can only withhold a privilege. This is the intended asymmetry: when the
 * mechanical layer is degraded we close more (§C), never open.
 *
 * Signals (ALL must hold for `healthy: true`):
 *  - `.rsct.json` present and JSON-parseable — a corrupt/absent config means
 *    the enforcement contract itself can't be trusted.
 *  - `.rsct/phase-state.json` readable and uncorrupted — the budget/ratchet
 *    that bounds free commits lives here (absent is fine: nothing to corrupt).
 *  - `.rsct/phase-state.lock` is not STALE — a stale lock means a writer
 *    crashed mid-write and the state may be torn (a fresh/held lock is fine).
 *  - HISTORY: `.rsct/audit.log` exists, is a non-empty file. This is the
 *    anti-wipe signal — `rm -rf .rsct` or a truncated audit log makes the
 *    free path fail-closed. "new == wiped == closed" is the CORRECT
 *    direction: the free lane is earned by an established plan context (the
 *    anti-rollback ceiling in Bloco 1.2 re-derives from this same append-only
 *    log), so a fresh or wiped project simply does not qualify — no
 *    wiped-vs-new disambiguation is needed. NB: a project that disabled audit
 *    (`audit.enabled: false`) has no history log, so free commits are closed
 *    by design — the anti-rollback anchor cannot exist without the audit log.
 *
 * Never throws.
 */
export function evaluateMcpHealth(
  projectRoot: string,
  opts: { now?: Date; config?: RsctConfig | null } = {},
): McpHealth {
  const now = opts.now ?? new Date()
  const reasons: string[] = []

  // 1. `.rsct.json` present + parseable.
  const configPath = join(projectRoot, '.rsct.json')
  if (!existsSync(configPath)) {
    reasons.push('config_absent')
  } else {
    try {
      JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      reasons.push('config_unparseable')
    }
  }

  // 2. phase-state readable/uncorrupted (absent is fine — nothing to corrupt).
  if (readPhaseState(projectRoot).parse_error) {
    reasons.push('phase_state_corrupt')
  }

  // 3. lock not stale (a stale/garbage lock ⇒ crashed writer, torn state).
  const lockPath = join(projectRoot, '.rsct', 'phase-state.lock')
  if (existsSync(lockPath)) {
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { locked_at?: string }
      const lockedAtMs = parsed.locked_at ? new Date(parsed.locked_at).getTime() : NaN
      const ageMs = now.getTime() - lockedAtMs
      if (Number.isNaN(lockedAtMs) || ageMs >= LOCK_STALE_MS) {
        reasons.push('phase_state_lock_stale')
      }
    } catch {
      reasons.push('phase_state_lock_stale')
    }
  }

  // 4. HISTORY signal: `.rsct/audit.log` exists and is a non-empty file.
  const auditPath = resolveAuditPath(projectRoot, opts.config?.audit)
  let historyOk = false
  try {
    if (existsSync(auditPath)) {
      const stat = statSync(auditPath)
      historyOk = stat.isFile() && stat.size > 0
    }
  } catch {
    historyOk = false
  }
  if (!historyOk) {
    reasons.push('audit_history_absent')
  }

  return { healthy: reasons.length === 0, reasons }
}
