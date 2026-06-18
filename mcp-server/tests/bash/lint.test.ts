import { describe, it, expect } from 'vitest'
import {
  extractBashBlocks,
  lintBlock,
  bashAvailable,
  bashSyntaxCheck,
  assertBashPolicy,
  repoRoot,
  loadPromptBlocks,
  loadScriptBlocks,
  type BashBlock,
  type Finding,
} from './lib/bash-lint.js'

// T0.a — Layer 1 static bash lint.
// Covers: (1) `bash -n` over every real prompt block + script (the V2 regression
// gate); (2) the AP1–AP7 detectors over the real corpus (no ERROR findings
// allowed); (3) detector self-tests (each must flag a known-bad and pass a
// known-good — a detector with no proof it fires is itself a silent-pass risk);
// (4) the CI anti-silent-skip guard.

const ROOT = repoRoot(__dirname)
const BASH = bashAvailable()
const REQUIRE_BASH = !!process.env.RSCT_REQUIRE_BASH

const PROMPT_BLOCKS = loadPromptBlocks(ROOT)
const SCRIPT_BLOCKS = loadScriptBlocks(ROOT)
const ALL = [...PROMPT_BLOCKS, ...SCRIPT_BLOCKS]

function errorsOf(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'error')
}

function label(b: BashBlock): string {
  return b.isScript ? b.source : `${b.source}:${b.startLine}`
}

describe('bash lint — corpus sanity', () => {
  it('finds the expected bash surface (prompts + scripts)', () => {
    // Guards against an extractor regression silently linting nothing.
    expect(PROMPT_BLOCKS.length).toBeGreaterThanOrEqual(60)
    expect(SCRIPT_BLOCKS.length).toBe(2)
  })

  it('reports skipped (illustrative / opted-out) blocks explicitly — no silent skips', () => {
    const skipped = ALL.filter((b) => b.skip)
    // Not an assertion on count; surfaces what the lint chose NOT to check.
    if (skipped.length) {
      // eslint-disable-next-line no-console
      console.log(`[bash-lint] skipped ${skipped.length} block(s):`,
        skipped.map((b) => `${label(b)} (${b.skipReason})`).join('; '))
    }
  })
})

describe('CI anti-silent-skip guard (V11)', () => {
  it('throws when bash is REQUIRED but unavailable', () => {
    expect(() => assertBashPolicy(true, false)).toThrow(/RSCT_REQUIRE_BASH/)
  })
  it('passes when bash is required and present, or not required', () => {
    expect(() => assertBashPolicy(true, true)).not.toThrow()
    expect(() => assertBashPolicy(false, false)).not.toThrow()
  })
  it('honours the live policy: if CI set RSCT_REQUIRE_BASH, bash must be present', () => {
    // In CI (RSCT_REQUIRE_BASH=1) this fails loudly if a runner lacks bash.
    expect(() => assertBashPolicy(REQUIRE_BASH, BASH)).not.toThrow()
  })
})

describe.skipIf(!BASH)('bash -n syntax gate (V2 regression)', () => {
  // ~70 synchronous `bash` spawns; bash process startup is slow (esp. Git Bash on
  // Windows CI) and contends with the rest of the suite — generous timeout.
  it('every non-skipped prompt block + script passes bash -n', () => {
    const failures: string[] = []
    for (const b of ALL) {
      if (b.skip) continue
      const r = bashSyntaxCheck(b.code)
      if (!r.ok) failures.push(`${label(b)}\n    ${r.error}`)
    }
    expect(failures, `bash -n failures:\n${failures.join('\n')}`).toEqual([])
  }, 120_000)
})

describe('detectors over the real corpus', () => {
  it('no ERROR-severity findings in any real block', () => {
    const errs: string[] = []
    for (const b of ALL) {
      for (const f of errorsOf(lintBlock(b))) {
        errs.push(`${label(b)} +${f.line} [${f.rule}] ${f.message}`)
      }
    }
    expect(errs, `unexpected ERROR findings:\n${errs.join('\n')}`).toEqual([])
  })

  it('summarizes WARN findings by rule (informational, non-failing)', () => {
    const counts: Record<string, number> = {}
    for (const b of ALL) {
      for (const f of lintBlock(b)) {
        if (f.severity === 'warn') counts[f.rule] = (counts[f.rule] ?? 0) + 1
      }
    }
    // eslint-disable-next-line no-console
    console.log('[bash-lint] WARN summary by rule:', counts)
    expect(typeof counts).toBe('object')
  })
})

