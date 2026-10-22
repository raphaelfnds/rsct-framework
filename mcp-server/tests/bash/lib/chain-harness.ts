import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalPath } from '../../../src/lib/repo-anchor.js'
import { extractBlockByAnchor } from './block-harness.js'
import { bashBin } from './resolve-bash.js'

export interface BlockStep {
  prompt: string
  anchor: string
  env?: Record<string, string>
  preamble?: string
  cwd?: string
}

export interface NodeStep {
  node: (dir: string) => void
}

export type ChainStep = BlockStep | NodeStep

export interface BlockOutcome {
  anchor: string
  exit: number
  out: string
}

export interface ChainResult {
  dir: string
  outcomes: BlockOutcome[]
  last: BlockOutcome
}

const made: string[] = []

export function chainDir(): string {
  const dir = canonicalPath(mkdtempSync(join(tmpdir(), 'rsct-chain-')))
  made.push(dir)
  return dir
}

export function cleanChains(): void {
  while (made.length) {
    try { rmSync(made.pop()!, { recursive: true, force: true }) } catch { }
  }
}

export function runBlockIn(root: string, dir: string, step: BlockStep, env: Record<string, string> = {}): BlockOutcome {
  const block = extractBlockByAnchor(root, step.prompt, step.anchor)
  const cwd = step.cwd ? join(dir, step.cwd) : dir
  mkdirSync(cwd, { recursive: true })
  const runner = join(dir, `.rsct_chain_${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(runner, `${step.preamble ?? ''}\n${block.code}\n`)
  const fullEnv = { ...process.env, HOME: dir.replace(/\\/g, '/'), ...env, ...(step.env ?? {}) }
  try {
    const out = execFileSync(bashBin(), [runner], {
      cwd,
      env: fullEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      killSignal: 'SIGKILL',
    })
    return { anchor: step.anchor, exit: 0, out }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string }
    return { anchor: step.anchor, exit: err.status ?? 1, out: `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}` }
  } finally {
    rmSync(runner, { force: true })
  }
}

export function runBlocks(root: string, steps: ChainStep[], opts: { dir?: string; env?: Record<string, string> } = {}): ChainResult {
  const dir = opts.dir ?? chainDir()
  const outcomes: BlockOutcome[] = []
  for (const step of steps) {
    if ('node' in step) {
      step.node(dir)
      continue
    }
    outcomes.push(runBlockIn(root, dir, step, opts.env))
  }
  const last = outcomes[outcomes.length - 1] ?? { anchor: '', exit: 0, out: '' }
  return { dir, outcomes, last }
}
