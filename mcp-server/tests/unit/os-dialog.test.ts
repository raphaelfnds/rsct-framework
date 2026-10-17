import { describe, it, expect, afterEach } from 'vitest'
import { win32 } from 'node:path'
import {
  defaultExecutor,
  promptYesNo,
  runWindowsDialog,
  runMacDialog,
  runLinuxDialog,
  windowsPowerShellPath,
  DIALOG_MESSAGE_VARIABLE,
  DIALOG_TITLE_VARIABLE,
  DIALOG_TEXT_LIMIT,
  type ExecResult,
  type Executor,
} from '../../src/lib/os-dialog.js'

const OPTS = { title: 'RSCT §C', message: 'Approve commit on protected branch?' }

interface Call {
  cmd: string
  args: string[]
  env: Record<string, string> | undefined
}

function recording(result: ExecResult): { executor: Executor; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    executor: (cmd, args, env) => {
      calls.push({ cmd, args, env })
      return result
    },
  }
}

const NEVER_CALLED: Executor = () => {
  throw new Error('executor should not be called')
}

const AWKWARD_TEXTS = [
  "Don't lose work",
  'with "quoted" text and a back\\slash',
  'don\u2019t \u00ABguillemets\u00BB \u2039single\u203A \u201Cquotes\u201D \u201Flow\u201E \uFF02wide\uFF02',
  'it costs $5 and 100% of `the` effort',
  '-e first line\nsecond line\r\nthird',
  'acentua\u00e7\u00e3o \u4e2d\u6587 \u{1F600}',
  '',
]

describe('promptYesNo — the test override is gone', () => {
  const saved = process.env.RSCT_TEST_DIALOG_RESPONSE
  afterEach(() => {
    if (saved === undefined) delete process.env.RSCT_TEST_DIALOG_RESPONSE
    else process.env.RSCT_TEST_DIALOG_RESPONSE = saved
  })

  it('RSCT_TEST_DIALOG_RESPONSE=yes in the environment does not answer: the dialog runs and its No stands', async () => {
    process.env.RSCT_TEST_DIALOG_RESPONSE = 'yes'
    const { executor, calls } = recording({ exitCode: 0, stdout: 'No\r\n', stderr: '' })
    const r = await promptYesNo(OPTS, { platform: 'win32', executor })
    expect(r).toEqual({ response: 'no', channel: 'windows' })
    expect(calls.length).toBe(1)
  })
})

describe('promptYesNo — text checks before any dialog', () => {
  it('replaces NUL with a visible symbol in the message and the title', async () => {
    const { executor, calls } = recording({ exitCode: 0, stdout: 'Yes', stderr: '' })
    await promptYesNo({ title: 'ti\u0000tle', message: 'visible\u0000hidden' }, { platform: 'win32', executor })
    expect(calls[0]?.env?.[DIALOG_MESSAGE_VARIABLE]).toBe('visible\u2400hidden')
    expect(calls[0]?.env?.[DIALOG_TITLE_VARIABLE]).toBe('ti\u2400tle')
  })

  it('refuses text over the limit as an input fault without running a dialog', async () => {
    const r = await promptYesNo(
      { title: 't', message: 'x'.repeat(DIALOG_TEXT_LIMIT) },
      { platform: 'win32', executor: NEVER_CALLED },
    )
    expect(r.response).toBe('no-channel')
    expect(r.channel).toBe('none')
    expect(r.input_fault).toBe(true)
    expect(r.error).toContain(String(DIALOG_TEXT_LIMIT))
  })

  it('counts the title toward the limit', async () => {
    const r = await promptYesNo(
      { title: 'x'.repeat(DIALOG_TEXT_LIMIT), message: 'm' },
      { platform: 'win32', executor: NEVER_CALLED },
    )
    expect(r.input_fault).toBe(true)
  })

  it('runs the dialog for text exactly at the limit', async () => {
    const { executor, calls } = recording({ exitCode: 0, stdout: 'Yes', stderr: '' })
    const r = await promptYesNo(
      { title: 't', message: 'x'.repeat(DIALOG_TEXT_LIMIT - 1) },
      { platform: 'linux', executor },
    )
    expect(r).toEqual({ response: 'yes', channel: 'linux-zenity' })
    expect(calls.length).toBe(1)
  })
})

describe('defaultExecutor — environment for the dialog program', () => {
  const saved = process.env[DIALOG_MESSAGE_VARIABLE]
  afterEach(() => {
    if (saved === undefined) delete process.env[DIALOG_MESSAGE_VARIABLE]
    else process.env[DIALOG_MESSAGE_VARIABLE] = saved
  })

  it('hands the child the request text, over a variable of the same name it inherited', () => {
    process.env[DIALOG_MESSAGE_VARIABLE] = 'inherited'
    const r = defaultExecutor(
      process.execPath,
      ['-e', `process.stdout.write(process.env.${DIALOG_MESSAGE_VARIABLE} ?? 'absent')`],
      { [DIALOG_MESSAGE_VARIABLE]: 'request' },
    )
    expect(r).toEqual({ exitCode: 0, stdout: 'request', stderr: '' })
  })
})

