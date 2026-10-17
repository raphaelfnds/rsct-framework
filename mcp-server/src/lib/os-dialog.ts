import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'

export type DialogResponse = 'yes' | 'no' | 'no-channel'

export type DialogChannel = 'windows' | 'macos' | 'linux-zenity' | 'none'

export interface DialogOptions {
  title: string
  message: string
}

export interface DialogResult {
  response: DialogResponse
  channel: DialogChannel
  error?: string
  input_fault?: true
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  error?: string
}

export type Executor = (cmd: string, args: string[], env?: Record<string, string>) => ExecResult

export interface PromptInternalOptions {
  platform?: NodeJS.Platform
  executor?: Executor
}

export const DIALOG_TEXT_LIMIT = 32_000
export const DIALOG_MESSAGE_VARIABLE = 'RSCT_DIALOG_MESSAGE'
export const DIALOG_TITLE_VARIABLE = 'RSCT_DIALOG_TITLE'
const MAC_OSASCRIPT = '/usr/bin/osascript'
const LINUX_ZENITY = '/usr/bin/zenity'

const VISIBLE_NUL = '\u2400'

const WINDOWS_SCRIPT =
  'Add-Type -AssemblyName System.Windows.Forms; ' +
  `$r = [System.Windows.Forms.MessageBox]::Show($env:${DIALOG_MESSAGE_VARIABLE}, $env:${DIALOG_TITLE_VARIABLE}, 'YesNo', 'Question'); ` +
  'Write-Output $r'

const MAC_SCRIPT_LINES: readonly string[] = [
  "ObjC.import('Foundation')",
  'const env = $.NSProcessInfo.processInfo.environment',
  `const message = ObjC.unwrap(env.objectForKey('${DIALOG_MESSAGE_VARIABLE}'))`,
  `const title = ObjC.unwrap(env.objectForKey('${DIALOG_TITLE_VARIABLE}'))`,
  'const app = Application.currentApplication()',
  'app.includeStandardAdditions = true',
  "app.displayDialog(message, { withTitle: title, buttons: ['No', 'Yes'], defaultButton: 'Yes' }).buttonReturned",
]

export async function promptYesNo(
  options: DialogOptions,
  internal: PromptInternalOptions = {},
): Promise<DialogResult> {
  const text: DialogOptions = {
    title: options.title.replaceAll('\u0000', VISIBLE_NUL),
    message: options.message.replaceAll('\u0000', VISIBLE_NUL),
  }
  const length = text.title.length + text.message.length
  if (length > DIALOG_TEXT_LIMIT) {
    return {
      response: 'no-channel',
      channel: 'none',
      error: `the dialog text is ${length} characters long; the limit is ${DIALOG_TEXT_LIMIT}`,
      input_fault: true,
    }
  }

  const platform = internal.platform ?? process.platform
  const executor = internal.executor ?? defaultExecutor

  switch (platform) {
    case 'win32':
      return runWindowsDialog(text, executor)
    case 'darwin':
      return runMacDialog(text, executor)
    case 'linux':
      return runLinuxDialog(text, executor)
    default:
      return {
        response: 'no-channel',
        channel: 'none',
        error: `unsupported platform: ${platform}`,
      }
  }
}

export function defaultExecutor(cmd: string, args: string[], env?: Record<string, string>): ExecResult {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
      ...(env !== undefined && { env: { ...process.env, ...env } }),
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

function dialogEnvironment(options: DialogOptions): Record<string, string> {
  return {
    [DIALOG_MESSAGE_VARIABLE]: options.message,
    [DIALOG_TITLE_VARIABLE]: options.title,
  }
}

export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot
  const root = systemRoot !== undefined && win32.isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows'
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function runWindowsDialog(options: DialogOptions, executor: Executor): DialogResult {
  const exec = executor(
    windowsPowerShellPath(),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
    dialogEnvironment(options),
  )

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

export function runMacDialog(options: DialogOptions, executor: Executor): DialogResult {
  const exec = executor(
    MAC_OSASCRIPT,
    ['-l', 'JavaScript', ...MAC_SCRIPT_LINES.flatMap((line) => ['-e', line])],
    dialogEnvironment(options),
  )

  if (exec.exitCode !== 0) {
    if (exec.error && exec.exitCode < 0) {
      return { response: 'no-channel', channel: 'none', error: exec.error }
    }
    return { response: 'no', channel: 'macos' }
  }
  const stdout = exec.stdout.trim()
  if (stdout === 'Yes') return { response: 'yes', channel: 'macos' }
  if (stdout === 'No') return { response: 'no', channel: 'macos' }
  return {
    response: 'no-channel',
    channel: 'none',
    error: `unexpected osascript output: ${stdout}`,
  }
}

export function runLinuxDialog(options: DialogOptions, executor: Executor): DialogResult {
  const exec = executor(LINUX_ZENITY, [
    '--question',
    `--title=${options.title}`,
    `--text=${options.message}`,
    '--no-wrap',
    '--no-markup',
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
