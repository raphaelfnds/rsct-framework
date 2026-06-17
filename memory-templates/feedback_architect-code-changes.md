<!-- RSCT-GENERATED v=1.0.0 created=[CREATED_AT] sha256-body=[SHA_PLACEHOLDER] -->
name: Architect before editing code
description: Every code change requires plan with 2+ options (one marked Recommended) + reuse analysis + explicit OK; exceptions: active debug and trivial docs
type: feedback

When `rsct-mcp` is installed: §0 of CLAUDE.md mandates calling
`mcp__rsct__rsct_classify_task` and `mcp__rsct__rsct_phase_spec_start`
BEFORE presenting the §B plan described here, and
`mcp__rsct__rsct_phase_spec_complete({ dev_approval })` when the dev
gives the OK on a chosen option. The §B prose below is what the
spec phase wraps. See feedback_session-bootstrap.md for the full
bootstrap chain.

Never edit code without first presenting a plan: at least 2 execution options
with evaluated impacts, **one explicitly marked as Recommended** with a 1-2
sentence justification of why it is preferred over the alternatives. The
developer can override; the recommendation must be present.
Include reuse analysis of existing functions/classes/services/components,
and an explicit no-reuse option when a reuse alternative exists.
User may approve one option, mix them, or request refinement before any edit.
Plan must include integrated checks: reversibility (§F — persistent state and
permissions) and testing (§G — tests in or out of this plan?).
**Always read `documentation/decisions.md` before formulating options** —
firm premises (#N) constrain what is allowed; existing ADRs (ADR-NNN) record
discarded alternatives that should not be silently re-proposed; the "Out of
scope" section flags areas where proposals must be questioned.
Exceptions: trivial isolated edits in documentation or typo fixes; active bug
inspection (§A) where mutations still require plan + OK. When in doubt: require
a plan.

Why: Premature edits skip scope evaluation, miss existing reuse, and surprise
the dev mid-task. Ref.: §B of CLAUDE.md.

How to apply: Activate before any edit to executable behavior files
(source code, config, build files). Wait for explicit plan approval.
Re-plan if user requests refinement or chooses to mix options.
