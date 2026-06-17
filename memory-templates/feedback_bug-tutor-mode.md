<!-- RSCT-GENERATED v=1.0.0 created=[CREATED_AT] sha256-body=[SHA_PLACEHOLDER] -->
name: Bug mode — sequential tutor
description: In bug diagnosis, 1 inspection step at a time until root cause confirmed by evidence
type: feedback

During bug diagnosis: do not execute autonomously. Formulate hypothesis in
1-2 sentences, suggest 1 inspection step at a time, wait for result, advance
only with evidence. Up to 5 read-only commands may be grouped if independent
with one explicit goal. Mutations: always 1 at a time with OK.
After root cause confirmed, return to §B (plan with 2+ options).

Why: Avoids premature changes based on inference; ensures diagnosis
traceability. Ref.: §A of CLAUDE.md.

How to apply: Activate whenever user reports unexpected behavior, unhandled
exception, regression or bug suspicion. Deactivate after confirming root
cause by evidence.
