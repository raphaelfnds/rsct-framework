# Command reference

RSCT installs five slash commands. Each is documented below with the same
structure: **purpose · when to use · preconditions · what it does · outputs ·
consent gates · re-run behavior · recovery.**

All five become available in *any* project on the machine after install +
an IDE restart. None of them push or commit to git on your behalf.

- [`/rsct-setup`](#rsct-setup) — set up or update project governance (the front door)
- [`/rsct-init-universe`](#rsct-init-universe) — bootstrap an org-level universe skeleton
- [`/rsct-canonical-source`](#rsct-canonical-source) — link a project to its universe
- [`/rsct-uninstall`](#rsct-uninstall) — reverse RSCT in a project
- [`/rsct-clean-code`](#rsct-clean-code) — sweep for duplication/scalability/dependency hygiene

---

## `/rsct-setup`

**Purpose.** Set up — or idempotently update — RSCT governance in the current
project. This is the **front door**: besides writing the local governance files,
it orchestrates the universe/topology onboarding (connect to an existing
universe, or offer to create one when it detects same-org sibling repos).

**When to use it.** In any app/project repo, the first time and on every later
re-run to pick up framework updates. **Do not run it inside a universe repo** —
a universe is governance infrastructure, not an app. `/rsct-setup` detects a
`.universe.json` in the repo and stops with that guidance (edit the universe's
files and commit them yourself; see [`/rsct-init-universe`](#rsct-init-universe)).

**Preconditions.** RSCT installed + IDE restarted. Git is recommended but not
required to start. If the project is linked to a universe, the universe is read
(never written) unless you explicitly consent to register this app.

**What it does (goal level).**
1. Discovers your stack and project facts (a handful of questions).
2. Presents a plan you must approve before any file is written.
3. Writes the governance artifacts (below).
4. If a universe is linked and this app is not yet registered, offers
   (consent-gated) to register it. If same-org sibling repos are detected and no
   universe exists, offers to create one. Confirms your repo topology
   (mono / monorepo / multi-repo).
5. In a confirmed **multi-repo** setup with **two or more registered apps**, it
   can guide you through declaring a **contract** — the framework asks the
   questions (producer, surface globs, consumers) and writes the entry into the
   universe's `contracts.json`; you review and commit the universe yourself. See
   [Multi-repo & contracts](multi-repo.md).

**Outputs (in this app repo).** `CLAUDE.md`, `documentation/`, `.rsct.json`,
memory entries under `.claude/projects/.../memory/`, and — if you opted into the
MCP companion — the SessionStart hook in `.claude/settings.local.json`. When a
universe is involved, registration writes into the **universe** repo's working
tree (an `applications/<app>/` README + the `registered_apps[]` index); it never
runs git there.

**Consent gates.** The plan must be approved before any write. Registering the
app into the universe, creating a universe, and writing a contract are each a
separate explicit opt-in (mutating another repo is never silent). Confirming the
topology is an explicit answer.

**Re-run behavior.** Idempotent. It compares content by SHA and only creates or
updates what changed; markers it already wrote are recognized, not duplicated.

**Recovery.** [`/rsct-uninstall`](#rsct-uninstall) reverses everything it wrote,
SHA256-protecting any file you edited by hand.

---

## `/rsct-init-universe`

**Purpose.** Bootstrap a new **org-level universe** repository — the skeleton
that holds organization-wide governance: naming standards, the canonical-sources
map, the `applications/` registry, and the `contracts.json` graph.

**When to use it.** Once per organization, when no universe exists yet. Run it in
the directory where the universe repo should live (it creates the skeleton there).
`/rsct-setup` and `/rsct-canonical-source` will offer to invoke it for you when
they detect you need a universe but don't have one.

**Preconditions.** RSCT installed + IDE restarted.

**What it does.** Creates a skeleton universe: `.universe.json` (the marker that
defines a repo as a universe — carries the org, the universe name, and an
initially empty `registered_apps[]` index), `docs/governance/` (naming
standards, retention, etc.), `docs/diagrams/` placeholders, an empty
`applications/` registry, `hosts/`, and an empty **`contracts.json`** template.
Everything is a skeleton with TODO placeholders — you fill the content as the
organization grows.

**Outputs.** A new universe repository (folders + template files). It is a
*skeleton*: no app is registered and no contract is declared yet. You own the
content and the commits.

**Consent gates.** It only creates files in the target universe directory. It
never touches an app repo and never runs git.

**Re-run behavior.** Existing files are left untouched (skip-if-exists); absent
skeleton files are recreated. It does not overwrite hand-edited governance.

**Recovery.** The universe is an ordinary git repo you own — revert with git.

---

## `/rsct-canonical-source`

**Purpose.** Link **this** project to its organization's universe — declaring the
universe as the *canonical architectural source* (the org's source of truth for
architecture and standards, which the agent treats as authoritative over local
guesses).

**When to use it.** In an app repo, after a universe exists, to connect the two.
After linking, `/rsct-setup` can register the app and the runtime tools surface
the universe.

**Preconditions.** RSCT installed + IDE restarted. A universe should exist; if
none is found locally or remotely, this command offers to create one
(invoking [`/rsct-init-universe`](#rsct-init-universe)), let you provide a path,
or record a remote-only reference.

**What it does.** Adds a `## Canonical architectural source` section to this
repo's `CLAUDE.md` pointing at the universe, and records the link in `.rsct.json`
(the `universe` block + `canonical_source_added`).

**Outputs (in this app repo).** The `CLAUDE.md` section + the `.rsct.json`
universe link. It does not write to the universe repo.

**Consent gates.** Edits only this repo's `CLAUDE.md` + `.rsct.json`. If it needs
to create a universe, that is a separate explicit choice.

**Re-run behavior.** Idempotent — recognizes the marker it wrote and updates in
place rather than duplicating the section.

**Recovery.** [`/rsct-uninstall`](#rsct-uninstall) removes the canonical-source
section and the link.

---

## `/rsct-uninstall`

**Purpose.** Reverse what `/rsct-setup` (and `/rsct-canonical-source`) created or
modified in **this** project — cleanly, without clobbering your own edits.

**When to use it.** To remove RSCT from a project, in full or selectively.

**Preconditions.** The project was set up by a marker-aware RSCT version
(1.0.0+). Legacy pre-marker installs cannot be auto-reversed and the command will
say so.

**What it does.** Excises each RSCT artifact by its marker. For generated files
it computes the current body SHA256: an unchanged file is safely deleted; a file
you edited is **preserved** (it asks rather than deleting your work). Supports a
**full** uninstall and **selective scopes** (for example memory-only, specific
rules, docs-only).

**Outputs.** The RSCT-added content is removed from this repo; your hand-edited
files are kept. The pre-setup git SHA recorded in `.rsct.json` is the backup —
no separate backup files are created.

**Consent gates.** Acts only on this repo. It removes the project-scope `.mcp.json`
`rsct` entry by key (preserving any other servers) when present.

**Re-run behavior.** Safe to re-run; already-removed artifacts are skipped.

**Recovery.** Restore from git (the pre-setup SHA, or your branch history). This
command never pushes.

---

## `/rsct-clean-code`

**Purpose.** Run a **clean-code sweep** over existing code: surface **duplication
/ centralization**, **scalability** risks, and **dependency hygiene**, then route
any change you accept through the normal RSCT cycle. It is the on-demand
counterpart to the cleanliness lens that §B already applies inline during
planning. It writes nothing and edits nothing on its own.

**How it differs from the other review surfaces.** `/rsct-clean-code` is a
*pre-Research* sweep of **existing** code that feeds a **new** cycle. The **REVIEW
phase** is a *post-Code* audit of a **diff inside** an open cycle.
`rsct_persona_review` is a *stateless* consultative lens (focus areas + questions
+ anti-patterns). Three distinct tools; this one is the "should we open a cycle to
clean this up?" entry point.

**When to use it.** In any repo, when you want a structured pass for duplication,
scalability, or stale/loose dependencies — before committing to a refactor. Works
whether or not RSCT is installed in the target repo (it falls back to the
prose-only §B discipline when the `rsct_*` tools are absent).

**Preconditions.** None hard. If the MCP companion is installed, accepted findings
are routed through the phase tools + the §C gate; if not, they are routed through
the prose §B plan (options + explicit OK).

**What it does.** (1) Agrees the scope with you (whole repo if small; otherwise
which modules). (2) Sweeps read-only across three lenses, each finding carrying
`file:line` evidence. (3) Presents findings and **debates** each — code may be the
way it is for a real business rule — so you decide **keep / refactor / defer**.
(4) For accepted items, hands off to `rsct_classify_task` + the phase tools (or
the prose §B plan) so the change goes through a real cycle. Dependency findings
report only what is verifiable offline (inventory, internal version drift, loose
ranges) and **never assert a "latest" target version**.

**Outputs.** Findings **in chat only** — there is no report file. The concrete
output is the set of accepted items, each routed into its own §B cycle (which then
creates the usual `plan_/progress_/spec_` — this command does not).

**Consent gates.** It **never mutates** anything: no edit, no dependency update, no
commit. Every accepted change is applied only later, through §B + your explicit OK
(and the §C dialog when the companion is installed).

**Re-run behavior.** Stateless — each run is a fresh sweep. Items you marked
**defer** will resurface next time; that is intentional, not a duplicate.

**Recovery.** N/A — nothing is written, so there is nothing to undo. Any change you
*routed* through the cycle is recovered like any other edit (git, or
[`/rsct-uninstall`](#rsct-uninstall) for RSCT-added artifacts).

---

See also: [Getting started](getting-started.md) ·
[Multi-repo & contracts](multi-repo.md) · [Troubleshooting](troubleshooting.md).
