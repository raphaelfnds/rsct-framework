import { existsSync, readFileSync } from 'node:fs'

import { decideAuditPath } from './audit-log.js'
import type { PlanAuthorizationBlock } from './phase-scope.js'
import type { RsctAuditConfig } from './project-root.js'

export const PLAN_AUTHORIZED_EVENT = 'plan_authorize.authorized'
export const PLAN_REVOKED_EVENT = 'plan_revoke.revoked'

function sameGrant(entry: Record<string, unknown>, token: PlanAuthorizationBlock): boolean {
  return entry['plan_slug'] === token.plan_slug && entry['branch'] === token.branch && entry['authorized_at'] === token.authorized_at
}

export function isTokenMintRecorded(
  projectRoot: string,
  auditConfig: RsctAuditConfig | undefined,
  token: PlanAuthorizationBlock,
): boolean {
  let minted = false
  try {
    const path = decideAuditPath(projectRoot, auditConfig).path
    if (!existsSync(path)) return false
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.includes(PLAN_AUTHORIZED_EVENT) && !line.includes(PLAN_REVOKED_EVENT)) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (!sameGrant(entry, token)) continue
      if (entry['event'] === PLAN_REVOKED_EVENT) return false
      if (
        entry['event'] === PLAN_AUTHORIZED_EVENT &&
        entry['max_actions'] === token.max_actions &&
        entry['expires_at'] === token.expires_at &&
        entry['approval_action_scope'] === token.approval_ref?.action_scope &&
        entry['approval_timestamp'] === token.approval_ref?.timestamp
      ) {
        minted = true
      }
    }
  } catch {
    return false
  }
  return minted
}
