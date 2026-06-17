import { describe, it, expect } from 'vitest'
import {
  promptYesNo,
  runWindowsDialog,
  runMacDialog,
  runLinuxDialog,
  type ExecResult,
  type Executor,
} from '../../src/lib/os-dialog.js'

const OPTS = { title: 'RSCT §C', message: 'Approve commit on protected branch?' }

function mockExec(impl: (cmd: string, args: string[]) => ExecResult): Executor {
  return (cmd, args) => impl(cmd, args)
}

const NEVER_CALLED: Executor = () => {
  throw new Error('executor should not be called when env override is set')
}

describe('promptYesNo — env override', () => {
  it('returns yes / env-override when RSCT_TEST_DIALOG_RESPONSE=yes', async () => {
    const r = await promptYesNo(OPTS, {
      env: { RSCT_TEST_DIALOG_RESPONSE: 'yes' },
      executor: NEVER_CALLED,
    })
    expect(r).toEqual({ response: 'yes', channel: 'env-override' })
  })

  it('returns no / env-override when RSCT_TEST_DIALOG_RESPONSE=no', async () => {
    const r = await promptYesNo(OPTS, {
      env: { RSCT_TEST_DIALOG_RESPONSE: 'NO' }, // case-insensitive
      executor: NEVER_CALLED,
    })
    expect(r).toEqual({ response: 'no', channel: 'env-override' })
  })

  it('ignores invalid override values and falls through to platform', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const r = await promptYesNo(OPTS, {
      env: { RSCT_TEST_DIALOG_RESPONSE: 'maybe' },
      platform: 'win32',
      executor: mockExec((cmd, args) => {
        calls.push({ cmd, args })
        return { exitCode: 0, stdout: 'Yes\n', stderr: '' }
      }),
    })
    expect(r.response).toBe('yes')
    expect(r.channel).toBe('windows')
    expect(calls.length).toBe(1)
  })
})

describe('promptYesNo — platform routing', () => {
  it('returns no-channel for an unsupported platform', async () => {
    const r = await promptYesNo(OPTS, {
      env: {},
      platform: 'freebsd' as NodeJS.Platform,
      executor: NEVER_CALLED,
    })
    expect(r.response).toBe('no-channel')
    expect(r.channel).toBe('none')
    expect(r.error).toContain('freebsd')
  })

  it('routes win32 to PowerShell MessageBox', async () => {
    const r = await promptYesNo(OPTS, {
      env: {},
      platform: 'win32',
      executor: mockExec(() => ({ exitCode: 0, stdout: 'Yes', stderr: '' })),
    })
    expect(r).toEqual({ response: 'yes', channel: 'windows' })
  })

  it('routes darwin to osascript', async () => {
    const r = await promptYesNo(OPTS, {
      env: {},
      platform: 'darwin',
      executor: mockExec(() => ({
        exitCode: 0,
        stdout: 'button returned:Yes',
        stderr: '',
      })),
    })
    expect(r).toEqual({ response: 'yes', channel: 'macos' })
  })

  it('routes linux to zenity', async () => {
    const r = await promptYesNo(OPTS, {
      env: {},
      platform: 'linux',
      executor: mockExec(() => ({ exitCode: 0, stdout: '', stderr: '' })),
    })
    expect(r).toEqual({ response: 'yes', channel: 'linux-zenity' })
  })
})

