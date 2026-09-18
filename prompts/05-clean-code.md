# RSCT Clean Code — 05-clean-code.md

You are operating inside a software project repository to run a **clean-code
sweep**: a read-only pass that surfaces **duplication / centralization**,
**scalability** risks, and **dependency hygiene** — then routes any change the
developer accepts through the normal RSCT cycle (R→S→V→C→T→REVIEW).

This command **never edits code or dependencies on its own**. It produces
findings, debates them with you, and — for the items you accept — hands off to
`rsct_classify_task` + the phase tools so the change goes through a real plan and
the §C gate. It writes **no files**.

**How this differs from the other review surfaces** (read this so the mental
model stays clean):
- **`/rsct-clean-code` (this command)** — a *pre-Research* sweep of **existing**
  code that *feeds a new cycle*. Nothing is under way yet.
- **The REVIEW phase** — a *post-Code* audit of a **diff** that lives *inside* an
  open cycle (correctness/security/regressions on what was just written).
- **`rsct_persona_review`** — a *stateless* consultative lens (focus areas +
  questions + anti-patterns), no phase, no state.

Read this entire file before executing any action.

---

## Absolute rules during this entire session

- **This command mutates nothing.** No `git commit`, no dependency install/update,
  no code edit. Every change is routed through §B (plan + explicit OK) — never
  applied here.
- **The sweep is read-only** — only reading and searching. Never run
  `npm update`, `mvn versions:use-latest`, `composer update`, or any command that
  changes the tree.
- **Findings are proposals, not verdicts.** Code may look "wrong" because of a
  **real business rule**. Debate each finding; never assume the code is a mistake.
- **Never name a "latest" dependency version.** You cannot verify a registry
  without network, and your training data is stale — asserting "X → Y" would be a
  guess. Report only what the manifests actually contain (see Phase 2, lens 3).
- When in doubt about anything: stop and ask.

---

## Phase 1 — Scope

Decide the sweep scope with the developer.

1. Gauge the size of the codebase (rough count of source files / modules). There
   is no magic threshold — use judgement:
   - **Small** project → sweep the whole tree.
   - **Larger** project → ask the developer **which modules** to sweep. If the
     project has `documentation/modules/` or `documentation/architecture.md`, use
     them to enumerate the candidate modules for the developer to choose from;
     otherwise (e.g. a repo without RSCT), enumerate by the repo's top-level
     source directories.
2. Record the chosen scope in chat before sweeping. This is a **stateless** run:
   there is no saved report; findings live in this conversation only. In a large
   sweep, prefer to close accepted items in **small batches** (route each through
   the cycle) rather than accumulating a long list that context compaction could
   drop.

---

## Phase 2 — Silent sweep (read-only)

Sweep the chosen scope with three lenses. Collect findings first; present in
Phase 3. **Every finding carries `file:line` evidence.** Use the available search
tools (grep/read) — do not embed heavy shell.

**Lens 1 — Duplication / centralization.** Several implementations of the same
thing (e.g. multiple number/date/currency formatters; copied validation; repeated
utilities). A candidate to centralize into one reusable unit. If a
`CONVENTIONS.md` exists at the project root, check the finding against the mold it
prescribes (§H).

**Lens 2 — Scalability.** Points that will not scale (an O(n²) loop on a hot path,
a query with no index/pagination, coupling that makes a foreseeable extension
hard). Advisory — a proposal for debate, not a defect.

**Lens 3 — Dependency hygiene (offline-verifiable only).** Read the manifests
present (`package.json`, `pom.xml`, `composer.json`, `requirements.txt`,
`go.mod`, …) and report **only what is verifiable without network**:
- an **inventory** of the pinned versions / ranges per manifest;
- **internal drift** — the same library pinned to *different* versions across
  manifests (fully offline, actionable);
- **loose ranges** — `*` / `latest` / an unpinned `^`/`~` with no lockfile, as a
  hygiene risk.

For each dependency worth revisiting, emit the literal marker **"confirm latest
against the registry — not verifiable offline"**. **Do not name a target version
and do not write "X → Y."** Nudging the developer to check the registry is the
deliverable; asserting the answer is not.

---

## Phase 3 — Present findings + debate

Present the findings grouped by lens. For **each** finding give:
1. **Evidence** — `file:line` (and a short snippet where it helps).
2. **Why it might be intentional** — your best hypothesis for a business rule or
   constraint that would justify the current shape.
3. **Proposed change** — what centralizing / refactoring / updating would look
   like, and the trade-off.

Then let the developer decide per finding: **keep** (intentional — leave it),
**refactor** (accept the change), or **defer** (later). This is a **dialogue**:
argue both sides honestly; do not push refactors.

---

## Phase 4 — Route accepted items into the cycle

For every item the developer accepts (**refactor**):

1. **Instruct / require** running `rsct_classify_task` for the change, then the
   phase tools (`rsct_phase_spec_start` → the plan → … → the §C gate on Code).
   The invocation itself cannot be *forced* by this prompt — what actually
   enforces the cycle in the target repo is **two mechanical gates**: the
   plan-tracking gate in `rsct_phase_code_start` (it rejects Code for
   `standard`/`complex` tasks when `plan_<slug>.md` + `progress_<slug>.md` are
   absent) and the **§C OS dialog** on commit / push / merge.
2. **This command writes nothing.** It only emits the hand-off. The
   `plan_/progress_/spec_` files for the refactor are created **afterward, by the
   normal §B cycle**, under that gate + your OK — not by `/rsct-clean-code`.
3. Route accepted items **one (or a small batch) at a time**, closing each through
   the cycle before moving on, so a long sweep does not pile up unrouted work.

**If RSCT is not installed in this repo** (the `rsct_*` tools are unavailable, or
there is no `.rsct.json` / no `rsct` entry in `.mcp.json`): fall back to the
prose-only §B discipline — present a plan with options and get explicit OK before
any edit (symmetric to the note at the top of the §B rule). The common case for
this command is precisely a repo *without* the framework, so detect and adapt.

---

## What this command does NOT do

- It does not edit code, bump dependencies, or commit.
- It does not write any file (no report artifact; findings are in chat).
- It does not decide *for* you — every change is your call, routed through §B.
- It does not remember prior runs — each sweep is fresh; items you marked "defer"
  will resurface next time (that is intentional, not a bug).
