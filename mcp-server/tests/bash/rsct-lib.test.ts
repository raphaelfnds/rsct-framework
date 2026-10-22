import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bashAvailable, repoRoot } from './lib/bash-lint.js'
import { bashBin } from './lib/resolve-bash.js'

const BASH = bashAvailable()
const ROOT = repoRoot(__dirname)

const sandboxes: string[] = []
function newSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsct-lib-'))
  sandboxes.push(dir)
  return dir
}
afterEach(() => {
  while (sandboxes.length) {
    const d = sandboxes.pop()!
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

function posix(path: string): string {
  return execFileSync(bashBin(), ['-c', 'cygpath -u "$1" 2>/dev/null || printf "%s" "$1"', '_', path], {
    encoding: 'utf8',
  }).trim()
}

const LIB = BASH ? posix(resolve(ROOT, 'scripts', 'rsct-lib.sh')) : ''

function run(body: string, opts: { cwd?: string; env?: Record<string, string> } = {}): { rc: number; out: string } {
  const dir = newSandbox()
  const script = join(dir, 'run.sh')
  writeFileSync(script, `. "${LIB}"\n${body}\n`)
  try {
    const out = execFileSync(bashBin(), [script], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      killSignal: 'SIGKILL',
    })
    return { rc: 0, out }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { rc: err.status ?? 1, out: `${err.stdout ?? ''}\n${err.stderr ?? ''}` }
  }
}

const STUB_WSLPATH = String.raw`#!/bin/sh
[ "$1" = "-w" ] || exit 2
echo "$2" >> "$0.log"
case "$2" in
  */WINSIDE|*/WINSIDE/*) printf 'C:\\fake%s\n' "$2" ;;
  *) printf '\\\\wsl.localhost\\Ubuntu%s\n' "$2" ;;
esac
`

interface Fixture {
  native: string
  root: string
  linux: string
  windows: string
  stub: string
  log: () => string[]
}

function fixture(): Fixture {
  const dir = newSandbox()
  mkdirSync(join(dir, 'linuxdir'))
  mkdirSync(join(dir, 'WINSIDE', 'Program Files'), { recursive: true })
  mkdirSync(join(dir, 'linuxdir', 'with space'))
  writeFileSync(join(dir, 'linuxdir', 'a.txt'), 'a\n')
  writeFileSync(join(dir, 'linuxdir', 'b.txt'), 'b\n')
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'wslpath'), STUB_WSLPATH)
  chmodSync(join(dir, 'bin', 'wslpath'), 0o755)
  const root = posix(dir)
  return {
    native: dir,
    root,
    linux: `${root}/linuxdir`,
    windows: `${root}/WINSIDE`,
    stub: `${root}/bin/wslpath`,
    log: () => {
      const p = join(dir, 'bin', 'wslpath.log')
      return existsSync(p) ? readFileSync(p, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean) : []
    },
  }
}

describe.skipIf(!BASH)('rsct_wsl_verdict (#110)', () => {
  it('maps every pair of (is WSL, --wsl given)', () => {
    const r = run('for p in "no no" "no yes" "yes yes" "yes no" "x y"; do set -- $p; rsct_wsl_verdict "$1" "$2"; done')
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim().split(/\r?\n/)).toEqual(['normal', 'stop-not-wsl', 'wsl', 'stop-no-flag', 'stop-no-flag'])
  })
})

describe.skipIf(!BASH)('rsct_wslpath_side — what wslpath -w answered (#110)', () => {
  it('only a \\\\wsl.localhost\\ or \\\\wsl$\\ answer is the Linux side', () => {
    const inputs = [
      String.raw`\\wsl.localhost\Ubuntu\home\dev`,
      String.raw`\\wsl$\Ubuntu-22.04\tmp`,
      String.raw`C:\Users\dev`,
      String.raw`\\server\share\dev`,
      String.raw`\\wsl.localhost.example\share`,
      String.raw`\\?\C:\dev`,
      String.raw`\\WSL.LOCALHOST\Ubuntu\home`,
      '',
    ]
    const dir = newSandbox()
    writeFileSync(join(dir, 'inputs.txt'), `${inputs.join('\n')}\n`)
    const r = run(`while IFS= read -r line; do rsct_wslpath_side "$line"; done < "${posix(join(dir, 'inputs.txt'))}"`)
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim().split(/\r?\n/)).toEqual(['linux', 'linux', 'windows', 'windows', 'windows', 'windows', 'windows', 'windows'])
  })
})

