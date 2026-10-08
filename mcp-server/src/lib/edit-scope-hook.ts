import { evaluateEditGuard } from './edit-guard.js'
import { resolveProjectRootFromArgs } from './hook-project-root.js'
import { resolveProjectRoot } from './project-root.js'

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
    const paths = [toolInput.file_path, toolInput.notebook_path].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    if (paths.length === 0) return { exitCode: 0, message: null }

    const cwdForResolve = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : cwd
    const projectRoot = resolveProjectRootFromArgs({ argv: [], env, cwd: cwdForResolve })
    const resolution = resolveProjectRoot(projectRoot)
    for (const filePath of paths) {
      const guard = evaluateEditGuard({
        projectRoot: resolution.root,
        rsctInstalled: resolution.rsct_installed,
        filePath,
        cwd: cwdForResolve,
      })
      if (guard.decision === 'block') {
        return { exitCode: 2, message: `[rsct] Edit blocked (${guard.status}): ${guard.reason}` }
      }
    }
    return { exitCode: 0, message: null }
  } catch {
    return { exitCode: 0, message: null }
  }
}
