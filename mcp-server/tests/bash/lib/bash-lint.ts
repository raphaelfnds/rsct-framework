// T0.a — Layer 1 static bash lint (the "regra-mãe", automated).
//
// Mechanically enforces the CLAUDE.md cross-OS bash anti-patterns (#1–#7) over
// the framework's bash surface: the fenced ```bash blocks in prompts/*.md and
// the standalone scripts/*.sh. Pure Node (no bash needed for the regex
// detectors), so it runs identically on every OS. The `bash -n` syntax gate is
// the one part that shells out to bash (guarded — see bashAvailable / the CI
// RSCT_REQUIRE_BASH policy in the test).
//
// History this guards (CLAUDE.md "Padrões a evitar"):
//   AP1 `| while` subshell var loss (CAP-13/19)
//   AP2 BRE alternation `\|` without -E (CAP-18/21)
//   AP3 sed `|` delimiter with a literal pipe (CAP-17)
//   AP4 missing CRLF strip before $-anchored regex / SHA (CAP-10/16)
//   AP5 JSON.parse→stringify reformat of managed files (CAP-9→15)
//   AP6 phantom (never-assigned) variables (CAP-18 AUDIT-A)
//   AP7 grep -iF SIGABRT on Git Bash (CAP-41)

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, basename } from 'node:path'

export interface BashBlock {
  source: string // file basename (e.g. "01-setup.md")
  startLine: number // 1-based line of the ```bash fence in the source
  code: string // block body (between the fences)
  isScript: boolean // true for whole scripts/*.sh, false for prompt blocks
  skip: boolean // illustrative / opted-out of linting
  skipReason?: string
}

export type Severity = 'error' | 'warn'

export interface Finding {
  rule: string // 'AP2', 'AP7', …
  severity: Severity
  line: number // 1-based within the block (0 = whole-block)
  message: string
}

// --- skip sentinels (V7: explicit directive is primary; ❌ is secondary) ---
const SKIP_DIRECTIVE = '# rsct-lint:skip'
const ILLUSTRATIVE = [/❌/, /\bNÃO usar\b/i, /\bPROIBIDO\b/i]

function skipState(code: string): { skip: boolean; reason?: string } {
  if (code.includes(SKIP_DIRECTIVE)) return { skip: true, reason: 'rsct-lint:skip directive' }
  for (const re of ILLUSTRATIVE) {
    if (re.test(code)) return { skip: true, reason: `illustrative sentinel ${re}` }
  }
  return { skip: false }
}

// --- extraction ---------------------------------------------------------------

/** Extract every fenced ```bash … ``` block from a markdown string. */
export function extractBashBlocks(markdown: string, source: string): BashBlock[] {
  const lines = markdown.split('\n')
  const blocks: BashBlock[] = []
  let inBlock = false
  let fenceLine = 0
  let buf: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!inBlock && /^```bash\s*$/.test(line)) {
      inBlock = true
      fenceLine = i + 1 // 1-based
      buf = []
      continue
    }
    if (inBlock && /^```\s*$/.test(line)) {
      const code = buf.join('\n')
      const s = skipState(code)
      blocks.push({ source, startLine: fenceLine, code, isScript: false, skip: s.skip, skipReason: s.reason })
      inBlock = false
      continue
    }
    if (inBlock) buf.push(line)
  }
  return blocks
}

// --- helpers for detectors ----------------------------------------------------

/** Collect short-flag letters from the args following a command on one line. */
function flagLetters(argsPortion: string): string {
  return [...argsPortion.matchAll(/(?:^|\s)-([A-Za-z]+)/g)].map((m) => m[1]).join('')
}

/** Lines of the block, stripped of trailing CR (so detectors are CRLF-stable). */
function blockLines(code: string): string[] {
  return code.split('\n').map((l) => l.replace(/\r$/, ''))
}

// --- detectors ----------------------------------------------------------------
// Conservative by design (a noisy linter gets ignored). AP2/AP7 are ERROR
// (reliable, real runtime failures); the heuristic ones are WARN until tuned
// (V4/V6). AP4/AP6 are block-local and skipped for whole scripts (V6).

export interface LintOptions {
  /**
   * Run AP6 (phantom variables). OFF by default: prompt blocks intentionally
   * share variables across phases, so a block-local scan reports dozens of
   * legitimately-external vars (structural noise). Enable for targeted checks;
   * a corpus-wide run needs a cross-phase-var allowlist first (future work).
   */
  phantomVars?: boolean
}

