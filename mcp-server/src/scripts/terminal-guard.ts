import { readFileSync } from 'node:fs'
import { decideTerminal } from '../lib/terminal-guard-hook.js'

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const decision = decideTerminal(readStdin(), process.env, process.cwd())
if (decision.message) process.stderr.write(`${decision.message}\n`)
process.exit(decision.exitCode)
