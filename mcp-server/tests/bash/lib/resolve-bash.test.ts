import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  resolveBash,
  bashBin,
  binFor,
  explainWrongBash,
  windowsCandidates,
  type BashCandidate,
} from './resolve-bash.js'
import { assertBashPolicy } from './bash-lint.js'

// Issue #78 item 5. Every case in the FIRST describe injects the platform, the
// candidate list and both probes, so nothing depends on the host: the Windows branch is
// exercised on the Linux and macOS CI cells and nothing shells out. The last describe
// is the exception and says so — it is the one that reads this machine.
//
// The cache is bypassed whenever opts are passed — vitest isolates per FILE, not per
// test, so a shared cache would let the second `it()` read the first one's answer and
// pass while asserting nothing.

/**
 * `unames` maps a binary to what `uname -s` says. A binary absent from the map has a
 * FAILING uname probe; `present` then lists which of those are nonetheless runnable —
 * the "there, but unverifiable" case that must not be filed as "no bash".
 */
const win = (
  candidates: BashCandidate[],
  unames: Record<string, string | null>,
  present: string[] = [],
) => ({
  platform: 'win32',
  candidates,
  probe: (bin: string) => unames[bin] ?? null,
  isRunnable: (bin: string) => present.includes(bin),
})

const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe'
const WSL_BASH = 'C:/WINDOWS/system32/bash.exe'
const MINGW = 'MINGW64_NT-10.0-26200'

