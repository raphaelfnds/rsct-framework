import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Strip a leading UTF-8 BOM (U+FEFF) so `JSON.parse` accepts the document.
 *
 * `readFileSync(_, 'utf8')` keeps the BOM, and `JSON.parse` rejects it — so one
 * save from Notepad or PowerShell 5.1 (`Out-File -Encoding utf8`, `Set-Content`)
 * makes a perfectly valid config unreadable to the whole framework. That failure
 * is Windows-origin but not Windows-only: the file travels in git.
 *
 * **Tolerate on read, never re-emit.** Callers strip before parsing and write
 * back plain UTF-8; a document that arrives with a BOM loses it the first time
 * the framework rewrites the file, and that is intended — nothing downstream
 * benefits from carrying it, and re-emitting would keep the file hostile to every
 * other JSON reader in the ecosystem.
 *
 * Every RSCT parse site of a shared JSON file must use this, or the ones that do
 * become MORE permissive than the ones that do not — and a reader that sees a
 * document its own enforcement scripts cannot read will report healthy while
 * nothing runs. That split-brain is why #24 reverted its own BOM handling and
 * deferred it here.
 *
 * Lives in `io-utils` (node builtins only) so `src/scripts/sanitize-permissions.ts`
 * can import it without pulling zod into a bundle that runs on every session boot.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

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
