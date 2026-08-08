import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Issue #52 — `rules/` and `memory-templates/` ship INTO a target project, where a
// project-relative `doc-templates/...` path resolves to nothing: scripts/install.sh
// copies the templates to ~/.rsct/ and /rsct-setup never places them in the repo.
// Every reference to an actual template file in those two trees must therefore carry
// the install root (or the source-clone form). Anchored on `.template` so prose that
// merely names the `doc-templates/` directory is not swept.
//
// Path note: from mcp-server/tests/unit/ the repo root is THREE levels up.
const ROOT = resolve(__dirname, '..', '..', '..')
const SCANNED_DIRS = ['rules', 'memory-templates']
const ALLOWED_PREFIXES = ['~/.rsct/', '<framework-source>/']
const TEMPLATE_REF = String.raw`(\S*)doc-templates/\S*\.template`

interface TemplateRef {
  file: string
  line: number
  text: string
  prefix: string
}

function collectRefs(): TemplateRef[] {
  const refs: TemplateRef[] = []
  for (const dir of SCANNED_DIRS) {
    const abs = join(ROOT, dir)
    for (const name of readdirSync(abs)) {
      if (!name.endsWith('.md')) continue
      const body = readFileSync(join(abs, name), 'utf8').replace(/\r/g, '')
      body.split('\n').forEach((line, i) => {
        // Fresh regex per line — no shared lastIndex across iterations.
        const re = new RegExp(TEMPLATE_REF, 'g')
        let m: RegExpExecArray | null
        while ((m = re.exec(line)) !== null) {
          refs.push({ file: `${dir}/${name}`, line: i + 1, text: m[0], prefix: m[1] })
        }
      })
    }
  }
  return refs
}

const REFS = collectRefs()

describe('template paths in shipped rules and memory entries (#52)', () => {
  it('finds the template references it is meant to guard', () => {
    // Without this the guard below would pass vacuously over an empty set if a file
    // were renamed or a directory moved.
    expect(REFS.length).toBeGreaterThanOrEqual(7)
  })

  it('every template reference resolves from the RSCT install root', () => {
    const offenders = REFS.filter(
      (r) => !ALLOWED_PREFIXES.some((p) => r.prefix.endsWith(p)),
    ).map((r) => `${r.file}:${r.line} → ${r.text}`)
    expect(offenders).toEqual([])
  })
})
