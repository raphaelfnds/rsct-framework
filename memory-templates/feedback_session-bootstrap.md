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

   Some hints are for the DEV, not for you — relay them and let the
   dev answer. They are emitted a bounded number of times, so one you
   read silently is spent. "A newer RSCT release is available": relay
   it; if the dev declines that release, call rsct_status again with
   decline_update:"<the tag in the hint>" (only that tag is accepted;
   a newer release asks once more). If the dev wants no release checks
   at all, update_check:"off" — reversible with "on". Never pass
   either parameter on your own initiative: they record a decision
   only the dev can make, and "off" silences security-patch notices
   for every project on the machine.

2. `mcp__rsct__rsct_load_context` — reads active plan, decisions
   snapshot, knowledge index, active_phase (if any). The
   next_action_hints field is mandatory reading.

3. `mcp__rsct__rsct_classify_task({ task_description })` — for any
   request above pure-docs/typo, classify FIRST. Returns tier
   (trivial | small | standard | complex) + recommended_phases[].
   tier=trivial means no spec or code phases — you do not bypass
   classify_task; classify_task tells you what to skip. REVIEW is
   never skipped for a change that touches code.

After step 3, branch on the returned tier:
- trivial: §B exception applies; proceed with the edit directly. If it
  touches code, run rsct_phase_review_start → rsct_phase_review_complete
  before rsct_request_commit.
- small: rsct_phase_spec_start → §B plan → rsct_phase_spec_complete →
  rsct_phase_code_start({ scope_globs, spec_tier: 'small' }) → edits
  gated by rsct_check_edit_scope → rsct_phase_code_complete →
  rsct_phase_test_* → **REVIEW phase**.
- standard: rsct_phase_research_start → research → _complete →
  rsct_phase_spec_start → §B plan → rsct_phase_spec_complete →
  **V phase** (rsct_phase_verification_start({
  declared_paths, spec_claims }) → answer EVERY finding →
  rsct_phase_verification_complete) →
  rsct_phase_code_start({ scope_globs, spec_tier: 'standard' }) →
  edits → rsct_phase_code_complete →
  rsct_phase_test_start → rsct_phase_test_complete → **REVIEW phase**
  (rsct_phase_review_start({ findings }) → answer EVERY declared finding
  and every removed comment → rsct_phase_review_complete).
- complex: same chain as standard; V phase is mandatory (skipping
  requires override_verification_skip=true PLUS a dev_approval and an
  OS dialog).

The full cycle is R→S→V→C→T→REVIEW (REVIEW audits code and tests together
on a green suite, V audits the spec).

**CAP-28 verification gate (v0.7.8+)**: rsct_phase_code_start REJECTS
when `spec_tier ∈ {standard, complex}` and no completed V block
matches `spec_ref` in phase-state.json. Pass `spec_tier` from your
earlier rsct_classify_task; to bypass V intentionally on a
standard/complex task, pass `override_verification_skip: true`
TOGETHER WITH a `dev_approval`. The tool forces an OS dialog and
ignores `trust_allowed_for`; the override is audit-logged.

A `trivial` or `small` tier skips V and plan tracking, so it
is only accepted when an rsct_classify_task verdict is on record.
Declaring a low tier without classifying first is refused
(`classify_evidence_absent`) — classify, then pass what it returned.

**REVIEW is mandatory at every tier (2.11.0)**: rsct_request_commit
refuses any staged code file that no completed rsct_phase_review_complete
stamped, whatever authorizes the commit. There is no include_review and
no override_review_skip — both are rejected as removed options.
rsct_phase_review_complete sweeps the touched files: remove EVERY comment
(never write one either); a comment that carried a measured fact moves
to documentation/decisions.md or documentation/knowledge/anti-decisions.md
first, and each removed comment gets a disposition (migrated with its
destination, or discarded) — pending_dispositions lists them. Functional
comments (shebang, licence header, tool directives such as
@ts-expect-error or # noqa) stay. A file the sweep cannot verify
(unsupported language, undeclared sql_dialect, parse error) or a
generated/vendored file you list in exempt_files goes to a dialog only
the dev answers. Stage exactly the reviewed bytes: an edit after the
REVIEW needs a new REVIEW, and a pre-commit hook that slips in
unreviewed code blocks further commits (review_drift) until one runs.

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

Findings BIND. Both the V phase and the REVIEW phase refuse to
complete while any finding they raised has no action — the rejection
returns the open ones, and rsct_phase_status lists them if the ids
scrolled out of context. Declaring a finding at rsct_phase_review_start
commits you to resolving it, so declare what the review genuinely
found. Never answer with an id you did not receive: unknown ids are
rejected, and inventing them was the gap this closes.

How to apply: The bootstrap chain (steps 1–3) runs FIRST in every
session and FIRST again for every new task within a session. Do not
read code beyond what the dev explicitly named, do not present a §B
plan, and do not edit any file before steps 1–3 complete. If
rsct-mcp is not installed (tool-not-found), fall back to §A–§H prose
and tell the dev to run /rsct-setup + install rsct-mcp.

See: rules/0-session-bootstrap.md (full prose §0), rules/B-architect-plan.md
(updated §B with phase_spec_* pointers), rules/D-branch-protection.md
(updated §D with phase_code_* + check_edit_scope pointers).