describe.skipIf(!BASH)('rsct_path_side and the functions built on it (#110)', () => {
  it('classifies the deepest existing folder of a path that does not exist yet', () => {
    const f = fixture()
    const r = run(
      [
        `RSCT_WSLPATH="${f.stub}"`,
        `rsct_path_side "${f.linux}"`,
        `rsct_path_side "${f.windows}"`,
        `rsct_path_side "${f.windows}/not/yet"`,
        `rsct_path_side "${f.linux}/not/yet"`,
      ].join('\n'),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim().split(/\r?\n/)).toEqual(['linux', 'windows', 'windows', 'linux'])
    expect(f.log()).toEqual([f.linux, f.windows, f.windows, f.linux])
  })

  it('a relative path, or one in Windows form, is never the Linux side, and wslpath is not asked', () => {
    const f = fixture()
    const r = run(
      [
        `RSCT_WSLPATH="${f.stub}"`,
        `cd "${f.linux}"`,
        'rsct_path_side "with space"',
        'rsct_path_side rel/x',
        `rsct_path_side 'C:\\Users\\dev\\AppData\\Roaming\\npm'`,
        `printf '[%s]\\n' "$(rsct_wsl_unsafe_destination 'C:\\Users\\dev\\npm')"`,
      ].join('\n'),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim().split(/\r?\n/)).toEqual(['unknown', 'unknown', 'unknown', String.raw`[C:\Users\dev\npm]`])
    expect(f.log()).toEqual([])
  })

  it('a link whose target is gone is never the Linux side', () => {
    const f = fixture()
    const gone = join(newSandbox(), 'gone')
    symlinkSync(gone, join(f.native, 'linuxdir', 'dangling'), 'junction')
    const r = run(
      [`RSCT_WSLPATH="${f.stub}"`, `rsct_path_side "${f.linux}/dangling"`, `rsct_path_side "${f.linux}/dangling/below/it"`].join('\n'),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim().split(/\r?\n/)).toEqual(['unknown', 'unknown'])
    expect(f.log()).toEqual([])
  })

  it('a path with a . or .. segment is never the Linux side, and wslpath is not asked', () => {
    const f = fixture()
    const r = run(
      [
        `RSCT_WSLPATH="${f.stub}"`,
        `cd "${f.linux}"`,
        `rsct_path_side "${f.linux}/missing/../../WINSIDE"`,
        `rsct_path_side "${f.linux}/.."`,
        `rsct_path_side "${f.linux}/./with space"`,
        `rsct_path_side "${f.linux}/."`,
        'rsct_path_side .',
        'rsct_path_side ..',
      ].join('\n'),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim().split(/\r?\n/)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'])
    expect(f.log()).toEqual([])
  })

  it('walks up without the external dirname, so an empty PATH cannot make it loop', () => {
    const f = fixture()
    const r = run(
      [`RSCT_WSLPATH="${f.stub}"`, 'PATH=""', `rsct_path_side "${f.linux}/not/yet/there"`, `rsct_path_side "${f.windows}/not/yet/there"`].join('\n'),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim().split(/\r?\n/)).toEqual(['linux', 'windows'])
    expect(f.log()).toEqual([f.linux, f.windows])
  })

  it('answers unknown when wslpath is missing or prints nothing, and unknown is never the Linux side', () => {
    const f = fixture()
    const silent = `${f.root}/bin/silent`
    const r = run(
      [
        `printf '#!/bin/sh\\nexit 0\\n' > "${silent}"`,
        `chmod +x "${silent}"`,
        `RSCT_WSLPATH="${f.root}/bin/none"`,
        `rsct_path_side "${f.linux}"`,
        `printf '[%s]\\n' "$(rsct_linux_path "${f.linux}")"`,
        `printf '[%s]\\n' "$(rsct_wsl_unsafe_destination "${f.linux}")"`,
        `if rsct_tool_is_windows "${f.linux}/a.txt"; then echo windows-tool; else echo linux-tool; fi`,
        `RSCT_WSLPATH="${silent}"`,
        `rsct_path_side "${f.linux}"`,
      ].join('\n'),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim().split(/\r?\n/)).toEqual(['unknown', '[]', `[${f.linux}]`, 'windows-tool', 'unknown'])
  })

  it('rebuilds PATH entry by entry: keeps Linux entries whole, drops Windows, empty and relative ones, expands nothing', () => {
    const f = fixture()
    const input = [f.linux, `${f.windows}/Program Files`, '', `${f.linux}/with space`, '.', 'bin', `${f.linux}/*`, f.windows].join(':')
    const r = run(
      [
        `RSCT_WSLPATH="${f.stub}"`,
        `cd "${f.linux}"`,
        `rsct_linux_path "${input}"`,
        'echo',
        'case "$-" in *f*) echo noglob-on ;; *) echo noglob-off ;; esac',
        'printf "[%s]\\n" "$IFS"',
      ].join('\n'),
    )
    expect(r.rc, r.out).toBe(0)
    const lines = r.out.replace(/\r/g, '').split('\n')
    expect(lines[0]).toBe([f.linux, `${f.linux}/with space`, `${f.linux}/*`].join(':'))
    expect(lines[1]).toBe('noglob-off')
    expect(lines[2]).toBe('[ \t')
  })

  it('a tool is Windows when it sits on the Windows side or starts with MZ', () => {
    const f = fixture()
    const r = run(
      [
        `RSCT_WSLPATH="${f.stub}"`,
        `printf 'MZ\\220\\000' > "${f.linux}/fake.exe"`,
        `printf '#!/bin/sh\\n' > "${f.linux}/tool"`,
        `printf '#!/bin/sh\\n' > "${f.windows}/tool"`,
        `for t in "${f.linux}/fake.exe" "${f.linux}/tool" "${f.windows}/tool"; do if rsct_tool_is_windows "$t"; then echo windows; else echo linux; fi; done`,
      ].join('\n'),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim().split(/\r?\n/)).toEqual(['windows', 'linux', 'windows'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a program that cannot be read counts as Windows', () => {
    const f = fixture()
    const r = run(
      [
        `RSCT_WSLPATH="${f.stub}"`,
        `printf '#!/bin/sh\\n' > "${f.linux}/locked"`,
        `chmod 111 "${f.linux}/locked"`,
        `if rsct_tool_is_windows "${f.linux}/locked"; then echo windows; else echo linux; fi`,
        `chmod 755 "${f.linux}/locked"`,
      ].join('\n'),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim()).toBe('windows')
    expect(f.log(), 'the check must get past the side test to the read').toContain(`${f.linux}/locked`)
  })

  it('names the first destination that is not on the Linux side, and nothing when all are', () => {
    const f = fixture()
    const r = run(
      [
        `RSCT_WSLPATH="${f.stub}"`,
        `printf '[%s]\\n' "$(rsct_wsl_unsafe_destination "${f.linux}" "" "${f.linux}/new/dir")"`,
        `printf '[%s]\\n' "$(rsct_wsl_unsafe_destination "${f.linux}" "${f.windows}/.rsct" "${f.windows}")"`,
      ].join('\n'),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim().split(/\r?\n/)).toEqual(['[]', `[${f.windows}/.rsct]`])
  })

  it('every function can be called under set -e without stopping the script', () => {
    const f = fixture()
    const r = run(
      [
        'set -e',
        `RSCT_WSLPATH="${f.root}/bin/none"`,
        'v=$(rsct_wsl_verdict yes no)',
        `s=$(rsct_path_side "${f.linux}/missing")`,
        `w=$(rsct_wslpath_side "")`,
        `p=$(rsct_linux_path "${f.linux}:${f.windows}")`,
        `d=$(rsct_wsl_unsafe_destination "${f.linux}")`,
        `RSCT_WSLPATH="${f.stub}"`,
        `d2=$(rsct_wsl_unsafe_destination "${f.linux}")`,
        'h=$(rsct_host_config)',
        `if rsct_tool_is_windows "${f.linux}/a.txt"; then t=windows; else t=linux; fi`,
        'echo "REACHED-END $v $s $w [$p] [$d2] $t"',
      ].join('\n'),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out, r.out).toContain('REACHED-END stop-no-flag unknown windows [] [] linux')
  })
})

describe.skipIf(!BASH)('rsct_host_config (#82)', () => {
  it('follows CLAUDE_CONFIG_DIR through node; backslashes become slashes on Windows only', () => {
    expect(run('command -v node').out.trim(), 'node must be on PATH, or the fallback answers instead').not.toBe('')
    const r = run('rsct_host_config', { env: { CLAUDE_CONFIG_DIR: String.raw`C:\Users\dev\cfg` } })
    expect(r.rc, r.out).toBe(0)
    expect(r.out.trim()).toBe(
      process.platform === 'win32' ? 'C:/Users/dev/cfg/.claude.json' : String.raw`C:\Users\dev\cfg/.claude.json`,
    )
  })

  it('falls back to CLAUDE_CONFIG_DIR, then HOME, when node is not on PATH', () => {
    const empty = posix(newSandbox())
    const withDir = run(`PATH="${empty}"; rsct_host_config`, { env: { CLAUDE_CONFIG_DIR: '/cfg/dir' } })
    expect(withDir.rc, withDir.out).toBe(0)
    expect(withDir.out.trim()).toBe('/cfg/dir/.claude.json')
    const withHome = run(`PATH="${empty}"; unset CLAUDE_CONFIG_DIR; HOME=/home/dev; rsct_host_config`)
    expect(withHome.rc, withHome.out).toBe(0)
    expect(withHome.out.trim()).toBe('/home/dev/.claude.json')
  })
})
