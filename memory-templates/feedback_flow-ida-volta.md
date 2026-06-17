<!-- RSCT-GENERATED v=1.0.0 created=[CREATED_AT] sha256-body=[SHA_PLACEHOLDER] -->
name: State reversibility (IDA/VOLTA)
description: In every plan that changes persistent state, evaluate reverse operation and user permissions — reminder integrated into §B, not a blocker
type: feedback

This rule is a reminder integrated into §B (planning), not a blocker.
When the plan covers any operation that changes persistent state — create,
save, group, approve, publish, activate, link, generate — include two
mandatory questions:

1. Permissions: will the user have permission to execute this operation?
   Check existing RBAC/roles in the codebase. If not found, ask the developer.
   The same question applies to the reverse operation.

2. Reversibility: is a reverse operation needed? Define what "reverse" means
   in this domain. Example: "cancel order" must restore inventory, not just
   delete the record.

If developer accepts implementing the reverse flow: follow §B + §C as usual.
If not: proceed normally.

Why: AI tends to focus on the forward flow ("create the entity") and forget
the inverse ("undo it cleanly"). Reverse flows often involve subtle business
logic — restoring counts, releasing locks, reverting state of related records —
that breaks silently if not planned upfront. Ref.: §F of CLAUDE.md.

How to apply: Activate during §B planning whenever the change mutates
persistent state. Add both questions to the plan as a check, not as a
gate. Do not block the flow — surface the questions and let the dev decide.
