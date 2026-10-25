import { readDatabaseSwitches } from './database-switches.js'
import { judgeCommand, type JudgeOptions, type ShellDialect } from './terminal-guard.js'

export interface TerminalGuardDecision {
  exitCode: 0 | 2
  message: string | null
}

export const TERMINAL_TOOLS: ReadonlyMap<string, ShellDialect> = new Map([
  ['Bash', 'bash'],
  ['Monitor', 'bash'],
  ['PowerShell', 'powershell'],
])

const PREFIX = '[rsct] Terminal command blocked'

function refuse(reason: string): TerminalGuardDecision {
  return { exitCode: 2, message: `${PREFIX}: ${reason}.` }
}

export function decideTerminal(
  rawStdin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  judge: Pick<JudgeOptions, 'resolveAlias' | 'aliasBudgetMs' | 'now'> = {},
): TerminalGuardDecision {
  try {
    let payload: unknown
    try {
      payload = JSON.parse(rawStdin)
    } catch {
      return refuse('the guard could not read the tool call it was given, so nothing ran')
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return refuse('the guard could not read the tool call it was given, so nothing ran')
    }
    const p = payload as Record<string, unknown>
    if (typeof p.tool_name !== 'string') return refuse('the tool call names no tool, so nothing ran')
    const dialect = TERMINAL_TOOLS.get(p.tool_name)
    if (dialect === undefined) return { exitCode: 0, message: null }

    const input = p.tool_input && typeof p.tool_input === 'object' ? (p.tool_input as Record<string, unknown>) : {}
    const command = input.command
    if (typeof command !== 'string') {
      if (p.tool_name === 'Monitor' && input.ws !== undefined) return { exitCode: 0, message: null }
      return refuse(`the ${p.tool_name} call carries no command text the guard can read, so nothing ran`)
    }

    const callCwd = typeof p.cwd === 'string' && p.cwd.length > 0 ? p.cwd : (env.CLAUDE_PROJECT_DIR ?? cwd)
    const switches = readDatabaseSwitches(env.CLAUDE_PROJECT_DIR ?? callCwd)
    const verdict = judgeCommand(command, {
      ...judge,
      dialect,
      cwd: callCwd,
      database: switches.database,
      databaseTestGuard: switches.test,
    })
    if (verdict.verdict === 'allow') return { exitCode: 0, message: null }
    return refuse(verdict.reason)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return {
      exitCode: 2,
      message:
        `${PREFIX}: the terminal guard failed (${why}), so nothing ran. STOP and tell the developer: ` +
        `they can run the command in their own terminal. If every command is refused, they repair the guard: in their own ` +
        `editor, remove the entry that runs terminal-guard.js from .claude/settings.json or .claude/settings.local.json, ` +
        `then run /rsct-setup again.`,
    }
  }
}