// --- detector self-tests: each AP must flag a known-bad and pass a known-good --

function lint(code: string, opts: { isScript?: boolean; phantomVars?: boolean } = {}): Finding[] {
  const [b] = extractBashBlocks('```bash\n' + code + '\n```\n', 'self-test.md')
  return lintBlock(opts.isScript ? { ...b, isScript: true } : b, { phantomVars: opts.phantomVars })
}
function rules(findings: Finding[]): string[] {
  return findings.map((f) => f.rule)
}

describe('detector self-tests', () => {
  it('AP1 — flags `| while`, passes process substitution', () => {
    expect(rules(lint('cmd | while read x; do N=$((N+1)); done\necho $N'))).toContain('AP1')
    expect(rules(lint('while read x; do N=$((N+1)); done < <(cmd)\necho $N'))).not.toContain('AP1')
  })

  it('AP2 — flags grep BRE \\|, passes grep -E', () => {
    expect(rules(lint('grep -q "a\\|b" file'))).toContain('AP2')
    expect(rules(lint('grep -qE "(a|b)" file'))).not.toContain('AP2')
  })

  it('AP3 — flags sed | delimiter with literal pipe, passes # delimiter', () => {
    expect(rules(lint('sed -E "s|a \\| b|X|" file'))).toContain('AP3')
    expect(rules(lint('sed -E "s#a [|] b#X#" file'))).not.toContain('AP3')
  })

  it('AP4 — flags SHA without CRLF strip, passes with tr -d', () => {
    expect(rules(lint('S=$(cat f | sha256sum | awk "{print \\$1}")'))).toContain('AP4')
    expect(rules(lint("S=$(tr -d '\\r' < f | sha256sum | awk '{print $1}')"))).not.toContain('AP4')
  })

  it('AP5 — flags whole-file round-trip, passes exception + safe per-value use', () => {
    // BAD: parse the whole file + re-stringify the whole object.
    expect(rules(lint('node -e \'const o=JSON.parse(fs.readFileSync(p,"utf8")); fs.writeFileSync(p, JSON.stringify(o,null,2))\''))).toContain('AP5')
    // GOOD: the documented .mcp.json exception.
    expect(rules(lint('node -e \'const o=JSON.parse(fs.readFileSync(".mcp.json","utf8")); fs.writeFileSync(p, JSON.stringify(o,null,2))\''))).not.toContain('AP5')
    // GOOD: safe per-value text-splice (decode one string, stringify single values).
    expect(rules(lint('node -e \'const v=JSON.parse("\\""+s+"\\""); out.push(JSON.stringify(p))\''))).not.toContain('AP5')
  })

  it('AP6 (opt-in) — flags a phantom var, passes an assigned var and a fallback', () => {
    expect(rules(lint('echo "$UNSET_PHANTOM_XYZ"', { phantomVars: true }))).toContain('AP6')
    expect(rules(lint('FOO=1\necho "$FOO"', { phantomVars: true }))).not.toContain('AP6')
    expect(rules(lint('echo "${MAYBE:-default}"', { phantomVars: true }))).not.toContain('AP6')
  })

  it('AP6 — is OFF by default (cross-phase noise) and suppressed for whole scripts (V6)', () => {
    expect(rules(lint('echo "$UNSET_PHANTOM_XYZ"'))).not.toContain('AP6') // default off
    expect(rules(lint('echo "$UNSET_PHANTOM_XYZ"', { isScript: true, phantomVars: true }))).not.toContain('AP6')
  })

  it('AP7 — flags grep -iF (any order), passes -iE and -F alone', () => {
    expect(rules(lint('ls | grep -iF "$X"'))).toContain('AP7')
    expect(rules(lint('ls | grep -Fi "$X"'))).toContain('AP7')
    expect(rules(lint('grep -qiF "$X" f'))).toContain('AP7')
    expect(rules(lint('grep -iE "$X" f'))).not.toContain('AP7')
    expect(rules(lint('grep -F "$X" f'))).not.toContain('AP7')
  })

  it('skips illustrative blocks (❌ sentinel) and the explicit directive', () => {
    expect(lint('# ❌ bad example\nls | grep -iF x')).toEqual([])
    expect(lint('# rsct-lint:skip\nls | grep -iF x')).toEqual([])
  })

  it('does not flag anti-patterns mentioned in comments', () => {
    expect(rules(lint('# never use grep -iF here\ngrep -E "(a|b)" f'))).not.toContain('AP7')
  })
})
