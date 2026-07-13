import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { resolveProjectRoot } from '../lib/project-root.js'
import { evaluateEditGuard } from '../lib/edit-guard.js'
import { resolveProjectRootFromArgs } from './sanitize-permissions.js'

/**
 * plan-lifecycle-v2 — Bloco 3.3: the PreToolUse Edit/Write/MultiEdit/
 * NotebookEdit guard entrypoint. Reads the hook payload on stdin, resolves the
 * project, and returns exit 2 (deny — the ONE authoritative block signal Claude
 * Code honors) ONLY for a genuine policy block. Every other outcome — allow,
 * empty/malformed stdin, missing file_path, or ANY fault — is exit 0, so a
 * broken guard never bricks editing (fail-OPEN on infra, fail-CLOSED on policy).
 */
export interface GuardDecision {
  exitCode: 0 | 2
  message: string | null
}

export function decide(
  rawStdin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): GuardDecision {
  try {
    const trimmed = rawStdin.trim()
    if (!trimmed) return { exitCode: 0, message: null }

    let payload: Record<string, unknown>
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!parsed || typeof parsed !== 'object') return { exitCode: 0, message: null }
      payload = parsed as Record<string, unknown>
    } catch {
      return { exitCode: 0, message: null }
    }

    const toolInput =
      payload.tool_input && typeof payload.tool_input === 'object'
        ? (payload.tool_input as Record<string, unknown>)
        : {}
    const rawPath = toolInput.file_path ?? toolInput.notebook_path
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return { exitCode: 0, message: null }
    }

    const cwdForResolve = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : cwd
    const projectRoot = resolveProjectRootFromArgs({ argv: [], env, cwd: cwdForResolve })
    const resolution = resolveProjectRoot(projectRoot)
    const guard = evaluateEditGuard({
      projectRoot: resolution.root,
      rsctInstalled: resolution.rsct_installed,
      filePath: rawPath,
    })

    if (guard.decision === 'block') {
      return { exitCode: 2, message: `[rsct] Edit blocked (${guard.status}): ${guard.reason}` }
    }
    return { exitCode: 0, message: null }
  } catch {
    // Any machinery fault ⇒ allow (a broken guard must never brick editing).
    return { exitCode: 0, message: null }
  }
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function isMain(): boolean {
  if (!process.argv[1]) return false
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1])
  } catch {
    return false
  }
}

if (isMain()) {
  const decision = decide(readStdin(), process.env, process.cwd())
  if (decision.message) process.stderr.write(`${decision.message}\n`)
  process.exit(decision.exitCode)
}
