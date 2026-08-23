<!-- RSCT-GENERATED v=1.0.0 created=[CREATED_AT] sha256-body=[SHA_PLACEHOLDER] -->
name: Commit/push/merge — authorization does not reuse
description: Each mutating git operation requires updated OK, even if a similar action was authorized earlier in the same session
type: feedback

Prohibited without explicit user authorization in this session: create commit,
push to any branch, perform branch merge, execute deploy or release, run
migration in a real environment, apply changes to auth, tenant context,
persistence core, or public contracts. Authorization does not reuse — each
occurrence requires an updated OK. "Already authorized" does not apply to the
next action, even if it looks similar.

**Universal override path:** the dev can bypass ANY framework rule (§A–§H)
with an explicit, single-action OK. Examples: "commit direto na main",
"skip plan and apply directly", "skip reverse-op planning for this".
Before acting: restate the override in 1 line, wait for "OK", apply once.
Next similar action requires fresh override OK. Log in progress_<slug>.md
if active. Framework guides; dev decides.

Why: A single approval can authorize an accidental cascade of mutations. Each
risky action needs explicit confirmation at the moment it happens, not by
inheritance from an earlier OK.

How to apply: Before any commit / push / merge / deploy / real-env migration,
or before touching auth / tenant / persistence / public contract code, stop
and request fresh OK. Do not infer authorization from prior actions in the
same session.

When `rsct-mcp` is installed, prefer the §C-gated MCP tools over plain
`Bash(git ...)` for the four mutating ops — they enforce the rule
mechanically (single-use `dev_approval` payload + cross-platform OS
dialog + audit log entry per call):

- `mcp__rsct__rsct_request_commit` for commits (for `trivial`/`small` tasks the
  dialog-free free-commit lane applies — bounded, audit-log-anchored ceiling;
  branch-protection + secret-scan still enforced. The lane is SUSPENDED while
  RSCT enforcement is not running — an enforcement script absent or with no hook
  wired to it — and the next commit falls back to a per-action `dev_approval`)
- `mcp__rsct__rsct_request_push` for pushes
- `mcp__rsct__rsct_request_merge` for merges
- `mcp__rsct__rsct_request_rebase` for rebases / `--squash` merges
  (history-rewriting; always per-action)

Merge, rebase/squash, and a push to a protected branch also require a
`pre_merge_ack` — four items (`plan_complete`, `adr_confirmed`,
`issues_resolved`, `hygiene_swept`) plus `files_swept[]`, checked BEFORE the OS
dialog so a bad ack costs nothing. `hygiene_swept` is the cleanup obligation:
sweep the files the integration carries for dead code and for comments that no
longer match the code, and list those paths. RSCT reads the carried paths from
git itself and rejects when one is missing, regardless of the booleans. It
applies at every tier. See feedback_branch-protection.md for the full checklist.

`rsct_request_push` sends only to **configured remote names** — a URL or a
filesystem path is refused, and branch protection compares the resolved push
DESTINATION, so `+main`, `HEAD:main` and `refs/heads/main` are all recognised as
`main`.

The MCP layer + SessionStart sanitizer hook close the "trust-forever"
bypass surface that pure prose cannot. Without `rsct-mcp` installed,
this rule is enforced only by Claude's own compliance.

Commit message length: keep it within THIS project cap — `commit_message_max_lines` in `.rsct.json`, chosen at `/rsct-setup` (default 15, range 1-500). `rsct_request_commit` rejects over it with `message_too_long` before the §C dialog, and the reject states the active value. Say what
changed and why; do not narrate the diff file by file — the diff already shows
that, and a long body encodes a session narrative that ages badly and makes
`git log` unscannable. Blank lines are not counted, so paragraph spacing is
free. `rsct_request_commit` enforces this mechanically and rejects before the
§C dialog, so an over-long message costs nothing but a rewrite. A project that
genuinely wants longer messages sets `commit_message_max_lines` in `.rsct.json`.
