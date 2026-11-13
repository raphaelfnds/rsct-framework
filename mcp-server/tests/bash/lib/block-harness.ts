import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { loadPromptBlocks, type BashBlock } from './bash-lint.js'
import { bashBin } from './resolve-bash.js'
import { BASH_BLOCK_TIMEOUT_MS } from './bash-bounds.js'

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

export function assertNodePolicy(required: boolean, available: boolean): void {
  if (required && !available) {
    throw new Error(
      'node is required (RSCT_REQUIRE_BASH strict mode) but `node` was not found — ' +
        'blocks 2/3 would silently skip. Failing instead.',
    )
  }
}

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
  preamble?: string
  seedFiles?: Record<string, string>
  runs?: number
  env?: Record<string, string>
}

export interface RunBlockResult {
  exit: number
  out: string
  dir: string
}

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
  const body = Array.from({ length: runs }, () => one).join('\n# --- rerun ---\n')
  const runnerPath = join(dir, '.rsct_runner.sh')
  writeFileSync(runnerPath, body)
  const env = { ...process.env, HOME: dir.replace(/\\/g, '/'), ...(opts.env ?? {}) }
  try {
    const out = execFileSync(bashBin(), [runnerPath], {
      cwd: dir,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: BASH_BLOCK_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    return { exit: 0, out, dir }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string }
    return { exit: err.status ?? 1, out: `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`, dir }
  }
}

export const readIn = (r: RunBlockResult, rel: string): string => readFileSync(join(r.dir, rel), 'utf8')
export const hasIn = (r: RunBlockResult, rel: string): boolean => existsSync(join(r.dir, rel))