describe('resolveBash (#78)', () => {
  it('is inert on non-Windows: returns the literal bash without probing anything', () => {
    // The load-bearing cross-OS assertion. CLAUDE.md's first rule is that Linux and
    // macOS must not regress, and the guarantee is structural: the platform check is
    // the first statement of resolve(), before any candidate logic or spawn. Asserting
    // the probe was never CALLED is what makes that testable rather than asserted.
    let probed = 0
    for (const platform of ['linux', 'darwin']) {
      const r = resolveBash({
        platform,
        candidates: [{ bin: 'anything', via: 'test' }],
        probe: () => {
          probed += 1
          return 'Linux'
        },
      })
      expect(r, `${platform} must resolve to the literal bash`).toEqual({
        kind: 'ok',
        path: 'bash',
      })
    }
    expect(probed, 'no candidate may be probed off Windows').toBe(0)
  })

  it('takes the first MSYS-flavoured candidate on Windows', () => {
    const r = resolveBash(
      win([{ bin: GIT_BASH, via: 'git --exec-path' }], { [GIT_BASH]: MINGW }),
    )
    expect(r).toEqual({ kind: 'ok', path: GIT_BASH })
  })

  it('skips WSL and keeps looking', () => {
    // The defect itself: WSL answers `uname -s` with Linux, is perfectly runnable, and
    // is often the ONLY bash on PATH. Existing-and-runnable is not the same as usable.
    const r = resolveBash(
      win(
        [
          { bin: WSL_BASH, via: 'PATH' },
          { bin: GIT_BASH, via: '%ProgramFiles%' },
        ],
        { [WSL_BASH]: 'Linux', [GIT_BASH]: MINGW },
      ),
    )
    expect(r).toEqual({ kind: 'ok', path: GIT_BASH })
  })

  it('rejects Cygwin, deliberately', () => {
    // README.md names Cygwin as a Windows bash flavour to distinguish from Git Bash.
    // Accepting it here would widen the contract past what any test has exercised.
    const r = resolveBash(win([{ bin: 'c:/cygwin64/bin/bash.exe', via: 'PATH' }], {
      'c:/cygwin64/bin/bash.exe': 'CYGWIN_NT-10.0',
    }))
    expect(r.kind).toBe('wrong')
  })

  it('reports a wrong bash instead of pretending there is none', () => {
    // The distinction the whole design rests on. `none` is allowed to become a skip —
    // it is today's behaviour for a machine with no bash. `wrong` must not, because a
    // machine WITH bash that skips 189 tests and exits 0 is the silent failure this
    // issue exists to remove.
    const r = resolveBash(win([{ bin: WSL_BASH, via: 'PATH' }], { [WSL_BASH]: 'Linux' }))
    expect(r.kind).toBe('wrong')
    if (r.kind !== 'wrong') return
    expect(r.found).toBe(WSL_BASH)
    expect(r.uname).toBe('Linux')
    expect(r.tried).toHaveLength(1)
  })

  it('reports none — and NOT wrong — when no bash runs at all', () => {
    const r = resolveBash(win([{ bin: 'bash', via: 'PATH' }], {}))
    expect(r.kind, 'a machine with no bash must keep its existing skip semantics').toBe(
      'none',
    )
  })

  it('a bash that is present but unverifiable is wrong, not none', () => {
    // The case a real run produced and the first design got wrong. WSL's `uname -s`
    // answers in ~4 s idle, but a probe issued while the suite is starting six files
    // can exceed the bound and come back null. Filing that as `none` sends the one
    // machine this issue is about down the SKIP path, with no named failure — the
    // defect, restored. "Not present" and "present but unverifiable" are different
    // answers and only the first may skip.
    const r = resolveBash(win([{ bin: WSL_BASH, via: 'PATH' }], {}, [WSL_BASH]))
    expect(r.kind).toBe('wrong')
    if (r.kind !== 'wrong') return
    expect(r.uname).toContain('uname -s` failed')
    expect(r.found).toBe(WSL_BASH)
  })

  it('an absent candidate does not mask a usable one found later', () => {
    const r = resolveBash(
      win(
        [
          { bin: 'C:/gone/bash.exe', via: '%ProgramFiles%' },
          { bin: GIT_BASH, via: 'PATH' },
        ],
        { [GIT_BASH]: MINGW },
      ),
    )
    expect(r).toEqual({ kind: 'ok', path: GIT_BASH })
  })

  describe('$RSCT_BASH is an instruction, not a candidate', () => {
    // Measured on the original design: a typo'd, quoted or WSL-pointing override fell
    // through to the next candidate, and on a machine where a later candidate worked
    // the run went GREEN while the developer believed the override was in effect. The
    // escape hatch reproduced the defect class the issue is about, so it gets its own
    // describe.
    it('a wrong override fails even when a good candidate follows it', () => {
      const r = resolveBash(
        win(
          [
            { bin: WSL_BASH, via: '$RSCT_BASH', explicit: true },
            { bin: GIT_BASH, via: 'git --exec-path' },
          ],
          { [WSL_BASH]: 'Linux', [GIT_BASH]: MINGW },
        ),
      )
      expect(r.kind).toBe('wrong')
      if (r.kind !== 'wrong') return
      expect(r.via).toBe('$RSCT_BASH')
      expect(r.found).toBe(WSL_BASH)
    })

    it('an unrunnable override fails even when a good candidate follows it', () => {
      const r = resolveBash(
        win(
          [
            { bin: 'C:/typo/bash.exe', via: '$RSCT_BASH', explicit: true },
            { bin: GIT_BASH, via: 'git --exec-path' },
          ],
          { [GIT_BASH]: MINGW },
        ),
      )
      expect(r.kind).toBe('wrong')
      if (r.kind !== 'wrong') return
      expect(r.uname).toBe('not present')
      expect(r.via).toBe('$RSCT_BASH')
    })
  })

  describe('windowsCandidates — the builder, not just the resolver', () => {
    // These exist because a REVIEW lens deleted `explicit: true` from the builder and
    // the entire suite stayed green: every case above hands `resolve()` a ready-made
    // list, so they pin the resolver's handling of the flag and nothing pins the code
    // that sets it. A guarantee whose mutation survives is not a guarantee.
    const ENV = { ProgramFiles: 'C:\\Program Files' } as NodeJS.ProcessEnv
    const never = () => false
    const noGit = () => null

    it('marks $RSCT_BASH explicit, and puts it first', () => {
      const list = windowsCandidates({ ...ENV, RSCT_BASH: 'C:/custom/bash.exe' }, never, noGit)
      expect(list[0]).toEqual({
        bin: 'C:/custom/bash.exe',
        via: '$RSCT_BASH',
        explicit: true,
      })
    })

    it('prefers PATH over the derived candidate, and marks neither explicit', () => {
      // "Keep what already works": on a machine whose PATH bash is already MSYS, the
      // derived candidate is Git's launcher, a different binary that reorders PATH.
      const list = windowsCandidates(ENV, never, () => 'C:/Program Files/Git/bin/bash.exe')
      expect(list.map((c) => c.via)).toEqual(['PATH', 'git --exec-path'])
      expect(list.some((c) => c.explicit)).toBe(false)
    })

    it('names each binary once, however many sources produce it', () => {
      // Measured on 64-bit Node: ProgramFiles and ProgramW6432 are the SAME directory,
      // and `git --exec-path` derives the same file — so an undeduped list named one
      // binary three times, printing three identical lines in the failure report that
      // is this issue's deliverable, and paying six spawns to re-ask one question.
      //
      // The expected path is built with `join`, NOT written as a backslash literal.
      // CI caught the first version of this test: `windowsCandidates` joins with the
      // HOST separator, so a hand-written `C:\Program Files\Git\bin\bash.exe` matched
      // on Windows and differed from the POSIX `C:\Program Files/Git/bin/bash.exe` on
      // ubuntu and macOS, where dedupe then had two distinct strings and kept both.
      // The resolver was right; the test was asserting path.join's platform behaviour
      // instead of the dedupe it claims to check.
      const ROOT = 'C:\\Program Files'
      const GIT = join(ROOT, 'Git', 'bin', 'bash.exe')
      const list = windowsCandidates(
        { ProgramFiles: ROOT, ProgramW6432: ROOT },
        () => true,
        () => GIT,
      )
      expect(list.map((c) => c.bin)).toEqual(['bash', GIT])
    })

    it('omits sources that produce nothing', () => {
      const list = windowsCandidates({} as NodeJS.ProcessEnv, never, noGit)
      expect(list).toEqual([{ bin: 'bash', via: 'PATH' }])
    })
  })

  it('the failure message names the cause and both fixes', () => {
    // #78's acceptance criterion is that the failure NAMES the wrong-bash resolution.
    // A message nobody checked is how "it says so somewhere" becomes untrue.
    const r = resolveBash(win([{ bin: WSL_BASH, via: 'PATH' }], { [WSL_BASH]: 'Linux' }))
    if (r.kind !== 'wrong') throw new Error('fixture must produce a wrong verdict')
    const text = explainWrongBash(r)
    expect(text).toContain(WSL_BASH)
    expect(text).toContain('Linux')
    expect(text).toContain('Git Bash')
    expect(text).toContain('RSCT_BASH')
  })
})

