import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TOOLS } from '../../src/catalog.js'

// Issue #83 acceptance item 5 — a tool module added without a `src/catalog.ts` entry
// is SILENTLY omitted from the server: no error, no failing test. Measured on
// `main` @ 1a186ea: dropping a valid, unregistered Tool into src/tools/ left the
// full suite at 92 files / 1727 passed / 1 skipped / exit 0.
//
// Why nothing else catches it. Before this file, `tool-count.test.ts` was the only
// test importing src/catalog.js, and every assertion in it reads from the catalog
// OUTWARD (docs, the boot log, HANDLERS lockstep). Nothing read from DISK INWARD,
// which is the direction an unregistered module escapes through. Meanwhile 44 test
// files import `src/tools/*` directly — so a contributor can write a tool AND a
// fully green unit test for it without ever registering it.
//
// Scope, deliberately narrow: the one thing no existing assertion covers is
// "module on disk, absent from TOOLS". Restating the TOOLS<->HANDLERS lockstep
// (tool-count.test.ts:50-51) or the boot-log name list (:66-77) here would be pure
// cost — a rename, an add or a remove is already red over there.
//
// The scope is TOOLS, not the whole server surface: `index.ts` also serves resources
// from `src/resources.ts`, which never passes through `catalog.ts` and carries the
// same silent-omission risk with no guard. Out of scope here, deliberately.
//
// dist/ is deliberately NOT checked. tsup.config.ts has three src/ entries and sets
// treeshake:true; dist/ holds only index.js, index.js.map and scripts/ — there is no
// dist/tools/. An unregistered module is unreachable from the entry graph, so
// asserting its absence from the bundle would be a test that cannot fail.
//
// Path note (same asymmetry as tool-count.test.ts): from mcp-server/tests/unit/ the
// mcp-server root is TWO levels up, not three.
const TOOLS_DIR = resolve(__dirname, '..', '..', 'src', 'tools')

/**
 * Modules under src/tools/ that legitimately declare NO tool — a shared helper, a
 * types module. EMPTY today: all 40 modules declare exactly one tool.
 *
 * This list can never rescue a real tool. `a module that looks like a tool must
 * parse as one` runs over every module with zero parsed names WITHOUT consulting
 * this allowlist, so a mis-parsed tool declaration stays red no matter what is
 * listed here. That ordering is the point: during this change's REVIEW, three
 * independent lenses each found that an allowlist consulted first is a documented
 * route from red back to green with an unregistered tool still on disk — one of
 * them executed the whole chain and reached 5 passed. The guard's own escape hatch
 * was the way to defeat it.
 */
const NON_TOOL_MODULES: string[] = []

/**
 * The declaration this scan reads. Tolerant of indentation, of digits in the name
 * (MCP permits them; `rsct_foo_v2` is a plausible future tool) and of anything after
 * the closing quote — a trailing comma, a comment. Deliberately NOT tolerant of
 * anything else, because a shape it cannot read is caught by LOOSE_DECL below rather
 * than passed over.
 *
 * It cannot collide with the `toolName: 'rsct_…'` field that 8 modules carry
 * (capture-issue, phase-abandon, phase-verification-complete, plan-authorize,
 * request-commit, request-merge, request-push, request-rebase): `^[ \t]*name:`
 * requires `name:` to follow the indentation directly.
 */
const NAME_DECL = /^[ \t]*name: '(rsct_[a-z0-9_]+)'/gm

/**
 * The safety net. Any line that LOOKS like a tool declaration but did not parse is a
 * mis-parsed tool, not a helper — different quotes, a name built from a constant, a
 * deeper nesting, an unexpected case. The remedy is to fix the line shape or widen
 * NAME_DECL, never to allowlist it.
 */
