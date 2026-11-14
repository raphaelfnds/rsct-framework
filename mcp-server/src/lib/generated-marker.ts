import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const MARKER = /^<!-- RSCT-GENERATED\b[^\n]*?\bsha256-body=([a-f0-9]{64})\b/

export function isUntouchedTemplate(path: string): boolean {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return false
  }
  const lf = bytes.indexOf(0x0a)
  if (lf < 0) return false
  const sha = MARKER.exec(bytes.subarray(0, lf).toString('utf8'))?.[1]
  if (sha === undefined) return false
  const body = Buffer.from(bytes.subarray(lf + 1).filter((byte) => byte !== 0x0d))
  return createHash('sha256').update(body).digest('hex') === sha
}
