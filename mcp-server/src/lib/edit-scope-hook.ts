import { isAbsolute, resolve } from 'node:path'
import { evaluateEditGuard } from './edit-guard.js'
import { resolveProjectRootFromArgs } from './hook-project-root.js'
import { resolveProjectRoot } from './project-root.js'
import { judgeSettingsWrite } from './settings-write-guard.js'

export interface GuardDecision {
  exitCode: 0 | 2
  message: string | null
}

export function decide(
  rawStdin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  evaluate: typeof evaluateEditGuard = evaluateEditGuard,
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
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''
    for (const filePath of paths) {
      const absolute = isAbsolute(filePath) ? filePath : resolve(cwdForResolve, filePath)
      const settingsWrite = judgeSettingsWrite(toolName, toolInput, absolute)
      if (settingsWrite.block) return { exitCode: 2, message: `[rsct] Edit blocked (claude_settings): ${settingsWrite.reason}` }
    }
    const projectRoot = resolveProjectRootFromArgs({ argv: [], env, cwd: cwdForResolve })
    const resolution = resolveProjectRoot(projectRoot)
    for (const filePath of paths) {
      const guard = evaluate({
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
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return {
      exitCode: 2,
      message: `[rsct] Edit blocked (guard_failed): the edit-scope guard failed (${why}), so the edit did not run. STOP and tell the developer: they can make the edit themselves. If every edit is refused, they repair the guard: in their own editor, remove the entry that runs edit-scope-guard.js from .claude/settings.json or .claude/settings.local.json, then run /rsct-setup again.`,
    }
  }
}
