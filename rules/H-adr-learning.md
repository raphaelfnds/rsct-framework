## §H — ADR auto-learning — recording decisions

During any session, when a decision meeting ANY of the criteria below is
identified, ask the developer if they want to record it. **Three distinct
artifacts capture three distinct things** — pick correctly (CAP-32 / CAP-54):

| File | Records | Examples |
|---|---|---|
| `documentation/decisions.md` | **Positive / adopted decisions** that the team will follow going forward — the *why/when* of a choice. Firm premises (non-negotiable) + durable ADRs (append-only history of choices made). Point-in-time, supersedable. | "Use Spring Boot 3.x", "JWT for auth tokens", "PostgreSQL 16 on staging", "All money fields are BigDecimal not double" |
| `documentation/knowledge/anti-decisions.md` | **Rejected / abandoned approaches**. Paths the team tried and explicitly will NOT take again. Protects the next agent/contributor from suggesting them anew. | "Tried Redis pub/sub for inter-service events — abandoned because of message loss on restart", "Migrated off Liquibase to Flyway in 2024 — do not propose Liquibase again" |
| `CONVENTIONS.md` (project root) | **Prescriptive coding conventions** — the standing *how* for all NEW code (naming, schema/migration patterns, identifier language, the mold for a new module). Consulted BEFORE writing code; a standing rule applied to every new file, not a point-in-time choice. A convention often *derives* from a decisions.md ADR. | "Identifiers in English", "each domain owns its schema", "migrations named `V<ts>__<domain>_<action>.sql`", "IDs are BIGINT via sequence" |

**Choosing**: if you would say "we *chose* X (and here's why)" → `decisions.md`.
If you would say "we explicitly avoid X because we tried Y and it failed" →
`anti-decisions.md`. If you would say "all new code *must* do X" (a standing,
prescriptive rule, not a one-time choice) → `CONVENTIONS.md`. A rejected
alternative inside an ADR's
"Alternatives considered" stays in the ADR; the dedicated
`anti-decisions.md` entry is for an abandoned approach that was
actually tried (or seriously considered + ruled out) and merits its own
top-level record.

**Criteria for a recordable decision (decisions.md):**
- Decision with no defined expiration (permanent or indefinite).
- Technology, library, pattern or architectural approach choice.
- Firm business or technical constraint or premise ("never do X", "always
  use Y for Z").
- Explicit choice not to implement something ("out of scope").
- Result of a debate between alternatives where one was discarded.

**Criteria for an anti-decision (anti-decisions.md):**
- An approach the team explicitly **rejected after trying it** (the
  failure mode is institutional knowledge worth preserving).
- A pattern repeatedly proposed by new contributors that has been
  knowingly ruled out (so future proposals can be deflected with the
  prior reasoning instead of re-debated).
- An attempted migration / rewrite that was rolled back, with the
  reason.

**Recording format in documentation/decisions.md:**

For firm premises (non-negotiable):
```
### #N — <short title>
<description + reason>
```

For durable ADRs (append-only, chronological order):
```
### ADR-NNN — <title> (<YYYY-MM-DD>, ref: <task/PR/issue>)
**Context**: <situation that led to the decision>
**Alternatives considered**: <list>
**Decision**: <what was decided and why>
**Consequences**: <what changes, what goes out of scope>
```

For out-of-scope items:
Add to the "Out of scope" section with 1 descriptive line.

**Execution rules:**
- Never rewrite an existing ADR — append only.
- Chronological history lives in git log, not in this file.
- Editing decisions.md follows §B exception (it is .md — no plan required),
  but commit/push follow §C (updated OK).
- If the developer does not accept the recording, proceed without
  registering a pending item.
- Propose once per relevant decision — do not repeat in the same session.

**Relation to `pre_merge_ack.adr_confirmed` (§C/§D, PH-5):** the
`adr_confirmed` item of the pre-integration checklist is a **rollup** — it
attests that the ADRs surfaced/agreed **during this session** are already
recorded via the flow above. It is **not** a cue to open a fresh round of
ADR proposals at merge time (that would violate "propose once per session"
here). If nothing was recordable, `adr_confirmed` is trivially true.
