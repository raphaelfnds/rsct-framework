<!-- RSCT-GENERATED v=1.0.0 created=[CREATED_AT] sha256-body=[SHA_PLACEHOLDER] -->
name: Plan tracking — branch-local files
description: After every approved plan, write plan_<slug>.md + progress_<slug>.md at project root; gitignored; never on main/test
type: feedback

After §B plan approval for any non-trivial task:

1. Derive slug from current branch name (e.g., feat/foo-bar → foo-bar).
2. Create `plan_<slug>.md` at project root using doc-templates/plan_slug.md.template,
   filling all sections with the approved plan content.
3. Create `progress_<slug>.md` at project root using doc-templates/progress_slug.md.template,
   starting with the initial entry "Plan approved, execution starting".
4. Remind the developer explicitly:
   "These two files are gitignored by default. To track them on this feature
   branch, run: git add --force plan_<slug>.md progress_<slug>.md
   Do NOT track them on main or test branches."

During execution:
- Update progress_<slug>.md after every meaningful step (commit, blocker,
  discovery, status change). Do not let it stale.
- If a discovery emerges that affects the plan, register it in the
  "Discoveries" section AND list 2+ options (resolve here vs defer to
  separate issue) for the dev to decide.

Before any `git push` or merge to main/test:
- Verify plan_*.md, progress_*.md, and spec_*.md are NOT in the diff
  being merged.
- If they are, warn the dev and ask to clean up before proceeding.

After a COMPLETED merge or PR — proactively SUGGEST cleanup (optional, the
dev's OK, never automatic, and only once the plan/progress/spec work is done):
1. Delete the **working branch** (local + remote):
   `git branch -d <branch>` + `git push origin --delete <branch>`, or GitHub's
   "Delete branch" button, or `gh pr merge --delete-branch`.
2. Delete the branch-local `plan_/progress_/spec_<slug>.md` files (they must
   never be tracked on a protected branch anyway). When `rsct-mcp` is installed,
   record the keep|delete decision with `rsct_plan_dispose` (plan-lifecycle-v2)
   — it prints an **advisory** cleanup report and **never auto-deletes**, and it
   covers the GitHub-PR-merge terminal too. (In `plan_file_retention: documented`
   mode, `spec_<slug>.md` is kept — versioned as durable design docs.)

This applies to **every** merge strategy — "merge" in this framework means any
of GitHub's three PR methods, and the cleanup is identical for all:
**merge commit** (`gh pr merge --merge`), **squash and merge** (`--squash`),
and **rebase and merge** (`--rebase`) — as well as a local `git merge` /
`rsct_request_merge`. If the dev declines, proceed without a pending item.

Naming alias: `spec_<slug>.md` is an accepted synonym of `plan_<slug>.md`
(useful when the dev prefers the M3 phase-machine wording). Same gitignore
rule, same template, same NEVER-on-protected guarantee. Canonical name
remains `plan_<slug>.md`; only use `spec_` when the dev explicitly asks.

Why: workflow audit trail at project root + auditable in feature branch +
clean main/test history. Files serve dev's working memory across sessions;
not part of public project knowledge.

How to apply: Activate immediately after §B plan approval. Maintain the
two files until task is completed. On task completion, the files can be
kept (history) or deleted (cleanup) per dev choice. Always recall the
gitignore + git add --force reminder when creating the files; do not skip
the dev warning.

**Session resume — proactive context-pressure detection:** AI cannot
introspect its own context window. Watch THREE observable signals:
(1) platform reminders about auto-compaction / summarization;
(2) heuristic — 4+ commits OR 6+ edits OR 30+ dev messages OR multiple
agent runs in the same session;
(3) plan milestone — section completed, commit landed, blocker appeared.

On ANY signal: (a) update progress_<slug>.md with current state; (b)
append/refresh "Session resume" block (slug, branch, refs, last/next
step, blockers, last commit SHA); (c) proactively ASK the dev (do not
wait for request):
"⚠ Context-pressure signal: <which>. Resume is fresh. Options:
 (a) continue in this session (risk: compaction may lose nuance)
 (b) generate final resume + new session (recommended on signal 1 or 2)
 (c) show resume before deciding."

If (b) chosen: print exact resume block, confirm dev opens new chat with
it before ending current session. If (a): proceed but keep resume fresh.

Always-fresh state is the safety net: even if detection fails, the dev can
grab the resume manually and switch sessions whenever they choose.