describe('promptYesNo — platform routing', () => {
  it('returns no-channel for an unsupported platform', async () => {
    const r = await promptYesNo(OPTS, {
      platform: 'freebsd' as NodeJS.Platform,
      executor: NEVER_CALLED,
    })
    expect(r.response).toBe('no-channel')
    expect(r.channel).toBe('none')
    expect(r.error).toContain('freebsd')
  })

  it('routes win32 to PowerShell MessageBox', async () => {
    const { executor, calls } = recording({ exitCode: 0, stdout: 'Yes', stderr: '' })
    const r = await promptYesNo(OPTS, { platform: 'win32', executor })
    expect(r).toEqual({ response: 'yes', channel: 'windows' })
    expect(calls[0]?.cmd).toBe(windowsPowerShellPath())
  })

  it('routes darwin to osascript', async () => {
    const { executor, calls } = recording({ exitCode: 0, stdout: 'Yes\n', stderr: '' })
    const r = await promptYesNo(OPTS, { platform: 'darwin', executor })
    expect(r).toEqual({ response: 'yes', channel: 'macos' })
    expect(calls[0]?.cmd).toBe('/usr/bin/osascript')
  })

  it('routes linux to zenity', async () => {
    const { executor, calls } = recording({ exitCode: 0, stdout: '', stderr: '' })
    const r = await promptYesNo(OPTS, { platform: 'linux', executor })
    expect(r).toEqual({ response: 'yes', channel: 'linux-zenity' })
    expect(calls[0]?.cmd).toBe('/usr/bin/zenity')
  })
})

