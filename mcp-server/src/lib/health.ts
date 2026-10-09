import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readPhaseState } from './phase-scope.js'
import { resolveAuditPath } from './audit-log.js'
import type { RsctConfig } from './project-root.js'

const LOCK_STALE_MS = 30_000

export interface McpHealth {
  healthy: boolean
  reasons: string[]
}

export function evaluateMcpHealth(
  projectRoot: string,
  opts: { now?: Date; config?: RsctConfig | null } = {},
): McpHealth {
  const now = opts.now ?? new Date()
  const reasons: string[] = []

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

  if (readPhaseState(projectRoot).parse_error) {
    reasons.push('phase_state_corrupt')
  }

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
