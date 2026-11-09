import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(__dirname, '..', '..', 'src')
const ZOD_SPECIFIER = /(?:\bfrom|\bimport\(|\brequire\()\s*['"](zod(?:\/[^'"]*)?)['"]/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const full = join(dir, item.name)
    if (item.isDirectory()) return sourceFiles(full)
    return item.name.endsWith('.ts') ? [full] : []
  })
}

describe('zod imports in src', () => {
  it('take zod only from zod/v3, so the gate schemas keep the v3 behaviour while the bundled MCP SDK uses the patched v4 core', () => {
    const files = sourceFiles(SRC)
    const specifiers = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(ZOD_SPECIFIER)].map((match) => ({ file: relative(SRC, file), specifier: match[1] })),
    )
    expect(specifiers.length).toBeGreaterThanOrEqual(44)
    expect(specifiers.filter((entry) => entry.specifier !== 'zod/v3')).toEqual([])
  })
})
