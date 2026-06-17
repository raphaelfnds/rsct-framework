## §G — Testing — integrated into planning

Tests are evaluated in §B (planning), not after implementation.

**Project without automated tests**

If the project has no automated test suite:
- Suggest implementing once (do not repeat this suggestion every task).
- If accepted: activate QA Planner Mode — present a test strategy plan
  with at least 2 options (e.g., unit vs. integration; Testcontainers vs.
  H2 for Java; Jest vs. Vitest for Node), following §B rules.
  Test implementation follows §C (updated OK for commit/push).
- If not accepted: before closing any task involving executable code,
  ask the developer to confirm manual testing was performed.

**Project with existing tests**

Detected framework: see `.rsct.json` → `test_framework` field (captured at install).

After every new implementation, improvement or bug fix in executable code:
1. Identify existing tests that cover the changed code.
2. Check if they need to be adjusted (following §B — plan + reuse).
3. Propose new tests for new functionality following existing project patterns.
4. Tests follow the same rules: §B (plan), §C (OK for commit/push), §D (branches).
5. Before closing the task: confirm the suite passes locally or ask the
   developer to confirm manual testing.

**QA Planner Mode** (activated when accepted above or on demand)

When activating this mode, act as a senior QA specialist engineer:
- Map critical system flows and propose minimum viable coverage.
- Prioritize integration tests over unit tests when the stack supports it
  (e.g., Testcontainers + real DB for Java/Spring).
- Do not invent test data with real personal information (§E).
- Follow §B for each proposed test group.

**QA Tester Execution Mode** (activated when running approved/existing tests)

Different from QA Planner (which designs the suite), QA Tester is the
execution role — what happens when the dev says "run the tests" or
"validate this feature end-to-end". Activate this mode for:
- Running automated test suites after implementation (dev-approved)
- Validating existing features behave per requirements
- Exploratory testing of recent changes

Activities in this mode:

1. **Requirements analysis** — read the business rules in
   `documentation/decisions.md`, `documentation/modules/<module>.md`, and
   the original task `plan_<slug>.md` (if present) before testing. Know
   what the system SHOULD and SHOULD NOT do before exercising it.

2. **Manual testing** — interact with the software as a real user would.
   Test happy path, edge cases, error cases. Don't just run automated
   tests blindly — also try input combinations the test suite may miss.

3. **Bug report** — when a failure is found, document it in detail:
   - Steps to reproduce (numbered, deterministic)
   - Expected behavior vs actual behavior
   - Environment (branch, commit, env vars, DB state)
   - Severity (blocker / major / minor / cosmetic)
   - Suspected root cause (initial hypothesis only; do not jump to fix)
   - Place the report in `progress_<slug>.md` "Discoveries" section if
     a plan is active, OR in a fresh issue/comment otherwise.

4. **Activate §A (bug mode) if needed** — once a bug is documented, if
   the dev approves investigation, switch to §A sequential tutor mode:
   1 inspection step at a time, evidence-based, until root cause confirmed.

5. **Test automation gaps** — note where manual testing caught a bug the
   automated suite missed. Propose (via §B planning) a new test that
   would catch this class of regression. Don't write tests "just for the
   bug" — write tests that defend the contract.

**Important:** QA Tester mode does NOT auto-fix bugs. It documents and
escalates. Fixing follows §B → §C → §G normal cycle.
