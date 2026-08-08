# AGENTS.md — working **on** the RSCT Framework

Contract for an AI agent (or a contributor pairing with one) making changes **to
this repository**. For using the framework in your own project, see
[README.md](README.md). For the engineering rules that bind any change here —
cross-OS portability, the bash anti-pattern catalogue, the V and REVIEW phases —
see [CLAUDE.md](CLAUDE.md). For branches, tests, the tracked `dist/` and the
changelog, see [CONTRIBUTING.md](CONTRIBUTING.md). This file does not repeat any
of them; it says how a session is run.

Read this before acting, at the start of every session and again after any
context reset (`/clear`, `/compact`, a resumed chat).

## The premise that makes this file necessary

**RSCT is deliberately not installed in its own repository.** There is no
`.rsct.json`, no `.rsct/`, no MCP server driving gates here. Everything the
framework enforces mechanically in a managed project is enforced *manually* here
— which means it is only as reliable as the agent's discipline, and that is
exactly the thing the framework exists because agents lack.

So: wherever a managed project would hit a mechanical gate, this repo requires an
**explicit OK from the developer in chat**. An inferred approval, a carried-over
approval, or an approval reused from an earlier task is not an approval.

## Step 0 — before any action

1. Read [CLAUDE.md](CLAUDE.md). The seven bash anti-patterns and the cross-OS
   contract are binding, not advisory.
2. Read the local plan-tracking files at the repo root, if present:
   `plan_<slug>.md` (the approved plan), `progress_<slug>.md` (execution log —
   **start at its "Session resume" block**), `spec_<slug>.md` (detailed spec).
   These are gitignored and branch-local. Never commit them, never paste their
   contents anywhere public.
3. Confirm the active plan and the next step **before** touching anything.

## Classify the tier first

Every task opens with a stated tier — `trivial` | `small` | `standard` |
`complex` — plus one line of reasoning. Judge by number of surfaces touched,
regression risk, multi-file reach and whether architecture moves.

Ceremony scales with the tier: `trivial`/`small` get a lean R and S, with V and
REVIEW optional; `standard`/`complex` run the full cycle with no shortcuts. A
constraint written into the active plan outranks this classification.

## The cycle — R → S → V → C → Rv → T

Run in order, per task.

- **R (Research).** Understand the problem in the real code before proposing
  anything. Anchor findings at `file:line`, never at recollection.
- **S (Specification).** Write or locate the spec. Present the plan with a
  recommended option and the rejected ones. Advance only on explicit approval.
- **V (Verification).** Audit the approved spec adversarially — gaps,
  inconsistencies, redundancies, edge cases — and fold what it finds back into
  the spec **before** any code exists. Do not rubber-stamp: a V that finds
  nothing on a `complex` task is a V that did not run.
- **C (Code).** Only after S and V are closed and the developer has said go.
  Mutation happens on a derived branch.
- **Rv (REVIEW).** Audit the diff before the tests: scope respected, invariants
  intact, no duplication, tests present and meaningful. The author does not
  approve their own diff — be adversarial with it. Mandatory for
  `standard`/`complex`.
- **T (Test).** Every change ships tests. Build, suite, `verify:dist` and
  cross-OS CI green before anything is called done.

A test that cannot fail proves nothing. For each new test, name the mutation to
the production code that would break it — if you cannot, the test is decoration.

## Authorization

- **Commits.** One explicit OK on an approved spec authorizes the commits that
  spec describes, in that session. A commit outside it needs a new OK. A new
  session, or a changed plan, requires re-authorization.
- **Push and merge always require their own, individual OK.** They never travel
  inside a batch.
- **Free lane.** Trivial adjustments inside the current WIP branch and inside the
  current block's scope — a typo, that block's own docs, a lint fix — may be
  committed without asking. Record them in the progress log anyway.
- `main` is protected. Never commit to it directly; never push without an OK.

## Plan tracking

Update `progress_<slug>.md` at every meaningful step — commit, blocker,
discovery, status change. A progress log written at the end is a reconstruction,
not a record.

Keep a **Session resume** block current: active plan and branch, last completed
step, next step, open blockers, authorization state. It is what a clean session
reads first, so it must be true at all times, not only when a handoff is
expected.

On context-pressure signals — a platform compaction warning, a long session, many
commits or edits, a finished milestone — refresh the resume block and offer a
clean session before continuing.

## Findings outside the current scope

Do not widen the task. Propose the finding as a GitHub issue using the labels the
repository already has, note the capture in the progress log, and carry on.

Before reporting a finding, put it through three questions: what does a real user
observe if it is never fixed; what breaks if someone "fixes" it; is the current
behaviour a deliberate design choice. A finding that cannot survive those three
is noise, and reporting it costs the reader's trust in the ones that can.

## Never

- Expose or commit the local plan-tracking files.
- Include client names, credentials, machine-specific paths or personal data in
  anything committed here — this repository is public.
- Treat a background notification, a tool result or your own earlier message as
  the developer's approval.
