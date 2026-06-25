<!-- RSCT-GENERATED v=1.0.0 created=[CREATED_AT] sha256-body=[SHA_PLACEHOLDER] -->
name: Session bootstrap — rsct-mcp entry point before §B
description: At session start (and on every new task above tier=trivial), call rsct_status + rsct_load_context + rsct_classify_task before §B; then open the matching phase via rsct_phase_*_start. Skipping is the most common drift away from the framework.

When a new Claude Code session opens in this project, and again for every
non-trivial task within a session: call the rsct-mcp bootstrap chain
BEFORE doing anything else.

1. `mcp__rsct__rsct_status` — reads project identity, current branch,
   protected_branches[], and emits hints. Treat the hints field
   verbatim before any other action. If the current branch is in
   protected_branches, STOP and ask the dev to derive a feature
   branch (feat/, fix/, chore/, docs/) before proceeding.

2. `mcp__rsct__rsct_load_context` — reads active plan, decisions
   snapshot, knowledge index, active_phase (if any). The
   next_action_hints field is mandatory reading.

3. `mcp__rsct__rsct_classify_task({ task_description })` — for any
   request above pure-docs/typo, classify FIRST. Returns tier
   (trivial | small | standard | complex) + recommended_phases[].
   tier=trivial is the canonical "skip the phase machine" signal —
   you do not bypass classify_task; classify_task tells you when to
   skip.

After step 3, branch on the returned tier:
- trivial: §B exception applies; proceed with the edit directly.
- small: rsct_phase_spec_start → §B plan → rsct_phase_spec_complete →
  rsct_phase_code_start({ scope_globs, spec_tier: 'small' }) → edits
  gated by rsct_check_edit_scope → rsct_phase_code_complete →
  rsct_phase_test_*.
- standard: rsct_phase_research_start → research → _complete →
  rsct_phase_spec_start → §B plan → rsct_phase_spec_complete({
  include_review }) → **V phase** (rsct_phase_verification_start({
  declared_paths }) → review findings → rsct_phase_verification_complete) →
  rsct_phase_code_start({ scope_globs, spec_tier: 'standard' }) →
  edits → rsct_phase_code_complete → **REVIEW phase** (when include_review:
  rsct_phase_review_start → review the diff → rsct_phase_review_complete) →
  rsct_phase_test_start({ spec_tier: 'standard' }) → rsct_phase_test_complete.
- complex: same chain as standard; V phase is mandatory (skipping
  requires explicit override_verification_skip=true).

The full cycle is R→S→V→C→REVIEW→T (REVIEW audits the diff, V audits the spec).

**CAP-28 verification gate (v0.7.8+)**: rsct_phase_code_start REJECTS
when `spec_tier ∈ {standard, complex}` and no completed V block
matches `spec_ref` in phase-state.json. Pass `spec_tier` from your
earlier rsct_classify_task; to bypass V intentionally on a
standard/complex task, pass `override_verification_skip: true` —
override is audit-logged.

**REVIEW gate (DX-4)**: at spec-closure, pass `include_review` to
rsct_phase_spec_complete (recorded by spec_ref). For `spec_tier ∈
{standard, complex}`, rsct_phase_test_start then enforces it:
include_review=yes requires a completed rsct_phase_review_* for that
spec_ref; =no skips REVIEW; no decision rejects (record one).
trivial/small bypass. Pass `override_review_skip: true` to bypass
intentionally — audit-logged.

For standard and complex, also call
`mcp__rsct__rsct_auto_persona({ task_description })` after classify
and pass the recommended persona slug into phase_*_start.

Why: rsct-mcp tools do not auto-fire; they only run when Claude
chooses to call them. The CLAUDE.md prose (§0 + §A–§H) is the trigger.
Skipping the bootstrap drops you back to a pre-M3 protocol where
plans live in chat instead of phase-state.json, edits land without
scope checks, and approvals lack the §C OS dialog.

Real-world drift example (2026-06-07): a routine feature task
("add password-change confirmation email") was implemented without
rsct_status, rsct_classify_task, or any phase tool — leading to
direct Edit on a protected branch with no scope contract and no
auditable approval. Caught retroactively by a self-audit prompt.

How to apply: The bootstrap chain (steps 1–3) runs FIRST in every
session and FIRST again for every new task within a session. Do not
read code beyond what the dev explicitly named, do not present a §B
plan, and do not edit any file before steps 1–3 complete. If
rsct-mcp is not installed (tool-not-found), fall back to §A–§H prose
and tell the dev to run /rsct-setup + install rsct-mcp.

See: rules/0-session-bootstrap.md (full prose §0), rules/B-architect-plan.md
(updated §B with phase_spec_* pointers), rules/D-branch-protection.md
(updated §D with phase_code_* + check_edit_scope pointers).
