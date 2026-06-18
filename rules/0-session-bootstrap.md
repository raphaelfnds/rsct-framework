## §0 — Session bootstrap (must run before §B)

When a new session opens in this project — or you receive any task more
substantive than a typo / doc-only fix — execute the following
**before** proposing a plan, before reading source code beyond what
the request explicitly names, and before any code edit.

This section is the bridge between the prose contract (§A–§H below)
and the `rsct-mcp` enforcement tools. **Skipping it is the most common
way Claude drifts off the framework** — the dev catches it
retroactively and has to regularize via `rsct_phase_abandon` or
manual cleanup.

### 1. Bootstrap calls (every session, every project)

In order, with NO other tool call in between:

1. **`mcp__rsct__rsct_status`** — reads `.rsct.json`, detects the
   active branch, surfaces `protected_branches[]` + `working tree
   clean?` + hints. If `rsct_installed: false`, ask the dev whether
   to run `/rsct-setup`. **Read the `hints` field verbatim** before
   anything else.

2. **`mcp__rsct__rsct_load_context`** — reads the active plan,
   decisions snapshot, knowledge index, and `active_phase` (if a
   phase from a prior session is still open). `next_action_hints`
   is mandatory reading; act on every hint.

If either call returns `rsct_installed: false`, the rsct-mcp is not
configured for this project — proceed with the §A–§H prose only, and
suggest the dev run `/rsct-setup` to enable the enforcement layer.

**Universe (org layer).** Both calls return a `universe` block. When
`universe.available` is `true`, this project belongs to an org-level
**universe** repository: consult its governance / naming standards
before proposing new structure (modules, services, naming, ownership),
and treat those org-level standards as **authoritative over local
guesses**. If the block carries a `note` (e.g. "configured but not
found", "found but unreadable", or a registry mismatch) or a hint that
this app is not registered, surface it to the dev — do not silently
ignore it. When `available` is `false` and there is no note, there is no
universe in play; proceed normally.

### 2. Task classification (any non-trivial request)

Before §B (presenting a plan):

3. **`mcp__rsct__rsct_classify_task`** with `task_description` set to
   the dev's request. Returns:
   - `tier`: `trivial` | `small` | `standard` | `complex`
   - `recommended_phases[]`: the RSCT sequence for that tier
   - `signals[]`: which keyword categories matched

`tier: trivial` (typically pure docs/typo) → skip the phase machine
entirely; §B exception applies. For everything else, the phase
machine is the next step.

### 3. Phase machine (any task above `trivial`)

For `small` → start with **spec** (research folded in):
- `mcp__rsct__rsct_phase_spec_start({ spec_ref, ... })` BEFORE
  presenting your §B plan.
- Present the plan (still per §B rules — 2 options + reuse +
  Recommended).
- On dev OK → `mcp__rsct__rsct_phase_spec_complete({ spec_ref,
  dev_approval })`. The §C OS dialog fires here; this is the formal
  gate that promotes "ok opção a" in chat to an auditable approval.

For `standard` and `complex` → start with **research**:
- `mcp__rsct__rsct_phase_research_start({ spec_ref })` before
  surveying the codebase.
- After research is done → `mcp__rsct__rsct_phase_research_complete`
  (§C gate).
- Then `mcp__rsct__rsct_phase_spec_start` → §B plan → `_complete`.

For `complex` additionally: V phase is mandatory between spec and
code:
- `mcp__rsct__rsct_phase_verification_start({ spec_ref,
  declared_paths })` after spec_complete.
- Review findings, set per-finding actions, then
  `mcp__rsct__rsct_phase_verification_complete`.

### 4. Code phase + scope-gated edits

Before any `Edit` / `Write` to executable behavior files
(`.java`, `.ts`, `.py`, `.yml`, source code, build configs):

- **Consult `./CONVENTIONS.md`** (if present) before writing new code — it is the
  project's *prescriptive* standard (naming, schema/migration patterns,
  identifier language, the mold for a new module); new code must conform
  (§B item 5 / §H taxonomy). If recurring conventions emerge and none exists,
  propose creating one — never silently.
- `mcp__rsct__rsct_phase_code_start({ spec_ref, scope_globs, spec_tier })` —
  declare WHICH files this phase intends to mutate. The `scope_globs[]`
  is the contract. **Pass `spec_tier`** from your earlier
  `rsct_classify_task` call: `tier='trivial'|'small'` bypasses the
  verification gate; `tier='standard'|'complex'` **rejects unless V
  phase was completed for the same `spec_ref`** (CAP-28). To skip V
  intentionally on a standard/complex task (rare), pass
  `override_verification_skip: true` — the override is audit-logged.
- Before each `Edit` call:
  `mcp__rsct__rsct_check_edit_scope({ file_path })` — returns
  `in_scope` / `out_of_scope` / `unknown`. If `out_of_scope`, STOP
  and ask the dev to expand `scope_globs` (requires re-opening spec)
  or to defer the change.
- After all edits land → `mcp__rsct__rsct_phase_code_complete`
  (§C gate).

### 5. Test phase

After code phase closes:
- `mcp__rsct__rsct_phase_test_start({ spec_ref })`.
- Run / add tests; check results.
- `mcp__rsct__rsct_phase_test_complete` — the §C gate that closes
  the task.

### 6. Branch protection check (§D)

`rsct_status` step 1 returns the current branch. If it's in
`protected_branches[]`, **STOP** before any of the phase-machine
calls above and ask the dev to confirm derivation of a feature
branch (`feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`).
Working on a protected branch directly requires explicit per-action
OK from the dev (§D below); deriving is the default.

### 7. Mid-session re-classification

If the dev pivots ("actually, let's also change X"), or you discover
mid-execution that the task is bigger than classified — call
`rsct_classify_task` again with the updated description. If the
new tier is higher, recommend abandoning the current phase via
`mcp__rsct__rsct_phase_abandon` and restarting at the appropriate
phase. Do not silently absorb scope.

### 8. Persona lens (optional but recommended)

For `standard` and `complex` tasks, call
`mcp__rsct__rsct_auto_persona({ task_description })` after
`rsct_classify_task`. The recommended persona's lens
(focus areas, questions, anti-patterns, knowledge categories)
sharpens the §B plan options. Pass the recommended persona slug into
`phase_*_start({ persona })` so it lands in the audit trail. The
**Tutor** persona is opt-in only — `rsct_auto_persona` never
recommends it; the dev chooses it explicitly when they want
step-by-step interactive guidance.

### 9. Issue capture during analysis

If at any point during research / spec / verification you find a
non-blocking finding (an unrelated bug, a doc gap, a tech-debt
candidate) — **do NOT scope-creep into fixing it**. Call
`mcp__rsct__rsct_capture_issue({ mode: 'draft', ... })` to format
a GitHub issue body the dev can paste later, or `mode: 'create'`
(§C-gated) to file it via `gh issue create` immediately.

### Bootstrap is OPT-OUT, not opt-in

The bootstrap calls (§0.1, §0.2, §0.3) are cheap: pure-query MCP
tools, zero LLM cost, sub-millisecond. There is no scenario where
skipping them is a net win. Even when the request feels small, the
classifier returns `tier: trivial` and tells you to skip the rest —
**the classifier IS the bypass; you don't bypass it manually**.

If `rsct-mcp` is not installed (any `mcp__rsct__rsct_*` call returns
"tool not found"), fall back to the §A–§H prose contract below and
explicitly mention to the dev that they should run `/rsct-setup`
and install `rsct-mcp` to enable the enforcement layer.
