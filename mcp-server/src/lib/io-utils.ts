import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Ensure the parent directory of `filePath` exists, creating it (and any
 * missing ancestors) idempotently. Wraps `mkdirSync({ recursive: true })`
 * so callers express intent ("make sure I can write here") rather than
 * an mkdir invocation.
 *
 * Audit/anti-replay writers both need this guarantee before their first
 * write to `.rsct/audit.log` or `.rsct/approvals-seen.json` on a fresh
 * project; centralising the helper avoids drift between the two
 * implementations.
 */
export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}
