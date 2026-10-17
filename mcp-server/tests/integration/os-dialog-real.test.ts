import { describe, it, expect } from 'vitest'
import {
  defaultExecutor,
  runMacDialog,
  runWindowsDialog,
  DIALOG_MESSAGE_VARIABLE,
  DIALOG_TITLE_VARIABLE,
  type DialogOptions,
  type Executor,
} from '../../src/lib/os-dialog.js'

const CORPUS: string[] = [
  'Approve commit on main?\n\nmessage: fix the parser',
  'don’t stop',
  ...[
    '‘', '’', '‚', '‛', '“', '”', '„', '‟', '‹', '›',
    '«', '»', 'ʼ', '′', '″', '＂', '＇', "'", '"', '`', '\\', '$', '%', '&',
  ],
  'it costs $5 and 100% of `the` effort',
  '-e',
  '--',
  'line1\nline2\r\nline3',
  'acentuação 中文 \u{1F600}',
  '',
  'x'.repeat(10_000),
]

const TITLE = 'RSCT — commit approval'

const SUBSTITUTE: Record<string, string> = {
  [DIALOG_MESSAGE_VARIABLE]: 'substitute text',
  [DIALOG_TITLE_VARIABLE]: 'substitute title',
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const WINDOWS_CALL = '[System.Windows.Forms.MessageBox]::Show('

function windowsEcho(captured: { stdout: string }, envInstead?: Record<string, string>): Executor {
  return (cmd, args, env) => {
    const script = args[args.length - 1] ?? ''
    expect(occurrences(args.join('\n'), WINDOWS_CALL)).toBe(1)
    const echo = script
      .replace(WINDOWS_CALL, '[string]::Concat(')
      .replace('Write-Output $r', 'Write-Output ([System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($r)))')
    const result = defaultExecutor(cmd, [...args.slice(0, -1), echo], envInstead ?? env)
    captured.stdout = result.stdout.trim()
    return result
  }
}

const MAC_CALL = 'app.displayDialog('
const MAC_ECHO_APP =
  "const echoApp = { displayDialog: (text, options) => ({ buttonReturned: encodeURIComponent([text, options.withTitle, options.buttons.join(','), options.defaultButton].join('|')) }) }"

function macEcho(captured: { stdout: string }, envInstead?: Record<string, string>): Executor {
  return (cmd, args, env) => {
    expect(args.filter((a) => a.includes(MAC_CALL)).length).toBe(1)
    expect(occurrences(args.join('\n'), MAC_CALL)).toBe(1)
    const echoed = args.flatMap((a) =>
      a.includes(MAC_CALL) ? [MAC_ECHO_APP, '-e', a.replace(MAC_CALL, 'echoApp.displayDialog(')] : [a],
    )
    const result = defaultExecutor(cmd, echoed, envInstead ?? env)
    captured.stdout = result.stdout.trim()
    return result
  }
}

const windowsShown = (stdout: string): string => Buffer.from(stdout, 'base64').toString('utf8')
const macShown = (stdout: string): string => decodeURIComponent(stdout)

describe.runIf(process.platform === 'win32')('runWindowsDialog — real powershell, no window', () => {
  it('every text reaches the dialog call verbatim', () => {
    for (const message of CORPUS) {
      const captured = { stdout: '' }
      const options: DialogOptions = { title: TITLE, message }
      runWindowsDialog(options, windowsEcho(captured))
      expect(windowsShown(captured.stdout)).toBe(`${message}${TITLE}YesNoQuestion`)
    }
  }, 300_000)

  it('the text shown is the one in the two variables, not one carried by the arguments', () => {
    const captured = { stdout: '' }
    runWindowsDialog({ title: TITLE, message: CORPUS[0]! }, windowsEcho(captured, SUBSTITUTE))
    expect(windowsShown(captured.stdout)).toBe('substitute textsubstitute titleYesNoQuestion')
  }, 60_000)
})

describe.runIf(process.platform === 'darwin')('runMacDialog — real osascript, no window', () => {
  it('every text reaches the dialog call verbatim', () => {
    for (const message of CORPUS) {
      const captured = { stdout: '' }
      runMacDialog({ title: TITLE, message }, macEcho(captured))
      expect(macShown(captured.stdout)).toBe([message, TITLE, 'No,Yes', 'Yes'].join('|'))
    }
  }, 300_000)

  it('the text shown is the one in the two variables, not one carried by the arguments', () => {
    const captured = { stdout: '' }
    runMacDialog({ title: TITLE, message: CORPUS[0]! }, macEcho(captured, SUBSTITUTE))
    expect(macShown(captured.stdout)).toBe(['substitute text', 'substitute title', 'No,Yes', 'Yes'].join('|'))
  }, 60_000)
})
