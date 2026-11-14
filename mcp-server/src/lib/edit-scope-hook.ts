import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { decideAuditPath } from './audit-log.js'
import { evaluateEditGuard } from './edit-guard.js'
import { resolveProjectRootFromArgs } from './hook-project-root.js'
import { resolveProjectRoot } from './project-root.js'
import { judgeProtectedPath, pathComponents } from './protected-paths.js'
import { canonicalPath } from './repo-anchor.js'
import { judgeClaudeAssetWrite, judgeClaudeConfigFile, judgeRsctConfigWrite, judgeSettingsWrite } from './settings-write-guard.js'

function samePath(a: string, b: string): boolean {
  return pathComponents(canonicalPath(a)).join('/') === pathComponents(canonicalPath(b)).join('/')
}

function configFolders(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const value = env.CLAUDE_CONFIG_DIR ?? ''
  if (value === '') return []
  const forms = /^~(?=$|[\\/])/.test(value) ? [value, join(homedir(), value.slice(1))] : [value]
  const bases = [cwd, env.CLAUDE_PROJECT_DIR].filter((b): b is string => typeof b === 'string' && b.length > 0)
  return [...new Set(forms.flatMap((form) => (isAbsolute(form) ? [resolve(form)] : bases.map((b) => resolve(b, form)))))]
}

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
    const absolutes = paths.map((filePath) => (isAbsolute(filePath) ? filePath : resolve(cwdForResolve, filePath)))
    const configDirs = configFolders(env, cwdForResolve)
    for (const absolute of absolutes) {
      const guarded = judgeProtectedPath(absolute)
      if (guarded.block) return { exitCode: 2, message: `[rsct] Edit blocked (protected_path): ${guarded.reason}` }
      const configFile = judgeClaudeConfigFile(toolName, absolute, configDirs)
      if (configFile.block) return { exitCode: 2, message: `[rsct] Edit blocked (claude_settings): ${configFile.reason}` }
      const settingsWrite = judgeSettingsWrite(toolName, toolInput, absolute, undefined, configDirs)
      if (settingsWrite.block) return { exitCode: 2, message: `[rsct] Edit blocked (claude_settings): ${settingsWrite.reason}` }
      const configWrite = judgeRsctConfigWrite(toolName, toolInput, absolute)
      if (configWrite.block) return { exitCode: 2, message: `[rsct] Edit blocked (rsct_config): ${configWrite.reason}` }
      const asset = judgeClaudeAssetWrite(toolName, toolInput, absolute, undefined, configDirs)
      if (asset.block) return { exitCode: 2, message: `[rsct] Edit blocked (claude_settings): ${asset.reason}` }
    }
    const projectRoot = resolveProjectRootFromArgs({ argv: [], env, cwd: cwdForResolve })
    const resolution = resolveProjectRoot(projectRoot)
    if (resolution.config?.audit?.path !== undefined) {
      const auditPath = decideAuditPath(resolution.root, resolution.config.audit).path
      if (absolutes.some((absolute) => samePath(absolute, auditPath))) {
        return { exitCode: 2, message: "[rsct] Edit blocked (protected_path): this write would change RSCT's audit log; that is the developer's own edit" }
      }
    }
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