const LOOSE_DECL = /name:\s*['"`]\s*rsct_/i

interface ToolModule {
  file: string
  names: string[]
  /** 1-based line of a loose declaration this scan could not parse, if any. */
  suspectLine: number | null
}

/**
 * CRLF is normalized before matching. NAME_DECL is line-anchored, and in JS `^`/`$`
 * treat `\r` as ordinary text — on a Windows checkout with autocrlf an un-normalized
 * scan would misparse every file. (CLAUDE.md anti-pattern #4, in its JS form.)
 */
const read = (file: string): string =>
  readFileSync(join(TOOLS_DIR, file), 'utf8').replace(/\r\n?/g, '\n')

function scan(): {
  modules: ToolModule[]
  directories: string[]
  foreign: string[]
} {
  const directories: string[] = []
  const foreign: string[] = []
  const modules: ToolModule[] = []

  for (const entry of readdirSync(TOOLS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      directories.push(entry.name)
      continue
    }
    if (!entry.name.endsWith('.ts')) {
      foreign.push(entry.name)
      continue
    }
    const body = read(entry.name)
    const names = [...body.matchAll(NAME_DECL)].map((m) => m[1]!)
    let suspectLine: number | null = null
    if (names.length === 0) {
      const idx = body.split('\n').findIndex((line) => LOOSE_DECL.test(line))
      suspectLine = idx === -1 ? null : idx + 1
    }
    modules.push({ file: entry.name, names, suspectLine })
  }
  return { modules, directories, foreign }
}

const { modules, directories, foreign } = scan()
const declaredNames = modules.flatMap((m) => m.names)
const sorted = (xs: string[]): string[] => [...xs].sort()

describe('every tool module on disk is registered in the catalog (#83)', () => {
  it('src/tools/ is flat — no subdirectory can hide a module from the scan', () => {
    // readdirSync does NOT recurse, and a `.endsWith('.ts')` filter drops a directory
    // entry WITHOUT A WORD. Measured during this change's verification phase: an
    // unregistered tool at src/tools/universe/get-universe-v2.ts left an otherwise
    // identical scan GREEN. Failing on the directory is cheaper than recursing and
    // keeps the flat layout a DECLARED invariant rather than an unstated assumption.
    expect(
      directories,
      'src/tools/ must stay flat: this scan does not recurse, so a tool inside a ' +
        'subdirectory would never be checked against catalog.ts. Move the module up, ' +
        'or teach scan() to recurse.',
    ).toEqual([])
  })

  it('src/tools/ holds only .ts modules', () => {
    // Same class as the directory guard, and the same reason it is worth one line:
    // `'x.mts'.endsWith('.ts')` is false, so a `.mts`/`.cts`/`.tsx` module would be
    // dropped in silence — with no contributor action at all, which is a weaker
    // precondition than any other hole this file closes.
    expect(
      foreign,
      'a non-.ts file under src/tools/ is skipped by this scan. If it is a tool ' +
        'module, this guard would not see it — add its extension to scan().',
    ).toEqual([])
  })

  it('a module that looks like a tool must parse as one', () => {
    // The assertion that closes the escape hatch. It runs over EVERY module with zero
    // parsed names, allowlisted or not, so `NON_TOOL_MODULES` can never hide a real
    // tool. Without it, the documented remedy for a parse failure ("add it to the
    // allowlist") silently ships an unregistered tool on a fully green suite.
    const misparsed = modules
      .filter((m) => m.names.length === 0 && m.suspectLine !== null)
      .map((m) => `${m.file}:${m.suspectLine} looks like a tool declaration`)

    expect(
      misparsed,
      'this line declares a tool but does not match NAME_DECL. Fix the line shape ' +
        "(two-space indent, single quotes: `name: 'rsct_x',`) or widen NAME_DECL. " +
        'Do NOT add it to NON_TOOL_MODULES — that would hide an unregistered tool.',
    ).toEqual([])
  })

  it('every module declares a tool name, or is an explicit non-tool', () => {
    // Sorted on both sides: readdirSync guarantees no ordering, and it was measured
    // returning NTFS collation on Windows — neither creation order nor byte sort. An
    // unsorted comparison would let a two-entry allowlist pass on one OS and fail on
    // another with an order-only diff. CLAUDE.md's first rule is cross-OS.
    const silent = modules.filter((m) => m.names.length === 0).map((m) => m.file)
    expect(
      sorted(silent),
      'a module here declares no tool. If it is a genuine helper, add it to ' +
        'NON_TOOL_MODULES; if it is a tool, the previous assertion says why it did ' +
        'not parse.',
    ).toEqual(sorted(NON_TOOL_MODULES))
  })

  it('every declared tool name is registered in the catalog', () => {
    const registered = new Set(TOOLS.map((t) => t.name))
    // Reported per module rather than as a set diff, so the failure names the file
    // to edit and the row to add. Strictly subsumed by the set comparison below;
    // it exists for the message, which is a reason stated rather than assumed.
    const unregistered = modules
      .flatMap((m) => m.names.map((name) => ({ file: m.file, name })))
      .filter(({ name }) => !registered.has(name))
      .map(({ file, name }) => `${file} declares ${name}, absent from catalog.ts`)

    expect(
      unregistered,
      'a tool reaches the server ONLY through src/catalog.ts — add it to TOOLS and ' +
        'its handler to HANDLERS.',
    ).toEqual([])
  })

  it('the declared names and the catalog are the same set, with no duplicates', () => {
    // Anti-vacuity, in the idiom of template-paths.test.ts:52. If the enumeration
    // ever breaks — a moved directory, a changed extension, a regex that stops
    // matching — every loop above passes over an empty list and reports success.
    // Measured: breaking the extension filter leaves 4 of 5 other assertions green
    // and only this one red. It also catches the reverse direction (a catalog row
    // whose module is gone) and a name declared in two files.
    expect(
      sorted(declaredNames),
      'the modules on disk and the catalog have drifted apart.',
    ).toEqual(sorted(TOOLS.map((t) => t.name)))
  })
})
