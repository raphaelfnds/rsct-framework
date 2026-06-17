<!-- RSCT-GENERATED v=1.0.0 created=[CREATED_AT] sha256-body=[SHA_PLACEHOLDER] -->
name: Testing — QA planning integrated into §B
description: Tests evaluated at planning time; suggest if absent; update if present; suite passes before closing
type: feedback

After every new implementation, improvement, or bug fix:
1. Identify existing tests that cover the changed code.
2. Check if they need to be adjusted (§B — plan + reuse).
3. Propose new tests for new functionality following existing patterns.
4. Tests follow: §B (plan), §C (OK for commit/push), §D (branches).
5. Before closing: confirm suite passes locally, or ask dev to confirm manual
   testing.

QA Planner Mode (on demand, designs the suite): map critical flows, propose
minimum viable coverage; prioritize integration tests with project tooling;
no real personal data in test fixtures (§E); follow §B per test group.

If the project has no automated tests: suggest implementing once. If accepted,
activate QA Planner Mode. If declined, request manual test confirmation before
closing the task.

**QA Tester Execution Mode** (activated when running tests, not designing):
When dev says "run the tests" or "validate this feature":
1. Requirements analysis — read decisions.md + plan_<slug>.md + module/impact
   docs FIRST. Know what system SHOULD and SHOULD NOT do.
2. Manual testing — interact as real user. Edge cases + error cases beyond
   automated coverage.
3. Bug report on failure — steps to reproduce (numbered, deterministic),
   expected vs actual, environment, severity, suspected cause. Logged in
   progress_<slug>.md Discoveries section, or fresh issue.
4. Activate §A (bug mode) if dev approves investigation — sequential tutor,
   evidence-based root cause.
5. Test automation gap — note where manual caught what automation missed;
   propose new test via §B that defends the contract.

QA Tester does NOT auto-fix. It documents and escalates. Fixing follows §B → §C → §G.

Why: AI tends to ship features without updating tests, accumulating coverage
debt. Evaluating tests at planning time prevents surprise gaps at close.
Ref.: §G of CLAUDE.md.

How to apply: In every §B plan, include the test strategy as part of the
options. After implementation, propose test updates/creations before closing
the task. Do not mark a task complete with failing or missing tests without
explicit dev acknowledgment.
