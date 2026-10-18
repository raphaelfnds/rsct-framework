import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { PlanAuthorizationBlock } from '../src/lib/phase-scope.js'

export function mintLine(token: PlanAuthorizationBlock, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: token.authorized_at,
    event: 'plan_authorize.authorized',
    plan_slug: token.plan_slug,
    branch: token.branch,
    authorized_at: token.authorized_at,
    expires_at: token.expires_at,
    max_actions: token.max_actions,
    approval_action_scope: token.approval_ref.action_scope,
    approval_timestamp: token.approval_ref.timestamp,
    ...over,
  })
}

export function recordMint(root: string, token: PlanAuthorizationBlock, over: Record<string, unknown> = {}): void {
  mkdirSync(join(root, '.rsct'), { recursive: true })
  appendFileSync(join(root, '.rsct', 'audit.log'), `${mintLine(token, over)}\n`, 'utf8')
}
