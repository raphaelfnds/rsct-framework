## §B — Mandatory plan before editing code

> **Pre-§B (when `rsct-mcp` is installed):** §0 of this CLAUDE.md
> mandates calling `mcp__rsct__rsct_classify_task` and then
> `mcp__rsct__rsct_phase_spec_start({ spec_ref })` **before**
> presenting the plan described here. When you receive the dev's
> explicit OK on a chosen option (or merged variant), call
> `mcp__rsct__rsct_phase_spec_complete({ spec_ref, dev_approval })`
> — this is the §C gate that promotes "ok opção A" in chat into an
> auditable approval with an OS dialog. If `rsct-mcp` is not
> installed, the prose contract below remains the full §B.

NEVER edit code without first presenting the user a plan containing:

1. At least 2 execution options with evaluated impacts for each.
   **One of the options must be explicitly marked Recommended**, accompanied
   by a 1-2 sentence justification of why it is preferred over the alternatives.
   The developer may override the recommendation; the recommendation itself
   must always be visible.
2. Reuse analysis: existing functions, classes, services, components or
   algorithms in the project that fully or partially cover the need —
   list which and where they are.
3. Explicit no-reuse option when a reuse alternative exists, so the user
   can compare reuse vs. greenfield.
4. Merging possibility: the user can choose one of the options, request
   refinement, or request a third option merging parts of both.
