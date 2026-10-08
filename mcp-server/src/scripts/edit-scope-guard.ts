import { readFileSync } from 'node:fs'
import { decide } from '../lib/edit-scope-hook.js'

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const decision = decide(readStdin(), process.env, process.cwd())
if (decision.message) process.stderr.write(`${decision.message}\n`)
process.exit(decision.exitCode)