describe('windowsPowerShellPath', () => {
  it('is the absolute System32 path under SystemRoot', () => {
    expect(windowsPowerShellPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('falls back to C:\\Windows when SystemRoot is missing or relative', () => {
    const expected = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    expect(windowsPowerShellPath({})).toBe(expected)
    expect(windowsPowerShellPath({ SystemRoot: 'Windows' })).toBe(expected)
    expect(win32.isAbsolute(windowsPowerShellPath())).toBe(true)
  })
})

describe('runWindowsDialog', () => {
  it('runs powershell by absolute path with the same arguments for any text, which travels only in the environment', () => {
    const seen: Call[] = []
    for (const text of AWKWARD_TEXTS) {
      const { executor, calls } = recording({ exitCode: 0, stdout: 'No', stderr: '' })
      runWindowsDialog({ title: `title ${text}`, message: text }, executor)
      seen.push(calls[0]!)
      expect(calls[0]?.env).toEqual({
        [DIALOG_MESSAGE_VARIABLE]: text,
        [DIALOG_TITLE_VARIABLE]: `title ${text}`,
      })
    }
    for (const call of seen) {
      expect(call.cmd).toBe(windowsPowerShellPath())
      expect(call.args).toEqual(seen[0]!.args)
    }
    expect(seen[0]!.args.slice(0, 4)).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'])
    expect(seen[0]!.args[4]).toContain(`$env:${DIALOG_MESSAGE_VARIABLE}`)
  })

  it('returns yes / windows for stdout "Yes"', () => {
    const r = runWindowsDialog(OPTS, recording({ exitCode: 0, stdout: 'Yes\r\n', stderr: '' }).executor)
    expect(r).toEqual({ response: 'yes', channel: 'windows' })
  })

  it('returns no / windows for stdout "No"', () => {
    const r = runWindowsDialog(OPTS, recording({ exitCode: 0, stdout: 'No\r\n', stderr: '' }).executor)
    expect(r).toEqual({ response: 'no', channel: 'windows' })
  })

  it('returns no-channel when powershell errors (ENOENT)', () => {
    const r = runWindowsDialog(
      OPTS,
      recording({ exitCode: -1, stdout: '', stderr: '', error: 'spawn powershell.exe ENOENT' }).executor,
    )
    expect(r.response).toBe('no-channel')
    expect(r.channel).toBe('none')
    expect(r.error).toContain('ENOENT')
  })

  it('returns no-channel for unexpected output', () => {
    const r = runWindowsDialog(OPTS, recording({ exitCode: 0, stdout: 'Cancel', stderr: '' }).executor)
    expect(r.response).toBe('no-channel')
    expect(r.error).toContain('Cancel')
  })
})

describe('runMacDialog', () => {
  it('runs osascript by absolute path with the same arguments for any text, which travels only in the environment', () => {
    const seen: Call[] = []
    for (const text of AWKWARD_TEXTS) {
      const { executor, calls } = recording({ exitCode: 0, stdout: 'No', stderr: '' })
      runMacDialog({ title: `title ${text}`, message: text }, executor)
      seen.push(calls[0]!)
      expect(calls[0]?.env).toEqual({
        [DIALOG_MESSAGE_VARIABLE]: text,
        [DIALOG_TITLE_VARIABLE]: `title ${text}`,
      })
    }
    for (const call of seen) {
      expect(call.cmd).toBe('/usr/bin/osascript')
      expect(call.args).toEqual(seen[0]!.args)
    }
    expect(seen[0]!.args.slice(0, 2)).toEqual(['-l', 'JavaScript'])
  })

  it('reads the message and the title from their own variables and hands both to the dialog', () => {
    const { executor, calls } = recording({ exitCode: 0, stdout: 'No', stderr: '' })
    runMacDialog(OPTS, executor)
    const script = calls[0]!.args.filter((_, i, all) => all[i - 1] === '-e').join('\n')
    expect(script).toContain(`const message = ObjC.unwrap(env.objectForKey('${DIALOG_MESSAGE_VARIABLE}'))`)
    expect(script).toContain(`const title = ObjC.unwrap(env.objectForKey('${DIALOG_TITLE_VARIABLE}'))`)
    expect(script).toContain("app.displayDialog(message, { withTitle: title, buttons: ['No', 'Yes'], defaultButton: 'Yes' }).buttonReturned")
  })

  it('returns yes for stdout "Yes"', () => {
    const r = runMacDialog(OPTS, recording({ exitCode: 0, stdout: 'Yes\n', stderr: '' }).executor)
    expect(r).toEqual({ response: 'yes', channel: 'macos' })
  })

  it('returns no for stdout "No"', () => {
    const r = runMacDialog(OPTS, recording({ exitCode: 0, stdout: 'No\n', stderr: '' }).executor)
    expect(r).toEqual({ response: 'no', channel: 'macos' })
  })

  it('returns no-channel for any other stdout', () => {
    const r = runMacDialog(OPTS, recording({ exitCode: 0, stdout: 'button returned:Yes', stderr: '' }).executor)
    expect(r.response).toBe('no-channel')
    expect(r.error).toContain('button returned:Yes')
  })

  it('returns no when osascript exits non-zero (user canceled)', () => {
    const r = runMacDialog(
      OPTS,
      recording({ exitCode: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' }).executor,
    )
    expect(r).toEqual({ response: 'no', channel: 'macos' })
  })

  it('returns no-channel when osascript binary is missing', () => {
    const r = runMacDialog(
      OPTS,
      recording({ exitCode: -1, stdout: '', stderr: '', error: 'spawn osascript ENOENT' }).executor,
    )
    expect(r.response).toBe('no-channel')
    expect(r.error).toContain('ENOENT')
  })
})

describe('runLinuxDialog', () => {
  it('runs zenity by absolute path with markup off and the text as its own --text argument', () => {
    const { executor, calls } = recording({ exitCode: 0, stdout: '', stderr: '' })
    runLinuxDialog({ title: 'a < b', message: 'x & y <z>' }, executor)
    expect(calls[0]?.cmd).toBe('/usr/bin/zenity')
    expect(calls[0]?.args).toEqual([
      '--question',
      '--title=a < b',
      '--text=x & y <z>',
      '--no-wrap',
      '--no-markup',
    ])
  })

  it('maps zenity exit 0 to yes', () => {
    const r = runLinuxDialog(OPTS, recording({ exitCode: 0, stdout: '', stderr: '' }).executor)
    expect(r).toEqual({ response: 'yes', channel: 'linux-zenity' })
  })

  it('maps zenity exit 1 to no', () => {
    const r = runLinuxDialog(OPTS, recording({ exitCode: 1, stdout: '', stderr: '' }).executor)
    expect(r).toEqual({ response: 'no', channel: 'linux-zenity' })
  })

  it('returns no-channel when zenity is not installed', () => {
    const r = runLinuxDialog(
      OPTS,
      recording({ exitCode: -1, stdout: '', stderr: '', error: 'spawn zenity ENOENT' }).executor,
    )
    expect(r.response).toBe('no-channel')
    expect(r.error).toContain('ENOENT')
  })

  it('returns no-channel for unexpected exit codes', () => {
    const r = runLinuxDialog(OPTS, recording({ exitCode: 5, stdout: '', stderr: 'X11 error' }).executor)
    expect(r.response).toBe('no-channel')
    expect(r.error).toContain('zenity exit 5')
  })
})