5. **Mandatory read of `documentation/decisions.md` before formulating options:**
   - **Firm premises (#N)** — non-negotiable. Any option that violates a firm
     premise must be discarded or the conflict must be escalated to the user
     explicitly. Never propose a plan that silently violates a premise.
   - **Existing ADRs (ADR-NNN)** — record alternatives already evaluated.
     Do not re-propose an alternative that an ADR already discarded without
     citing the ADR and stating why it should be re-opened.
   - **Out of scope section** — explicit list of what this project does NOT
     do. Proposals that touch out-of-scope areas must be flagged.
   - **`CONVENTIONS.md` (project root), if present** — the project's
     *prescriptive* coding conventions (naming, schema/migration patterns,
     identifier language, the mold for a new module). **New code MUST conform**;
     cite the convention when a plan follows it. If recurring conventions are
     emerging and no `CONVENTIONS.md` exists yet, **propose** creating one (the
     §H taxonomy: decisions × anti-decisions × conventions) — never create it
     silently. `CONVENTIONS.md` is the standing *how*; `decisions.md` is the
     *why/when*.
6. **Plan tracking files (after developer approval):**
   **Immediately** after the dev approves the plan — *before writing any
   code* — write two files at the project root. Do not defer this: the MCP
   gate `rsct_phase_code_start` mechanically **rejects** the Code phase for
   `standard`/`complex` tasks when `plan_<slug>.md` + `progress_<slug>.md`
   are absent (pass `plan_slug`; override only with `override_plan_tracking`).
   - `plan_<slug>.md` — the approved plan, using the framework template
     `doc-templates/plan_slug.md.template`.
   - `progress_<slug>.md` — execution log, using the framework template
     `doc-templates/progress_slug.md.template`.

   Slug derives from the current branch name (e.g.,
   `feat/aprovacao-requisicao-compra` → `aprovacao-requisicao-compra`).

   **Multi-phase plans (one spec per phase):** when the plan has more than
   one phase, write **one `spec_<phase-slug>.md` per phase**, created before
   that phase's Code — each phase carries its own detailed spec while the
   master `plan_<slug>.md` holds the overall arc. A **single-phase** plan
   needs NO spec file: detail the spec in memory/chat at that moment and
   proceed. When starting Code, pass `plan_slug` (and `spec_slug` when
   multi-phase) to `rsct_phase_code_start`: the gate requires
   `plan_/progress_` for the plan, plus `spec_<spec_slug>.md` whenever
   `spec_slug` differs from `plan_slug` (its multi-phase signal).

   **Accepted alias (single-phase only):** `spec_<slug>.md` may stand in for
   `plan_<slug>.md` when the dev prefers the "spec" wording — same gitignore
   rule, same NEVER-on-protected guarantee, same template
   (`doc-templates/plan_slug.md.template`). For multi-phase plans keep the
   master doc named `plan_<slug>.md` so the per-phase `spec_` files never
   collide with it.

   These files are **gitignored by default** (see `.gitignore` patterns
   `plan_*.md`, `progress_*.md`, and `spec_*.md` added by `/rsct-setup`).
   To track them on the current feature branch, the developer uses:
   ```
   git add --force plan_<slug>.md progress_<slug>.md
   ```

   **These files must NEVER be tracked on `main` or `test` branches.**
   Before any merge or push to a protected branch, verify they are absent
   from the diff being merged. Always remind the developer of this rule
   when creating the files.

   **Session resume — proactive context-pressure detection:**

   The AI cannot reliably introspect its own context window (no direct
   API for "how much context is left?"). The framework compensates with
   **three observable signals** the AI is required to watch and act on:

   **Signal 1 — Platform reminders.** Claude Code (and similar tools)
   emit system reminders about approaching context compaction
   ("messages will be summarized", "auto-compact pending", or similar
   wording). When this kind of reminder appears in the conversation,
   treat it as an explicit context-pressure trigger.

   **Signal 2 — Operation count heuristic.** After substantial work
   (rough indicators: 4+ commits, 6+ significant edits, 30+ dev
   messages in the same session, multiple parallel agent runs), assume
   context is non-trivially loaded.

   **Signal 3 — Plan milestone.** When a plan section completes, a
   commit lands, or a hard blocker appears, that is a natural
   checkpoint regardless of context pressure.

   **Required behavior on any signal:**

   1. Immediately update `progress_<slug>.md` with the current state
      (last completed step, next planned step, open blockers, last
      commit SHA).
   2. Append/refresh a "Session resume" block at the end of
      `progress_<slug>.md`:
      ```markdown
      ## Session resume (for new chat context)

      To continue task `<TASK_SLUG>` in a new Claude Code session, paste:

      > Continue task `<TASK_SLUG>` on branch `<BRANCH_NAME>`.
      > Plan: see plan_<TASK_SLUG>.md
      > Progress so far: see progress_<TASK_SLUG>.md
      > Last completed step: <ITEM>
      > Next planned step: <ITEM>
      > Open blockers / questions: <LIST>
      > Last commit: <SHA> (<message>)
      ```
   3. Proactively ask the developer (do NOT wait for them to bring it up):
      ```
      ⚠ Context-pressure signal detected: <which signal>.
      progress_<slug>.md is up to date and contains a fresh resume block.

      Options:
        (a) Continue in this session — risk: context compaction may lose nuance
        (b) Generate final resume and continue in a new session (recommended
            when signal 1 or signal 2 fired)
        (c) Show me the current resume block before I decide

      Which do you prefer?
      ```
   4. If the dev chooses (b): print the exact resume block content
      ready to paste, confirm the dev opens a new chat with it before
      the AI ends the current session.
   5. If the dev chooses (a): proceed but keep the resume block fresh
      so the option remains available later.

   **Always-fresh state is the safety net.** Even if all 3 signals fail
   (rare), as long as the AI keeps `progress_<slug>.md` updated after
   every meaningful step, the dev can grab the resume manually at any
   moment and switch sessions on their own initiative.

The plan must be presented and explicitly approved by the user before any
edit in executable behavior files (.java, .properties, .yml, .ts, .tsx,
.js, pom.xml, composer.json, package.json, framework configuration).

Even when the user explicitly requests reuse ("use what already exists"),
the concrete application of reuse (which specific function, class, service)
must be presented and explicitly approved before editing.

**Integrated checks in every plan (§B always includes):**

Reversibility check (§F): for any flow that changes persistent state, the
plan must include: "Is a reverse operation needed? Who has permission to
execute it?" If business rules for permissions are not found in code or
documentation, ask the developer before including in the plan.

Testing check (§G): the plan must include: "Do you want automated tests in
this plan?" If yes → add test strategy as part of the plan options.
If no → record that manual tests must be confirmed before closing the task.

Exceptions to §B:
- Trivial isolated edits in documentation (*.md) or typo fixes with no
  behavioral impact.
- Active debug session (§A): during bug diagnosis, §B does not apply to
  inspection commands; code mutations still require plan + OK.
- When in doubt about whether the exception applies, always require a plan.

**§B and the M3 phase machine (when `rsct-mcp` is installed):**

`rsct_classify_task` returns `tier: trivial` for genuine §B
exceptions — that IS the structural way to detect "trivial / doc-only
fix" and skip the plan. For every other tier (`small` / `standard` /
`complex`), the §B plan still applies, AND it is presented inside an
open phase (`rsct_phase_spec_start` opened before, `_complete` closing
on OK). The phase tools do not replace the §B rules above; they bracket
them with state + audit + the §C OS dialog.
