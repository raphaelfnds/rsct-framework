import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Vitest's default is 5000 ms, and much of this suite is spawn-bound rather
    // than compute-bound: the bash harness shells out per test, and status /
    // load-context / git / request-commit each spawn git. Measured on Windows,
    // idle: ~133 ms for a bare `bash -c true`. That cost lands in wall clock,
    // which is what these timeouts measure.
    //
    // 60_000 is the value this repo already uses for exactly this harness.
    // Three files consume `runBlock` from tests/bash/lib/block-harness.ts;
    // block-smoke and section-reconcile annotate their tests 60_000 (73x and
    // 11x), and canonical-source-slot annotates nothing at all — so its 35
    // tests (32 of which spawn bash) sat on 5000 ms. Matching the siblings is
    // the whole change; explicit annotations still override this default.
    //
    // The default is suite-wide rather than scoped to tests/bash/, because the
    // class is not: 1361 of the 1471 tests sat at 5000 ms, only 68 of them
    // under tests/bash/. The worst outside it, tests/unit/status.test.ts, was
    // measured at 4494 ms — an 11% margin — across 10 full-suite runs.
    //
    // What this does NOT do is bound a hang: a SYNCHRONOUS test body is never
    // interrupted, only failed retroactively once it returns, and every bash
    // test is synchronous `execFileSync`. Bounding a hang needs a timeout on
    // the spawn itself (`safeGit`, the bash harness) and `timeout-minutes` in
    // CI. Those live in other files and are tracked separately.
    testTimeout: 60_000,
    // Hooks are budgeted separately from tests, so `testTimeout` does not reach
    // them and the class above stays half-open without this. Two beforeEach
    // hooks are squarely in it: tests/unit/git.test.ts runs 5 sequential git
    // spawns before every test in the file, tests/unit/load-context.test.ts
    // runs 6. At ~133 ms per Windows spawn under load, those sat against
    // vitest's 10 s default.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'html'],
    },
  },
})
