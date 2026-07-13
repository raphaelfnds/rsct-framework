## §D — Protected branches

> **Pre-§D (when `rsct-mcp` is installed):** §0 of this CLAUDE.md
> mandates calling `mcp__rsct__rsct_status` at session start. Its
> output lists the active branch + `protected_branches[]` + hints.
> If the active branch is in the protected list, the hint reads
> "§D requires a derived branch (feat/, fix/, chore/, docs/) for
> any mutating work — confirm with dev before proposing changes".
> **Treat that hint as a STOP signal** — do not skip ahead to §B
> until the dev confirms the derivation strategy. The §A–§H prose
> below remains the full §D when `rsct-mcp` is not installed.

Treat `main` and `test` (when it exists) as protected branches.
Without explicit reconfirmed authorization for the current action:

- Prohibited: git commit, git push, git merge (incoming or outgoing),
  git rebase, git reset, force push, or checkout for editing.
- Allowed without OK per action: reading (git log, git diff, git show)
  and temporary checkout for inspection with immediate return to another branch.
- For any mutating work: create a derived branch (feat/, fix/, chore/, docs/)
  and open a PR.

**"Merge" = any of GitHub's three PR methods.** Wherever this framework says
"merge" (the §C `rsct_request_merge`, or a PR), it covers **merge commit**
(`gh pr merge --merge`), **squash and merge** (`--squash`), and **rebase and
merge** (`--rebase`) — there is no fourth method. After a merge/PR completes by
ANY of them, **and once the task's plan/progress/spec work is done**, proactively
**suggest** (optional, the dev's OK, never automatic): delete the **working
branch** (local + remote — `git branch -d` / `git push origin --delete`, GitHub's
"Delete branch", or `gh pr merge --delete-branch`) and the
`plan_/progress_/spec_<slug>.md` tracking files. When `rsct-mcp` is installed,
record the keep|delete decision with `rsct_plan_dispose` (plan-lifecycle-v2) —
it prints an **advisory** cleanup report and **never auto-deletes**, and it works
for the GitHub-PR-merge terminal too (where neither `rsct_request_merge` nor
`_push` runs). A PR-level squash/rebase runs via `gh` / the web UI, so raising the
suggestion is on you. (In `plan_file_retention: documented` mode, `spec_<slug>.md`
is kept — tracked as durable design docs.)

**Pre-integration hygiene checklist (before any outward integration):**

Before you integrate outward — a merge, a GitHub PR (any of the three
methods), or a **push to a protected branch** — run a quick hygiene
checklist and confirm it with the dev:

1. Is the task/phase work actually **complete**?
2. Are the pertinent **ADRs recorded** (→ §H)? (Confirm the ones already
   surfaced this session are written — this is not a new proposal round.)
3. Are the associated **issues resolved**?

When `rsct-mcp` is installed, `rsct_request_merge` (always), `rsct_request_push`
(when the branch is protected), and `rsct_request_rebase` (local rebase/squash,
plan-lifecycle-v2) enforce this mechanically via `pre_merge_ack` (§C) — the ack
is a self-attestation (except `plan_complete`, now cross-checked against open
`- [ ]` items in the plan's progress), so answer it honestly; marking any item
false is honored as a stop. **A local rebase/squash now has a §C-gated tool**
(`rsct_request_rebase`, which requires its own `pre_merge_ack`); **only PR merges
via `gh`/the web UI still have no MCP tool** — there the checklist is **yours to
run as prose** before the outward-facing action. A push to a non-protected
feature/WIP branch is not an integration and does not need the checklist.

Even if the user authorized a push on a protected branch in the same session,
the next push on that branch requires an updated OK (§C — authorization does
not reuse). Exception: the current session may be working directly on a
protected branch by explicit user decision — even in this case, each mutating
action on the protected branch still requires OK per action.

**Active branch verification at task boundaries:**

At the start of every task and after any pause (planning done → new task,
resume after break, switch context), run:
```bash
git rev-parse --abbrev-ref HEAD
```

If the current branch differs from the branch where a prior plan was approved
(visible in `plan_<slug>.md` metadata, if present):
- Explicitly ask the developer which branch to continue work in.
- Do NOT assume the current branch is intentional.

If the current branch is `main`, `test`, `dev`, or any other protected branch
declared in `.rsct.json`:
- Strongly recommend creating a new derived branch before any mutation.
- Recommend reusing the existing working branch from `plan_<slug>.md` if
  the task is a continuation.

**§D and the M3 phase machine (when `rsct-mcp` is installed):**

The Code phase (§B-approved plan moving into execution) is wrapped by:

1. `mcp__rsct__rsct_phase_code_start({ spec_ref, scope_globs, spec_tier })` —
   declare the files this phase intends to mutate. The `scope_globs[]`
   is the per-phase contract. **Pass `spec_tier`** from your earlier
   `rsct_classify_task` result: `trivial`/`small` bypass the
   verification gate; `standard`/`complex` are rejected unless the V
   phase was completed for the same `spec_ref` (CAP-28). To skip V
   intentionally on a standard/complex task, pass
   `override_verification_skip: true` — the override is audit-logged.
2. Before each `Edit` / `Write`:
   `mcp__rsct__rsct_check_edit_scope({ file_path })` returns
   `in_scope` / `out_of_scope` / `unknown`. If `out_of_scope`, STOP
   and ask the dev to expand `scope_globs` (via re-opening spec) or
   to defer the edit. The check is read-only and cheap — call it for
   every Edit, not just the first one.
3. `mcp__rsct__rsct_phase_code_complete({ spec_ref, dev_approval })`
   — §C gate after all edits land.
4. The REVIEW phase (when `include_review:true` was recorded at
   spec_complete): `rsct_phase_review_start` → review the diff →
   `rsct_phase_review_complete`. Then `rsct_phase_test_start({ spec_ref,
   spec_tier })` — for `standard`/`complex` it rejects unless the review
   decision is honored (completed, or `include_review:false`), bypassable
   with `override_review_skip: true` (audit-logged). The recommended
   cycle is R→S→V→C→REVIEW→T.

The branch derivation step above is INDEPENDENT of and PRECEDES the
phase machine: derive `feat/<slug>` (or equivalent) FIRST, then open
the code phase on the derived branch. Mutating on a protected branch
remains forbidden regardless of how `scope_globs` is declared.