describe('assertBashPolicy names the right cause (#78)', () => {
  // Both branches asserted through the injected resolution. The `wrong` text is
  // otherwise unreachable in a green run, which is how a corrected message ships
  // unchecked — measured: mutating the branch to `&& false` left the suite green.
  it('a wrong bash is reported as wrong, not as missing', () => {
    expect(() =>
      assertBashPolicy(true, false, {
        kind: 'wrong',
        found: WSL_BASH,
        uname: 'Linux',
        via: 'PATH',
        tried: [],
      }),
    ).toThrow(/a bash was found, but it is not usable/)
  })

  it('a genuinely missing bash keeps the original message', () => {
    expect(() => assertBashPolicy(true, false, { kind: 'none', tried: [] })).toThrow(
      /was not found on PATH/,
    )
  })

  it('says nothing when bash is available, or when it is not required', () => {
    expect(() => assertBashPolicy(true, true, { kind: 'ok', path: 'bash' })).not.toThrow()
    expect(() => assertBashPolicy(false, false, { kind: 'none', tried: [] })).not.toThrow()
  })
})

describe('this machine can run the bash tests (#78)', () => {
  // UNGATED, on purpose, and the only tests here that touch the real host. They turn a
  // wrong bash into a named failure instead of the 71 unexplained ones the issue
  // measured. Passes when bash is usable, and also when there is no bash at all: that
  // case is `none`, which legitimately skips.
  //
  // HONEST LIMIT: this pair is a DEVELOPER-MACHINE guard, and it is inert on CI. On
  // Linux and macOS it cannot fail by construction — resolveBash() returns `ok` before
  // touching the host, which is the same inertness the cross-OS guarantee rests on —
  // and the Windows runner ships Git Bash, so it passes there whether or not the
  // resolver works. The 11 injected cases above are what actually exercise the Windows
  // classifier in all six cells; CI cannot prove this half.
  it('a usable bash is resolvable, or there is none at all', () => {
    const r = resolveBash()
    expect(
      r.kind,
      r.kind === 'wrong' ? `\n${explainWrongBash(r)}\n` : '',
    ).not.toBe('wrong')
  })

  it('an unresolvable machine still spawns exactly what it did before #78', () => {
    // The real compatibility property, and the reason binFor() is a separate pure
    // function: on `none` or `wrong` the call sites must receive the literal 'bash'
    // they used before this change, so a machine the resolver cannot help behaves
    // as it always did. Killing mutation: return the found path on a `wrong` verdict.
    expect(binFor({ kind: 'none', tried: [] })).toBe('bash')
    expect(
      binFor({
        kind: 'wrong',
        found: WSL_BASH,
        uname: 'Linux',
        via: 'PATH',
        tried: [],
      }),
    ).toBe('bash')
    expect(binFor({ kind: 'ok', path: GIT_BASH })).toBe(GIT_BASH)
    expect(bashBin().length).toBeGreaterThan(0)
  })
})
