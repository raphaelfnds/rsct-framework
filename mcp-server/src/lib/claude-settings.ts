import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
 * Read and parse one path with a plain `JSON.parse` — deliberately no leniency,
 * and a UTF-8 BOM is the case that makes the point.
 *
 * A BOM (Notepad, PowerShell 5.1 `Out-File -Encoding utf8`) survives
 * `readFileSync(_, 'utf8')` and makes `JSON.parse` throw. Stripping it here
 * would let this reader see a document NOTHING else in RSCT can read:
 * `src/scripts/sanitize-permissions.ts` parses raw, and so do all five bash
 * blocks in `prompts/01-setup.md` and `prompts/03-uninstall.md`. On a BOM'd file
 * the sanitizer aborts and the poison-pill strip never happens — so a lenient
 * reader would find the hook entry, report enforcement as live, and produce
 * exactly the false-healthy verdict this check exists to remove. Being MORE
 * permissive than the component you are reporting on is how you end up lying
 * about it.
 *
 * A BOM therefore lands in `malformed` — no evidence, silence. That is the wrong
 * answer in the safe direction; the right fix is to tolerate a BOM everywhere or
 * nowhere, which spans surfaces well outside this module.
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
    return { path, status: 'ok', data: JSON.parse(raw) }
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
