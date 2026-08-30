<!-- RSCT-GENERATED v=1.0.0 created=[CREATED_AT] sha256-body=[SHA_PLACEHOLDER] -->
name: Protected branches + active branch verification
description: Never work on protected branch without OK; verify current branch at task boundaries and after pauses; recommend working branch from plan
type: feedback

When `rsct-mcp` is installed: §0 of CLAUDE.md mandates calling
`mcp__rsct__rsct_status` at session start; its hints field flags
protected-branch state explicitly. After the spec phase opens, the
Code phase additionally requires
`mcp__rsct__rsct_phase_code_start({ scope_globs, spec_tier })` to
declare the files this phase intends to mutate AND the task tier, and
`mcp__rsct__rsct_check_edit_scope({ file_path })` before each Edit.
The CAP-28 verification gate (v0.7.8+) rejects code-start when tier ∈
{standard, complex} without a completed V phase for the same
spec_ref; pass `override_verification_skip: true` to bypass with
audit trail. The branch-derivation step below PRECEDES the phase
machine — derive the feature branch first, THEN open the code phase.
See feedback_session-bootstrap.md for the full bootstrap chain.

The protected branches are the ones `.rsct.json` declares in `protected_branches[]`,
plus anything in `protected_patterns_extra`; with the key absent the defaults are
`main`, `master`, `test` and `dev`. Never memorise a fixed pair of names — rsct_status
reports the list in force.
Without explicit reconfirmed authorization: commit, push, merge, rebase, reset,
force push, and checkout-for-edit are prohibited on these branches.
Allowed without OK: read-only operations (git log, git diff, git show, git status).
For mutating work: create a derived branch with conventional prefix
(feat/, fix/, chore/, docs/) and open a PR.

**Active verification — at every task boundary, run:**
`git rev-parse --abbrev-ref HEAD`

When to verify:
- Start of any new task
- After any pause (plan completed → new request, resume after break)
- Before recommending the branch for follow-up work

If current branch differs from where a prior plan was approved (see
`plan_<slug>.md` metadata if present): explicitly ask the developer which
branch to continue in. Do not assume the current branch is intentional.

If the current branch is one of the protected branches (per `.rsct.json`, or the
defaults when the key is absent):
strongly recommend a derived branch before any mutation. If continuing
a known task, recommend the working branch from `plan_<slug>.md`.

**Pre-integration hygiene checklist (§C/§D, PH-5).** Before any outward
integration — a merge, a rebase/squash, or a push to a protected branch — answer
four items and confirm them with the dev: is the work **complete**; are the
pertinent **ADRs recorded**; are the associated **issues resolved**; have the
files this integration carries been **swept** for dead code and for comments that
no longer match the code. When ADRs, issues or the sweep are attested true, a
non-empty `note` must say what.

The fourth item also carries `files_swept[]`, the paths you swept. When
`rsct-mcp` is installed it reads the paths the integration really carries out of
git and rejects when one is missing from your list — **whatever the booleans
say**. Get the same list it reads with
`git diff --name-only --diff-filter=d <base>...<head>`, using the range for your
operation: merge → `HEAD...<source_branch>` · rebase → `<ref>...HEAD` ·
squash → `HEAD...<ref>` · push → `<remote>/<dest_branch>...<source_ref>`.
It checks **coverage**,
that the carried paths were claimed as swept; not that a sweep happened or found
anything. No tier exemption: residue reaches the codebase at every task size.

Practise the sweep at the refactor moment while the context is warm; it is
enforced later, at the integration boundary, where residue would become permanent.

Why: Protected branches are shared truth for the team; accidental direct
mutation affects everyone and is hard to undo cleanly. Derived branches isolate
experimental work and force review.

How to apply: Before any mutating git command, check the current branch. If it
matches a protected branch, stop, request creation of a derived branch, and
require explicit reconfirmed OK if user insists on working directly.