describe('runWindowsDialog', () => {
  it('passes a single-quote-escaped script to powershell', () => {
    let capturedScript = ''
    runWindowsDialog(
      { title: "Don't lose work", message: "It's the §C dialog" },
      mockExec((cmd, args) => {
        expect(cmd).toBe('powershell.exe')
        expect(args).toContain('-NoProfile')
        expect(args).toContain('-ExecutionPolicy')
        capturedScript = args[args.length - 1] ?? ''
        return { exitCode: 0, stdout: 'Yes', stderr: '' }
      }),
    )
    // PowerShell single-quoted string escapes ' as ''.
    expect(capturedScript).toContain("Don''t lose work")
    expect(capturedScript).toContain("It''s the §C dialog")
  })

  it('returns yes / windows for stdout "Yes"', () => {
    const r = runWindowsDialog(
      OPTS,
      mockExec(() => ({ exitCode: 0, stdout: 'Yes\r\n', stderr: '' })),
    )
    expect(r).toEqual({ response: 'yes', channel: 'windows' })
  })

  it('returns no / windows for stdout "No"', () => {
    const r = runWindowsDialog(
      OPTS,
      mockExec(() => ({ exitCode: 0, stdout: 'No\r\n', stderr: '' })),
    )
    expect(r).toEqual({ response: 'no', channel: 'windows' })
  })

  it('returns no-channel when powershell errors (ENOENT)', () => {
    const r = runWindowsDialog(
      OPTS,
      mockExec(() => ({
        exitCode: -1,
        stdout: '',
        stderr: '',
        error: 'spawn powershell.exe ENOENT',
      })),
    )
    expect(r.response).toBe('no-channel')
    expect(r.channel).toBe('none')
    expect(r.error).toContain('ENOENT')
  })

  it('returns no-channel for unexpected output', () => {
    const r = runWindowsDialog(
      OPTS,
      mockExec(() => ({ exitCode: 0, stdout: 'Cancel', stderr: '' })),
    )
    expect(r.response).toBe('no-channel')
    expect(r.error).toContain('Cancel')
  })
})

describe('runMacDialog', () => {
  it('escapes double quotes and backslashes in the AppleScript', () => {
    let capturedScript = ''
    runMacDialog(
      { title: 'msg\\title with "quotes"', message: 'with "quoted" text' },
      mockExec((_cmd, args) => {
        capturedScript = args[1] ?? ''
        return { exitCode: 0, stdout: 'button returned:Yes', stderr: '' }
      }),
    )
    expect(capturedScript).toContain('msg\\\\title with \\"quotes\\"')
    expect(capturedScript).toContain('with \\"quoted\\" text')
  })

  it('returns yes for "button returned:Yes" stdout', () => {
    const r = runMacDialog(
      OPTS,
      mockExec(() => ({
        exitCode: 0,
        stdout: 'button returned:Yes',
        stderr: '',
      })),
    )
    expect(r).toEqual({ response: 'yes', channel: 'macos' })
  })

  it('returns no when osascript exits non-zero (user canceled)', () => {
    const r = runMacDialog(
      OPTS,
      mockExec(() => ({
        exitCode: 1,
        stdout: '',
        stderr: 'execution error: User canceled. (-128)',
      })),
    )
    expect(r).toEqual({ response: 'no', channel: 'macos' })
  })

  it('returns no-channel when osascript binary is missing', () => {
    const r = runMacDialog(
      OPTS,
      mockExec(() => ({
        exitCode: -1,
        stdout: '',
        stderr: '',
        error: 'spawn osascript ENOENT',
      })),
    )
    expect(r.response).toBe('no-channel')
    expect(r.error).toContain('ENOENT')
  })
})

describe('runLinuxDialog', () => {
  it('maps zenity exit 0 to yes', () => {
    const r = runLinuxDialog(
      OPTS,
      mockExec(() => ({ exitCode: 0, stdout: '', stderr: '' })),
    )
    expect(r).toEqual({ response: 'yes', channel: 'linux-zenity' })
  })

  it('maps zenity exit 1 to no', () => {
    const r = runLinuxDialog(
      OPTS,
      mockExec(() => ({ exitCode: 1, stdout: '', stderr: '' })),
    )
    expect(r).toEqual({ response: 'no', channel: 'linux-zenity' })
  })

  it('returns no-channel when zenity is not installed', () => {
    const r = runLinuxDialog(
      OPTS,
      mockExec(() => ({
        exitCode: -1,
        stdout: '',
        stderr: '',
        error: 'spawn zenity ENOENT',
      })),
    )
    expect(r.response).toBe('no-channel')
    expect(r.error).toContain('ENOENT')
  })

  it('returns no-channel for unexpected exit codes', () => {
    const r = runLinuxDialog(
      OPTS,
      mockExec(() => ({ exitCode: 5, stdout: '', stderr: 'X11 error' })),
    )
    expect(r.response).toBe('no-channel')
    expect(r.error).toContain('zenity exit 5')
  })
})
