<!-- RSCT-GENERATED v=1.0.0 created=[CREATED_AT] sha256-body=[SHA_PLACEHOLDER] -->
name: ADR auto-learning
description: When identifying a permanent decision during conversation, ask if dev wants to record in documentation/decisions.md
type: feedback

During any session, when a decision meets ANY criterion below, ask the
developer where to record it. **Two distinct files, two distinct
kinds of decision (CAP-32):**

`documentation/decisions.md` — POSITIVE / ADOPTED decisions:
- Decision with no defined expiration (permanent or indefinite)
- Technology, library, pattern, or architectural choice
- Firm business or technical constraint ("we always do X")
- Explicit choice not to implement something
- Result of a debate where one alternative was chosen

`documentation/knowledge/anti-decisions.md` — REJECTED / ABANDONED:
- An approach the team explicitly rejected AFTER TRYING it
- A pattern repeatedly proposed but knowingly ruled out (so future
  proposals can be deflected with prior reasoning)
- A migration / rewrite that was rolled back with the reason

Choosing: if you would say "we do X" → decisions.md. If you would say
"we explicitly avoid X because we tried Y and it failed" →
anti-decisions.md.

decisions.md format: firm premises (#N) for non-negotiable constraints,
or durable ADRs (ADR-NNN, append-only) with context, alternatives,
decision, consequences. Never rewrite — append. anti-decisions.md
format: free-form entry with title, what was tried, why it failed,
date. See doc-templates/knowledge/anti-decisions.md.template.

Why: Decisions are forgotten if not recorded; later sessions or new
team members repeat closed debates. ADRs preserve the *why* that
`git log` does not. Anti-decisions capture the failure modes that are
invisible from current code — without them, the next session will
keep proposing the abandoned approaches. Ref.: §H of CLAUDE.md.

How to apply: Listen for permanent or firm decisions during
conversation. When one occurs, ask the dev which file fits (or pick
yourself if the choice is obvious: "we do X" → decisions; "we tried X
and dropped it" → anti-decisions). Propose registration once. If
accepted, append to the appropriate file. Never rewrite prior
entries.