export function lintBlock(block: BashBlock, opts: LintOptions = {}): Finding[] {
  if (block.skip) return []
  const findings: Finding[] = []
  const lines = blockLines(block.code)
  const whole = lines.join('\n')

  lines.forEach((line, idx) => {
    const ln = idx + 1

    // Comment-only lines describe anti-patterns ("# grep -iF crashes …") — they
    // are not real command invocations, so the command-shape detectors skip them
    // (avoids false ERRORs on documentation inside a block).
    if (/^\s*#/.test(line)) return

    // AP7 — grep -iF (any order/cluster). Real SIGABRT on Git Bash grep 3.0.
    const grepM = line.match(/\bgrep\b(.*)$/)
    if (grepM) {
      const flags = flagLetters(grepM[1])
      if (flags.includes('i') && flags.includes('F')) {
        findings.push({ rule: 'AP7', severity: 'error', line: ln,
          message: 'grep with both -i and -F crashes Git Bash grep 3.0 (CAP-41). Use tr to case-fold + -F, or tr+case glob.' })
      }
      // AP2 (grep) — BRE alternation `\|` without -E/-P → silent fail on BSD grep.
      if (/\\\|/.test(grepM[1]) && !flags.includes('E') && !flags.includes('P')) {
        findings.push({ rule: 'AP2', severity: 'error', line: ln,
          message: 'grep BRE alternation \\| fails silently on BSD grep (macOS) (CAP-18/21). Use -E "(a|b)".' })
      }
    }

    // AP2 (sed) — BRE alternation `\|` without -E/-r.
    const sedM = line.match(/\bsed\b(.*)$/)
    if (sedM) {
      const flags = flagLetters(sedM[1])
      if (/\\\|/.test(sedM[1]) && !flags.includes('E') && !flags.includes('r')) {
        findings.push({ rule: 'AP2', severity: 'error', line: ln,
          message: 'sed BRE alternation \\| is not portable (CAP-18). Use -E and a char class.' })
      }
      // AP3 — sed `s|…|…|` (pipe delimiter) with a literal pipe in the body.
      if (/s\|/.test(sedM[1]) && /\\\||\[\|\]/.test(sedM[1])) {
        findings.push({ rule: 'AP3', severity: 'warn', line: ln,
          message: 'sed using | as the s/// delimiter while the pattern contains a literal pipe (CAP-17). Use # delimiter + [|] char class.' })
      }
    }
  })

  // AP1 — `| while` feeding a loop (subshell drops outer-var mutations). The safe
  // form is `done < <(cmd)`. Warn on a real pipe-into-while (comment lines, which
  // often document the anti-pattern itself, are ignored).
  lines.forEach((line, idx) => {
    if (/^\s*#/.test(line)) return
    if (/\|\s*while\b/.test(line)) {
      findings.push({ rule: 'AP1', severity: 'warn', line: idx + 1,
        message: 'pipe into `while` runs the loop in a subshell — outer vars/counters are lost (CAP-13/19). Use `while …; do …; done < <(cmd)`.' })
    }
  })

  // AP5 — whole-file JSON round-trip reformats managed files (CAP-9→15). The
  // dangerous shape is `JSON.parse(…readFileSync…)` (parse the WHOLE file) plus
  // `JSON.stringify(obj, null, 2)` (re-serialize the WHOLE object). Per-value
  // use — `JSON.parse('"'+s+'"')` / `JSON.stringify(p)` — is the SAFE text-splice
  // idiom and must NOT trip. Excepted: .claude/settings.json and .mcp.json
  // (documented structured-merge exception). Code lines only.
  const codeLines = lines.filter((l) => !/^\s*(#|\/\/)/.test(l))
  const code = codeLines.join('\n')
  const parsesWholeFile = /JSON\.parse\s*\([^)]*readFileSync/.test(code)
  const stringifiesWhole = /JSON\.stringify\s*\([^)]*,\s*null\s*,/.test(code)
  if (parsesWholeFile && stringifiesWhole) {
    const isException = /\.mcp\.json|settings\.json/.test(whole)
    if (!isException) {
      const ln = lines.findIndex((l) => /JSON\.stringify\s*\([^)]*,\s*null\s*,/.test(l) && !/^\s*(#|\/\/)/.test(l)) + 1
      findings.push({ rule: 'AP5', severity: 'warn', line: ln,
        message: 'whole-file JSON.parse(readFileSync)→JSON.stringify(…,null,2) reformats the managed file (CAP-9→15). Use text-splice/sed unless it is the documented settings.json/.mcp.json exception.' })
    }
  }

  // The following are block-local heuristics — skipped for whole scripts (V6),
  // where vars are legitimately defined across the file and CRLF is handled
  // centrally.
  if (!block.isScript) {
    // AP4 — SHA / $-anchored regex without a preceding `tr -d '\r'` (CAP-10/16).
    // The portable `sha256_compute()` helper DEFINITION is exempt: it is a pure
    // dispatcher (sha256sum/shasum/openssl) and CRLF normalization is the caller's
    // job (callers pipe `tr -d '\r' | sha256_compute`).
    const definesShaHelper = /sha256_compute\s*\(\s*\)\s*\{/.test(whole)
    const usesSha = /sha256sum|shasum|sha256_compute|openssl dgst/.test(whole)
    const usesAnchoredAwk = /awk[^\n]*\/\^[^\n]*\$\//.test(whole)
    const stripsCr = /tr -d ['"]?\\r['"]?/.test(whole)
    if ((usesSha || usesAnchoredAwk) && !stripsCr && !definesShaHelper) {
      findings.push({ rule: 'AP4', severity: 'warn', line: 0,
        message: 'SHA / $-anchored regex without `tr -d \\r` first — CRLF residue breaks the match on Windows (CAP-10/16).' })
    }

    // AP6 — phantom variable: a $VAR used but never assigned in the block and not
    // given a ${VAR:-default} fallback (CAP-18 AUDIT-A). Opt-in (see LintOptions).
    if (opts.phantomVars) findings.push(...detectPhantomVars(lines))
  }

  return findings
}

/** AP6 helper — flag obviously-unassigned variable references (conservative). */
function detectPhantomVars(lines: string[]): Finding[] {
  const assigned = new Set<string>()
  const usedAt = new Map<string, number>()
  const NAME = /[A-Za-z_][A-Za-z0-9_]*/
  lines.forEach((line, idx) => {
    // assignments: VAR=…  / read VAR / for VAR in / VAR+=…  / local VAR / export VAR
    const a = line.match(new RegExp(`^\\s*(?:export\\s+|local\\s+)?(${NAME.source})\\s*\\+?=`))
    if (a) assigned.add(a[1])
    for (const m of line.matchAll(new RegExp(`\\bread\\b[^\\n]*?\\b(${NAME.source})`, 'g'))) assigned.add(m[1])
    for (const m of line.matchAll(new RegExp(`\\bfor\\s+(${NAME.source})\\s+in\\b`, 'g'))) assigned.add(m[1])
    // uses: $VAR or ${VAR…}. ${VAR:-x} / ${VAR:=x} provide a fallback → safe.
    for (const m of line.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)(:[-=?+][^}]*)?\}?/g)) {
      const name = m[1]
      const hasFallback = !!m[2]
      if (!hasFallback && !usedAt.has(name)) usedAt.set(name, idx + 1)
    }
  })
  const SPECIAL = new Set(['HOME', 'PWD', 'PATH', 'USER', 'SHELL', 'OSTYPE', 'HOSTNAME', 'BASH_SOURCE', 'IFS', 'PS1', 'RANDOM', 'LINENO', 'TMPDIR'])
  const findings: Finding[] = []
  for (const [name, line] of usedAt) {
    if (assigned.has(name)) continue
    if (SPECIAL.has(name)) continue
    if (/^[0-9]+$/.test(name)) continue // positional $1, $2…
    findings.push({ rule: 'AP6', severity: 'warn', line,
      message: `variable $${name} is used but never assigned in this block and has no \${${name}:-default} fallback — confirm it is set by a prior phase, else it silently expands to empty (CAP-18 AUDIT-A).` })
  }
  return findings
}

// --- bash -n syntax gate ------------------------------------------------------

let _bashChecked = false
let _bashOk = false

/** Is `bash` runnable on this machine? Cached. */
export function bashAvailable(): boolean {
  if (_bashChecked) return _bashOk
  _bashChecked = true
  try {
    execFileSync('bash', ['--version'], { stdio: 'ignore' })
    _bashOk = true
  } catch {
    _bashOk = false
  }
  return _bashOk
}

/** Run `bash -n` (syntax-only) on a snippet. Reads the script from stdin. */
export function bashSyntaxCheck(code: string): { ok: boolean; error?: string } {
  try {
    execFileSync('bash', ['-n'], { input: code, stdio: ['pipe', 'ignore', 'pipe'] })
    return { ok: true }
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string; message?: string }
    const stderr = err.stderr ? err.stderr.toString().trim() : err.message ?? 'bash -n failed'
    return { ok: false, error: stderr }
  }
}

/**
 * CI anti-silent-skip guard (V11): when bash is REQUIRED (RSCT_REQUIRE_BASH set)
 * but unavailable, the suite must FAIL rather than quietly skip the bash -n gate.
 */
export function assertBashPolicy(required: boolean, available: boolean): void {
  if (required && !available) {
    throw new Error(
      'RSCT_REQUIRE_BASH is set but `bash` was not found on PATH. The bash -n gate ' +
        'would silently skip — failing instead (a green CI that tested nothing is the ' +
        'failure class T0 exists to prevent).',
    )
  }
}

// --- repo corpus loaders ------------------------------------------------------

/** Repo root, given the directory of the calling test (mcp-server/tests/bash). */
export function repoRoot(testDir: string): string {
  return resolve(testDir, '..', '..', '..')
}

/** All ```bash blocks across prompts/*.md. */
export function loadPromptBlocks(root: string): BashBlock[] {
  const dir = resolve(root, 'prompts')
  const blocks: BashBlock[] = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const md = readFileSync(resolve(dir, f), 'utf8')
    blocks.push(...extractBashBlocks(md, f))
  }
  return blocks
}

/** The standalone scripts/*.sh as whole-file "blocks". */
export function loadScriptBlocks(root: string): BashBlock[] {
  const dir = resolve(root, 'scripts')
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sh'))
    .sort()
    .map((f) => {
      const code = readFileSync(resolve(dir, f), 'utf8')
      const s = skipState(code)
      return { source: basename(f), startLine: 1, code, isScript: true, skip: s.skip, skipReason: s.reason }
    })
}
