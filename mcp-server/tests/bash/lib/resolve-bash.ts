// Issue #78, comment item 5 — on Windows, `bash` on PATH is often WSL's
// C:\WINDOWS\system32\bash.exe, not Git Bash. Measured from PowerShell on a
// developer machine: `bash` resolved to WSL (`uname -s` -> Linux) and was the ONLY
// bash on PATH. Handing WSL a Windows path mangles it, and the suite reports
// "No such file or directory" for a file that was written correctly — a message
// that reads as broken prompt logic. Two sessions hit it on the same day; the
// second avoided a wrong conclusion only by running a control from Git Bash.
//
// WHY THIS NEVER THROWS. The obvious design was "throw when nothing verifies", and
// three review lenses measured it converting a loud failure into a silent one:
// bash-lint.ts's `bashAvailable()` wraps its spawn in `catch { _bashOk = false }`,
// which feeds `describe.skipIf(!BASH)` across five files — MEASURED with a wrong
// bash forced, 189 tests skip and `npm test` would have exited 0. `runBlock`'s catch
// would have turned the throw into a normal-looking result whose assertions then fail
// on missing files, which is #78's own symptom. So the resolver CLASSIFIES and the
// callers decide:
//
//   'ok'    - a usable bash; behaves exactly as the literal 'bash' did before.
//   'none'  - no bash at all. PRESERVES today's semantics: the skipIf gates skip,
//             and assertBashPolicy still fails under RSCT_REQUIRE_BASH.
//   'wrong' - a bash exists but is the wrong flavour. This is the new condition,
//             and it must never become a skip: resolve-bash.test.ts turns it into
//             ONE named failure instead of the 71 unexplained ones #78 measured.
//
// POSIX IS INERT BY CONSTRUCTION. The `platform !== 'win32'` return is the first
// statement of resolve(), before any candidate logic, any spawn and any cache
// read. Linux and macOS get the literal 'bash' they got before this file existed.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

export type BashResolution =
  | { kind: 'ok'; path: string }
  | { kind: 'none'; tried: string[] }
  | { kind: 'wrong'; found: string; uname: string; via: string; tried: string[] }

export interface ResolveBashOpts {
  /** Defaults to `process.platform`. Injected so the Windows branch is testable on CI. */
  platform?: string
  /** Defaults to the real candidate list. Injected to avoid depending on the host. */
  candidates?: BashCandidate[]
  /** Defaults to a real `uname -s` spawn. Injected so tests never shell out. */
  probe?: (bin: string) => string | null
  /**
   * Defaults to a real `bash --version` spawn. Only consulted when `probe` fails, to
   * separate "this binary is not here" from "it is here and I could not verify it".
   */
  isRunnable?: (bin: string) => boolean
}

export interface BashCandidate {
  bin: string
  /** Where this candidate came from, for the failure message. */
  via: string
  /** An explicit instruction ($RSCT_BASH) is never silently skipped — see below. */
  explicit?: boolean
}

/**
 * Git Bash and MSYS2 report MINGW64_NT / MINGW32_NT / MSYS_NT. WSL reports Linux and
 * Cygwin reports CYGWIN_NT — both are excluded deliberately. README.md already tells
 * Windows *users* "Git Bash, not PowerShell, and not WSL" and names Cygwin only as a
 * flavour to distinguish; this is the same boundary, for the *test suite*.
 */
const MSYS_UNAME = /^(MINGW(32|64)?|MSYS)_NT/

/**
 * Bounded on purpose. Measured: WSL's `bash -c "uname -s"` takes ~3.9 s cold on a
 * developer machine (and 4.4 s when probed as a wrong override), and this runs at
 * module-collection time where neither `testTimeout` nor `hookTimeout` reaches it —
 * vitest.config.ts says so itself: a synchronous body "is never interrupted, only
 * failed retroactively". Unlike the pre-existing single spawn of the CHOSEN bash,
 * this deliberately probes binaries expected to be wrong. Same idiom as
 * block-harness.ts and script-install.test.ts, which both pair timeout + SIGKILL.
 */
const PROBE_TIMEOUT_MS = 30_000

