import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { stripBom } from './io-utils.js'

/**
 * Reader for the project-scope Claude Code settings files. Deliberately DUMB: it
 * resolves the paths, reads, parses, and reports what it saw. It knows nothing
 * about hooks, markers or enforcement — callers interpret.
 *
 * **Scope is project-local, and that is a security decision.** Claude Code also
 * merges a user-level `~/.claude/settings.json` (and enterprise-managed
 * settings), but this module does not read them, for two independent reasons:
 *
 *  - The user-level file exists on essentially every machine that runs Claude
 *    Code and usually carries no `hooks` key at all. Admitting it as evidence
 *    would make every project without its own hook entry look like a positive
 *    "not registered" finding, when in fact nothing was observed about that
 *    project. The "no evidence" branch would become unreachable in the field.
 *  - Registration is detected by a path SUBSTRING (see `lib/version-drift.ts`),
 *    and a user-level entry is inherently project-agnostic: an absolute path
 *    registering the hook for a DIFFERENT project still contains
 *    `.rsct/scripts/<name>.js`, so it would read as registered for every project
 *    on the machine. That is precisely the false-healthy report this check
 *    exists to remove.
 *
 * Accepted consequence: a hook registered ONLY at user or enterprise level reads
 * as unregistered here. Callers must phrase their finding as what was observed
 * in THIS project's files, never as a claim about the machine.
 *
 * **No non-builtin imports, ever.** `src/scripts/sanitize-permissions.ts` is
 * bundled into a standalone SessionStart hook and will want this reader (#12).
 * That bundle is ~9 KB because it imports node builtins only; the sibling
 * edit-scope guard is ~146 KB purely from reaching `lib/project-root.ts` and
 * pulling zod along. A zod-carrying reader would inflate a hook that runs on
 * every session boot by an order of magnitude.
 */

/**
 * What was observed at one path. The four values are NOT decoration — callers
 * split them into two groups that mean opposite things:
 *
 *  - `ok` and `absent` are both EVIDENCE. A file that is not there holds no hook,
 *    which is a fact about the project, the same way an absent `.rsct/scripts`
 *    directory is treated as positive evidence in `lib/version-drift.ts`.
 *  - `unreadable` and `malformed` are the absence of evidence. Something is there
 *    and we could not see into it, so no conclusion may be drawn from it.
 */
export type SettingsStatus = 'ok' | 'absent' | 'unreadable' | 'malformed'

export interface SettingsFile {
  /** Absolute path that was attempted. */
  path: string
  status: SettingsStatus
  /** Parsed document when `status === 'ok'`, else null. Untyped by design. */
  data: unknown
}

/**
 * The project-scope files Claude Code merges, in precedence order. `/rsct-setup`
 * writes hooks into `settings.json` only, but a dev may legitimately move an
 * entry into `settings.local.json` — and there it still runs, so it still counts
 * as evidence. The question this module serves is whether enforcement is live,
 * not whether setup ran.
 */
export const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

/**
 * Read and parse one path, tolerating a UTF-8 BOM.
 *
 * #24 deliberately did NOT strip it here, and the reasoning is worth keeping:
 * a lenient reader would have seen a document nothing else in RSCT could read —
 * the sanitizer and every bash block parsed raw — so on a BOM'd file it would
 * have found the hook entry and reported enforcement as live while the sanitizer
 * aborted and enforced nothing. Being more permissive than the component you
 * report on is how you end up lying about it.
 *
 * #12 removed that asymmetry by making all eleven parse sites tolerate a BOM, so
 * this reader is no longer ahead of anyone. `stripBom` is the shared one.
 */
function parseSettings(path: string): SettingsFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    // ENOENT is a fact about the project. Anything else (EACCES, EIO, a stalled
    // UNC mount) means we could not look — never report that as "not there".
    return { path, status: code === 'ENOENT' ? 'absent' : 'unreadable', data: null }
  }
  try {
    return { path, status: 'ok', data: JSON.parse(stripBom(raw)) }
  } catch {
    return { path, status: 'malformed', data: null }
  }
}

/**
 * Read every project-scope settings file. Never throws; always returns one entry
 * per candidate, in `PROJECT_SETTINGS_FILES` order.
 */
export function readClaudeSettings(projectRoot: string): SettingsFile[] {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return []
  return PROJECT_SETTINGS_FILES.map((name) => parseSettings(join(projectRoot, '.claude', name)))
}
