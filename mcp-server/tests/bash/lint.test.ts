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
    expect(PROMPT_BLOCKS.length).toBeGreaterThanOrEqual(60)
    expect(SCRIPT_BLOCKS.length).toBe(3)
  })

  it('no scripts/*.sh is ever skipped by the illustrative-sentinel heuristic (#73)', () => {
    const skipped = SCRIPT_BLOCKS.filter((b) => b.skip).map((b) => `${b.source} (${b.skipReason})`)
    expect(
      skipped,
      'a script was skipped wholesale — its detectors AND its bash -n gate did not run. ' +
        'Reword the comment: do not put ❌ / PROIBIDO / "NÃO usar" in scripts/*.sh.',
    ).toEqual([])
  })

  it('reports skipped (illustrative / opted-out) blocks explicitly — no silent skips', () => {
    const skipped = ALL.filter((b) => b.skip)
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
    expect(() => assertBashPolicy(REQUIRE_BASH, BASH)).not.toThrow()
  })
})

describe.skipIf(!BASH)('bash -n syntax gate (V2 regression)', () => {
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
    expect(rules(lint('node -e \'const o=JSON.parse(fs.readFileSync(p,"utf8")); fs.writeFileSync(p, JSON.stringify(o,null,2))\''))).toContain('AP5')
    expect(rules(lint('node -e \'const o=JSON.parse(fs.readFileSync(".mcp.json","utf8")); fs.writeFileSync(p, JSON.stringify(o,null,2))\''))).not.toContain('AP5')
    expect(rules(lint('node -e \'const v=JSON.parse("\\""+s+"\\""); out.push(JSON.stringify(p))\''))).not.toContain('AP5')
  })

  it('AP6 (opt-in) — flags a phantom var, passes an assigned var and a fallback', () => {
    expect(rules(lint('echo "$UNSET_PHANTOM_XYZ"', { phantomVars: true }))).toContain('AP6')
    expect(rules(lint('FOO=1\necho "$FOO"', { phantomVars: true }))).not.toContain('AP6')
    expect(rules(lint('echo "${MAYBE:-default}"', { phantomVars: true }))).not.toContain('AP6')
  })

  it('AP6 — is OFF by default (cross-phase noise) and suppressed for whole scripts (V6)', () => {
    expect(rules(lint('echo "$UNSET_PHANTOM_XYZ"'))).not.toContain('AP6')
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