function probeUname(bin: string): string | null {
  try {
    return execFileSync(bin, ['-c', 'uname -s'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }).trim()
  } catch {
    return null
  }
}

/**
 * Asked only when `probeUname` fails, and it is what keeps a real machine from being
 * misfiled. MEASURED: WSL's bash answers `uname -s` with "Linux" in ~4 s idle, but a
 * probe issued while the suite is starting six files can exceed the bound and come
 * back null. Without this second question that machine resolves to `none` — the code
 * path that legitimately SKIPS — so the one machine #78 is actually about would get
 * silent skips and no named failure. "Not present" and "present but unverifiable" are
 * different answers, and only the first may skip.
 */
function isRunnableBash(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Derived from `git --exec-path` rather than hardcoded: measured
 * `C:/Program Files/Git/mingw64/libexec/git-core` -> three levels up ->
 * `C:/Program Files/Git` -> `bin/bash.exe`. The same relative layout holds for a
 * Scoop or portable install, which a hardcoded Program Files path would miss. It
 * does NOT hold for a bare MSYS2 install (bash lives under `usr/bin/`), which is
 * exactly why every candidate is verified by running it rather than trusted.
 */
function gitBashFromExecPath(): string | null {
  try {
    const execPath = execFileSync('git', ['--exec-path'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }).trim()
    if (!execPath) return null
    const candidate = join(resolvePath(execPath, '..', '..', '..'), 'bin', 'bash.exe')
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

/**
 * EXPORTED so it can be asserted. Every case in resolve-bash.test.ts's first describe
 * hands `resolve()` a candidate list, which proves the resolver honours `explicit` but
 * proves nothing about the builder that sets it — measured during REVIEW: deleting
 * `explicit: true` below left the whole suite green, unlocking the guarantee this
 * file's longest comment is about. `env` and `exists` are injectable for the same
 * reason: a test must be able to build the list without owning the host.
 */
export function windowsCandidates(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  deriveGitBash: () => string | null = gitBashFromExecPath,
): BashCandidate[] {
  const list: BashCandidate[] = []
  const override = env.RSCT_BASH
  // Marked `explicit`: an override that fails verification is an ERROR, never a
  // fall-through. Measured on the original design — a typo'd, quoted, or
  // WSL-pointing $RSCT_BASH fell through to the next candidate and produced a GREEN
  // run that masked the broken override. The escape hatch contained the very
  // silent-failure class this issue exists to close.
  if (override) list.push({ bin: override, via: '$RSCT_BASH', explicit: true })

  // PATH FIRST among the non-explicit candidates — "keep what already works".
  // Measured: on a machine whose PATH bash was already MINGW, preferring the derived
  // candidate silently swapped `Git/usr/bin/bash.exe` (2.3 MB) for `Git/bin/bash.exe`
  // (45 KB), which is Git for Windows' LAUNCHER: it hoists /mingw64/bin and /usr/bin
  // to the FRONT of PATH, ahead of a caller-supplied prefix. Nothing flipped here, but
  // script-install.test.ts's pre-flight exists precisely to assert that a stub dir wins
  // PATH resolution, and running it under a bash that reorders PATH is a trap laid for
  // a machine that has mingw-w64 nodejs installed.
  //
  // This does NOT weaken the fix: PATH is accepted only if its `uname -s` is MSYS, and
  // WSL answers Linux — so the binary this issue exists to reject still is.
  list.push({ bin: 'bash', via: 'PATH' })

  const derived = deriveGitBash()
  if (derived) list.push({ bin: derived, via: 'git --exec-path' })

  for (const root of [env.ProgramFiles, env['ProgramW6432']]) {
    if (!root) continue
    const candidate = join(root, 'Git', 'bin', 'bash.exe')
    if (exists(candidate)) list.push({ bin: candidate, via: '%ProgramFiles%' })
  }

  // Dedupe by binary, first `via` winning. Measured: on 64-bit Node `ProgramFiles` and
  // `ProgramW6432` are the SAME directory and `git --exec-path` derives the same file,
  // so an undeduped list named one binary three times — printing three identical lines
  // in the failure report that is this issue's whole deliverable, and paying six spawns
  // to re-ask a question already answered, at module-collection time where no vitest
  // timeout reaches.
  const seen = new Set<string>()
  return list.filter((c) => (seen.has(c.bin) ? false : (seen.add(c.bin), true)))
}

function resolve(opts: ResolveBashOpts = {}): BashResolution {
  const platform = opts.platform ?? process.platform
  // FIRST STATEMENT, deliberately. Nothing below runs on Linux or macOS.
  if (platform !== 'win32') return { kind: 'ok', path: 'bash' }

  const probe = opts.probe ?? probeUname
  const runnable = opts.isRunnable ?? isRunnableBash
  const candidates = opts.candidates ?? windowsCandidates()
  const tried: string[] = []
  /** The last candidate that was PRESENT but not usable — what `wrong` reports. */
  let unusable: { bin: string; via: string; uname: string } | null = null

  for (const candidate of candidates) {
    const uname = probe(candidate.bin)

    if (uname === null) {
      // Present but unverifiable, or simply absent? Only the second may skip.
      const present = runnable(candidate.bin)
      const state = present ? 'present, but `uname -s` failed' : 'not present'
      tried.push(`${candidate.bin} (${candidate.via}) -> ${state}`)
      if (present) unusable = { bin: candidate.bin, via: candidate.via, uname: state }
      // An explicit instruction is reported either way — never silently skipped.
      if (candidate.explicit) {
        return { kind: 'wrong', found: candidate.bin, uname: state, via: candidate.via, tried }
      }
      continue
    }

    tried.push(`${candidate.bin} (${candidate.via}) -> ${uname}`)
    if (MSYS_UNAME.test(uname)) return { kind: 'ok', path: candidate.bin }
    unusable = { bin: candidate.bin, via: candidate.via, uname }
    if (candidate.explicit) {
      return { kind: 'wrong', found: candidate.bin, uname, via: candidate.via, tried }
    }
  }

  // `none` is reserved for a machine with no bash at all: it keeps the pre-existing
  // skip semantics. Anything we could see but not use is `wrong`, and must be named.
  if (unusable === null) return { kind: 'none', tried }
  return { kind: 'wrong', found: unusable.bin, uname: unusable.uname, via: unusable.via, tried }
}

let cached: BashResolution | null = null

/**
 * Cached for the real (uninjected) call only. Passing ANY opt bypasses the cache:
 * vitest isolates per FILE, not per test, so a shared cache would let the second
 * `it()` in resolve-bash.test.ts read the first one's answer and pass vacuously.
 */
export function resolveBash(opts?: ResolveBashOpts): BashResolution {
  if (opts) return resolve(opts)
  if (cached === null) cached = resolve()
  return cached
}

/**
 * The binary a resolution names. Split out as a pure function so the property that
 * matters is testable: on `none` or `wrong` this is exactly the literal `'bash'` the
 * call sites used before #78, so a machine this resolver cannot help behaves as it
 * always did rather than spawning something unexpected.
 */
export function binFor(r: BashResolution): string {
  return r.kind === 'ok' ? r.path : 'bash'
}

/** The binary to spawn. Falls back to the literal 'bash', preserving old behaviour. */
export function bashBin(): string {
  return binFor(resolveBash())
}

/** Human-readable explanation of a `wrong` verdict, for the one test that reports it. */
export function explainWrongBash(r: Extract<BashResolution, { kind: 'wrong' }>): string {
  return [
    `The resolved bash is not Git Bash / MSYS2.`,
    `  found: ${r.found}  (via ${r.via})`,
    `  uname -s: ${r.uname}`,
    `  candidates tried:`,
    ...r.tried.map((t) => `    ${t}`),
    ``,
    `The bash tests hand bash a Windows path; WSL bash consumes the backslashes and`,
    `reports "No such file or directory" for a file that was written correctly.`,
    ``,
    `Fix either way:`,
    `  - run the suite from Git Bash, or put C:\\Program Files\\Git\\bin ahead on PATH`,
    `  - or set RSCT_BASH to the bash.exe you want (it is used as given, never skipped)`,
  ].join('\n')
}
