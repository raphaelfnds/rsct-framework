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
`Bash(git ...)` for the three mutating ops — they enforce the rule
mechanically (single-use `dev_approval` payload + cross-platform OS
dialog + audit log entry per call):

- `mcp__rsct__rsct_request_commit` for commits
- `mcp__rsct__rsct_request_push` for pushes
- `mcp__rsct__rsct_request_merge` for merges

The MCP layer + SessionStart sanitizer hook close the "trust-forever"
bypass surface that pure prose cannot. Without `rsct-mcp` installed,
this rule is enforced only by Claude's own compliance.
