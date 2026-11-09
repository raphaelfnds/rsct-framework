import { describe, it, expect } from 'vitest'
import { scanDiffForSecrets } from '../../src/lib/secrets.js'
import { unapprovedFindings } from '../../src/lib/integration-gate.js'

const diff = (line: string): string => ['diff --git a/c.env b/c.env', '--- a/c.env', '+++ b/c.env', '@@ -0,0 +1 @@', `+${line}`].join('\n')

describe('a finding is the same as an approved one only when its whole line is', () => {
  it('treats the same line as approved, wherever it now sits', () => {
    const approved = scanDiffForSecrets(diff('password = "aaaaaaaaaaaa"'))
    const again = scanDiffForSecrets(diff('password = "aaaaaaaaaaaa"'))
    expect(approved[0]!.excerpt).toBe(again[0]!.excerpt)
    expect(unapprovedFindings(again, approved)).toEqual([])
  })

  it('treats a different secret under the same key as new, though the masked excerpt is the same', () => {
    const approved = scanDiffForSecrets(diff('password = "aaaaaaaaaaaa"'))
    const other = scanDiffForSecrets(diff('password = "bbbbbbbbbbbb"'))
    expect(other[0]!.excerpt, 'control: the mask hides the difference').toBe(approved[0]!.excerpt)
    expect(unapprovedFindings(other, approved)).toHaveLength(1)
  })

  it('never puts the line or its hash in the finding it returns', () => {
    const found = scanDiffForSecrets(diff('password = "aaaaaaaaaaaa"'))
    expect(JSON.stringify(found)).not.toMatch(/aaaaaaaaaaaa|[0-9a-f]{64}/)
  })
})
