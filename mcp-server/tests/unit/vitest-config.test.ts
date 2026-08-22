import { describe, it, expect } from 'vitest'

/**
 * A tripwire for `vitest.config.ts`, because a wrong config here is SILENT.
 *
 * Two facts, both measured on this repo rather than assumed:
 *
 *  1. `tsc --noEmit` passes with a bogus key inside `vitest.config.ts`. The
 *     typecheck script never sees the file — `tsconfig.json` includes only
 *     `src/**\/*`. Verified by inserting `testTimoutTypo: 12345` and watching
 *     `npm run typecheck` come back clean.
 *  2. Vitest 4.1.8 accepts unknown config keys without a warning, and silently
 *     ignores options written at the wrong nesting level.
 *
 * So a `testTimeout` that is misspelled, misplaced, or dropped by a merge ships
 * completely inert, identically on all three target OSes, with no signal at all
 * until an unrelated flake resurfaces weeks later. That is the silent-failure
 * class `CLAUDE.md` calls the most dangerous, arriving through configuration
 * instead of through a shell pattern.
 *
 * This asserts the RESOLVED value the runner actually applied — never the
 * presence of the key in the file, which is what a config the runner ignored
 * would still satisfy.
 *
 * If you deliberately change the timeout, change the number here too. The test
 * is a tripwire, not a ceiling.
 */
const EXPECTED_DEFAULT_TIMEOUT_MS = 30_000

describe('vitest.config.ts — the configured timeout is actually applied', () => {
  it('resolves the suite-wide default testTimeout onto a test that declares none', (ctx) => {
    // Mutation that turns this red: delete `testTimeout` from vitest.config.ts,
    // misspell it, or nest it outside the `test` block — each leaves the runner
    // on its 5000 ms built-in default.
    expect(ctx.task.timeout).toBe(EXPECTED_DEFAULT_TIMEOUT_MS)
  })

  it('still lets an explicit per-test timeout win over the default', (ctx) => {
    // `tests/bash/` annotates individual tests with a 60/90/120 s ladder. Those
    // must keep overriding the default, or raising the default would quietly
    // LOWER the budget of the 107 tests that carry a bigger one.
    //
    // Mutation that turns this red: any change making the config default
    // outrank a declared per-test timeout.
    expect(ctx.task.timeout).toBe(45_000)
  }, 45_000)
})
