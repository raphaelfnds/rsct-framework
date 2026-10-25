<!-- RSCT-GENERATED v=1.0.0 created=[CREATED_AT] sha256-body=[SHA_PLACEHOLDER] -->
name: Commit/push/merge — authorization does not reuse
description: Each mutating git operation requires updated OK, even if a similar action was authorized earlier in the same session
type: feedback

Prohibited without explicit user authorization in this session: create commit,
push to any branch, perform branch merge, execute deploy or release, run
migration in a real environment, run a migration, seed, reset or wipe — or a test
suite — against a database not known to be a disposable test one, apply changes
to auth, tenant context, persistence core, or public contracts. Authorization
does not reuse — each
occurrence requires an updated OK. "Already authorized" does not apply to the
next action, even if it looks similar.

**Universal override path:** the dev can bypass ANY framework rule (§A–§M)
with an explicit, single-action OK. Examples: "commit direto na main",
"skip plan and apply directly", "skip reverse-op planning for this".
Before acting: restate the override in 1 line, wait for "OK", apply once.
Next similar action requires fresh override OK. Log in progress_<slug>.md
if active. Framework guides; dev decides. An override of the commit / push /
merge / rebase gates is carried out by the dev, in their own terminal: with
`rsct-mcp` installed, the terminal guard refuses those git commands from the
agent's terminal, and a refusal is a STOP — never work around it.

Why: A single approval can authorize an accidental cascade of mutations. Each
risky action needs explicit confirmation at the moment it happens, not by
inheritance from an earlier OK.

How to apply: Before any commit / push / merge / deploy / real-env migration /
migration, seed, reset, wipe or test suite against a database not known to be
a disposable test one,
or before touching auth / tenant / persistence / public contract code, stop
and request fresh OK. Do not infer authorization from prior actions in the
same session.

When `rsct-mcp` is installed, use the §C-gated MCP tools for the four mutating
ops — the terminal guard refuses a plain `git commit` / `push` / `merge` /
`rebase` (and `cherry-pick`, `revert`, `am`, `gh pr merge`) from the agent's
Bash, PowerShell or Monitor tool, and so does a `git pull` that is not `--ff-only`
and `git commit-tree`. Every one of these tools shows the OS dialog —
`trust_allowed_for` does not apply to them, and with no dialog channel they are
refused. The only exception is a commit under the batch token the developer
approved for a multi-phase plan, for 8 hours at most. The tools enforce the rule
mechanically
(single-use `dev_approval` payload + cross-platform OS dialog + audit log
entry per call):

- `mcp__rsct__rsct_request_commit` for commits (every commit pops the OS dialog,
  unless a plan-scoped batch token is active; either path carries only code a
  completed REVIEW stamped — a staged code file that no REVIEW covers, or that
  still has a comment, is rejected before any dialog, `review_missing` /
  `comments_present`)
- `mcp__rsct__rsct_request_push` for pushes
- `mcp__rsct__rsct_request_merge` for merges
- `mcp__rsct__rsct_request_rebase` for rebases / `--squash` merges
  (history-rewriting; always per-action)

Merge, rebase/squash, and a push to a protected branch also require a
`pre_merge_ack` — four items (`plan_complete`, `adr_confirmed`,
`issues_resolved`, `hygiene_swept`) plus `files_swept[]`, checked BEFORE the OS
dialog so a bad ack costs nothing. `hygiene_swept` is the cleanup obligation:
sweep the files the integration carries for dead code, and list those paths
(comments are already enforced mechanically at commit time by the REVIEW sweep). RSCT reads the carried paths from
git itself and rejects when one is missing, regardless of the booleans. It
applies at every tier. See feedback_branch-protection.md for the full checklist.

`rsct_request_push` sends only to **configured remote names** — a URL or a
filesystem path is refused, and branch protection compares the resolved push
DESTINATION, so `+main`, `HEAD:main` and `refs/heads/main` are all recognised as
`main`.

The same terminal guard refuses commands that change a database: a client
statement that writes or that it cannot read, a migration, seed, reset or wipe,
a restore, `docker compose down -v`, and — in a Laravel project whose tests are
not pointed at a disposable database — the test run. There is no RSCT tool for
these: the developer runs them in their own terminal. Switching those rules off
is the developer's own edit of `.rsct.json` (`database_guard`,
`database_test_guard`), never yours.

The MCP layer, the SessionStart sanitizer hook and the PreToolUse terminal
guard close the "trust-forever" bypass surface that pure prose cannot. The
guard is a backstop, not the rule: every commit, push, merge and rebase goes
through the RSCT tools, whatever form the command would take — the OS dialog
remains the guarantee. Without `rsct-mcp` installed, this rule is enforced
only by Claude's own compliance.

Commit message length: keep it within THIS project cap — `commit_message_max_lines` in `.rsct.json`, chosen at `/rsct-setup` (default 15, range 1-500). `rsct_request_commit` rejects over it with `message_too_long` before the §C dialog, and the reject states the active value. Say what
changed and why; do not narrate the diff file by file — the diff already shows
that, and a long body encodes a session narrative that ages badly and makes
`git log` unscannable. Blank lines are not counted, so paragraph spacing is
free. `rsct_request_commit` enforces this mechanically and rejects before the
§C dialog, so an over-long message costs nothing but a rewrite. A project that
genuinely wants longer messages sets `commit_message_max_lines` in `.rsct.json`.
