import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Vitest's default is 5000 ms, and a large part of this suite is
    // spawn-bound rather than compute-bound: the bash harness shells out per
    // test, and status / load-context / git / request-commit each spawn git.
    // Measured on Windows, idle: ~133 ms for a bare `bash -c true`, ~672 ms for
    // one bash + grep + sed + awk block. Those costs land in wall clock, which
    // is what a test timeout measures.
    //
    // 30 s is not a new number. `tests/bash/` already annotates individual
    // tests with a ladder — 60_000 x96, 90_000 x9, 120_000 x2, 30_000 x1 — and
    // this is its smallest rung; the explicit annotations still override this
    // default wherever they appear. What the default fixes is the tests that
    // never got one: 1361 of 1472 tests sit at vitest's 5000 ms, including all
    // 35 in `tests/bash/canonical-source-slot.test.ts` (32 of which spawn bash)
    // and `tests/unit/status.test.ts`, measured at a 4494 ms worst case — 11%
    // margin — over 10 full-suite runs.
    //
    // What this does NOT do is bound a hang: a SYNCHRONOUS test body is never
    // interrupted, only failed retroactively once it returns. Bounding a hang
    // needs a timeout on the spawn itself (`safeGit`, the bash harness) and
    // `timeout-minutes` in CI. Those live in other files and are tracked
    // separately; raising this number neither helps nor hurts them.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'html'],
    },
  },
})
