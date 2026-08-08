import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Guards on the TEXT the framework ships into a project — rule sections, memory
// entries, doc templates and the worked example. Each invariant below was
// established by a bug that reached the field, and each is cheap to restate and
// expensive to rediscover. The prompts are deliberately NOT scanned: `01-setup.md`
// legitimately contains the strings it removes from installed projects.
//
// Path note: from mcp-server/tests/unit/ the repo root is THREE levels up.
const ROOT = resolve(__dirname, '..', '..', '..')
const SHIPPED_DIRS = ['rules', 'memory-templates', 'doc-templates', 'examples']

interface ShippedFile {
  path: string
  body: string
}

function shippedFiles(): ShippedFile[] {
  const out: ShippedFile[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (/\.(md|template)$/.test(entry.name)) {
        out.push({
          path: child,
          body: readFileSync(join(ROOT, child), 'utf8').replace(/\r/g, ''),
        })
      }
    }
  }
  SHIPPED_DIRS.forEach(walk)
  return out
}

const FILES = shippedFiles()

describe('shipped rule text — invariants', () => {
  it('actually scans the surfaces it claims to guard', () => {
    // Anti-vacuity: without this, a moved directory would turn every assertion
    // below into a check over an empty list.
    expect(FILES.length).toBeGreaterThan(20)
    expect(FILES.some((f) => f.path === 'rules/B-architect-plan.md')).toBe(true)
    expect(FILES.some((f) => f.path === 'doc-templates/plan_slug.md.template')).toBe(true)
  })

  it('#51 — no shipped surface teaches `git add --force`', () => {
    // Force-adding is the one action that defeats the ignore rule these files sit
    // under. It used to appear in eight of them.
    const offenders = FILES.filter((f) => f.body.includes('git add --force')).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('#50 — §D and its memory entry defer to .rsct.json instead of naming branches', () => {
    const targets = [
      'rules/D-branch-protection.md',
      'memory-templates/feedback_branch-protection.md',
    ]
    for (const rel of targets) {
      const file = FILES.find((f) => f.path === rel)
      expect(file, `${rel} was not scanned`).toBeDefined()
      expect(file?.body, `${rel} must point at the config key`).toContain('protected_branches')
      // The two superseded enumerations #50 was filed against. The rule and the
      // memory entry are read by the same agent in the same session; they drifted
      // apart once already, and only the rule got fixed the first time.
      expect(file?.body, `${rel} still names a fixed pair`).not.toMatch(/`main` and `test`/)
      expect(file?.body, `${rel} still names a fixed triple`).not.toMatch(/`main`\/`test`/)
    }
  })

  it('#58 — §H and its memory entry agree on the anti-decisions heading shape', () => {
    // The same failure as the #50 pair, one file over. CAP-32 edited these two
    // together; afterwards the memory entry acquired "free-form" while §H stayed
    // silent on the shape, and the parser bound to a third thing. That divergence
    // IS issue #58, and nothing was watching it.
    const targets = [
      'rules/H-adr-learning.md',
      'memory-templates/feedback_adr-autolearning.md',
    ]
    for (const rel of targets) {
      const file = FILES.find((f) => f.path === rel)
      expect(file, `${rel} was not scanned`).toBeDefined()
      // The full heading, not just the id token: `## AD-NNN: <title>` is a shape the
      // reader tolerates but neither the template nor the memory entry prescribes, and
      // a bare `toContain('AD-NNN')` would let exactly that divergence back in.
      expect(file?.body, `${rel} must name the prescribed heading shape`).toContain(
        '### AD-NNN — ',
      )
      expect(
        file?.body,
        `${rel} calls the anti-decisions format free-form — the parser binds to a heading`,
      ).not.toMatch(/free-form/i)
    }
  })
})
