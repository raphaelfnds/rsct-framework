import { execFileSync } from 'node:child_process'

/**
 * Cross-platform Yes/No OS dialog adapter (INV-2.1: validation channel
 * inaccessible to Claude). F2.5.5 consumes this; F2.5.0..F2.5.3 do not.
 *
 * The dialog is rendered by the user's desktop environment, NOT by
 * Claude Code's tool-result channel — that's the property M2 leans on
 * to make the §C contract enforceable against a fabricated `dev_approval`.
 *
 * Tests cannot pop real dialogs, so this module exposes two seams:
 *
 *  1. `RSCT_TEST_DIALOG_RESPONSE=yes|no` env override — short-circuits to
 *     the configured response. Documented as test-only; in production
 *     the env var should not be set. Anyone running with it set is
 *     explicitly opting out of dialog enforcement (like `--unsafe-perm`).
 *  2. Injectable `executor` parameter on each per-platform helper — lets
 *     unit tests substitute `execFileSync` with a fake that returns
 *     known exit codes and stdout.
 */

export type DialogResponse = 'yes' | 'no' | 'no-channel'

export type DialogChannel =
  | 'env-override'
  | 'windows'
  | 'macos'
  | 'linux-zenity'
  | 'none'

export interface DialogOptions {
  title: string
  message: string
}

export interface DialogResult {
  response: DialogResponse
  channel: DialogChannel
  error?: string
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  error?: string
}

export type Executor = (cmd: string, args: string[]) => ExecResult

export interface PromptInternalOptions {
  platform?: NodeJS.Platform
  executor?: Executor
  env?: NodeJS.ProcessEnv
}

const ENV_OVERRIDE_KEY = 'RSCT_TEST_DIALOG_RESPONSE'

/**
 * Pop a Yes/No dialog appropriate to the host OS. Sync under the hood
 * (`execFileSync`) but exposed as Promise so future async backends
 * (DBus, native module, etc.) can slot in without a breaking change.
 */
export async function promptYesNo(
  options: DialogOptions,
  internal: PromptInternalOptions = {},
): Promise<DialogResult> {
  const env = internal.env ?? process.env
  const override = readEnvOverride(env)
  if (override !== null) {
    return { response: override, channel: 'env-override' }
  }

  const platform = internal.platform ?? process.platform
  const executor = internal.executor ?? defaultExecutor

  switch (platform) {
    case 'win32':
      return runWindowsDialog(options, executor)
    case 'darwin':
      return runMacDialog(options, executor)
    case 'linux':
      return runLinuxDialog(options, executor)
    default:
      return {
        response: 'no-channel',
        channel: 'none',
        error: `unsupported platform: ${platform}`,
      }
  }
}

function readEnvOverride(env: NodeJS.ProcessEnv): DialogResponse | null {
  const raw = env[ENV_OVERRIDE_KEY]
  if (!raw) return null
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'yes') return 'yes'
  if (normalized === 'no') return 'no'
  return null
}

/**
 * Default executor: wraps `execFileSync` and normalizes thrown errors
 * (non-zero exit, ENOENT) into the same `ExecResult` shape the platform
 * helpers expect.
 */
function defaultExecutor(cmd: string, args: string[]): ExecResult {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    })
    return { exitCode: 0, stdout, stderr: '' }
  } catch (err) {
    return normalizeExecError(err)
  }
}

function normalizeExecError(err: unknown): ExecResult {
  if (err && typeof err === 'object') {
    const e = err as {
      status?: number | null
      stderr?: string | Buffer
      stdout?: string | Buffer
      code?: string
      message?: string
    }
    const result: ExecResult = {
      exitCode: typeof e.status === 'number' ? e.status : -1,
      stdout: bufferOrStringToString(e.stdout),
      stderr: bufferOrStringToString(e.stderr),
    }
    const message = e.message ?? (e.code ? `exec failed: ${e.code}` : undefined)
    if (message) result.error = message
    return result
  }
  return { exitCode: -1, stdout: '', stderr: '', error: String(err) }
}

function bufferOrStringToString(value: string | Buffer | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return value.toString('utf8')
}

/**
 * Escape a value for embedding inside a PowerShell single-quoted string.
 * PowerShell doubles `'` to escape; nothing else needs escaping inside
 * single-quoted strings.
 */
function escapePowerShellSingleQuoted(s: string): string {
  return s.replace(/'/g, "''")
}

export function runWindowsDialog(options: DialogOptions, executor: Executor): DialogResult {
  const msg = escapePowerShellSingleQuoted(options.message)
  const title = escapePowerShellSingleQuoted(options.title)
  const script =
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `$r = [System.Windows.Forms.MessageBox]::Show('${msg}', '${title}', 'YesNo', 'Question'); ` +
    `Write-Output $r`
  const exec = executor('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ])

  if (exec.error || exec.exitCode < 0) {
    return {
      response: 'no-channel',
      channel: 'none',
      error: exec.error ?? `powershell exit ${exec.exitCode}`,
    }
  }
  const stdout = exec.stdout.trim()
  if (stdout === 'Yes') return { response: 'yes', channel: 'windows' }
  if (stdout === 'No') return { response: 'no', channel: 'windows' }
  return {
    response: 'no-channel',
    channel: 'none',
    error: `unexpected powershell output: ${stdout}`,
  }
}

/**
 * Escape a value for embedding inside an AppleScript double-quoted string.
 * AppleScript escapes `"` as `\"` and `\` as `\\`.
 */
function escapeAppleScriptDoubleQuoted(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function runMacDialog(options: DialogOptions, executor: Executor): DialogResult {
  const msg = escapeAppleScriptDoubleQuoted(options.message)
  const title = escapeAppleScriptDoubleQuoted(options.title)
  const script = `display dialog "${msg}" with title "${title}" buttons {"No","Yes"} default button "Yes"`
  const exec = executor('osascript', ['-e', script])

  // Cancel / Esc → osascript exits non-zero (typically 1, "User canceled.").
  if (exec.exitCode !== 0) {
    if (exec.error && exec.exitCode < 0) {
      return { response: 'no-channel', channel: 'none', error: exec.error }
    }
    return { response: 'no', channel: 'macos' }
  }
  const stdout = exec.stdout.trim()
  if (stdout.includes('button returned:Yes')) return { response: 'yes', channel: 'macos' }
  if (stdout.includes('button returned:No')) return { response: 'no', channel: 'macos' }
  return {
    response: 'no-channel',
    channel: 'none',
    error: `unexpected osascript output: ${stdout}`,
  }
}

export function runLinuxDialog(options: DialogOptions, executor: Executor): DialogResult {
  const exec = executor('zenity', [
    '--question',
    `--title=${options.title}`,
    `--text=${options.message}`,
    '--no-wrap',
  ])

  if (exec.error && exec.exitCode < 0) {
    return { response: 'no-channel', channel: 'none', error: exec.error }
  }
  if (exec.exitCode === 0) return { response: 'yes', channel: 'linux-zenity' }
  if (exec.exitCode === 1) return { response: 'no', channel: 'linux-zenity' }
  return {
    response: 'no-channel',
    channel: 'none',
    error: `zenity exit ${exec.exitCode}: ${exec.stderr.trim()}`,
  }
}
