// T0.c — Layer 3 harness: run a SELF-CONTAINED prompt mutation block against a
// throwaway fixture and assert its post-conditions.
//
// The block is extracted from the prompt BY ANCHOR (a substring of its
// `CHECKPOINT:` line) so the test always runs the REAL shipped block — it can
// never drift from a hand-copied snapshot. Blocks run WITHOUT `set -e` (the way
// the AI runs them, statement-by-statement); assertions are on file STATE, not
// exit code. Blocks 2/3 use `node -e`, so a node guard is provided.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { loadPromptBlocks, type BashBlock } from './bash-lint.js'

// --- node availability (blocks 2 & 3 call `node -e`) ---
let _nodeChecked = false
let _nodeOk = false
export function nodeAvailable(): boolean {
  if (_nodeChecked) return _nodeOk
  _nodeChecked = true
  try {
    execFileSync('node', ['--version'], { stdio: 'ignore' })
    _nodeOk = true
  } catch {
    _nodeOk = false
  }
  return _nodeOk
}

/** Anti-silent-skip: when node is REQUIRED but absent, fail rather than skip. */
export function assertNodePolicy(required: boolean, available: boolean): void {
  if (required && !available) {
    throw new Error(
      'node is required (RSCT_REQUIRE_BASH strict mode) but `node` was not found — ' +
        'blocks 2/3 would silently skip. Failing instead.',
    )
  }
}

/** Find the single prompt block whose body contains `anchor`. Throws on 0 or >1. */
export function extractBlockByAnchor(root: string, promptBasename: string, anchor: string): BashBlock {
  const matches = loadPromptBlocks(root).filter(
    (b) => b.source === promptBasename && b.code.includes(anchor),
  )
  if (matches.length !== 1) {
    throw new Error(
      `anchor "${anchor}" matched ${matches.length} block(s) in ${promptBasename} (expected exactly 1)`,
    )
  }
  return matches[0]!
}

export interface RunBlockOpts {
  promptBasename: string
  anchor: string
  /** Shell lines prepended once before the block (e.g. SENSITIVE_VARS=…). */
  preamble?: string
  /** Files seeded into the temp working dir: relative path → content. */
  seedFiles?: Record<string, string>
  /** Run the block N times in the SAME dir (idempotency tests). Default 1. */
  runs?: number
  /** Extra env for the bash process (merged over a hermetic default). */
  env?: Record<string, string>
}

export interface RunBlockResult {
  exit: number
  out: string
  dir: string
}

/**
 * Run a prompt block in a fresh temp dir. `$(pwd)` inside the block resolves to
 * that dir (cwd of the bash process), so the block reads/writes the seeded
 * fixtures. Returns file state via `dir`; assert on that, not on `exit`.
 */
export function runBlock(root: string, opts: RunBlockOpts): RunBlockResult {
  const block = extractBlockByAnchor(root, opts.promptBasename, opts.anchor)
  const dir = mkdtempSync(join(tmpdir(), 'rsct-block-'))
  for (const [rel, content] of Object.entries(opts.seedFiles ?? {})) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  const runs = opts.runs ?? 1
  const one = `${opts.preamble ?? ''}\n${block.code}\n`
  // No `set -e` — run as the AI runs it. Repeat in-place for idempotency tests.
  const body = Array.from({ length: runs }, () => one).join('\n# --- rerun ---\n')
  const runnerPath = join(dir, '.rsct_runner.sh')
  writeFileSync(runnerPath, body)
  // Hermetic by default: HOME points at the temp dir so a block reading
  // $HOME/.rsct/... never touches the real home (overridable via opts.env).
  const env = { ...process.env, HOME: dir.replace(/\\/g, '/'), ...(opts.env ?? {}) }
  try {
    const out = execFileSync('bash', [runnerPath], {
      cwd: dir,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { exit: 0, out, dir }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string }
    return { exit: err.status ?? 1, out: `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`, dir }
  }
}

// --- assertion helpers ---
export const readIn = (r: RunBlockResult, rel: string): string => readFileSync(join(r.dir, rel), 'utf8')
export const hasIn = (r: RunBlockResult, rel: string): boolean => existsSync(join(r.dir, rel))
