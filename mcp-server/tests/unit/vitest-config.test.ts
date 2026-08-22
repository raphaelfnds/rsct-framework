import { describe, it, expect } from 'vitest'

import config from '../../vitest.config.js'

/**
 * A tripwire for `vitest.config.ts`, because a wrong config here is SILENT:
 * `tsc --noEmit` never sees the file (`tsconfig.json` includes only `src/**\/*`,
 * verified by inserting a bogus key and watching typecheck stay clean), and
 * vitest 4.1.8 accepts unknown keys without a warning. So a misspelled or
 * mis-nested `testTimeout` ships inert, on all three OSes, with no signal until
 * an unrelated flake resurfaces.
 *
 * Two assertions, because either one alone has a hole:
 *  - the RESOLVED value catches a config the runner ignored, but goes green if
 *    someone annotates the guard itself with `}, 60_000)` — the very syntax 107
 *    tests in `tests/bash/` use;
 *  - the DECLARED value catches a broken key even then, but goes green if the
 *    runner never read the file.
 * Together they close both. If you change the timeout deliberately, change the
 * constant too — that is the tripwire, not a bug.
 */
const EXPECTED_TEST_TIMEOUT_MS = 60_000

describe('vitest.config.ts — the configured timeout is actually applied', () => {
  it('resolves the configured default onto a test that declares none', (ctx) => {
    // Mutation: delete `testTimeout` from vitest.config.ts, misspell it, or
    // nest it outside the `test` block — each leaves the runner on 5000 ms.
    expect(ctx.task.timeout).toBe(EXPECTED_TEST_TIMEOUT_MS)
  })

  it('declares that same default in the config file itself', () => {
    // Mutation: the same three, and this one still fails if the guard above is
    // neutered by its own per-test annotation.
    expect(config.test?.testTimeout).toBe(EXPECTED_TEST_TIMEOUT_MS)
  })
})
