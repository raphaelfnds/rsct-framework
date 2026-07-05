# Changelog

All notable changes to the RSCT Framework are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Stable.** `v1.0.0` was the first stable, open-source release of the RSCT
> Framework. The framework **release version** (the prompts/rules set plus the
> `rsct-mcp` code) bumps per release; the embedded **marker schema id** (`v=1.0.0`)
> is a separate, frozen axis — it keys marker idempotency and changes only when the
> marker *format* does, not on every release. New changes are recorded under
> **[Unreleased]** until the next tagged release.

## [2.1.0] - 2026-07-05

Flow-hardening release (the `flow-lock` track): promotes several prose-only
disciplines into mechanical MCP gates and adds a clean-code command — without new
OS popups and without new tools (**37 tools, unchanged**). The product version
moves to **2.1.0**; the marker **schema id stays at `v=1.0.0`** (frozen — format
unchanged). Backward-compatible.

### Added

- **Pre-integration hygiene gate — `pre_merge_ack` (PH-5).** `rsct_request_merge`
  (always) and `rsct_request_push` (only to a protected branch) now require a
  self-attested hygiene checklist (`plan_complete` / `adr_confirmed` /
  `issues_resolved`, with a `note` when ADRs/issues are attested), checked
  **before** the OS dialog — a missing/incomplete ack rejects **in chat, no new
  popup**. Honest by design: presence is a forcing function, not a substantive
  lock; the one behavioral lock is honoring a declared `false`. New reject kinds
  `pre_merge_ack_missing` / `pre_merge_ack_incomplete`.
- **Plan-tracking gate on the Code phase (PH-1).** `rsct_phase_code_start` refuses
  the Code phase for `standard`/`complex` tasks unless the plan is on disk
  (`plan_<slug>.md` + `progress_<slug>.md`, plus per-phase `spec_<slug>.md` for a
  multi-phase plan). New inputs `plan_slug` + `override_plan_tracking` (bypass is
  audit-logged); `trivial`/`small` skip it.
- **`/rsct-clean-code` command (PH-7).** A read-only, advisory sweep through three
  lenses — duplication/centralization, scalability, dependency hygiene (offline
  only) — that debates findings with the dev and never mutates on its own. The
  same duplication/centralization lens is folded into `/rsct-setup`'s §B Research.
- **Worktree-orchestration nudge (PH-3).** `rsct_classify_task` suggests, for a
  `complex` tier, running disjoint file-group phases in parallel via isolated
  `git worktree`s; the plan template gains a "Phases & parallelization" section
  and §B a worktree question for 3+-phase plans. Advisory — never auto-creates.
- **`/VERSION` single-source of the product version (PH-6, closes #7).** The repo
  root `/VERSION` file is the one hand-edited version; `mcp-server/src/lib/version.ts`,
  `package.json`, and `package-lock.json` are derived via `npm run sync-version`.

### Changed

- **Batch-commit token is now OFFERED at planning (PH-4).** After a **multi-phase**
  plan is approved, RSCT proactively suggests `rsct_plan_authorize` (marked
  Recommended for multi-phase runs); single-phase plans are not offered it. Clarified
  that the token auto-resets via branch scope / plan completion / TTL / budget.
- **Name-mismatch warnings broadened (PH-2).** `rsct_get_topology` now validates every
  contract **`consumer`** and this repo's own **`app.name`** against the registered
  apps (not just the `producer`), flagging case-only drift as a likely typo. Only the
  `producer` gates; the extra checks are warn-only.
- **`§C`/`§D`/`§H` prose** updated for the `pre_merge_ack` checklist (mechanics, the
  pre-integration hygiene checklist, and the ADR-confirmed rollup).
- **User docs synced** (README, `docs/`, `mcp-server/README.md`, CONTRIBUTING) to the
  above behaviors ahead of the release.

### Fixed

- **Cross-OS edit-scope matching (PH-1).** `rsct_check_edit_scope` now matches an
  absolute `file_path` against relative scope globs via normalized prefix-strip
  (was anchored `^…$` and silently never matched an absolute path).

## [2.0.0] - 2026-06-25

Multi-repo governance + a guided onboarding orchestrator + the mechanical REVIEW
phase. The product (release) version moves to **2.0.0**; the embedded marker
**schema id stays at `v=1.0.0`** (its format is unchanged, so existing installs
keep marker idempotency). The tool catalog grows **30 → 37**.

### Added

- **Repo topology detection (T2).** `lib/topology.ts` classifies a project as
  `mono` / `monorepo` / `multi-repo` — inferred from signals (nested app markers;
  registered-app count in an external universe) and **confirmed** by the dev at
  `/rsct-setup` (persisted to `.rsct.json` `topology.mode`). `rsct_get_topology`
  exposes the mode plus the org-level **contract graph**.
- **Contract-surface gate (T2 / INV-7).** In a confirmed **multi-repo** setup,
  `rsct_request_commit` blocks a commit in the **producer** repo that touches a
  declared surface (path globs in `contracts.json` at the universe root), listing
  the affected consumers, unless a per-action `override_contract_surface: { reason }`
  is given. Producer matching is exact and case-sensitive; consumer repos are never
  blocked by the gate; a plan-authorization token never bypasses it (hard block).
- **New MCP tools** for the universe/topology/onboarding surface:
  `rsct_get_universe`, `rsct_get_topology`, and `rsct_detect_onboarding` (the
  `/rsct-setup` onboarding orchestrator).
- **End-user documentation** under [`docs/`](docs/): a per-command manual, a
  getting-started/onboarding guide, a multi-repo & contracts guide, and a
  troubleshooting guide.
- **Mechanical REVIEW phase (DX-4).** A code review of the diff is now a
  first-class phase between Code and Test — the recommended cycle is
  **R→S→V→C→REVIEW→T**. It is opt-in and asked ONCE: pass `include_review` to
  `rsct_phase_spec_complete` to record the decision (keyed by `spec_ref`). For
  `spec_tier ∈ {standard, complex}`, `rsct_phase_test_start` enforces it —
  `decision=no` proceeds (review skipped), `decision=yes` requires a completed
  `rsct_phase_review_{start,complete}`, and no decision rejects; pass
  `override_review_skip=true` to bypass (audit-logged). trivial/small bypass the
  gate. Mirrors how the V audit sits between Spec and Code. New tools:
  `rsct_phase_review_start`, `rsct_phase_review_complete`.
- **Org-universe governance reads (T1c).** `rsct_get_universe` surfaces the linked
  universe's governance docs (`docs/governance/*.md`, `docs/INDEX.md`); a governance
  index also appears in `rsct_status` / `rsct_load_context`.
- **Plan-authorization batch tokens (T3).** `rsct_plan_authorize` / `rsct_plan_revoke`:
  one approval mints a plan- and branch-scoped token covering up to N commits
  (default 20) for a time window (default 120 min), so commits within an approved plan
  don't each stop for an OK. Commit-only (push/merge keep per-action §C); never bypasses
  branch protection, the secrets scan, or the contract gate; auto-revokes on branch
  switch / plan completion / expiry / exhaustion; per-git-worktree state.
- **Guided onboarding orchestrator (DX-1).** `/rsct-setup` becomes the single guided
  front door: a deterministic universe≠app guard (it stops if run inside a universe
  repo), same-org sibling-repo detection (`rsct_detect_onboarding`), and a guided offer
  to create or link an org universe.
- **Guided contract authoring (DX-1b).** In a confirmed multi-repo setup with ≥2
  registered apps, `/rsct-setup` can walk the producer through declaring a contract
  (producer, surface globs, consumers) and write it into the universe's `contracts.json`
  via an injection-safe additive splice. The create-universe decline is remembered
  (ask-once, persisted in `.rsct.json`).
- **Producer-name-mismatch warning (DX-5).** `rsct_get_topology` warns when a
  `contracts.json` `producer` matches no registered app — or matches only by case (a
  case-only typo the gate silently treats as unregistered, with the correctly-cased
  name suggested) — so a dead contract gate is caught proactively instead of silently
  never firing.

### Changed

- **Plain-language user-facing copy (DX-2 / DX-2b).** De-jargoned the MCP and prompt
  strings the developer actually sees: gate and decline reasons reworded (e.g.
  "§C rejected" → "Approval rejected"), and section-symbol (`§C`) + lock-state jargon
  removed from OS-dialog titles and hints. The project's user-facing language standard
  is English; `/rsct-setup` migrates legacy pt-BR `CLAUDE.md` sections on update.
- **Version model clarified (DX-5b).** The `v=1.0.0` carried by every RSCT marker is a
  **marker schema id** (frozen — it keys idempotency), distinct from the product
  release version; labels, docs, and install/uninstall comments reworded accordingly.
  The `v=1.0.0` token stays byte-identical.
- **Tool catalog grew to 37** (30 → 37 across the post-1.1.0 train: T1c universe reads,
  T2 topology + contract gate, T3 plan tokens, DX-1 onboarding detector, DX-4 REVIEW
  phase).

## [1.1.0] - 2026-06-18

Universe-aware runtime + a cross-OS **test foundation** for the prompt/install
bash. Protocol and code versions bump together to `1.1.0` (per the v1.0.0
versioning policy). The embedded RSCT **marker schema stays at `v=1.0.0`** — its
format is unchanged, so existing installs keep marker idempotency (a marker-version
bump would make `/rsct-setup` re-runs duplicate blocks in already-configured
projects).

### Added

- **Universe-aware `rsct_status` / `rsct_load_context` (T1.a).** The org-level
  universe (universe repo, `.universe.json`, `applications/` registry) was populated
  by `/rsct-canonical-source` but never read at runtime. A new `lib/universe.ts` —
  the single source both tools call, so they cannot drift — resolves the universe
  (configured path → candidate paths → none), reads it (dirs are the registry ground
  truth, JSON is the index), and surfaces an always-present `universe` block
  (`available`, `name`, `registered_apps_count`, `this_app_registered`, `note`) plus
  a registration hint. Fail-graceful: any universe problem degrades to
  `available:false` and never throws into session bootstrap. Three states
  distinguished — ok / configured-but-missing / degraded — with registry
  reconciliation notes. `rules/0-session-bootstrap.md` §0.1 documents consulting the
  universe governance when available.
- **Consent-gated app registration in `/rsct-setup` (T1.b).** A new Phase 4.8 acts
  on the "this app is not registered" hint: on an explicit opt-in (`[y/N]`), it
  renders `applications/<app>/README.md` from the universe template and appends the
  app to `.universe.json` `registered_apps[]` by **text-splice** (never a whole-file
  `JSON.parse`→`stringify`). It writes into the universe's **own** repo as working
  files only and **never** runs git there (the dev reviews and commits in the
  universe themselves); it never overwrites an existing app dir (reconciles the index
  instead). Self-contained: identity + universe path are read from the project's
  `.rsct.json`.
- **Test foundation for the bash surface (T0).** The prompt/install bash — where
  every historical CAP bug lived — had zero automated coverage. Three layers, all in
  the cross-OS CI matrix: (1) a **static bash lint** — `bash -n` over every prompt
  block + script, plus AP1–AP7 detectors for the CLAUDE.md anti-patterns, each with
  known-bad/known-good self-tests; (2) a **script-level sandbox smoke** — real
  install/uninstall into a throwaway `$HOME` (layout, idempotency, scrub); (3) a
  **curated prompt-block smoke** — runs self-contained mutation blocks (gitignore
  backfill, `.rsct.json` secrets merge, `.mcp.json` scrub, app registration) against
  fixtures, extracted by anchor so they never drift from the prompt. CI sets
  `RSCT_REQUIRE_BASH=1` so a runner without bash FAILS rather than silently skipping.
- **Non-interactive install mode.** `install.sh` / `uninstall-framework.sh` accept
  `RSCT_ASSUME_YES=1` / `--yes` / `-y` (answer prompts with defaults) and
  `RSCT_SKIP_MCP=1` / `--skip-mcp` (framework files only — no global `npm install -g`
  / `claude mcp add`). Interactive behavior is unchanged.
- **`.github/dependabot.yml`** — security-updates only (`open-pull-requests-limit: 0`);
  `esbuild` ignored (a build-time-only transitive dep that never ships — `dist/` is
  prebuilt).

### Fixed

- Apostrophes inside `node -e '...'` blocks in `01-setup.md` (Phase 4.4) and
  `03-uninstall.md` (Phase 4.V.a2) closed the single-quoted string and broke the
  command at runtime — surfaced by the new bash lint's `bash -n` gate. Reworded the
  offending comments/strings (no logic change). A new anti-pattern vector beyond the
  documented `\b`/escape case (CAP-20): apostrophes in JS comments/strings inside a
  single-quoted `node -e`.

## [1.0.0] - 2026-06-15

**First stable release.** Consolidates the entire pre-1.0 development effort
into a minimum-viable, dogfood-validated governance framework for AI-assisted
engineering: **M1 Recall**, **M2 Enforcement**, the **M3 R→S→V→C→T phase
machine**, **L3 personas**, the **Tutor**, **issue capture**, the bilingual
EN+pt-BR vocabulary, the content-SHA memory classifier, the prebuilt-`dist/`
toolchain-free install, and the full cross-OS correctness sweep (Windows /
WSL / Linux / macOS). The CAP-by-CAP record of how it was built follows below.

### Changed (v0.7.23 — CAP-57: ship prebuilt `dist/` + prebuilt-aware install (no build toolchain on user machines, `npm audit` clean))

`npm audit` flagged 2 high-severity advisories on `esbuild` during every
`install.sh` run. Both are **dev-only** (esbuild reaches the machine purely as a
transitive build dependency of `tsup`/`vitest`, never at runtime) and neither
vector applies here — but they appeared because the installer **built the MCP
server on the user's machine**, dragging the whole build toolchain (and its
audit noise) onto every install. CAP-57 moves the build to the maintainer side
and ships the compiled artifact, so users install only the 3 runtime deps.

- `mcp-server/dist/` is now **tracked** (`dist/index.js` +
  `dist/scripts/sanitize-permissions.js`). Sourcemaps (`dist/**/*.map`) stay
  gitignored — not used at runtime, ~620KB/release of avoidable git bloat.
- `scripts/install.sh` — the rsct-mcp install is now **prebuilt-aware**: when the
  shipped `dist/index.js` is present it runs `npm install -g .` only (runtime
  deps; the global install honors `package.json` `"files":["dist"]` and there is
  no `prepare` script, so it never builds) — `tsup`/`esbuild`/`vitest` never land
  on the user machine and `npm audit` stays clean. The **source-build fallback**
  (`npm install && npm run build && npm install -g .`) is preserved verbatim for
  dev checkouts with no prebuilt `dist/`. All three manual-command hints (skip /
  retry / no-Node) updated to the prebuilt-first form.
- `mcp-server/package.json` — new `verify:dist` script
  (`tsup && git diff --exit-code -- dist`): a maintainer-side guard that rebuilds
  and fails if the tracked artifact is stale. It runs in the **same environment**
  that produces the commit, so it is deterministic — sidestepping the cross-OS
  build-reproducibility false-positives that a CI-side compare would suffer.
- The shipped artifact is byte-identical to what users built locally before —
  only the **build location** changes (maintainer vs user). No runtime/behavioral
  change to the server; build + full test suite remain green.

#### Migration for existing contributor clones

End users are unaffected. A **contributor** whose clone predates CAP-57 has a
locally-built, previously **untracked** `mcp-server/dist/` on disk; because
`dist/` is now tracked, `git pull` may refuse with *"untracked working tree files
would be overwritten by merge"*. Resolve once, before pulling, with either:

```bash
# Option A — drop the local build; the pull brings the tracked one.
rm -rf mcp-server/dist && git pull

# Option B — if the pull already landed, reset dist/ to the tracked version.
git checkout -- mcp-server/dist
```

The sourcemaps (`mcp-server/dist/**/*.map`) remain gitignored, so they stay as
local untracked files and never conflict.

### Added (v0.7.22 — CAP-56: CLAUDE.md → CONVENTIONS.md top-level pointer + UPDATE backfill)

Closes the CAP-54 orphan gap: a project `CONVENTIONS.md` (CAP-54's Phase 4.7
scaffold) was reachable only via the in-section §B/§H references, which the
Phase 4.2 per-section classifier never re-syncs on a `present-en` CLAUDE.md — so
on an UPDATE install nothing at the **top** of CLAUDE.md pointed at it (CAP-56
incident, 2026-06-13). A managed top-level pointer block now makes the reference
first-class and self-healing on re-run.

- `doc-templates/CLAUDE.md.template` — new top-level `<!-- RSCT-CONVENTIONS-REF
  v=1.0.0 -->` block (between the intro and the first `---`): "if `CONVENTIONS.md`
  exists at the project root, consult it before writing new code", with the
  *how* vs *why/when* distinction and a §B/§H cross-reference. CREATE installs
  get it verbatim.
- `prompts/01-setup.md` Phase 4.2 **Step E** — idempotent additive backfill for
  UPDATE installs that predate the pointer. Node text-splice (not sed/awk) so the
  multi-line block inserts cleanly cross-OS and the existing file's EOL (CRLF/LF)
  is detected and preserved (anti-pattern #4); anchored on the RSCT_APP header
  line (managed by Step D, reliably present in UPDATE), with a `# CLAUDE.md`
  heading fallback. Marker-guarded → true no-op when the pointer is already there
  (so CREATE installs never double-insert) and on every subsequent re-run.
  Post-mutation sanity grep (regra-mãe #3; fixed-string, no `-i`+`-F`).
- `prompts/01-setup.md` Phase 4.7 — the scaffold offer is refined to a
  **single-line, opt-in** prompt with **no brainstorming/pre-fill**; the default
  is an empty skeleton the dev populates later (per the dogfood decision). Still
  non-destructive (never overwrites an existing `CONVENTIONS.md`).
- Smoke-tested (16 assertions): insertion after RSCT_APP (LF + CRLF), CRLF
  preservation, `# CLAUDE.md` fallback when no RSCT_APP, byte-identical no-op when
  the marker is present, and safe skip when no anchor exists.
- No `mcp-server` code change — prompt/template/docs only; build + suite remain
  green from CAP-55.

### Added (v0.7.21 — CAP-55: post-merge cleanup reminder (working branch + plan files), all GitHub merge methods)

Extends CAP-53. The post-completion cleanup reminder now also covers the
**working branch**, and the framework's notion of "merge" is made explicit:
it covers **all three GitHub PR methods** — merge commit, squash and merge,
rebase and merge.

- `rsct_request_merge` — the CAP-53 completion hint now suggests (optional, the
  dev's OK, never automated) **both** deleting the merged working branch
  (`input.source_branch`, local + remote) **and** the
  `plan_/progress_/spec_<slug>.md` files, gated on `isPlanComplete`. The hint and
  the tool description note the cleanup is identical after a GitHub PR merge by
  any strategy.
- **Architecture note:** squash/rebase PR merges run via `gh pr merge` / the web
  UI, **not** `rsct_request_merge`, so there is no tool hook at PR-merge time —
  the reminder for that path lives in the **plan-tracking memory** and **§D**:
  - `memory-templates/feedback_plan-tracking.md` — new "after a completed merge
    or PR" section: suggest deleting the working branch (local + remote) + the
    plan/progress/spec files, for **every** strategy (merge commit / squash /
    rebase, plus local `git merge`), only once the task is complete.
  - `rules/D-branch-protection.md` (§D) — clarifies that "merge" = any of
    GitHub's three PR methods (there is no fourth) and restates the
    completion-gated, optional, dev-OK cleanup of branch + tracking files.
- Tests: `request-merge.test.ts` +2 (branch-cleanup hint present when the plan is
  complete; absent otherwise). mcp-server build + full suite green.

### Added (v0.7.20 — CAP-53/54: §C plan-tracking reminders + project CONVENTIONS.md)

Two behavioral gaps observed across long dogfood sessions: the agent forgets to
keep plan-tracking current / clean it up, and there is no prescriptive home for
project coding conventions.

#### CAP-53 — plan-tracking reminders at the §C gate

The guidance to update `progress_*.md` and to keep `plan_*.md`/`spec_*.md` off
protected branches existed only in prose (rules/B §B item 6 + the
plan-tracking feedback memory) — nothing reinforced it mechanically, so it
depended on the agent's memory. Now the §C tools emit advisory **hints** (the
same channel as `bootstrap_warning`; never blocking):
- `rsct_request_commit` — when a branch-local plan/spec exists, reminds the
  agent to update `progress_<slug>.md` (and `plan_/spec_` if the plan changed).
- `rsct_request_push` / `_merge` — when the plan's `Status` is **complete**,
  SUGGESTS (optional, dev's OK, never automated) deleting
  `plan_/progress_/spec_<slug>.md` so they never land on a protected branch.
- `lib/plan.ts`: `findActivePlan` now detects the `spec_` alias too (was
  `plan_` only); new exported `isPlanComplete(status)` (EN + pt-BR completion
  words, `\b`-anchored so "incomplete" does not match).
- Tests: `plan.test.ts` (+7), request-commit hint coverage (+2).

#### CAP-54 — project CONVENTIONS.md (the prescriptive "how")

Clarifies a 3-way taxonomy and fills a real gap: there was no project-scope home
for **prescriptive coding conventions** (naming, schema/migration patterns,
identifier language, the mold for a new module) — only universe-scope
`naming-standards.md`, `decisions.md` firm premises, and the Senior Dev persona's
"code style" lens. So a fresh session naturally invented a root `CONVENTIONS.md`.
The framework now recognizes it as a first-class artifact:
- **Taxonomy (§H):** `decisions.md` = adopted choices (*why/when*, supersedable)
  × `anti-decisions.md` = tried-and-abandoned × **`CONVENTIONS.md`** = standing
  prescriptive rules (*how*, consulted before writing code; a convention often
  *derives* from an ADR).
- `doc-templates/CONVENTIONS.md.template` — generic skeleton (sections are
  prompts the dev fills); shipped to `~/.rsct/doc-templates/` by install.sh.
- `01-setup.md` **Phase 4.7** — **opt-in, non-destructive** scaffold: if
  `./CONVENTIONS.md` is absent, ASK the dev; only on yes, render the template
  (`[APP_NAME]`). Never overwrites an existing one. **Root-level, committable**
  (NOT gitignored, NO RSCT marker — dev-owned).
- Rules: §B item 5 ("consult `CONVENTIONS.md` before writing code; new code MUST
  conform; propose creating one if conventions emerge"), §0 step 4 (consult
  before code-phase edits).
- Uninstall: dev-owned — never touched.

#### Tested

- mcp-server: build clean + full suite (plan.test +7, request-commit +2).
- Smoke (Git Bash): Phase 4.7 scaffold (absent→render with `[APP_NAME]`,
  exists→skip, committable/not-gitignored); `findActivePlan` detects `spec_`;
  `isPlanComplete` for EN/pt-BR words and rejects "incomplete".

### Fixed (v0.7.19 — CAP-52: dogfood follow-up — Phase 4.6 loopified, sanitizer re-run churn, leak-scan noise, scope_mismatch guidance)

Two fresh-install dogfood reports (separate sessions) converged on the same
root cause for the memory phase, plus a few smaller items. Mostly
`prompts/01-setup.md`; one `mcp-server` tool-description change.

#### G1 (medium) — Phase 4.6 was not loopified like 4.5/4.5b

Phases 4.5/4.5b ship complete `while`/`for` loops ready to run literally, but
4.6 shipped only a **single-entry classifier** (`feedback_<name>.md` literal
placeholder) plus a prose action table. With no canonical loop over the 11
memory templates, the agent had to **hand-write the iteration** — which collides
with the prompt's own "execute literally / do NOT reimplement" mandate and is
exactly how the earlier `feedback_*.md.template` zero-match footgun arose (the
feedback templates carry **no** `.template` suffix; only `MEMORY.md.template`
does).

**Fix**: 4.6 now embeds a **canonical loop** that iterates
`~/.rsct/memory-templates/feedback_*.md`, classifies each entry (CREATE /
UPDATE / SKIP / PRESERVE by content-SHA) and **executes it inline** — same
writer/marker shape as 4.5. Null-glob-safe (`[ -f ]`), CRLF-normalized, and it
prints a summary. The prose action table is replaced by a one-paragraph
reference. Node-tested across all four states + idempotency + null-glob; the
loop never creates `MEMORY.md` (handled by its own additive-merge block).

#### G2 (low-medium) — sanitizer churned on every re-run

The `.rsct/scripts/sanitize-permissions.js` copy stamped a per-run `INSTALL_TS`
timestamp and rewrote **unconditionally**, so every re-run dirtied the file (a
1-line diff + a CRLF flip on autocrlf=true Windows) even when the rsct-mcp
version was identical (the F2 CAP-51 fix had missed this writer).

**Fix**: drop the per-run timestamp (drift detection keys off the `v=` version,
which stays; install time is already in git history / the audit log) and write
**only when the content differs** (CRLF-normalized compare). Smoke: same-version
re-run is byte-stable / skipped, a CRLF-on-disk copy is not rewritten, a version
bump rewrites.

#### #3 (low/cosmetic) — leak-scan false positives on framework artifacts

Phase 5's human-review leak scan flagged the framework's OWN generated content
(the §E/§H rules literally name "secret/token/jwt/cpf"; `.rsct.json` carries
`secrets_extra_patterns` var names by design), adding noise to review.

**Fix**: the untracked-file pass now skips files carrying the `RSCT-GENERATED`
marker and `.rsct.json`. Dev-authored files are NOT skipped, and the definitive
gate (`rsct_request_commit`'s INV-6 on the staged diff) still scans everything.

#### G3 (info) — `scope_mismatch` soft signal

A commit logged `fabrication_signals: ["scope_mismatch"]` (soft, non-blocking)
because the free-text `action_scope` did not reconcile with the staged diff.
Documented in the `rsct_request_commit` `dev_approval` description that
`action_scope`/`reason` should mirror the actual staged diff (files + branch) to
keep the signal clear.

#### Deferred

Standardizing the `memory-templates/` suffix (`feedback_*.md` vs
`MEMORY.md.template`) — flagged low by both reports — is left as-is: renaming
would touch install-copy, the loop glob, and uninstall, risking install-state
breakage for no functional gain. The convention is now documented inline in the
4.6 loop, and the loopification removes the footgun that the inconsistency fed.

### Fixed (v0.7.18 — CAP-51: field-report follow-up — secrets migration convergence, no-op write guards, discovery-spec tightening)

A second field report (Windows Git Bash + WSL UNC root + `core.autocrlf=true`)
flagged five real issues. All in `prompts/01-setup.md` (no mcp-server change;
version bumped for lockstep). Each fix is smoke-tested; the secrets change is
node-tested with the reporter's exact repro.

#### F1 (medium) — secrets migration never converged

CAP-50 migrated `secrets_extra_patterns[]` legacy shapes (`\bVAR\b`,
`VAR\s*[=:]\s*\S+`) to the canonical `=` form **only for vars rediscovered in
the current run** (`for (const v of vars)`). An entry whose var was not
re-derived that run — e.g. `VITE_PUSHER_APP_KEY` lives in `.rsct.json` but not in
`.env.example` — stayed in its old shape **forever**, leaving a permanently mixed
array that never converges across re-runs.

**Fix**: migrate **by shape**, independent of the run's `SENSITIVE_VARS`. A new
`legacyVarOf(pattern)` recognizes the two framework-generated shapes and returns
the var name to rewrite to `=`; dev-authored regexes (`^custom.*$`, `\.env`, …)
match neither shape and are preserved verbatim. The run's vars are then unioned
as before. Structured for **future scalability**: a later canonical change is one
more clause in `legacyVarOf`, not a rewrite. Node test (reporter's repro): a
`VITE_PUSHER_APP_KEY` orphan **not** in the run's vars migrates to `=` and the
array converges on the second run; dev custom + idempotency preserved.

#### F2 (low-medium) — no-op writes flipped CRLF→LF (phantom `M` in git status)

Two writes ran unconditionally even when the result was byte-identical: the
Phase 4.2 Step D `sed -i` on `CLAUDE.md` (when the header date was already today)
and the Phase 4.V.b `.rsct/scripts/package.json` write. On a Windows checkout
with `core.autocrlf=true` and no `.gitattributes`, rewriting flips CRLF→LF on
disk, so the file shows as **modified with an empty diff** — polluting review and
risking an accidental EOL-flip commit via `git add -A`.

**Fix**: guard both behind a content check. Step D skips the `sed` when the
header already carries `APPLIED_AT_DATE`; the `package.json` write fires only when
the file is absent or its CRLF-normalized content differs. Smoke: identical
(LF and CRLF) → skip, absent/differing → write.

#### F3 (low) — `SENSITIVE_VARS` selection was under-specified

Phase 1.8's "aggregate findings into a deduplicated list" left the secret/not-secret
call to agent judgment; a literal reading of the universal `^[A-Z_]+=` probe would
dump non-secret keys (`APP_NAME`, `APP_URL`, pagination/locale flags, …) into
`secrets_extra_patterns[]` (which then re-derive inconsistently — feeds F1). Added
an explicit **selection criterion**: include only names matching a credential
token (`secret|password|token|api[_-]?key|private|credential|cert|dsn|auth|…`) or
a dev-flagged name; exclude obviously non-secret uppercase config keys; ask when
unsure.

#### F4 (info) — single-shell assumption vs. tool-per-call harness

The prompt assumed a persistent shell, but Claude Code's Bash tool starts a fresh
shell per call, so the "single `APPLIED_AT` for the whole run" guarantee (and the
discovery vars) can diverge across phases on a fresh CREATE. Added a note to
capture `APPLIED_AT`/`APPLIED_AT_DATE` **once** and thread the literal value
forward (and to re-declare/forward every discovery var rather than relying on
shell persistence).

#### F5 (info) — Phase 5 bootstrap stamp with a freshly-migrated `.mcp.json`

The session's MCP server still runs the pre-migration config, so on WSL-from-Windows
a bare `rsct_status` in Phase 5 step 3 may resolve `C:\Windows` /
`rsct_installed: false`. Documented that `project_root` must be passed explicitly
to that call until Claude Code is restarted and the server reloads the `.mcp.json`.

### Fixed (v0.7.17 — CAP-50: audit follow-up — macOS BRE grep, secrets prose false-positive, uninstall/scope-switch orphans, path hardening, doc accuracy)

An audit-level multi-agent sweep (7 dimensions, adversarially verified) of the
CAP-36..49 work surfaced a batch of real issues. Each fix below is smoke-tested
cross-OS / unit-tested; mcp-server stays green.

#### High

- **macOS silent failure in the RSCT_APP header rotation** ([01-setup.md:773,785]).
  The Phase 4.2 Step D guard greps used BRE `[[:space:]]\+` — but `\+` is a GNU
  extension that BSD grep (macOS) treats as a literal `+`, so the guard never
  matched and the header date rotation was skipped silently on macOS
  (anti-pattern #2). Fixed to POSIX `[[:space:]][[:space:]]*`. `-E` is **not** an
  option here — the marker's literal `|` would become ERE alternation. A class
  sweep confirmed these were the only two `grep \+` occurrences in the prompts.
- **Secrets pattern still matched documentation prose** (audit F5). CAP-42's
  `<VAR>\s*[=:]\s*\S+` still fired on `APP_KEY: a chave` (the `:` form is
  ambiguous — YAML assignment vs a doc label). CAP-50 narrows to **`=` only**
  (`<VAR>\s*=\s*\S+`): unambiguous, and `.env`/`*.properties` (the files
  SENSITIVE_VARS is discovered from) use `=`. Real secret VALUES in `:`/YAML are
  still caught by `lib/secrets.ts` value-shape + generic key-name patterns. The
  Phase 4.4 generator now migrates **both** legacy forms (`\bVAR\b` and
  `VAR\s*[=:]\s*\S+`) to the `=` form so re-runs converge. Smoke: `APP_KEY=v`
  matches, `APP_KEY: a chave` does NOT, migration + idempotency verified.

#### Medium

- **Uninstall left `.claude/settings.json` as `{}`** (audit F2). The SessionStart
  hook scrub (03-uninstall.md Phase 4.V.a) always rewrote the file even when it
  became empty. Now it deletes the file when nothing remains — mirroring the
  `.mcp.json` scrub (4.V.a2). Only fires when install created it solely for the
  hook.
- **Orphan `.mcp.json` on a scope switch** (audit #3). When a dev who set up
  project-scope later re-runs `/rsct-setup` with user/skip scope, Phase 4.V.c2
  now **warns** that a committed `.mcp.json` registers rsct — without touching it
  (it is shared via git; removing it would break the team — use `/rsct-uninstall`).
- **`resolveProjectRoot` path hardening** (audit F4/F6/F14). `sanitizeRoot` now
  rejects whitespace-only values (`trim()`) and **relative paths** (the schema
  promises an absolute path; a relative one would silently resolve against the
  server cwd, e.g. `C:\Windows` on WSL), each with a one-time stderr warning.
  +3 unit tests (relative rejected, whitespace rejected, diagnostic once).
- **CLAUDE_PROJECT_DIR observability** (audit F13). The server now emits a
  one-time stderr diagnostic when it resolves the root from `CLAUDE_PROJECT_DIR`,
  so a WSL developer can confirm which detection path fired.
- **CHANGELOG CAP-48 entry was misleading after CAP-49** (audit F4/F8/F9/F17 —
  one issue, four finder hits). The CAP-48 entry called the
  `["--project-root", "${workspaceFolder}"]` form "corrected" / "portable" and
  `args: []` "not safe" — the opposite of what CAP-49 proved. Added a prominent
  *Superseded by CAP-49* banner + fixed the "corrected `args`" line.
- **README falsely called the version a git "tag"** (audit F3). The `v0.7.x`
  versions are committed/merged to `main` but **not git-tagged** (last real tag:
  `v0.7.12-cap35`). Reworded "latest tag" / "current shipped state" to say
  "current `main` state … not yet git-tagged". (Per owner: tags are created only
  on explicit request.)

#### Deferred (needs owner decision)

- **CLAUDE.md anti-pattern #5** only lists `.claude/settings.json` as the
  `JSON.parse→stringify` structured-merge exception; the `.mcp.json` CAP-48/49/50
  operations are the same approved exception but not yet listed there. Editing
  CLAUDE.md requires explicit owner authorization (per its own edit rule), so
  this is pending an OK.

#### Re-triaged out (audit noise)

The sweep confirmed 17 raw findings (0 rejected by its own verifiers), but
re-triage dropped: extracting the prompt node-blocks into tested TS modules (a
large refactor against the bash-in-markdown design), a CAP-8 numbering-gap note
(normal), and a stale-detection miss for `--project-root=value` (a form the
framework never generates; `${` is already caught).

#### Tested

- Smoke (Git Bash): portable RSCT_APP grep matches + rotates; secrets `=`-only
  matches assignments, not prose, with dual-form migration + idempotency.
- mcp-server: `project-root.test.ts` +3 (23 in file); full suite green; build clean.

### Fixed (v0.7.16 — CAP-49: `${workspaceFolder}` in the generated `.mcp.json` broke project-root detection)

A field report on WSL-from-Windows: `rsct_status` / `rsct_load_context` returned
`rsct_installed: false` with `project.root: "C:\\Windows\\${workspaceFolder}"`,
and an explicit `project_root` tool argument was ignored. Two symptoms, **one
cause — introduced by CAP-48**: the `.mcp.json` it generated carried
`args: ["--project-root", "${workspaceFolder}"]`.

**Root cause.** Claude Code does **not** expand `${workspaceFolder}` in
`.mcp.json` args — the server received the literal string. `readOverrideRoot()`
returned it, `resolveProjectRoot` ran `path.resolve("${workspaceFolder}")`
against the process cwd (`C:\Windows`, because Windows rejects a UNC cwd when the
Node server is launched against a `//wsl.localhost/...` project) → the bogus
`C:\Windows\${workspaceFolder}` with no `.rsct.json`. And because the launch
override is evaluated **before** the `startDir`, the explicit `project_root`
argument was discarded. This broke the CAP-48 `.mcp.json` for **every** user
(any project, not only WSL): `resolve("${workspaceFolder}")` never lands on a
real root.

#### Part A — `.mcp.json` uses `args: []` (the form `claude mcp add` actually writes)

- Phase 4.V.c2 now writes `{ "command": "rsct-mcp", "args": [] }` — no path, no
  placeholder. The server auto-detects the root. It also **migrates** a stale
  CAP-48 entry whose args still carry `${...}` / `--project-root` back to
  `args: []` (idempotency was by key, so a re-run would otherwise never fix the
  committed file). `README` + `mcp-server/README` corrected (the README example
  was the original source of the wrong `args`), plus a **Team onboarding** note
  (the committed `.mcp.json` shares the *registration*, not the *binary* —
  every teammate still installs `rsct-mcp`; only the owner runs `/rsct-setup`).

#### Part B — `resolveProjectRoot` hardening (`mcp-server/src/lib/project-root.ts`)

New precedence, highest first, with a placeholder guard at every source:

1. `input.project_root` (explicit tool arg) — now wins over the launch override
   (the schema promised "overrides detection"; previously the launch arg won → Bug 2).
2. launch override (`--project-root` / `RSCT_PROJECT_ROOT`).
3. **`CLAUDE_PROJECT_DIR`** (set by Claude Code) — the walk start; this is what
   lets the server find the project on WSL-from-Windows despite the `C:\Windows` cwd.
4. `process.cwd()`.

`sanitizeRoot()` rejects any source value containing an unsubstituted `${...}`
(one-time stderr warning per source) instead of resolving it against the cwd —
so even a not-yet-migrated `.mcp.json` no longer yields a false negative.

#### Tested

- `project-root.test.ts`: +5 cases (explicit-over-override precedence,
  placeholder override ignored → `CLAUDE_PROJECT_DIR` fallback, placeholder
  explicit ignored → override, `CLAUDE_PROJECT_DIR` as walk start, warn-once).
  **20/20** in the file; full suite **504/504**. The 499 prior tests are
  unchanged — they exercise the override-as-direct-root contract, which is preserved.
- `.mcp.json` merge/migration smoke (5 scenarios): create `args:[]`, idempotent,
  migrate a `${workspaceFolder}` entry to `args:[]` while preserving a dev's
  other server and the `command`, re-run no-op.

**Boundary.** B2 resolves WSL auto-detection only if Claude Code exposes
`CLAUDE_PROJECT_DIR` to the MCP server process (it does for hooks; unverified for
MCP servers). If it does not, the reliable path on WSL remains passing
`project_root` explicitly — which Part A re-enables.

### Added (v0.7.15 — CAP-48: project-scope MCP registration materialized as a committable `.mcp.json`)

> **⚠ Superseded in part by CAP-49 (v0.7.16) and audit F5 (CAP-50).** The text
> below documents the `.mcp.json` `args: ["--project-root", "${workspaceFolder}"]`
> form and argues `args: []` is "not safe". That reasoning was **wrong**: Claude
> Code does not expand `${workspaceFolder}`, so the form broke project-root
> detection for every user. CAP-49 reverted it to `args: []`. Read the CAP-49
> entry above for the correct behavior; the text below is kept as the historical
> record of what CAP-48 shipped.

Closes the field-report E1 gap end-to-end. Until now, choosing **[2] Project
scope** in `scripts/install.sh` only printed instructions — the dev had to run
`claude mcp add rsct rsct-mcp --scope project` by hand in every project. CAP-47
added warnings; CAP-48 makes it actually happen, versioned in the project for
team sharing.

**Design.** `install.sh` runs in the framework dir (it does not know the target
project), so it cannot create the project `.mcp.json` itself. Instead the
installer **records the choice** and `/rsct-setup` (which runs in the project)
**materializes** it:

```
install.sh [2]  ──>  ~/.rsct/mcp-scope = "project"
/rsct-setup     ──>  creates/merges ./.mcp.json  (mcpServers.rsct)
/rsct-uninstall ──>  scrubs the rsct key from ./.mcp.json
```

**install.sh** — each scope branch now writes `~/.rsct/mcp-scope`
(`project` / `user` / `skip`). The [2] branch's message changed: `/rsct-setup`
will auto-create the committable `.mcp.json`; manual `claude mcp add` is now
optional. The CAP-47 user-scope-conflict warning and effective-scope report stay.

**01-setup.md — new Phase 4.V.c2.** Gated on `[ -n "$SANITIZER_SRC" ]` (rsct-mcp
available) AND `mcp-scope = project`. Structured merge (the documented exception,
like the settings.json hook) writes:

```json
{ "mcpServers": { "rsct": { "command": "rsct-mcp",
  "args": ["--project-root", "${workspaceFolder}"] } } }
```

`${workspaceFolder}` is **literal** (resolved by Claude Code per clone), so the
committed file is portable across every teammate's checkout path — confirmed
needed by the `resolveProjectRoot` precedence (cwd at MCP startup is
unreliable; `args: []` is not safe). Idempotent by the `rsct` key (JSON has no
comments — the server name IS the marker). Preserves any other `mcpServers` the
dev added. Created even when a user-scope registration exists locally (the
`.mcp.json` is for teammates who clone). The flag read is `[ -f ]`-guarded and
CRLF-tolerant (`tr -d '\r'`). The forward-looking `.mcp.json` marker note in
Phase 4.4b is updated to reflect that setup now edits the file.

**03-uninstall.md — new Phase 4.V.a2.** Inside the Category-E-gated Phase 4.V,
scrubs `mcpServers.rsct` **by key**, preserving the dev's other servers; removes
`.mcp.json` if it held only rsct; no-op when absent / malformed / already clean.

**Not gitignored.** The RSCT `.gitignore` block (Phase 4.4b) does not list
`.mcp.json`, so it stays trackable/committable (the framework repo's own
`.gitignore` ignores its dev `.mcp.json` — that is the repo, not a target project).

**README** "Project scope detail" rewritten for the auto-create flow and the
`args` form `["--project-root", "${workspaceFolder}"]` — **later reverted to
`[]` by CAP-49** (see the banner at the top of this entry).

#### Tested

- **Merge/scrub prototype** (8 scenarios, exact-byte seeds): create-when-absent,
  idempotent re-run, preserve a dev server `foo` while adding rsct, scrub removes
  rsct keeping foo, scrub removes the file when only rsct, no-op on absent,
  no-op on malformed, keep file when other top-level keys remain.
- **Flag gate** (6 scenarios): `project`+sanitizer → create; re-run → no-op;
  `user`/absent → skip; no sanitizer → skip; CRLF flag → still create; output is
  valid JSON.
- `bash -n scripts/install.sh`; mcp-server build + 499/499 tests (version bump
  lockstep — no TS logic change).

**Boundary.** Setup does NOT invoke `claude mcp add` during the session (direct
structured write is deterministic and CLI-independent). Each teammate still needs
`rsct-mcp` installed (binary on PATH) for the committed `.mcp.json` to connect.

### Fixed (v0.7.14 — CAP-42..47: WSL2-from-Windows field-report follow-up — secrets-pattern false positives, destructive CLAUDE.md UPDATE, bootstrap marker, untracked leak-scan, autocrlf doc, MCP scope)

The C/D/E categories of the same field report (v0.7.13 shipped A+B). These
are robustness, UX, and one design fix. Touches `prompts/01-setup.md`,
`scripts/install.sh`, and `README.md` — no mcp-server TypeScript change
(version bumped for lockstep only). Each bash/logic change smoke-tested in
MINGW64 Git Bash; mcp-server 499/499 still pass.

#### CAP-42 (C1) — `secrets_extra_patterns` fired on prose mentions of the var name

Phase 4.4 generated one regex per `SENSITIVE_VARS` entry as a bare
word-boundary `\b<VAR>\b`. Applied by `scanDiffForSecrets` as an
extra-pattern, that matches the variable NAME **anywhere** in an added
line — including the §E security note that merely *lists* which vars to
watch. Committing the framework's own security doc then tripped
`rsct_request_commit`'s INV-6 and forced the dev to override the block.

**Fix**: generate an assignment-context regex `<VAR>\s*[=:]\s*\S+` (fires
only on an actual `VAR=value` / `VAR: value`, not a prose mention).
Backslashes built via `String.fromCharCode(92)` (anti-pattern #4 / CAP-20).
Re-runs **migrate** any legacy `\b<VAR>\b` entry this run regenerates to the
assignment form (so the array converges instead of carrying both), while
leaving dev-authored patterns — and the CAP-20 corruption cure — untouched.
Smoke (self-contained, exact-byte seed): `APP_KEY=base64:...` matches, the
prose `monitore a variavel APP_KEY` does NOT, custom `^custom-.*$` survives,
a corrupted `\\bOLDVAR\\b` is cured, and the second run is a byte-stable no-op.

#### CAP-43 (C2) — "bootstrap not detected" warned on the first commit after setup

`/rsct-setup` never called `rsct_status`/`rsct_load_context`, so
`.rsct/phase-state.json` landed without a `bootstrap_at` stamp
(`stampBootstrapMarker`, CAP-31). The very first `rsct_request_commit` /
`_push` / `_merge` then warned "bootstrap not detected" even though setup
had just run.

**Fix**: Phase 5 now instructs the agent to call `rsct_status` once at the
end of setup (when `rsct-mcp` is installed), stamping the marker and
silencing the spurious warning.

#### CAP-44 (C3) — Phase 5 leak-scan missed untracked (just-created) files

The review used `git diff | grep`, which never sees files setup just
**created** (`documentation/`, `.rsct.json`, memory entries, the sanitizer)
— they are untracked until `git add`. In practice only
`rsct_request_commit`'s staged-diff INV-6 caught those at commit time.

**Fix**: scan tracked diff **and** untracked files
(`git ls-files --others --exclude-standard`, `grep -I` to skip binaries).
`-iE` is used (not the `-i`+`-F` combo that SIGABRTs on Git Bash grep 3.0 —
CLAUDE.md anti-pattern #7). Smoke: catches a tracked `DB_PASSWORD` and an
untracked `API_KEY`, ignores a clean file.

#### CAP-45 (C4) — `LF will be replaced by CRLF` warnings undocumented

On Windows `autocrlf=true`, git warns on every generated artifact. It is
harmless (every framework SHA strips `\r` first, so idempotency holds), but
was undocumented.

**Fix**: README section explaining the warning is benign and offering an
optional project-root `.gitattributes` (`eol=lf` for the RSCT artifacts) to
silence it. `/rsct-setup` does NOT write it — it won't touch a dev-owned file.

#### CAP-46 (D1) — destructive CLAUDE.md UPDATE replaced rich PT-BR sections silently

Phase 4.2 Step A replaced each `present-ptbr` section wholesale with the
canonical `rules/` content. Those sections are the dev's ORIGINAL prose
(no RSCT marker, no SHA), so — unlike the documentation/memory classifiers
that PRESERVE dev edits — project-specific rules were discarded silently.

**Fix**: Step A now classifies each section as *equivalent* (safe to
replace) or *diverges* (carries project-specific clauses). On divergence the
agent **stops, shows a focused diff, and asks** — offering replace / keep-as-is
(wrap-only) / hand-merge — and defaults to NOT replacing. Recovery via
`git checkout $SETUP_COMMIT_SHA_BEFORE -- CLAUDE.md` is still documented.

#### CAP-47 (E1) — `install.sh` project-scope choice masked by a user-scope registration

Choosing `[2] Project scope` only printed instructions. If rsct was already
registered at **user** scope, it resolved in every project regardless — so
`claude mcp list` showed ✓ Connected and masked the chosen scope (the report:
"chose project but stayed global, no warning").

**Fix**: `[2]` now detects an existing user-scope registration (parse
`~/.claude.json` `mcpServers.rsct`, same method as the default branch) and
warns, pointing at `claude mcp remove rsct --scope user`. The install
summary also reports the **effective** user-level scope so the dev knows what
actually resolves.

### Fixed (v0.7.13 — CAP-36..41: WSL2-from-Windows field-report — `.rsct.json` render, write-failure guards, UNC paths, ESM sanitizer, encoded-path resolution)

A field report from a real install on **WSL2-accessed-from-Windows** (Claude
Code + framework + memory on the Windows side; the Laravel/Pest repo living in
the Ubuntu distro, reached over the UNC share `//wsl.localhost/Ubuntu/...`)
surfaced two confirmed output bugs and four portability gaps specific to that
split-filesystem topology. All six are in `prompts/01-setup.md` bash (no
TypeScript/mcp-server change); each was smoke-tested in the same MINGW64 Git
Bash that produced the report. The unifying cause across the gaps: the prompts
assume the project, `~/.rsct`, and `~/.claude` share one `$HOME`/filesystem —
which WSL2-from-Windows splits.

#### CAP-36 (A1) — `protected_branches` rendered invalid JSON

The `rsct.json.template` line carried the placeholder with **literal brackets**
(`"protected_branches": [PROTECTED_BRANCHES_JSON_ARRAY],`), and the Phase 4.4
render `sed -e "s|\[PROTECTED_BRANCHES_JSON_ARRAY\]|${PROTECTED_JSON}|g"`
matched (and consumed) those brackets — but `PROTECTED_JSON` was built without
any. Result: `"protected_branches": "main", "master",` — invalid JSON that
broke every downstream `JSON.parse`. The existing placeholder-sweep check did
not catch it (no `[PLACEHOLDER]` token survives — the values are just
malformed).

**Fix**: build the CSV inner first, then wrap once (`PROTECTED_JSON="[${INNER}]"`),
so the replacement supplies the brackets the sed consumed. Empty branch list →
`[]` (valid). Added a structural `node -e 'JSON.parse(...)'` sanity gate after
the placeholder sweep (skipped silently when no node runtime — rsct-mcp already
requires one). Smoke: `["main","master","test","dev"]`, single-branch, and
empty all render VALID; the pre-fix form reproduces INVALID.

#### CAP-37 (A2) — CREATE logged/counted even when the write failed

In Phases 4.5 / 4.5b / 4.V.b the pattern was
`mkdir -p ...; { printf ...; } > "$TARGET"; grep ...; echo CREATE; COUNT++`.
When `mkdir`/redirect failed (e.g. the CAP-38 UNC EROFS below), the post-write
`grep` returned non-zero on the missing file — the only `exit 1` guarded
placeholder leaks, not write failure — so `CREATE` was still printed and the
counter bumped. The report saw `CREATE=5` with 2 nonexistent files.

**Fix**: `|| { echo ERROR; exit 1; }` on both `mkdir` and the redirect, plus a
`[ -f "$TARGET" ]` existence gate before logging/counting. Applied to both CREATE
paths and the sanitizer copy; UPDATE redirects got the `||`-guard too. Smoke:
redirect into a directory path → guard fires, exit 7 (no false CREATE).

#### CAP-38 (B1) — `mkdir -p` aborts on the UNC root `//wsl.localhost`

`mkdir -p "$(pwd)/documentation/impact"` with `pwd=//wsl.localhost/Ubuntu/...`
makes `mkdir` walk components from `//wsl.localhost` (a read-only network mount)
and abort: `cannot create directory '//wsl.localhost': Read-only file system`.
This silently skipped creation of `documentation/{impact,tests,knowledge}/`,
`.rsct/scripts/`, and `.claude/`. Note the split from file writes: an *absolute*
UNC `> "$TARGET"` redirect works (MSYS maps it to the Windows `\\wsl.localhost\`
backend) — **only `mkdir -p` is UNC-hostile** because it tries to recreate the
mount root.

**Fix**: make only the `mkdir` calls relative (the cwd is already the project
root). Phases 4.5/4.5b use `mkdir -p "$(dirname "$TARGET_REL")"` (TARGET_REL is
already relative); the sanitizer/settings phases use `mkdir -p ".rsct/scripts"`
/ `mkdir -p ".claude"`. The absolute `TARGET`/`SETTINGS_PATH` used for the
write itself stays absolute (works over UNC). Smoke: relative nested `mkdir -p`
of `documentation/impact` succeeds.

#### CAP-39 (B3) — `npm root -g` returns a native Windows path used inside bash

In Phase 4.V.a, `npm root -g` on Windows returns `C:\Users\...\node_modules`
(backslashes), yielding mixed separators
(`C:\...\node_modules/rsct-mcp/dist/...`) downstream. It worked only by Git
Bash tolerance.

**Fix**: normalize with `cygpath -u` when present (`command -v cygpath`). On
Linux/macOS cygpath is absent, so the value is preserved unchanged — portable.
Smoke: `C:\Users\...\npm\node_modules` → `/c/Users/.../npm/node_modules`.

#### CAP-40 (B4) — ESM sanitizer copied into a possibly-CommonJS project

`dist/scripts/sanitize-permissions.js` is ESM (`import ... from 'fs'`). Copied
as a bare `.js` into `.rsct/scripts/`, Node resolves the module type from the
nearest `package.json` walking up — in a CommonJS project (Laravel/Vite root
with `"type":"commonjs"`, or no package.json), `.js` defaults to CommonJS and
the SessionStart hook throws *"Cannot use import statement outside a module"*.
The report saw exit 0 only because **Node 22.7+ auto-detects ESM syntax when
the type is *ambiguous*** — latent, version- and project-dependent.

**Fix**: write `.rsct/scripts/package.json` `{ "type": "module" }` alongside the
copy, pinning ESM regardless of host project module system or Node version.
Removed by the existing uninstall `rm -rf .rsct/scripts`. Smoke (forced root
`"type":"commonjs"`): without the local package.json → `import` fails; with it →
runs.

#### CAP-41 (B2) — `PROJECT_ENCODED` resolution for UNC/WSL + `grep -iF` crash

On WSL2-from-Windows the project root is a driveless UNC path, and the Phase 1.7
encoding (built around `pwd -W`/`cygpath -w`) is not guaranteed to reproduce the
on-disk dir name Claude Code created — risking memory written to a fresh dir
beside the real one. The pre-existing fuzzy fallback was diagnostic-only.

**Fix**: when the computed `MEMORY_DIR` is absent, resolve from disk — adopt an
existing `projects/` entry **only** when the match is unambiguous (exactly one
dir whose name contains the basename AND has a `memory/` subdir). Zero/many
matches → keep the computed value and defer to Phase 3 (never write two encoded
dirs). A final `effective value` echo is the authoritative one for Phase 4.6.

**Cross-OS bug found while validating this fix**: the GNU **grep 3.0** bundled
with Git Bash **SIGABRTs** (`Aborted — core dumped`, rc=134) on the `-i`+`-F`
flag combination *regardless of input* (`-iF`, `-Fi`, `-qiF` all crash; `-iE`,
`-qiE`, `-qF`, `-qxF` are fine). The Phase 1.7 fuzzy line already used
`ls | grep -iF "$BASENAME"` — it crashed on every Windows run, silently (tail of
the block). The resolver now matches with a case-folded `tr`+`case` glob (POSIX,
crash-free on all three OSes), eliminating the only `-iF` in the codebase. Smoke:
unique-resolve, ambiguous-defer, no-match-create, empty/absent `projects/`
null-safety, and case-insensitive match all pass.

#### Scope of this ship

WSL2-specific **bugs and portability gaps (categories A + B)** only. The field
report's later categories are NOT in this ship: secrets-pattern false positives
(C1), bootstrap-marker on setup (C2), untracked leak-scan (C3), autocrlf note
(C4), destructive CLAUDE.md UPDATE default (D1), and `install.sh` MCP-scope
reporting (E1) remain open for a follow-up.

### Improved (v0.7.12 — CAP-35: `last_capture` preservation across re-runs)

**Bug class**: `[CREATED_AT]` placeholder, fixed by CAP-23 to no longer
leak verbatim, was substituted with `${APPLIED_AT_DATE}` (the date of
the current `/rsct-setup` run) on EVERY re-run. Result: every file
containing `last_capture: [CREATED_AT]` in its template body (1
`infrastructure.md` + 10 knowledge categories with a `last_capture`
frontmatter line) flipped to a spurious **UPDATE** on every re-run —
even when zero real template content had changed. The acme-api
2026-06-10 dogfood reported exactly this pattern: 10 files marked
UPDATE with the only diff being `last_capture: 2026-06-08` →
`last_capture: 2026-06-10`. Functionally correct, semantically wrong:
"last_capture" should reflect when the dev last meaningfully captured
into the section, not when the framework last re-ran setup.

#### Fix — preserve existing `last_capture` value on UPDATE

Phase 4.5 and Phase 4.5b sed pipelines now read the TARGET body before
resolving the template, extract any existing
`last_capture: YYYY-MM-DD` line, and pass that value as
`EFFECTIVE_CREATED_AT` to the substitution. The fallback to
`${APPLIED_AT_DATE}` (today) only fires when:
- The TARGET file does not exist (CREATE path — fresh stamp is
  correct).
- The TARGET has no `last_capture` line at all (older template that
  didn't carry the metadata).
- The existing value is a non-date sentinel (e.g., `<TODO>`, `unknown`,
  empty) — regex requires a strict `[0-9]{4}-[0-9]{2}-[0-9]{2}`.

Reader fragment:

```bash
EFFECTIVE_CREATED_AT="${APPLIED_AT_DATE}"
if [ -f "$TARGET" ]; then
  EXISTING_LAST_CAPTURE=$(tr -d '\r' < "$TARGET" 2>/dev/null \
    | grep -E '^last_capture:[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]]*$' \
    | head -1 \
    | sed -E 's/^last_capture:[[:space:]]+([0-9]{4}-[0-9]{2}-[0-9]{2}).*$/\1/')
  if [ -n "$EXISTING_LAST_CAPTURE" ]; then
    EFFECTIVE_CREATED_AT="$EXISTING_LAST_CAPTURE"
  fi
fi
```

CRLF tolerant (`tr -d '\r'` before grep — same CAP-10/16 idiom).
POSIX ERE (`-E`) for cross-OS BSD/GNU portability (CAP-21 idiom).

#### Effect on the 4-state classifier

Idempotency restored:

- **First run** on a fresh file → CREATE with `last_capture: <today>`.
  Stored marker SHA = SHA of body containing today's date.
- **Subsequent run** with no template change → `EXISTING_LAST_CAPTURE`
  matches the marker's body date → TEMPLATE_BODY_SHA equals
  USER_BODY_SHA → **SKIP**. No spurious UPDATE.
- **Subsequent run with real template change** (different non-date
  content) → SHAs still differ → UPDATE legitimately, with
  `last_capture` preserved across the rewrite (not reset to today).

#### Anti-regression check (CAP-23) unaffected

The post-write `grep -qE '\[(APP_NAME|CREATED_AT|...)\]'` check
continues to fail loud if any framework placeholder survived
substitution. CAP-35 only changes the value substituted into
`[CREATED_AT]`, not whether substitution occurs.

#### Tested

- **7-scenario smoke** (`cap35-smoke.sh`):
  1. CREATE (target absent) → uses today's date ✓
  2. UPDATE with existing 2026-06-08 → preserves 2026-06-08 ✓
  3. Target with `<TODO>` sentinel → falls back to today ✓
  4. Target with very old date (2025-01-15) → preserved ✓
  5. Idempotency — RUN1 body byte-identical to RUN2 ✓
  6. Target without any `last_capture` line → fallback today ✓
  7. CRLF Windows-style target → date preserved (tr -d \r works) ✓
- mcp-server: 499/499 tests PASS (no impact — change is in the
  prompts/01-setup.md bash, not in the TypeScript source), typecheck
  clean, build clean.

#### What this cures in the acme-api dogfood

On the next `/rsct-setup` re-run after upgrading to v0.7.12+,
infrastructure.md and the 9 affected knowledge files (anti-decisions
is PRESERVE_WITH_WARNING regardless) will SKIP instead of UPDATE,
because their bodies already carry `last_capture: 2026-06-10` from the
v0.7.11 install — and CAP-35 will read that value back instead of
re-resolving to whatever today's date happens to be.

#### Boundary

Only `[CREATED_AT]` gets the preservation treatment, and only for the
`last_capture: YYYY-MM-DD` line shape. Other placeholders
(`[APP_NAME]`, `[ORG_SLUG]`, etc.) continue to substitute uniformly —
their values are derived from configuration, not from disk state, so
preservation logic does not apply.

### Improved (v0.7.11 — CAP-33 + CAP-34: bootstrap visibility extended to §C-gated mutations + docs/rules sweep)

Closes the visibility gap noted in v0.7.10's CHANGELOG: CAP-31
surfaced bootstrap state only in `rsct_phase_code_start`. The §C
mutating family (`rsct_request_commit`, `_push`, `_merge`) sat downstream
of the same §0 contract but did not check it. CAP-33 extends the
visibility, CAP-34 sweeps docs/rules to reflect the consolidated state.

#### CAP-33 — bootstrap visibility on `request_commit`, `request_push`, `request_merge`

**Refactor**: `evaluateBootstrapMarker` (and its `BootstrapMarker` type)
moved from `tools/phase-code-start.ts` to `lib/phase-scope.ts` so all
mutating tools can share the same evaluator without duplicating the
threshold logic or the hint text.

**Fix — applied uniformly across the three request tools**:

In the success (post-mutation) path of each tool:
1. Call `evaluateBootstrapMarker({ projectRoot, now })`.
2. If `status !== 'fresh'`:
   - Append `bootstrap.hint` to `hints[]` (visible to the agent and
     surfaced in the response).
   - Emit a `<tool>.bootstrap_warning` audit entry with
     `bootstrap_status`, `bootstrap_at`, `age_ms`, and tool-relevant
     metadata (branch, remote, sha, etc.) — never blocks the mutation.
3. Add `bootstrap_marker` to the output payload so callers can branch
   programmatically instead of grepping hint strings.

**Audit events added**:
- `request_commit.bootstrap_warning`
- `request_push.bootstrap_warning`
- `request_merge.bootstrap_warning`

**Why soft enforcement**: the mutation already passed §C
(`dev_approval` consumed, OS dialog confirmed). Rejecting after that
point would invalidate the consumed approval and corrupt the
`approvals-seen.json` accounting. Warn + audit is the right severity
for "§0 was probably skipped but commit/push/merge happened anyway"
— makes drift visible without breaking workflows.

#### CAP-34 — docs/rules sweep

- `rules/C-reauthorize.md` — new paragraph documenting CAP-33: when
  bootstrap is missing/stale on a mutation, hint + audit are emitted;
  always soft, never reject.
- `README.md` — current shipped state advanced to
  `v0.7.11-cap33-cap34` with the bootstrap-visibility-extended
  description.
- `examples/README.md` — version reference advanced to match.
- Audit-level sweep confirmed: no other prompts / templates / rules
  surfaces the previous "v0.7.10" tag string; no orphan references.

#### Tested

- **4 new unit tests** across the three request-tool test files:
  - `request-commit.test.ts` — missing bootstrap emits warning + audit
  - `request-commit.test.ts` — fresh bootstrap (no hint, no audit)
  - `request-push.test.ts` — missing bootstrap on push
  - `request-merge.test.ts` — missing bootstrap on merge
- **All 495 existing tests** continue to pass — `evaluateBootstrapMarker`
  is a pure read of `phase-state.json`; no side effects on legacy
  paths.
- **mcp-server**: 499/499 tests PASS (up from 495), typecheck clean,
  build clean.

#### Boundary state

Full gate / visibility chain now reaches every §C-gated mutation
endpoint:

```
rsct_status / rsct_load_context → stamps bootstrap_at
   ↓
rsct_classify_task → records tier_max
   ↓
rsct_phase_code_start checks:
   1. classify_gate (CAP-30) — rejects downgrade
   2. verification_gate (CAP-28) — rejects without completed V
   3. bootstrap_marker (CAP-31) — warns if §0 stale/missing
   ↓
rsct_request_commit / _push / _merge checks:
   1. §C gate (dev_approval + OS dialog)
   2. INV-5 branch protection
   3. INV-6 secrets scan (commit only)
   4. bootstrap_marker (CAP-33) — warns if §0 stale/missing
```

Every mechanical gate that exists in the framework is now reachable at
the appropriate entry point, with override flags audit-logged where
overrides are allowed and warnings audit-logged where enforcement is
soft.

### Added (v0.7.10 — CAP-30 + CAP-31 + CAP-32: classify→code-start mechanical link, bootstrap visibility, decisions/anti-decisions clarity)

Trio that closes the remaining architectural gaps from the bug report
that motivated CAP-28/29:
- **CAP-28** (v0.7.8) closed self-authorized V skip mechanically.
- **CAP-29** (v0.7.9) strengthened the upstream signal so tier=complex
  fires more often.
- **CAP-30** persists the classifier verdict and rejects code_start
  when the agent passes a *lower* tier than the recorded max
  (closes the "lie about tier" residual vector).
- **CAP-31** stamps §0 bootstrap timestamps so downstream mutating
  tools can see whether bootstrap was performed in the current session
  window (closes Bug #3 from the audit — pulou §0 bootstrap).
- **CAP-32** clarifies the documental confusion between
  `decisions.md` (positive adopted decisions) and
  `anti-decisions.md` (rejected/abandoned approaches) — Bug #5 from
  the audit.

#### CAP-30 — mechanical link `classify_task` → `code_start`

**Schema additions** on `PhaseState`:
```ts
last_classify?: {
  tier: string         // most recent verdict
  tier_max: string     // highest ever recorded (ratchet — cannot lower)
  classified_at: string
  signals_summary?: string
}
```

**`rsct_classify_task`** now writes this block on every call via
`stampClassifyVerdict` (lib/phase-scope). The ratchet: a later weaker
classify call CANNOT lower `tier_max` — only `tier` reflects the
latest. This defends against the downgrade attack where the agent
re-runs classify with a softer description after first getting
`complex`.

**`rsct_phase_code_start`** new gate (`evaluateClassifyGate`):
1. No `last_classify` block → `no_record` (gate inactive, fall through)
2. `spec_tier` rank ≥ `tier_max` rank → `satisfied`
3. `spec_tier` rank < `tier_max` rank:
   - `override_classify_downgrade=true` → `overridden` (audit-logged
     as `code.start.classify_downgrade_override`)
   - else → `rejected_downgrade` (audit-logged as
     `code.start.rejected` with `reject_kind: 'classify_downgrade'`)

Output now carries `classify_gate` alongside `verification_gate`.
Reject envelope uses new top-level status `classify_gate_rejected`.

Tier rank (`tierRank` in `lib/phase-scope`): trivial=0 < small=1 <
standard=2 < complex=3. Unknown tier → 0 (most permissive — never
false-rejects on a malformed state).

#### CAP-31 — bootstrap visibility (soft enforcement)

**Schema addition** on `PhaseState`:
```ts
bootstrap_at?: string  // ISO timestamp of last rsct_status / rsct_load_context call
```

**`rsct_status`** and **`rsct_load_context`** stamp `bootstrap_at`
via `stampBootstrapMarker` (lib/phase-scope). Best-effort write —
failures swallowed (these are read-only diagnostic tools at the API
contract).

**`rsct_phase_code_start`** new evaluator (`evaluateBootstrapMarker`):
- `bootstrap_at` absent → `missing` (loud hint + audit
  `code.start.bootstrap_warning` with `bootstrap_status: missing`)
- `bootstrap_at` older than `BOOTSTRAP_STALE_MS` (4 hours) → `stale`
  (warn hint + audit with `bootstrap_status: stale` + `age_ms`)
- `bootstrap_at` ≤ 4h → `fresh` (no hint, no audit)

Soft enforcement intentional — bootstrap is a recommendation, not a
hard gate (a fresh project install legitimately has no stamp; agent
that bootstraps mid-session should not fail). The warning + audit
trail makes drift visible without breaking workflows.

Output now carries `bootstrap_marker` alongside other gate diagnostics.

#### CAP-32 — `decisions.md` vs `anti-decisions.md` clarity

**Issue**: the acme-api dev correction surfaced that the
agent put a *rejected approach* into `decisions.md` (which is for
adopted decisions). The current rule H mentioned only `decisions.md`;
`anti-decisions.md` was documented under
`doc-templates/knowledge/anti-decisions.md.template` but not
distinguished in the §H ADR-learning rule or in the auto-learning
memory entry. Agents lacked clear guidance on which file to use.

**Fix**:
- `rules/H-adr-learning.md` — new table mapping each file to its
  purpose + concrete examples ("we do X" → decisions.md; "we tried
  Y and dropped it" → anti-decisions.md) + criteria block for
  anti-decisions in parallel with criteria for decisions.
- `memory-templates/feedback_adr-autolearning.md` — mirrors the
  rule H distinction so the memory entry agents recall in-session
  also carries the choosing rubric.

#### Tests

- **7 new unit tests** in `phase-code-start.test.ts`:
  - CAP-30 reject downgrade (complex → trivial)
  - CAP-30 satisfied (>= tier_max)
  - CAP-30 override with audit
  - CAP-30 no_record fall-through
  - CAP-31 missing bootstrap warning + audit
  - CAP-31 stale bootstrap warning
  - CAP-31 fresh bootstrap (no hint)
- **All 488 existing tests** continue to pass — `classify_gate.status='no_record'` makes the gate inactive when no classify is recorded, preserving backward compat across existing test scenarios.
- **mcp-server**: 495/495 tests PASS (up from 488), typecheck clean,
  build clean (bundle 265.95 KB, +7.63 KB vs v0.7.9 for the new
  schema fields + writers + readers + gate logic).

#### Test isolation fix (CAP-31 side effect)

`rsct_status` and `rsct_load_context` tests pass `project_root:
SAMPLE_RSCT` to exercise fixture loading. The CAP-31 stamp now writes
`phase-state.json` into that fixture's `.rsct/` directory, dirtying
the working tree on every test run. Added gitignore patterns under
`mcp-server/tests/fixtures/**/.rsct/` for runtime artifacts
(`phase-state.json`, `phase-state.lock`, `audit.log`,
`approvals-seen.json`) so the fixture's tracked `.rsct.json` stays
clean while runtime stamps are local-only.

#### Boundary closed

The full chain is now mechanically enforced:

```
rsct_classify_task → records tier_max in phase-state
   ↓
rsct_phase_code_start checks:
   1. classify_gate (CAP-30) — reject if spec_tier < tier_max
   2. verification_gate (CAP-28) — reject if V not completed (≥ standard)
   3. bootstrap_marker (CAP-31) — warn if §0 not done in 4h window
```

An agent that wants to bypass any of these gates must pass the
matching explicit override flag (`override_classify_downgrade`,
`override_verification_skip`), each audit-logged. No soft "skip
because it feels optional" path remains.

#### Remaining open items (not closed in this ship)

- **`rsct_request_*` family** (commit/push/merge) does not yet warn
  on missing bootstrap. CAP-31 currently surfaces only in
  `phase_code_start`. If the dev wants bootstrap visibility on commit
  gates too, that's a CAP-33+ follow-up (sound design but increasing
  scope of the writer touchpoints).
- **Tier hard-link**: agent can still pass an incorrect
  `spec_tier='complex'` (upgrade) when the classifier said
  `'standard'` — CAP-30 only blocks downgrade. Upgrades are
  considered safe (agent voluntarily entering more rigor).

### Improved (v0.7.9 — CAP-29: `rsct_classify_task` multi-concern + step-count detection)

**Bug class**: heuristic-induced under-classification. The pre-v0.7.9
classifier scanned for architecture / multi-file / trivial / mutation
keywords only. Multi-concern tasks (DTO + service + listener + template +
test) collapsed to `tier='standard'` because no single keyword group
hit hard enough, and the agent then chose to skip V — exactly the
acme-api 2026-06-09 case CAP-28 closed mechanically at the
gate. CAP-29 closes it upstream by making the classifier itself
recognize multi-concern shape, so the agent receives `tier='complex'`
with the correct hint chain ("V phase MANDATORY") instead of a soft
"standard" that invited the skip in the first place.

#### Fix — two new signal families layered into the cascade

**1. `CONCERN_LEXICONS`** — 7 independent technical-concern categories:
- `dto` (dto, record, schema, entity, value object, payload)
- `service` (service, business logic, use case, regra de negócio)
- `listener` (listener, event handler, event-driven, subscriber, ...)
- `template` (template, render, html, view, ui, email template)
- `test` (unit test, junit, vitest, mock, mockito, assertj, ...)
- `persistence` (query, sql, repository, jpa, hibernate, migration, ...)
- `api` (endpoint, controller, rest, route, http, webhook)

Each category has multilingual entries (EN + pt-BR) with narrow,
non-overlapping vocabulary. Substring match is case-insensitive and
order-independent. `detectConcerns()` returns the set of category
keys that hit — cardinality drives the cascade.

**2. `countSteps()`** — multi-step plan detector. Matches `\b(passo|step)\s+\d+\b` AND numbered-list lines `(?:^|\n|\s)(\d+)\.\s+\S`.
Returns the count of distinct step markers. 4+ steps signals an
explicit multi-step plan that needs the full cycle.

#### New cascade branches (inserted between trivial and small)

```
1. archHits > 0                                 → complex (unchanged)
2. multiHits > 0                                → standard (unchanged)
3. trivialHits + concerns=0 + steps<4 + <12w    → trivial (tightened)
4. NEW: stepCount ≥ 4                           → complex
5. NEW: concerns.size ≥ 3                       → complex
6. NEW: concerns.size === 2                     → standard
7. mutationHits + ≤20w + concerns.size ≤ 1      → small (tightened)
8. default                                      → standard (unchanged)
```

Trivial branch (3) now also requires `concerns=0` and `steps<4` —
prevents a "fix typo" + 4 concerns mention from collapsing to trivial.
Small branch (7) now also requires `concerns.size ≤ 1` — a 2+ concern
task escalates to standard or complex regardless of mutation verb
shortness.

#### New `signals[]` entries

Output `signals[]` now surfaces `concerns:[X,Y,Z]` (sorted) and
`steps:N` alongside the existing `architecture / multi-file /
trivial-shape / mutation-verbs / word_count`. The dev (and the next
LLM session) sees exactly which signals fired in the decision —
explains the upgrade without grepping reasoning text.

#### Hint refresh for CAP-28 alignment

Hints for `standard` and `complex` tiers now reference CAP-28 by
name and call out the mechanical gate behavior of
`rsct_phase_code_start`:

> Standard tier — CAP-28: rsct_phase_code_start REJECTS with
> reject_kind=verification_required unless V phase completed (or
> override_verification_skip=true passed).

Previously the standard hint said V was "optional" — exactly the
soft-language vector that led to the acme-api skip. Closed.

#### Tested

- **6 new unit tests** in `classify-task.test.ts`:
  - 3+ concerns → complex
  - 2 concerns → standard
  - 4+ numbered steps → complex
  - single concern + short mutation → small (no regression)
  - acme-api-like task (DTO + service + listener + template
    + test) → complex (real dogfood case from 2026-06-09)
  - trivial doc-fix unaffected (no concerns) → trivial
- **17 existing tests** pass unchanged (no regression in trivial /
  small / standard / complex / pt-BR / CAP-6 expanded vocabulary
  paths).
- **mcp-server**: 488/488 tests PASS (up from 482), typecheck clean,
  build clean.

#### Boundary

The classifier is still **advisory** at this layer — `phase_code_start`
remains the mechanical gate (CAP-28). An agent that chooses to pass
`spec_tier='trivial'` to `code_start` despite a complex
classify result still bypasses the gate. Closing that final vector
(mechanical link between classify_task and code_start tier) is a
candidate CAP-30+ — would require persisting the classify_task
verdict and reading it back at code_start.

### Added (v0.7.8 — CAP-28: hard verification gate on `rsct_phase_code_start`)

**Bug class addressed**: agent self-authorization to skip the V phase
between spec and code. Per `acme-api` 2026-06-09 session log,
the agent received `next_recommended_phase: 'verification'` from
`rsct_phase_spec_complete`, classified the task as `standard` via
`rsct_classify_task`, and decided "verification is optional, going
straight to code" — invoking `rsct_phase_code_start` without ever
calling `rsct_phase_verification_start`. The dev had to intercept and
revert. Identical class to CAP-15 execution mandate (canonical bash
literally executed) but at the phase-flow layer.

**Why earlier mitigations did not catch it**: `spec_complete` only
emits a soft hint string (`"Next recommended phase: 'verification'"`)
and `rsct_classify_task` heuristic surfaces tier=standard from
word-count + mutation-verb signals without any mechanical link to the
phase machine. Pure agent-compliance contract, no enforcement —
exactly the brittleness `rsct-mcp` exists to close (see
project_mcp-consciousness "mechanical layer must block behavioural
shortcuts").

#### Fix — hard gate at code-start entry point

`rsct_phase_code_start` gains two new input fields and a mechanical
gate evaluator:

| Field | Type | Default | Behaviour |
|---|---|---|---|
| `spec_tier` | `'trivial' \| 'small' \| 'standard' \| 'complex'` | `'standard'` | Canonical RSCT tier; tier ∈ {trivial, small} bypasses the gate automatically per the tier table in `prompts/B-architect-plan.md`. tier ∈ {standard, complex} requires V completion or explicit override. |
| `override_verification_skip` | `boolean` | `false` | Explicit acknowledgment of skipping V for tier ∈ {standard, complex}. When `true`, the override is recorded in `.rsct/audit.log` as `code.start.verification_override`. Use only when the dev has explicitly chosen to bypass V. |

Gate decision tree (`evaluateVerificationGate`):

1. `tier ∈ {trivial, small}` → `bypassed_tier`, proceed
2. `tier ∈ {standard, complex}`:
   - V block in `phase-state.json` matches `spec_ref` AND has `completed_at` → `satisfied`, proceed
   - V block matches `spec_ref` but no `completed_at` → `rejected_incomplete`, fail with hint to call `rsct_phase_verification_complete` first
   - V block absent OR `spec_ref` mismatch:
     - `override_verification_skip=true` → `overridden`, proceed (audit-logged)
     - else → `rejected_required`, fail with hint to run V or pass override

Rejected paths emit `code.start.rejected` audit entries with
`reject_kind ∈ {verification_required, verification_incomplete}`.
Success paths surface `verification_gate.status` in the tool output for
in-conversation transparency.

#### Supporting change — preserve V block as audit trail

`rsct_phase_verification_complete` previously **deleted** the
`verification` sub-block from `phase-state.json` on success. This made
"did V actually complete for this spec?" impossible to answer
post-hoc. The complete handler now:

- Preserves the verification block instead of deleting it
- Sets `completed_at` to the completion timestamp
- Prunes large arrays (`findings`, `discovered_importers`,
  `declared_paths`) — their content already lives in
  `.rsct/audit.log` as per-finding `verification.finding` /
  `verification.action` entries, so the state file stays bounded
- Retains `spec_ref`, `spec_tier`, `started_at`, `completed_at`,
  `persona` as durable metadata for the CAP-28 gate

`cleared_verification: true` semantics unchanged (workload is cleared;
metadata is the trail).

#### Schema additions to `phase_code_start` output

New top-level field `verification_gate: VerificationGate` on both
success and reject paths. The reject path uses a new status value
`verification_gate_rejected` (alongside the existing `started` /
`phase_already_active` / `state_write_failed`) so callers can branch
mechanically instead of grepping the hint string.

#### Tested

- **8 new unit tests** in `phase-code-start.test.ts` covering:
  trivial bypass / small bypass / standard + V completed (satisfied)
  / standard + V incomplete (rejected) / standard + no V no override
  (rejected) / standard + no V with override (proceed + audit) /
  complex + no V (rejected) / V completed for a different spec_ref
  (rejected) / default tier=standard active when omitted.
- **2 updated tests** in `phase-verification-complete.test.ts`:
  happy-path + clear_phase=false now assert the V block is preserved
  with `completed_at` instead of `undefined`.
- **1 updated test** in `phase-pairs-smoke.test.ts`: code-start smoke
  now passes `spec_tier='trivial'` to bypass the gate (focus is
  phase-state write + scope_globs, not V semantics — V gate has
  dedicated coverage).
- mcp-server: 482/482 tests PASS (up from 473 — 8 new + 1 updated),
  typecheck clean, build clean (bundle 255.34 KB, +5.66 KB vs v0.7.7
  for the gate logic + audit + schema).

#### Backward compat

- Old projects whose `phase-state.json` was written by a pre-v0.7.8
  `verification_complete` (V block already deleted) reach
  `rejected_required` on subsequent `code_start`. The dev passes
  `override_verification_skip=true` once to bypass; future V runs
  populate the new shape and the gate works mechanically thereafter.
- Trivial/small workflows are unaffected — they bypass the gate by
  tier.

### Fixed (v0.7.7 — CAP-25 + CAP-26 + CAP-27: M3 phase-state hygiene sweep)

Trio of related bugs/gaps centered on `.rsct/phase-state.json` —
the artifact the M3 phase machine writes on every
`rsct_phase_*_start/_complete` call. The file never got first-class
treatment across the framework's install/uninstall path despite
shipping in v0.3.0 (M3 release). All three close the same surface.

#### CAP-25 — `.rsct/phase-state.json` missing from gitignore block

**Bug**: the `.gitignore` RSCT block written by Phase 4.4b of
`prompts/01-setup.md` listed `.rsct/audit.log` and
`.rsct/approvals-seen.json` but NOT `.rsct/phase-state.json`. Every
project with M3 phase tools used showed `.rsct/phase-state.json` as
untracked in `git status` forever, polluting the working tree on
every run. Bug existed since M3 phase machine shipped (v0.3.0+).

**Captured by**: `acme-api` dev session running a spec→code
cycle that noticed the orphan file in `git status` after task
completion. Never tracked in any branch — pure untracked litter.

**Fix**:
1. Add `.rsct/phase-state.json` AND `.rsct/phase-state.lock` to
   `PATTERN_BLOCK` (canonical block written on fresh install). The
   `.lock` file is the advisory lock the M3 writer uses to serialize
   writes — normally released, but can persist briefly if a process
   crashes mid-write.
2. Add two backfill cases mirroring CAP-16 (`spec_*.md` alias backfill
   from v0.7.1): scans marker-wrapped blocks for each line and appends
   it in canonical position when missing
   (`.json` after `approvals-seen.json`; `.lock` after `.json`).
   POSIX-portable, CRLF-tolerant (`tr -d '\r'` idiom mirror).

**Backward compat**: projects with pre-v0.7.7 `.gitignore` RSCT block
get the new line appended on next `/rsct-setup` run via backfill —
same idempotent pattern as CAP-16. No marker rewrite, no duplicates,
dev-custom lines outside the block preserved. No manual intervention.

#### CAP-26 — `prompts/03-uninstall.md` left `.rsct/phase-state.json` orphan

**Bug**: the uninstall path did not delete `.rsct/phase-state.json`.
Seven adjacent inconsistencies, all rooted in the same omission (the
file was treated as "M3 artifact, future-proof, currently absent on
M2 installs" when in fact M3 was the live phase machine writing it
on every phase tool invocation):

| Site | Before | After |
|---|---|---|
| Line 165 (Phase 1.6 catalogue intro) | "four M2-installed artifacts" | "framework-installed artifacts ... phase-state on the fly by M3" |
| Line 173 (artifact table) | "M3 artifact, future-proof / Currently absent on M2 installs" | "M3 phase machine on every phase_*_start/_complete call / remove (analogous to approvals-seen)" |
| Line 179 (inventory example) | `phase-state:absent` | `phase-state:present` |
| Lines 282-283 (Category E table) | no row for phase-state | new row: default-remove, silent (mirror of approvals-seen) |
| Lines 332-336 (display block) | three .rsct lines | four .rsct lines including phase-state |
| Line 358 (silent-removal parens) | `(scripts/ and approvals-seen.json removed silently)` | `(scripts/, approvals-seen.json, and phase-state.json removed silently)` |
| Line 660 (Phase 4.V.c canonical bash) | only `rm -f .rsct/approvals-seen.json` | adds `rm -f .rsct/phase-state.json` + `rm -f .rsct/phase-state.lock` (defensive against stale lock) |
| Line 716 (Phase 6 final report) | no phase-state in "Removed" list | adds line for phase-state under M3 |

**Result**: `/rsct-uninstall` now removes `.rsct/phase-state.json`
silently when Category E is in scope. Mirror of how approvals-seen
is handled — internal state, no post-uninstall value, no dev
question needed.

#### CAP-27 — README outdated (`v0.7.0-cap15` referenced as "current shipped state")

**Bug**: `README.md` lines 358-368 and line 409 still pointed at
`v0.7.0-cap15-execution-mandate` as the current shipped state.
Repo had drifted seven patch releases ahead
(v0.7.1 → v0.7.7) without README sync. Each CAP ship widened the drift.

**Fix**: README now references `v0.7.7-cap25-cap26-cap27` and lists
the three v0.7.x sweep arcs explicitly:
- cross-OS correctness (CAP-20/21/22)
- placeholder-leak cure (CAP-23/24)
- M3 phase-state hygiene (CAP-25/26/27)

`examples/README.md:14` carried the same `v0.7.0-cap15-execution-mandate`
reference and was synced in the same ship (caught by audit-level sweep
post-commit). Refreshed in the same ship so future readers see the
actual head.

#### Smoke coverage

- **CAP-25** (gitignore): 5 scenarios — fresh install / idempotent
  re-run / backfill from v0.7.6 block / re-run on backfilled / CRLF
  Windows input. All PASS.
- **CAP-26** (uninstall): 4 scenarios — full Category E uninstall
  removes phase-state / idempotent on already-clean .rsct/ / rmdir
  succeeds after granular cleanup / .rsct/ preserved when audit.log
  kept. All PASS.
- **Regression**: CAP-23 (3 scenarios) + CAP-20 LIVE end-to-end
  (4 scenarios) re-ran — all PASS, no regression from CAP-25/26/27.
- **mcp-server**: typecheck clean, build clean (bundle 249.68 KB),
  473/473 tests PASS.

### Fixed (v0.7.6 — CAP-23 + CAP-24: placeholder-leak in template writers + preventive `| while` removal)

Pair of historical bugs caught in `acme-api` Phase 5 review on
v0.7.5 install. The dev had restored `.rsct.json` pre-CAP-20 and
re-run `/rsct-setup`; the diff review surfaced the visible placeholder
leak (CAP-23) and a wide sweep then found the dormant `| while`
anti-pattern (CAP-24) that the v0.7.5 sweep missed because it focused
on cross-OS (BRE / sed -i / CRLF) rather than placeholder hygiene.

#### CAP-23 — `[CREATED_AT]` placeholder leaks through template writers

**Bug**: Phase 4.5 and Phase 4.5b sed pipelines in
`prompts/01-setup.md` substituted only `[APP_NAME]` when resolving
template bodies. Every other framework placeholder shipped to disk
verbatim. The 11 templates with `last_capture: [CREATED_AT]` in body
(1 doc + 10 knowledge categories) produced files containing the
literal string `last_capture: [CREATED_AT]` — visible, ugly, and
the file's own marker SHA was computed over the leaked body so the
re-run classifier silently re-shipped the leak forever (SKIP or
UPDATE both wrote the same leaked content). Bug existed since
template inception — affected CREATE and every UPDATE in every
install of every project ever to run `/rsct-setup`.

**Captured by**: `acme-api` Phase 5 review on v0.7.5 — dev
noticed `[CREATED_AT]` in the knowledge UPDATEs and surfaced it as
"framework upstream nao trata esse placeholder em 4.5b". Confirmed
in the prompt source.

**Why v0.7.5 missed it**: the v0.7.5 wide sweep ran against the 6
anti-patterns in `CLAUDE.md` (BRE, sed delimiter, CRLF, JSON.parse,
phantom vars, `| while` with counters). Placeholder-leak in template
writers was not in that list — gap in the audit catalogue.

**Fix — 4 writers unified**:
1. **Phase 4.5** (`documentation/` canonicals): `sed` chain now
   substitutes `[APP_NAME]` AND `[CREATED_AT]` (`${APPLIED_AT_DATE}`
   `YYYY-MM-DD`).
2. **Phase 4.5b** (`documentation/knowledge/`): same chain.
3. **Phase 4.3** (`CLAUDE.md` writer): defensive — template currently
   only has `[APP_NAME]` in body, but the chain now stays consistent
   so the next template addition cannot silently leak.
4. **Phase 4.6** (memory writer): defensive — memory templates
   currently have no `[CREATED_AT]` body placeholder, but the chain
   is mirrored across all 4 writers for uniformity.

**Anti-regression — every Phase 4.3/4.5/4.5b CREATE and UPDATE now
runs a post-write `grep -qE '\[(APP_NAME|CREATED_AT|ORG_SLUG|...
TEST_FRAMEWORK)\]'` check on the rendered file**. If any framework
placeholder survives substitution, setup fails loud with a vocal
ERROR pointing at the offending template. Future template additions
that add a new placeholder will trip this check on first CREATE
instead of silently shipping leaked content.

**Tested**: 3-scenario CAP-23 smoke (clean substitution / leaked
placeholder trips anti-regression / clean output silent) + the full
CAP-20 smoke harness re-ran (LIVE prompt body + embedded — 4/4 + 14/14
asserts still PASS), confirming the sed chain change did not regress
the secrets writer.

**04-init-universe.md verified clean**: lines 239-244 already
substitute `[ORG_SLUG]`, `[CREATED_AT]`, `[GITHUB_REMOTE]` uniformly.
No fix needed there.

**plan/progress writers (`plan_slug.md.template`,
`progress_slug.md.template`) are out of scope**: those are written by
the IA when starting a spec/plan (claude-interpreted substitution),
not by a canonical writer in `prompts/`. Any leak there is a
session-level concern, not a framework bug.

#### CAP-24 — `| while` in `03-uninstall.md` Phase 1.4 / 1.5 (preventive)

**Bug**: `find documentation/ ... | while read -r f` (Phase 1.4) and
`ls "$MEMORY_DIR"/... | while read -r f` (Phase 1.5) both use
pipeline-while — `cmd | while`, which runs the loop body in a
subshell. The loops today only `echo` (no counter / external variable
mutation), so the bug is **dormant, not active**. But the pattern is
exactly the trap CLAUDE.md root anti-pattern #1 warns against
(CAP-13 incident on Phase 4.6 additive-merge, CAP-19 incident on
Phase 4.5/4.5b OUT_OF_SCOPE scan).

**Captured by**: CAP-23 post-fix wide sweep against anti-pattern #1.

**Fix**: convert both to `done < <(...)` process substitution. Loop
body unchanged. Behavior identical for the current echo-only loop;
prevents the next edit that introduces a counter from silently
regressing into all-zero summaries.

### Fixed (v0.7.5 — CAP-20 + CAP-21 + CAP-22: cross-OS correctness sweep)

Three related cross-OS correctness bugs caught in a single ship after
the v0.7.4 dogfood loop on `acme-api` surfaced CAP-20 in
runtime. CAP-21 and CAP-22 were discovered during the post-fix wide
sweep prescribed by the new **Portabilidade cross-OS** rule added to
`CLAUDE.md` (root) — the rule mandates that any change to the project
must work on Windows (Git Bash / MSYS2), Linux (GNU coreutils) and
macOS (BSD coreutils) without regression.

#### CAP-20 — `secrets_extra_patterns` escape-level mismatch (`prompts/01-setup.md` Phase 4.4)

**Bug**: the `node -e` block that merges `SENSITIVE_VARS` into
`.rsct.json` `secrets_extra_patterns[]` captured existing entries via
regex over the raw bytes between quotes (so `"\\bX\\b"` on disk
yielded `\\bX\\b` — a 4-byte escape) but built the comparator key in
decoded-byte space (`\bX\b` — a 2-byte escape). Every known VAR
mis-compared as "new"; the subsequent `JSON.stringify(p)` then
double-escaped the existing entries before writing, so on each UPDATE
re-run the array grew (8 → 16 → 24) with half the entries corrupted
into shape `"\\\\bX\\\\b"` (literal backslash + `b`, NOT a word
boundary). The secret classifier silently stopped matching those
patterns because `new RegExp("\\bX\\b")` does not test as a word
boundary.

**Captured by**: `acme-api` v0.7.4 dogfood run on 2026-06-08
— the reading agent froze on the bug (CAP-15 Execution Mandate) and
escalated. By the time it was caught, `.rsct.json` had 16 entries
(8 corrupted + 8 correct).

**Fix**:
1. Add `decodeJsonStringBody(s)` helper that `JSON.parse`-s a single
   string literal body (NOT the whole file — anti-pattern #5 is
   respected; text-splice remains).
2. Decode every captured entry into `decoded[]` so the in-memory
   representation is uniformly raw bytes.
3. Auto-cure corrupted entries: filter out anything whose raw bytes
   exactly match `\\b<WORD>\\b` (3-byte prefix `\,\,b` + word body +
   3-byte suffix). Detector is strict — custom dev-authored patterns
   like `^[a-z]+$`, `\.json`, or `\bCUSTOM\b` (word-boundary
   word-boundary intent) are NEVER matched and preserved verbatim.
4. Short-circuit no-op only when `added === 0 AND curedCount === 0`
   (so cure paths still write).
5. Vocal log: `cured N corrupted entries (CAP-20)` when curing,
   `added N secrets_extra_patterns entries: ...` when adding; both
   joined with `; ` when both happen.

Projects with pre-v0.7.5 corrupted `.rsct.json` are auto-cured on
next setup run; no manual intervention required.

**Tested**: 5-scenario smoke harness (fresh install / idempotent
re-run / v0.7.4-corrupted cure / custom regex preservation / mixed
corrupt+custom+correct), plus end-to-end run against the LIVE prompt
body extracted via awk (proves the smoke is in sync with the actual
shipped block).

#### CAP-21 — BRE `\|` alternation in Phase 1.8 sensitive-vars probe

**Bug**: 3 `grep` invocations in `prompts/01-setup.md` Phase 1.8
(lines 330 / 334 / 338, Java/Spring + .NET + Node probes) used
`grep "pat1\|pat2\|pat3"` — GNU BRE alternation. BSD `grep` (macOS
default) does NOT support `\|` in BRE and falls back to literal
matching, returning empty results. `SENSITIVE_VARS` would come back
empty on macOS → `secrets_extra_patterns[]` populated with nothing →
secret classifier loses coverage of project-specific names.

**Captured by**: CAP-20 post-fix wide sweep against anti-pattern #2
(CLAUDE.md root). Sibling regression to CAP-17 AUDIT-C (v0.7.3) which
caught the same pattern in Phase 4.2 — Phase 1.8 survived that pass.

**Fix**: convert the 3 `grep "..."` to `grep -E "..."` and replace
each `\|` with `|`. POSIX-portable across all three OS.

**Tested**: smoke against a Java/Spring fixture confirmed 5 expected
matches in the ERE form.

#### CAP-22 — `sed -i` without empty suffix breaks on BSD/macOS

**Bug**: 3 `sed -i` invocations omitted the empty-suffix argument
required by BSD `sed`:
- `prompts/02-canonical-source.md:244` — excise existing CANONICAL
  SOURCE block in UPDATE mode
- `prompts/03-uninstall.md:426` — excise `<!-- RSCT-§X-... -->`
  sections during uninstall
- `prompts/03-uninstall.md:446` — excise CANONICAL SOURCE block
  during uninstall

GNU `sed` (Git Bash / Linux) treats `sed -i 'expr' file` as in-place
with no backup. BSD `sed` (macOS) requires `sed -i SUFFIX expr file`
— `SUFFIX=''` for no backup. Without it, macOS `sed` consumes the
next arg (`'expr'`) as the suffix and then treats `file` as the
expression, producing a syntax error or accidentally writing a
backup with a garbage suffix.

**Captured by**: CAP-21 post-fix wide sweep against `sed -i\b`. The
same `case "$(uname -s)" in Darwin) sed -i ''; *) sed -i ;; esac`
branching was already in `prompts/01-setup.md` lines 694-701 and
923-931 (Phase 4.2 RSCT_APP header rotation and Phase 4.4 applied_at
rotation — CAP-17 / pre-CAP-17 fix), so the pattern was internally
inconsistent across the framework's prompts.

**Fix**: wrap each of the 3 sites in the same `case "$(uname -s)"`
branch, mirroring the existing pattern in `01-setup.md`. Cross-OS
parity across all `sed -i` invocations restored.

**Tested**: smoke on Git Bash (MINGW64) confirmed the GNU path
excises both the markers and inter-marker content while preserving
surrounding bytes.

#### CLAUDE.md (root) — new section: Portabilidade cross-OS

A dedicated section was added to `CLAUDE.md` (root) **with explicit
dev authorization** elevating the cross-OS portability requirement
to a project-level principle (not just a bash anti-pattern subitem).
Includes a table of historically-bitten Windows/Linux/macOS
divergences (`grep` alternation, `sed -i` suffix, CRLF, `\b` in
`node -e`, default tool ergonomics) and a 5-step checklist for
authors. Tied back to CAP-10/16/17/18/20/21.

### Fixed (v0.7.4 — CAP-19: architectural anti-scope-creep contract for Phase 4.5 / 4.5b / 4.6)

**This is an architectural fix, not a point fix.** The prior v0.7.x
train cured one drift surface at a time (CAP-9 through CAP-18: prose
→ canonical bash for specific writers). Phase 4.5 / 4.5b / 4.6 were
left with the wrong **shape** of contract — they listed canonical
files in prose ("Files to create if missing") and said "Never delete
or overwrite existing files", but the **decision of what is canonical
vs dev-custom was Claude-interpreted**, not mechanical. That created
a recurring class of regression where the reading agent decided a
dev-custom file was "completable" and proposed marker / frontmatter /
category integration on top of it.

#### Origin (v0.7.3 dogfood, 2026-06-08)

Reading agent on `acme-api` ran v0.7.3 `/rsct-setup` and
proposed **mutating three dev-custom files** under
`documentation/deployment/` (`runbook.md`, `environments.md`,
`spec-deploy.md`):

> "OPTION B (RECOMENDADO) — marker + frontmatter YAML por categoria.
>  Categorias propostas: environments.md → rsct_category: environments;
>  runbook.md → rsct_category: runbook; spec-deploy.md →
>  rsct_category: deploy-spec. Corpo (do # Titulo em diante) inalterado."

The agent invented three category labels (`environments`, `runbook`,
`deploy-spec`) that exist in **no** template under `doc-templates/`,
proposed adding RSCT markers to files that are NOT canonical, and
framed it as "preserving the body byte-for-byte" — even though
adding a marker + frontmatter changes the file's structure. The
dev's prior request ("manter ou update preservando conteúdo") meant
**don't touch**, but the prose contract was ambiguous enough that
the agent took it as "integrate while preserving body".

This is exactly the failure mode the CAP-15 execution mandate exists
to prevent. CAP-9 through CAP-18 closed it for specific writers
(applied_at rotation, secrets_extra_patterns merge, .gitignore
backfill, RSCT_APP header rotation, RSCT-§X excision, canonical-source
insertion). Phase 4.5 / 4.5b / 4.6 still had a "Claude decides what
is canonical" decision point and that point drifted again.

#### Architectural fix — closed-set contract

Phase 4.5, 4.5b, and 4.6 now carry the same architectural shape:

1. **`CANONICAL_X` array** explicitly enumerates the closed set of
   files the framework owns under the relevant directory. Format:
   one line per file, `target_relpath|template_relpath`. Adding or
   removing a canonical file requires editing this prompt AND the
   matching template — no path adds a file to the set at runtime.

2. **Classifier loop iterates ONLY over `CANONICAL_X`.** Each entry
   runs through the 4-state SHA classifier (CREATE / UPDATE / SKIP /
   PRESERVE) and produces a vocal log line. The loop has no
   awareness of files outside `CANONICAL_X` — there is no
   "fallthrough to a fifth state" that touches them.

3. **OUT_OF_SCOPE scan** runs in a separate, **read-only** branch
   after the classifier loop. It `find`s every file under the
   relevant directory, subtracts `CANONICAL_X`, and **logs each
   dev-custom path as `OUT_OF_SCOPE  <path> (dev-custom — intacto,
   never touched)`**. The scan never reads file bodies, never
   computes SHAs over them, never opens them for write, never adds
   markers, never adds frontmatter.

4. **Anti-drift contract paragraph** in each phase explicitly lists
   the forbidden moves: "add marker to dev-custom file", "add
   frontmatter to dev-custom file", "integrate dev-custom path
   into the RSCT marker system", "invent category for dev-custom
   files". Each move is named in prose so the next reading agent
   has zero ambiguity.

5. **Phase 5 summary** includes the OUT_OF_SCOPE counts so the dev
   sees the dev-custom inventory before approving the commit.

Phase 4.5 (documentation/): 7-entry closed set spanning the
canonical project docs (README, architecture, decisions,
setupdeveloper, infrastructure, impact/README, tests/README).

Phase 4.5b (documentation/knowledge/): 11-entry closed set
spanning the knowledge graph categories shipped under
`doc-templates/knowledge/`.

Phase 4.6 (memory): `CANONICAL_MEMORY` is built dynamically from
`~/.rsct/memory-templates/*.template` (mirroring the classifier's
existing iteration source). OUT_OF_SCOPE scan reports dev-custom
memory entries (`project_*.md`, `feedback_<custom>.md`) intact.

#### Smoke-tested against the acme-api scenario

Reproduced the exact failure case: project with the 7 canonical
docs **plus** `documentation/deployment/{runbook,environments,
spec-deploy}.md`, `documentation/api/{endpoints,error-codes}.md`,
`documentation/architecture/module-map.md`,
`documentation/business/permissions.md` — all dev-custom.

```
=== Phase 4.5 classifier (canonical loop only) ===
  PRESERVE documentation/README.md: dev-edited
  PRESERVE documentation/architecture.md: dev-edited
  PRESERVE documentation/decisions.md: dev-edited
  PRESERVE documentation/setupdeveloper.md: dev-edited
  CREATE  documentation/impact/README.md
  CREATE  documentation/tests/README.md
  PRESERVE documentation/infrastructure.md: dev-edited

=== Phase 4.5 OUT_OF_SCOPE scan ===
  OUT_OF_SCOPE  documentation/api/endpoints.md
  OUT_OF_SCOPE  documentation/api/error-codes.md
  OUT_OF_SCOPE  documentation/architecture/module-map.md
  OUT_OF_SCOPE  documentation/business/permissions.md
  OUT_OF_SCOPE  documentation/deployment/environments.md
  OUT_OF_SCOPE  documentation/deployment/runbook.md
  OUT_OF_SCOPE  documentation/deployment/spec-deploy.md

=== Verify dev-custom files byte-identical to pre-run state ===
  ✓ deployment/runbook.md untouched
  ✓ deployment/environments.md untouched
  ✓ deployment/spec-deploy.md untouched
  ✓ api/endpoints.md untouched
  ✓ api/error-codes.md untouched
```

The three deployment files the v0.7.3 reading agent proposed to
mutate are **byte-identical** to pre-run state. The classifier
**physically cannot reach them** — they are not in `CANONICAL_DOCS`,
the loop never sees them, and the OUT_OF_SCOPE branch is read-only
by construction.

#### Why this matters beyond the specific dogfood

Prior CAPs cured the "agent invents the wrong sed" failure mode for
specific writers. CAP-19 cures the "agent invents what's in scope"
failure mode for whole phases. The contract is no longer "Claude
reads the prose list and infers what's canonical" — it is "the
prompt enumerates the canonical set in a bash array; nothing
outside that array is reachable from any mutating path." This
removes a class of drift, not just an instance.

#### Backward compat

Zero on-disk changes for v0.7.0 / v0.7.1 / v0.7.2 / v0.7.3 install
state. The new classifier output adds explicit `OUT_OF_SCOPE` log
lines that did not exist before — dev sees their dev-custom
inventory on every re-run as part of the Phase 4.5 / 4.5b / 4.6
report. No marker shape change, no migration required.

#### Pre-commit audit caught a regression in CAP-19 itself

The first draft of CAP-19 (5 new bash loops in Phase 4.5 / 4.5b /
4.6) was written with the `printf '%s\n' "$CANONICAL_X" | while read`
shape. That is the SAME anti-pattern CAP-13 (v0.6.7) had to cure for
Phase 4.6 additive-merge: `| while` runs the loop body in a
**subshell**, so `CREATE_COUNT=$((CREATE_COUNT + 1))` inside the
body is discarded when the subshell exits. The summary print at the
end of each phase would have always shown `CREATE: 0, UPDATE: 0,
OUT_OF_SCOPE: 0` regardless of what the classifier actually did —
shipping a fake "all-zero" report that would erode dev trust in the
output.

Caught in pre-commit `grep` for `| while` across `prompts/*.md`
before push. All 5 loops rewritten to use process substitution
(`done < <(...)`), counters smoke-tested in the acme-api
scenario and confirmed to report the actual values
(`CREATE=5, SKIP=1, PRESERVE=1, OUT_OF_SCOPE=2`).

The recurring nature of this bug (CAP-13 cured one instance, CAP-19
reintroduced it during a major rewrite, audit caught it before
ship) prompted a new file: `CLAUDE.md` at the repo root now carries
an explicit **"Padrões a evitar nos prompts bash"** section
documenting this and four other recurring anti-patterns
(BRE `\|` alternation, sed `|` delimiter with literal pipe in
pattern, CRLF in regex-`$`-anchored matches, JSON.parse +
JSON.stringify on managed files, ghost variables without
fallback). Any future contributor or reading agent editing
`prompts/*.md` must re-check against this list. Removing a class
of recurring bug requires more than fixing the instance — it
requires writing down the failure mode where future maintainers
will see it.

### Fixed (v0.7.3 — CAP-17: Phase 4.2 Step D + Phase 4.3 CREATE writer canonical bash)

#### Origin (dogfood run, 2026-06-08)

The v0.7.2 dogfood re-run on a Java/Windows project captured a bug
in Phase 4.2's UPDATE-mode header rotation. The reading agent took
the prose instruction "Add or update at the very top of `CLAUDE.md`"
literally, wrote its own `sed` on the fly, and mis-escaped the
literal pipe in the marker shape:

```bash
sed -i -E 's|(<!-- RSCT_APP: acmeApi \| updated: )[0-9]{4}-[0-9]{2}-[0-9]{2}( -->)|\12026-06-08\2|' CLAUDE.md
```

The `\|` inside an ERE pattern is interpreted as **alternation**,
not as a literal pipe. The pattern split into "match-A OR match-B"
where match-B (`updated: [date]`) also fits the adjacent
`<!-- RSCT_UNIVERSE: acme-universe | updated: 2026-06-06 -->`
line. The agent's `sed` rotated **both** dates — the second
collaterally — and the dev had to revert manually before commit.

#### Root cause

Phase 4.2 Step D was **prose-only**: "Add or update at the very
top of CLAUDE.md ... `<!-- RSCT_APP: [APP_NAME] | updated: [YYYY-MM-DD] -->`".
No canonical bash block. CAP-15 added an execution mandate, but
the mandate only forces literal execution of code blocks that
**exist**; prose still required the agent to invent the writer.

Phase 4.3 (CREATE mode) referenced "Apply Step D version header"
— same issue, no canonical bash. Step C beside it was also
prose ("replace [TEST_FRAMEWORK_PLACEHOLDER] ... replace
[PROTECTED_BRANCHES_PLACEHOLDER] ... list sensitive variables in
§E") but all three placeholders had been removed from the
canonical `rules/` files in earlier sweeps — Step C was 100%
dead-code instruction for years.

#### Fix — Phase 4.2 Step D (UPDATE mode rotation)

Replaces prose with a canonical bash block:

- `#` sed delimiter (not `|`) so the literal pipe in the marker
  shape needs no escape and cannot be misread.
- Literal pipe inside the pattern is expressed as `[|]` (POSIX
  character class) — no `\|` (GNU/BSD extension with conflicting
  semantics).
- Whitespace is `[[:space:]]+` so dev whitespace edits do not
  break the match.
- Pattern anchors on `RSCT_APP:[[:space:]]+${APP_NAME}` exactly —
  it will NEVER match `RSCT_UNIVERSE`, `RSCT_VERSION`, or any
  other marker shape sharing ` | updated: `.
- Post-write sanity check: `grep -q ... ${APPLIED_AT_DATE}`
  confirms the rotation landed. Any failure surfaces vocally
  on stderr (same idiom as Phase 4.4 applied_at, Phase 4.4b
  spec_*.md backfill).
- Portable across GNU sed (Linux + Git Bash) and BSD sed (macOS)
  via `case "$(uname -s)"`.

#### Fix — Phase 4.3 CREATE writer canonical bash

The Phase 4.2 Step D bash is UPDATE-mode only (header must
already exist). To keep the **first install** flow working, Phase
4.3 needs an explicit writer that **inserts** the `RSCT_APP`
header line into the rendered template. v0.7.3 adds it:

- `tr -d '\r' < template | sed -E "s#\[APP_NAME\]#...#g"`
  renders the template with placeholder substitution + CRLF
  normalization (mirror of the CAP-10 SHA pipeline fix).
- `awk -v line="<!-- RSCT_APP: ... | updated: ... -->"
  '{print} /^<!-- RSCT_VERSION:/{print line}'` inserts the
  RSCT_APP line right after the RSCT_VERSION line. POSIX awk,
  portable.
- Tempfile + atomic `mv` survives mid-stream awk failure.
- Post-write sanity check confirms the line landed.

The CLAUDE.md template (`doc-templates/CLAUDE.md.template`)
**intentionally does not** carry a `RSCT_APP` line — the date
rotates per-run and Phase 4.2 Step D rotates it in-place via
canonical sed. Keeping the template date-free preserves the
file's content-SHA marker stability across re-runs.

#### Step C removed (was dead-code for years)

Earlier versions of Phase 4.2 instructed Claude to substitute
three placeholders in the just-inserted rule sections:
- `[TEST_FRAMEWORK_PLACEHOLDER]` (in §G) — removed from
  `rules/G-testing.md` during CAP-15 audit (rewritten to point
  at `.rsct.json → test_framework`).
- `[PROTECTED_BRANCHES_PLACEHOLDER]` (in §D) — never made it
  into `rules/D-branch-protection.md`.
- "Project-specific variables" subsection in §E — never made it
  into `rules/E-secrets-leak.md`.

Step C had zero concrete placeholders to substitute since at
least CAP-15. v0.7.3 removes the prose entirely and documents
the historical context in a one-paragraph note (so future
readers don't go looking for "Step C" in git history). Future
template-side additions of similar placeholders should ship
with the canonical bash writer alongside, not as prose
instruction.

#### Smoke-tested both flows

```
=== CREATE: render template + insert RSCT_APP header ===
<!-- RSCT_VERSION: 1.0.0 -->
<!-- RSCT_APP: MyApp | updated: 2026-06-08 -->     ← inserted
<!-- Generated by RSCT Framework v1.0.0 -->

# CLAUDE.md — MyApp                                ← [APP_NAME] substituted

=== UPDATE 1 day later with coexisting RSCT_UNIVERSE ===
<!-- RSCT_VERSION: 1.0.0 -->
<!-- RSCT_APP: MyApp | updated: 2026-06-09 -->     ← rotated
<!-- Generated by RSCT Framework v1.0.0 -->
<!-- RSCT_UNIVERSE: my-universe | updated: 2026-01-01 -->  ← UNTOUCHED ✓
```

The exact bug from the dogfood run (RSCT_UNIVERSE collaterally
modified) is no longer reachable: the new sed pattern cannot
match `RSCT_UNIVERSE` because it anchors on the literal
`RSCT_APP:` prefix + the exact `${APP_NAME}` value.

#### Backward compat

Zero on-disk changes for v0.7.0 / v0.7.1 / v0.7.2 install state.
Projects installed before v0.7.3 already have the correct
`<!-- RSCT_APP: ... -->` header (the prose path worked when the
agent escaped correctly; the bug only fired when the agent
chose `|` as the sed delimiter — narrow window). v0.7.3 just
makes the writer explicit so the same agent cannot make the
same escape mistake on the next re-run.

#### CAP-18 hardening — two additional prose-interpretation surfaces
#### closed in the same ship

The CAP-17 post-fix audit surfaced two adjacent prose-only
surfaces that carried the same class of risk (agent inventing
its own writer on the fly). Both were classified as "non-blocking
medium" in the audit summary but shipped in v0.7.3 anyway because
keeping prose-interpretation risk in the framework after the CAP-15
mandate is exactly the failure mode the mandate was written to prevent.

**AUDIT-A — `prompts/03-uninstall.md` Phase 4.2 `<§X>` excision:**

Previously, Phase 4.2 showed a single example `sed -i '/<!-- RSCT-§F-BEGIN/,/<!-- RSCT-§F-END/d'`
and instructed the agent to "adapt for each section in scope". The
example was correct (single `/` sed delimiter, no `|` alternation
risk), but every re-run required the agent to interpret "in scope"
into a list, then write one sed per section. Prose-interpretation.

v0.7.3 replaces that with an explicit canonical bash loop that
iterates over a `SECTIONS_TO_REMOVE` variable. The variable defaults
to `"0 A B C D E F G H"` (full uninstall) when unset — the most
common case — and is overridable for selective uninstalls
(`SECTIONS_TO_REMOVE="F G"`). Each iteration verifies the marker
pair is present before the sed runs, runs the sed, then verifies
the BEGIN marker is gone before logging success. Smoke-tested:

```
CASE 1: SECTIONS_TO_REMOVE unset (fallback default) → excises every
        present §X, no-ops absent ones, canonical-source intact ✓
CASE 2: SECTIONS_TO_REMOVE="F G" → excises only §F + §G, leaves
        §0 + §A + canonical-source intact ✓
CASE 3: SECTIONS_TO_REMOVE="Z" (non-existent) → file unchanged ✓
```

**AUDIT-B — `prompts/02-canonical-source.md` Phase 4 UPDATE-mode preamble:**

Phase 4 of `/rsct-canonical-source` writes a multi-line markdown
block into `CLAUDE.md`. The block carries placeholders Claude must
resolve from Phase 3 dev answers (hosts, roles, paths) — that part
is legitimately Claude-decided and stays prose. But the **mechanical
prerequisite** (detect existing canonical-source block and excise
it before re-insertion) was also prose-only. An agent that
forgets the excision on re-run would write a second canonical-source
block alongside the old one, breaking `/rsct-uninstall`'s
marker-pair detection contract.

v0.7.3 adds a canonical bash **preamble** in Phase 4 that handles
the excision mechanically — same `sed` range-delete pattern as
`03-uninstall.md` Phase 4.3, with a post-excise sanity check that
both markers are gone. The markdown block below the preamble is
unchanged (single source of truth for the section's shape and
Claude-decided fields). Smoke-tested:

```
CASE 1: UPDATE mode (existing block present) → block excised,
        coexisting §0 intact ✓
CASE 2: CREATE mode (no existing block) → file unchanged, prose
        path proceeds normally ✓
CASE 3: Mixed RSCT-§F + RSCT-§G + canonical-source → canonical
        excised, §F + §G untouched ✓
```

**AUDIT-C — `prompts/01-setup.md` Phase 4.4 BRE alternation portability:**

The Phase 4.4 `.rsct.json` placeholder sanity check was using GNU
BRE alternation:

```bash
grep -q '\[\(APP_NAME\|ORG_SLUG\|...\)\]' "$RSCT_JSON"
```

POSIX BRE does **not** include alternation — `\|` is a GNU extension
that BSD `grep` (the default on macOS) does not honor in BRE mode.
On macOS, the sanity check would have silently failed to detect
unsubstituted placeholders, leaving the malformed `.rsct.json` in
place after a botched render.

Replaced with POSIX ERE (`-E` flag, no escaping), which honors
alternation across every grep implementation:

```bash
grep -qE '\[(APP_NAME|ORG_SLUG|...|PROTECTED_BRANCHES_JSON_ARRAY)\]' "$RSCT_JSON"
```

Same semantics, portable everywhere. Smoke-tested in GNU grep
(Git Bash): matches placeholder, rejects non-placeholder, no
false positive on real values.

#### Why CAP-18 ships in v0.7.3 (not as a separate v0.7.4)

The CAP-17 audit explicitly framed AUDIT-A and AUDIT-B as
non-blocking medium priority. Decision to consolidate into the
same ship: (a) both surfaces are exactly the kind of
prose-interpretation surface the CAP-15 execution mandate
exists to prevent, so deferring them weakens the mandate's
implicit contract with the agent; (b) shipping them separately
forces every consumer through two version bumps and two
install.sh runs; (c) smoke coverage is complete in all 6
test cases, and neither change touches code that ran in v0.7.2
production (the canonical bash blocks are net-new, not rewrites
of pre-existing behavior). Backward compat: zero on-disk
changes for any v0.7.x install state.

### Fixed (v0.7.2 — CAP-16 follow-up: CRLF tolerance + post-backfill sanity in Phase 4.4b)

A post-merge audit of v0.7.1 against the CAP-16 backfill block surfaced
two issues — one medium-severity functional bug specific to Windows
(the primary target platform), one defense-in-depth gap. Both shipped
in v0.7.2 as a same-day follow-up because the entire feature surface
of v0.7.1 (the backfill itself) was vulnerable.

#### Issue A — `$` anchor over a CRLF-terminated `.gitignore`

The v0.7.1 backfill used:

```bash
awk '/^progress_\*\.md$/{print; print "spec_*.md"; next} 1' "$GITIGNORE" ...
```

When `.gitignore` lands on disk as `progress_*.md\r\n` (real
CRLF — e.g., committed with `.gitattributes` `* text eol=crlf`,
edited in a Windows editor that writes CRLF, or pulled from a
remote that normalized the file that way), the awk `$` anchor
refuses to match: the trailing `\r` falls between `.md` and the
end-of-record, and `^progress_\*\.md$` no longer fits the
record. awk processes every line through the trailing `1`
(catch-all print rule), producing a byte-identical copy of
the input. `spec_*.md` is never inserted.

The failure would be **silent**: the `! grep -qF "spec_*.md"`
pre-check passes (grep without `-x` is tolerant to trailing
CR), the awk pipeline exits 0, the `mv` succeeds, and the
`echo "  CAP-16 backfill: added ..."` line prints. A dev
watching the run sees a success message that does not match
disk state.

Smoke-tested on Git Bash on Windows: in that specific
combination, the shell `>` redirect normalized CRLF → LF
before the file landed on disk, masking the bug. The fix is
still applied because (a) other write paths (editors, CI
pipelines, `git checkout` with eol=crlf attribute) deliver
real CRLF; (b) the `tr -d '\r'` cost is one extra syscall;
(c) the failure mode it removes is silent and confusing to
debug after the fact.

#### Fix A — prepend `tr -d '\r'` and add a post-write sanity check

```bash
tr -d '\r' < "$GITIGNORE" \
  | awk '/^progress_\*\.md$/{print; print "spec_*.md"; next} 1' \
  > "${GITIGNORE}.tmp" && mv "${GITIGNORE}.tmp" "$GITIGNORE"

if grep -qF "spec_*.md" "$GITIGNORE"; then
  echo "  CAP-16 backfill: added spec_*.md alias to existing RSCT .gitignore block"
else
  echo "  ⚠ CAP-16 backfill: spec_*.md insertion did not land — inspect $GITIGNORE manually" >&2
fi
```

`tr -d '\r'` normalizes CRLF → LF in the awk input, so the
pattern match works regardless of how git's autocrlf setting
materialized the file. The output is written in LF; if the dev's
git config wants CRLF in the working tree, the next checkout
will re-apply it. Round-trip is invisible to the dev's diff.

#### Issue B — silent no-op was indistinguishable from success

Even with the CRLF cause fixed, the v0.7.1 shape would still
fall into silent no-op for any future failure mode (a missing
`progress_*.md` line in a hand-edited block, an unusual EOL
variant, etc.).

#### Fix B — vocal sanity check after every backfill attempt

The new `if grep -qF "spec_*.md" "$GITIGNORE"; then ... else
echo "⚠ ... insertion did not land" >&2; fi` post-write check
**verifies the line is actually in the file** before logging
success. Any failure surfaces vocally on stderr ("inspect
manually") instead of silently printing a misleading success
line. Same defense-in-depth idiom used in Phase 4.4 applied_at
rotation (`grep -q ... || exit 1`).

#### Backward compat

Zero on-disk changes for v0.7.0 or v0.7.1 install state. The
v0.7.2 patch only changes the awk pipeline shape; the inserted
line, marker shape, and idempotency contract are unchanged.

### Fixed (v0.7.1 — CAP-16: Phase 4.4b backfills `spec_*.md` into pre-v0.7.0 `.gitignore` blocks)

#### Symptom

The v0.7.0 dogfood re-run (acme-api) surfaced a gap in
Phase 4.4b's idempotency: the `.gitignore` RSCT block was managed
by BEGIN/END markers, but the idempotency check was scoped to
"is the BEGIN marker present?" only. Re-runs on projects set up
before v0.7.0 therefore took the **no-op branch** even though
the canonical block had gained a new pattern line (`spec_*.md`,
shipped in v0.7.0 as the defensive alias of `plan_*.md`). The
new pattern never landed on existing projects — the alias rule
was inert for the entire pre-v0.7.0 install base.

The dogfood instance flagged it correctly in its discovery
report (`⚠ Conteúdo legado: NÃO inclui spec_*.md … o bloco
NÃO será atualizado automaticamente`) but had no path forward
short of manual edit by the dev.

#### Root cause

`prompts/01-setup.md` Phase 4.4b expanded the
`$PATTERN_BLOCK` heredoc in v0.7.0 to include
`spec_*.md` between `progress_*.md` and the runtime-state
comment. The downstream conditional, however, was unchanged:

```bash
if [ "$HAS_NEW_BLOCK" = "yes" ]; then
  : # already managed by markers, no-op
elif ...
```

`HAS_NEW_BLOCK=yes` resolves on a v0.6.x marker just as it
does on a v0.7.0 marker. There was no per-pattern check.

#### Fix

Replace the `:` no-op with a per-pattern backfill that scans for
each pattern line individually and inserts the ones missing,
without rewriting the BEGIN/END markers (so idempotency tracking
stays intact). v0.7.1 backfills only `spec_*.md` (the single
v0.7.0 addition); future additions follow the same pattern.

```bash
if [ "$HAS_NEW_BLOCK" = "yes" ]; then
  if ! grep -qF "spec_*.md" "$GITIGNORE"; then
    awk '/^progress_\*\.md$/{print; print "spec_*.md"; next} 1' \
      "$GITIGNORE" > "${GITIGNORE}.tmp" && mv "${GITIGNORE}.tmp" "$GITIGNORE"
    echo "  CAP-16 backfill: added spec_*.md alias to existing RSCT .gitignore block"
  fi
elif ...
```

Why `awk` instead of `sed -i`:
- POSIX awk is portable across GNU (Git Bash / Linux) and BSD
  (macOS) without per-OS dispatch — `sed -i` requires `-i ''`
  on BSD and `-i` on GNU.
- Tempfile + atomic `mv` survives a mid-stream awk failure
  (the `.gitignore` is not left half-written).
- `awk` handles the "append after match" pattern cleanly
  without quoting newlines in the replacement.

Why `grep -qF "spec_*.md"` (literal, no regex):
- The `*` inside `spec_*.md` is a literal glob character, not
  a regex metacharacter; `-F` (fixed string) skips regex
  interpretation entirely.
- Re-running setup after the backfill is a clean no-op: the
  next `grep` finds the line and the awk pass never runs.

#### Backward compat

Zero on-disk changes for v0.7.0-installed projects (`spec_*.md`
is already in their block from the canonical write). v0.7.1 only
acts on **pre-v0.7.0** projects on their next `/rsct-setup` run,
and only inserts the single line. No marker shape change, no
re-run side effects.

### Changed (v0.7.0 — CAP-15: execution mandate + reformat-safe canonical writers)

**Why this is a minor bump (0.6.x → 0.7.0):** CAP-15 changes the
**execution contract** of the framework prompts, not a single
mechanism. Every Claude instance reading `prompts/01-setup.md` now
operates under explicit constraints about how to handle the canonical
code blocks. Existing projects are unaffected (no on-disk shape change);
the change is visible in re-runs through new `CHECKPOINT:` log lines
and in the absence of cosmetic JSON reformats.

#### Origin: dogfood run on v0.6.7 (2026-06-08)

A re-run of `/rsct-setup` against a third real dogfood project (after
two earlier rounds against a Java/Windows project) surfaced a new
failure mode: the Claude instance executing the prompt **wrote its
own classifier in Node** (`rsct-apply.js` in `/tmp`) instead of
executing the canonical bash from `prompts/01-setup.md` Phase 4.5 /
4.5b / 4.6. The Node port was correct in its content-SHA logic — but
it also wrote `.rsct.json` via `JSON.stringify(json, null, 2)`,
reformatting the `protected_branches` array from single-line to
multi-line. That reformat surfaced in the dev's commit diff as a
non-functional change the dev now had to review and approve, alongside
the legitimate `applied_at` rotation.

Root cause: the prompt **already used Node** in Phase 4.4
(`secrets_extra_patterns` merge) and Phase 4.V.c (SessionStart hook
install). The reading instance generalised "Node is fine for state
writes" from those two blocks to the whole prompt — and that
generalisation broke idempotency by introducing reformat.

#### Fixes shipped in this release

**P0 #1 — `applied_at` rotation now uses `sed -i` in-place**
(`prompts/01-setup.md` Phase 4.4). Replaces the prior prose-only
direction "update install.applied_at" (which the dogfood instance
interpreted as "JSON.parse → modify → JSON.stringify") with an
explicit, canonical bash block that swaps **only** the value between
the existing quotes. Every other byte of `.rsct.json` (whitespace,
key order, array shape) stays byte-stable. Portable across GNU sed
(Linux + Git Bash) and BSD sed (macOS); sanity check confirms the
field was found and updated. Cures the reformat observed in the
2026-06-08 dogfood run.

**P0 #4 — `secrets_extra_patterns` merge no longer round-trips
through JSON.parse / JSON.stringify** (`prompts/01-setup.md` Phase 4.4).
The previous Node block parsed the whole file, modified the array, and
re-serialised — that re-serialisation was the second reformat surface
in `.rsct.json`. The new block keeps `node -e` (regex-array boundary
detection is hard in POSIX BRE) but operates as **read+regex+text-splice
only**: locates the `secrets_extra_patterns` array in the raw file text,
splices the new entries into the matched region, and writes the file
back. The rest of `.rsct.json` keeps its formatting byte-for-byte.

**P0 #2 / #3 — `.claude/settings.json` install + scrub marked as
documented EXCEPTION**. The hook install (`01-setup.md` Phase 4.V.c)
and the hook scrub (`03-uninstall.md` Phase 4.V.a-uninstall) still
use `JSON.parse → JSON.stringify` because the hook entry is nested
(`hooks.SessionStart[].hooks[]`) and a text-based regex insertion
cannot guarantee correct array boundary handling across the legitimate
variability of dev-customized settings.json shapes. Both blocks now
carry an explicit `EXCEPTION: structured merge required` comment so
future readers know this is **the only** reformat surface in the
framework, and is intentional. Symmetric prose on both sides.

**P1 #5 — Execution mandate**: new section near the top of
`prompts/01-setup.md` (immediately after "Absolute rules") states the
contract explicitly:
1. Execute every code block **literally**; no translation to Node /
   Python / PowerShell.
2. Do NOT consolidate multiple Phase blocks into a single helper script.
3. Do NOT reformat managed files (the `.claude/settings.json` blocks
   are the only documented exception).
4. Reaching for an external script bypasses the framework — STOP.
5. CHECKPOINT lines surface obedience in the dev's terminal.

**P1 #6 — Phase 4.6 UPDATE wording** changed from "Same as CREATE
(overwrites the file with the new resolved body + fresh marker)" to
an explicit instruction to execute the **same bash pipeline** as
CREATE — same `tr -d '\r'` normalization, same `printf '%s\n' "$BODY"`
writer, same marker shape. Closes the prose-vagueness CAP-14 fix had
left behind.

**P3 #11 — CHECKPOINT echoes** added at the top of every mutating
bash block: Phase 4.1 (branch creation), 4.4 (applied_at + secrets),
4.4b (.gitignore), 4.5 (documentation CREATE), 4.6 (memory classifier),
4.V.c (SessionStart install), 4.V.a-uninstall (SessionStart scrub).
Each line reads `echo "  CHECKPOINT: Phase X.Y executing canonical
bash"`. Devs now have a positive signal in the terminal that the
canonical path ran; absence of the line is a red flag that the prompt
was bypassed.

**P2 #8 — `mcp-server/package.json` "version" synced from "0.2.1" to
"0.7.0"** (lockstep with `version.ts`). The dessynced package.json was
the reason the dogfood install.sh re-run reported "up to date" from
npm even after the binary had changed across CAP-9 → CAP-14: npm sees
package.json's "0.2.1" and considers any global install at "0.2.1"
already current. CAP-15 also adds a docstring at the top of
`version.ts` reminding future maintainers to bump both files together,
since the symptom (silent skip of the new binary) is invisible without
inspecting `npm list -g` against `version.ts` runtime output.

#### Backward compatibility

Zero on-disk changes for existing projects. The first re-run of
`/rsct-setup` after v0.7.0 will:
- Print new CHECKPOINT lines (informational only).
- Rotate `applied_at` via the new `sed -i` path (single-line edit
  instead of full-file reformat — diff is now exactly 1 line).
- Merge `secrets_extra_patterns` via text splice instead of
  JSON.stringify — `.rsct.json` formatting now stable across re-runs.

No marker shape change, no migration needed. Projects already
installed on v0.6.7 with reformatted `.rsct.json` from
dogfood-style runs will keep their reformat — v0.7.0 only stops creating **new**
reformats; it does not unwind past ones (low cost, dev can manually
revert if they care).

#### Audit sweep expansion (added 2026-06-08)

After the initial CAP-15 fixes landed, the dev requested an end-to-end
**audit-level sweep** of every file that could affect a client install
(framework + documentation + templates), with the stated rationale
that *"most users will click yes blindly trusting the framework so there
can be no errors or gaps"*. The sweep uncovered 11 additional issues
that were grouped and fixed in the same CAP-15 ship:

**Leak fixes (L1–L5)** — identity / IP exposure that would propagate
to every client install:

- **L1**: `LICENSE` copyright line shortened from a personal-brand
  attribution to `RSCT Framework Contributors` (open-source convention).
- **L2**: `mcp-server/LICENSE` was missing entirely despite
  `package.json` declaring MIT — created with the same MIT text.
- **L3**: `doc-templates/knowledge/team-capabilities.md.template`
  carried real-team examples (named individuals, company names,
  load-level commentary, deadlines). Examples replaced with neutral
  placeholders (alice, bob, carol, Acme Corp, Project Atlas, generic
  dates). Same template ships to every client install — the leak was
  high-blast-radius.
- **L4**: `doc-templates/knowledge/stakeholder-map.md.template`
  carried `CFO (Acme)` in the example. Sanitized to `Acme Corp`.
- **L5**: Nine other knowledge templates carried `Captured: 2026-06-03
  by raphael`-style stamps in their example sections (the canonical
  "good example" inside every schema file). Stamps and authoring
  attribution sanitized to `2025-10-15 by alice`. Same fix applied
  in `doc-templates/infrastructure.md.template`, the matching
  `sample-rsct` test fixture, and the `anti-decisions.test.ts`
  vitest fixture.

**Structural bugs (B1–B6)** — defects in templates / prompts that
would surface during real install / re-run:

- **B1**: `doc-templates/rsct.json.template` had
  `"protected_branches": ["main", "test"]` hard-coded. On a real
  install, Phase 1.4 of `01-setup.md` detects the actual protected
  set (typically adding `master` and `dev`) but the render path
  ignored it — the rendered `.rsct.json` would say `["main", "test"]`
  while the project actually had four. Replaced the hard-coded array
  with a `[PROTECTED_BRANCHES_JSON_ARRAY]` placeholder; added a
  canonical bash CREATE-mode renderer in `01-setup.md` Phase 4.4
  that converts the space-separated `PROTECTED_BRANCHES` (Phase 1.4
  capture) to a JSON array via `tr | sed | paste -sd, -` and
  substitutes it through.
- **B2**: `universe-templates/CLAUDE.md.template` line 2 had
  `Generated by RSCT Framework — https://github.com/<your-org>/rsct-framework`
  with the literal `<your-org>` placeholder. `/rsct-init-universe`
  Phase 3.2 only substitutes `[ORG_SLUG]`, `[CREATED_AT]`,
  `[GITHUB_REMOTE]` — `<your-org>` was never resolved, so the
  link landed on every client universe as a dead link. Removed
  the dead URL and replaced the marker with the canonical
  `RSCT-GENERATED v=1.0.0 created=[CREATED_AT]` shape so Phase 3.2
  substitution catches the timestamp.
- **B3 + B4**: `prompts/04-init-universe.md` had none of the CAP-15
  hardening that `01-setup.md` got. Added a parallel execution
  mandate at the top, `CHECKPOINT:` echoes at the start of each
  mutating bash block (Phase 3.1, 3.2, 3.3), and rewrote the
  template-render block in Phase 3.2 to (a) use `|` as the sed
  delimiter (was mixed `/` and `|` — `/` would break on a
  `GITHUB_REMOTE` URL) and (b) prepend `tr -d '\r'` to normalize
  Windows CRLF before substitution (matching the CAP-10 fix
  applied in `01-setup.md`).
- **B5**: `universe-templates/README.md.template` had no marker at
  all, so a re-run of `/rsct-init-universe` could not distinguish
  the framework-rendered file from a fresh dev-authored one.
  Added the canonical `RSCT-GENERATED v=1.0.0 created=[CREATED_AT]
  kind=universe-readme` marker line at the top.
- **B6**: `universe-templates/CLAUDE.md.template` carried a third
  marker shape (`RSCT-UNIVERSE-VERSION: 1.0.0`) distinct from the
  `RSCT-GENERATED` shape on every doc/memory template AND the
  `RSCT_VERSION` shape on the project's `CLAUDE.md.template`. Unified
  to `RSCT-GENERATED v=1.0.0 created=[CREATED_AT] kind=universe-claude-md`
  — same prefix as the rest, with a `kind=` discriminator for
  files that don't carry a body SHA. Two shapes total now: the
  hashed body marker (`RSCT-GENERATED ... sha256-body=...`) on
  files where CAP-10 / CAP-12 SHA semantics apply, and the unhashed
  marker (`RSCT-GENERATED ... kind=...`) on files where Phase 3.2
  idempotency relies on file-presence instead of body SHA.

**Repo hygiene**:
- 6 orphan `plan_*.md` / `progress_*.md` files at repo root (left over
  from an aborted dogfood-bootstrap attempt — see
  `project_rsct-framework-estado-a` memory) were already gitignored,
  so they never reached the published repo. No action needed in this
  ship beyond confirming they are not tracked.
- `mcp-server/README.md` line 183 had a personal-name reference
  ("Windows for Raphael") in a sign-off checklist. Generalised to
  "primary maintainer platform".

**`README.md` Medium link kept** at line 3 (`medium.com/@raphael.fnds`)
as legitimate attribution to the original conceptual paper — same
convention as a research paper citation; not classified as a leak.

#### `spec_*.md` accepted as a naming alias of `plan_*.md`

Devs reading the prompts may name a plan-tracking artefact `spec_<slug>.md`
instead of `plan_<slug>.md` — the M3 phase machine already uses "spec"
terminology (`rsct_phase_spec_start`, `spec_ref`), so the alias arises
naturally. Until v0.7.0 this name was unrecognised: the file would be
**tracked by git** (no gitignore match) and the dev could accidentally
push a working spec to `main` / `test`.

v0.7.0 treats `spec_*.md` as a **defensive alias** of `plan_*.md` with
the same semantics — same gitignore rule, same NEVER-on-protected
guarantee, same template (`doc-templates/plan_slug.md.template`). The
canonical name remains `plan_<slug>.md`; the alias is only used when
the dev explicitly asks for "spec" wording.

Sites updated (7):
- `.gitignore` (framework root): added `spec_*.md` + matching
  `!mcp-server/tests/fixtures/**/spec_*.md` exception line.
- `prompts/01-setup.md` Phase 4.4b: `.gitignore` block now writes
  three gitignore patterns (`plan_*.md`, `progress_*.md`, `spec_*.md`).
  Inline comment notes the alias semantics.
- `prompts/03-uninstall.md` legacy-block warning: cleanup hint now
  mentions `spec_*.md` so dev knows to remove it when scrubbing
  a pre-marker (legacy) RSCT block.
- `rules/B-architect-plan.md` item 6: explicit "Accepted alias"
  paragraph documenting the rule.
- `memory-templates/feedback_plan-tracking.md`: pre-merge check now
  scans `spec_*.md` too; alias paragraph at the end.
- `memory-templates/MEMORY.md.template`: index entry mentions
  the alias.
- `README.md` "Done" section: prose mentions alias.

**NOT changed in v0.7.0** (defer to a future CAP if real friction
surfaces):
- `mcp-server/src/lib/plan.ts`, `mcp-server/src/resources.ts`, and the
  M3 phase tools still look up `plan_<slug>.md` only. The MCP recall
  surface (`rsct://plan` resource, `rsct_load_context` active-plan
  field) continues to scan for `plan_<slug>.md` specifically. A dev
  that names the artefact `spec_<slug>.md` will get an empty result
  from `rsct_load_context`'s active-plan field — a minor
  observability gap, not a correctness gap. If this surfaces during
  dogfood, the fix is one regex broaden in `plan.ts`'s glob.
- `examples/java-spring/CLAUDE.md` keeps the canonical-only wording
  to model the recommended naming convention.

#### Final audit pass — 3 last-mile fixes (added 2026-06-08, before commit)

A second "audit-level" sweep before the CAP-15 commit landed surfaced
three items the previous passes had missed. All three would have
shipped to clients otherwise.

- **`doc-templates/progress_slug.md.template:6`** — the inline link
  `Plan: [plan_[TASK_SLUG].md](plan_[TASK_SLUG].md)` was malformed
  markdown: the `[` / `]` inside the link **text** close the link
  prematurely, leaving the renderer with broken syntax even after
  `[TASK_SLUG]` substitution (Phase 4.5 of `01-setup.md` copies
  templates as-is, no link rewriting). Replaced with inline-code
  `Plan: \`plan_[TASK_SLUG].md\`` — robust at any rendering stage,
  plus a parenthetical noting the `spec_<slug>.md` alias.
- **`doc-templates/plan_slug.md.template` warning** — the "branch-local
  file" warning told the dev `git add --force plan_[TASK_SLUG].md`
  without mentioning the `spec_<slug>.md` alias from §B item 6. A dev
  who picked the spec alias would see the wrong filename in the
  warning and either ignore it or rename. Updated to mention both
  canonical and alias forms (`progress_slug.md.template` got the
  same change in the same pass).
- **`prompts/02-canonical-source.md`** — the third prompt in the
  framework was the only one without the CAP-15 execution mandate or
  `CHECKPOINT:` echoes. Added a parallel **execution mandate** block
  right after Absolute rules (same 5-clause structure as `01-setup.md`
  and `04-init-universe.md`) PLUS the explicit guarantee that the
  Phase 4 **markdown content** is also canonical and must be inserted
  byte-for-byte — the `<!-- RSCT-CANONICAL-SOURCE-BEGIN -->` / `END`
  markers are the contract `/rsct-uninstall` depends on for detection
  and removal. Added `echo "  CHECKPOINT: Phase X.Y executing canonical
  ..."` lines to all five Phase 1 bash blocks (1.1 identity, 1.2 local
  path, 1.3 section detection, 1.4 URL normalization, 1.5 read-only
  `.rsct.json` inspection). Phase 5's `.rsct.json` mutation is explicitly
  pointed at the canonical `sed -i -E` pattern from `01-setup.md` Phase
  4.4 — closing the JSON-stringify reformat surface for the third
  prompt too.

#### `scripts/uninstall-framework.sh` simetria de versão

`install.sh` was updated in this release to write **both**
`~/.rsct/VERSION` (protocol) and `~/.rsct/VERSION-CODE` (code). The
uninstall script was reading only the legacy `VERSION` file and
displaying `(v1.0.0)` regardless of which code release was actually
installed — confusing for the dev clicking yes on a "Will remove"
prompt that hides the real release identity. v0.7.0 reads both files
and emits a three-state tag:

- `(protocol=1.0.0, code=0.7.0)` — post-v0.7.0 install (both files
  present).
- `(v1.0.0)` — pre-v0.7.0 install (legacy VERSION only).
- `(no version metadata)` — directory exists but no version markers
  (manually-created `~/.rsct/` or a broken install).

The `rm -rf "$RSCT_HOME"` line already removed both files in one
shot; this fix is purely about *display* before the dev confirms.
Audit reviewed for prose-only paths / JSON.stringify on managed
files / leaks of identity / asymmetries with `install.sh` — none
remaining.

### Fixed (v0.6.7 — CAP-13/14: Phase 4.6 additive-merge becomes executable + auto-detects MEMORY.md entry style)

#### CAP-13 — Additive merge for PRESERVE_WITH_WARNING was prose, not bash

- **Symptom:** when `Phase 4.6` classified a project's MEMORY.md as
  `PRESERVE_WITH_WARNING` (user customized the index), the additive
  merge that should append template entries missing from the user's
  file was described only as prose ("Append only lines from the new
  template that are not present in the current MEMORY.md"). The
  Claude executing the prompt had to interpret that into action; in
  practice on the v0.6.6 dogfood run against the first dogfood project (Java + Windows)
  (2026-06-07), the merge was silently skipped — the new
  `feedback_session-bootstrap.md` entry shipped in CAP-11 was
  CREATEd in the memory directory, but the MEMORY.md index never
  picked up the matching line. The dev had to insert it manually
  via `sed`.

- **Root cause:** every other Phase 4.6 action (CREATE / UPDATE /
  SKIP / PRESERVE classification + marker write) ships as executable
  bash inside a fenced code block. Only the PRESERVE additive merge
  path was prose-only — easy for an LLM to read and shrug off as
  "no-op" when the file is already there.

- **Fix:** replaced the prose paragraph with an explicit bash block
  inside `prompts/01-setup.md` Phase 4.6. The block walks every
  `feedback_*.md` referenced in the incoming template, checks
  presence in the user file with `grep -qF`, and appends the
  matching template line when absent. Uses process substitution
  (`done < <(...)`) instead of `| while` so the `APPENDED` and
  `UNKNOWN_STYLE` counters survive the loop body (the latter would
  vanish in a subshell). POSIX-BRE only — portable across Git Bash
  / Linux / macOS sed.

#### CAP-14 — MEMORY.md entry-style detection (templates vs markdown link)

- **Symptom:** the the first dogfood project (Java + Windows) MEMORY.md is customized to use
  markdown links (`- [Title](feedback_*.md) — description`) rather
  than the framework template style
  (`- **Title** — description → \`feedback_*.md\``). The CAP-13 fix
  appended the new entry verbatim from the template — visually
  inconsistent next to the customized ones, and not clickable in
  IDE preview. The dev normalized manually with a second `sed`.

- **Fix:** the new additive-merge bash now detects the user's entry
  style from the first existing `feedback_*.md` reference in their
  MEMORY.md and converts each appended line accordingly:
  - `USER_STYLE=template` — template line copied verbatim.
  - `USER_STYLE=link` — template line parsed (`sed -n` extracts
    `TITLE` from `**...**` and `BODY` from between `— ` and ` → \`...\``),
    then rewrapped as `- [TITLE](FB_FILE) — BODY`.
  - `USER_STYLE=unknown` (neither pattern matched) — falls back to
    template style and increments `UNKNOWN_STYLE` so the Phase 5
    WARN fires for the dev to review.
  - `USER_STYLE=template` is also the default for an empty MEMORY.md.

- **Why two styles, not more:** the variant space (bold + arrow,
  markdown link, plain item, emoji prefix, indentation, …) is
  open-ended. We support the two we have observed in real use
  (framework default + the most common dev customization) and emit
  a WARN for everything else, so the framework stays predictable
  and the dev keeps full control over presentation quirks.

- **Smoke-tested 2026-06-07:** ran the new sed extraction + the
  template→link conversion against the actual
  `memory-templates/MEMORY.md.template` and the
  `feedback_session-bootstrap.md` entry. Generated line matches
  byte-for-byte what the dev produced manually in the the first dogfood project (Java + Windows)
  session (`- [Session bootstrap — rsct-mcp entry point before §B](feedback_session-bootstrap.md) — at session start ...`).

#### Phase 5 report — three new advisories

After the additive-merge runs, Phase 5 emits one of:
- nothing (no entries appended);
- `INFO: MEMORY.md additive merge appended N entr(y|ies), auto-converted to your [title](file.md) link style.` (when `USER_STYLE=link`);
- `WARN: MEMORY.md additive merge appended N entr(y|ies) using template style because your existing entry shape did not match the two supported styles. Review the appended line(s) and normalize manually if needed.` (when `USER_STYLE=unknown` or any per-line fallback).

#### Backward compat

No marker shape change, no migration needed. Projects that already had
their MEMORY.md additive-merged manually (the first dogfood project (Java + Windows)) get a
no-op next re-run — the `grep -qF "$FB_FILE"` short-circuits when the
filename is already referenced. Projects on v0.6.5 / v0.6.6 with a
PRESERVED MEMORY.md and missing entries will pick the merge up
automatically on the next `/rsct-setup`.

### Fixed (v0.6.6 — CAP-10/11/12: EOL normalization + Phase 4.6 SHA symmetry + MEMORY.md.template index)

Three defects surfaced when the CAP-9 content-SHA classifier from v0.6.5
ran for the first time on the first dogfood project (Java + Windows) (Windows + Java repo with
`core.autocrlf` active). Bundled into a single fix branch because all
three touch the same SHA / template-index machinery and all three
require the same one-time "UPDATE storm" on existing projects.

#### CAP-10 — CRLF false positive across all SHA sites

- **Symptom:** on the first dogfood project (Java + Windows), every one of the 11
  `documentation/knowledge/*.md` files came back as
  `PRESERVE_WITH_WARNING` ("dev edited; body_sha != marker_sha") on the
  v0.6.5 re-run, even though the dev had not edited any of them. The
  same false positive would surface on every Windows project that lets
  git convert line endings between install and re-run, and would also
  classify those files as `MODIFIED` during `/rsct-uninstall`.

- **Root cause:** all three SHA-comparison sites read the body via
  `tail -n +2 "$f" | sha256_compute` and the marker was written from a
  body in LF. When `git autocrlf=true` (or `core.autocrlf=true`, or any
  `.gitattributes` rule that normalizes line endings) converts the
  working tree to CRLF after install, every byte after column 1 of
  every line shifts and the body SHA never matches the marker SHA
  again.

- **Fix:** insert `tr -d '\r'` into the pipeline at every SHA-compute
  site so the digest is invariant to line-ending normalization. Three
  sites changed:
  - `prompts/01-setup.md` Phase 4.5 CREATE example (line ~858) —
    `BODY=$(tail -n +2 ... | tr -d '\r' | sed ...)`
  - `prompts/01-setup.md` Phase 4.6 template + user body (lines
    ~954-964) — `tail -n +2 ... | tr -d '\r' | ...`
  - `prompts/03-uninstall.md` Phase 1.4 / 1.5 (line ~131) —
    `CURRENT_SHA=$(tail -n +2 "$f" | tr -d '\r' | sha256_compute)`

#### CAP-12 — Phase 4.6 SHA symmetry (discovered during CAP-10 sweep)

- **Symptom:** Phase 4.6 of v0.6.5 would never emit `SKIP` even when
  the user file body and the template body were byte-identical — the
  classifier would always fall through to `UPDATE` on every re-run.
  Hidden in the the first dogfood project (Java + Windows) session because the 9 UPDATEs there
  were genuine (the v0.6.4 body changes were real); the next re-run on
  the same project would have re-emitted 9 UPDATEs anyway.

- **Root cause:** asymmetric trailing-newline handling between the
  marker SHA and the new template SHA.
  - Phase 4.5 CREATE: writes the file via
    `{ printf '%s\n' "$MARKER"; printf '%s\n' "$BODY"; } > target`
    and the marker stores `SHA(printf '%s\n' "$BODY")`, i.e. body + 1
    trailing `\n`.
  - Phase 4.6 user-side: `tail -n +2 "$TARGET" | sha256_compute` reads
    body + trailing `\n` from disk. Matches the marker — correct.
  - Phase 4.6 template-side (v0.6.5): `printf '%s' "$TEMPLATE_BODY_RESOLVED" | sha256_compute`
    — no trailing newline. Never matches the user-side hash. SKIP
    path unreachable.

- **Fix:** change the Phase 4.6 template SHA line to
  `printf '%s\n' "$TEMPLATE_BODY_RESOLVED" | sha256_compute`. The
  inline comment in `01-setup.md` now documents the alignment with
  Phase 4.5 CREATE behavior so future edits don't reintroduce the
  asymmetry.

#### CAP-11 — `MEMORY.md.template` missing entry for `feedback_session-bootstrap.md`

- **Symptom:** v0.6.4 shipped `feedback_session-bootstrap.md` as a new
  memory entry (Phase 4.6 creates it on every fresh / updated install)
  but `memory-templates/MEMORY.md.template` was never updated with the
  matching index line. Result: even when Phase 4.6 successfully CREATEs
  the feedback file, the MEMORY.md additive-merge has nothing new to
  add, and the dev has to hand-edit MEMORY.md to surface the new entry
  in the index.

- **Fix:** added one line in `memory-templates/MEMORY.md.template`
  after the `feedback_plan-tracking.md` entry, matching the structure
  of the 9 existing entries.

#### Backward-compat — one-time "UPDATE storm" on existing projects

The CAP-10 and CAP-12 fixes change the SHA reported by every existing
file that carries an `<!-- RSCT-GENERATED ... sha256-body=... -->`
marker. On the **first** re-run of `/rsct-setup` after upgrading to
v0.6.6, existing projects will see:

- Windows with `autocrlf=true`: every previously-PRESERVE knowledge
  file flips to UPDATE (cured), then stabilizes.
- Linux/Mac (no CRLF): only memory files feel CAP-12 — one UPDATE
  per feedback file, then stabilize.

Second re-run onwards is clean. No migration script ships because the
"storm" is self-correcting (the UPDATE writes a fresh marker with the
new normalized SHA) and the cost of a migration that detects "v0.6.5-
style SHA" is higher than the one-time noise. This warning is
explicitly surfaced in the Phase 5 report so the dev recognizes the
benign churn.

### Fixed (v0.6.5 — CAP-9: content-SHA detection in Phase 4.6)

- **`prompts/01-setup.md` Phase 4.6 rewritten to detect template body
  changes by SHA256, not by protocol-version string.** The previous
  classifier compared `EXISTING_VERSION` (extracted from the user
  file's marker) with `RSCT_TEMPLATE_VERSION` (the framework's
  declared version) — both stable at `v=1.0.0` across the entire
  pre-release `v0.x` train. Result: any edit to a template body that
  did not also bump the protocol version was silently skipped on
  re-runs of `/rsct-setup`.

  Concrete drift observed and motivating this fix: v0.6.4 added new
  paragraphs about the M3 phase machine to
  `memory-templates/feedback_architect-code-changes.md` and
  `memory-templates/feedback_branch-protection.md`. A re-run of
  `/rsct-setup` on the first dogfood project (Java + Windows) correctly detected the missing §0
  rule but emitted `SKIP all other feedback_*.md (markers match
  templates)` — leaving the two updated bodies stale on disk.

  The new classifier (Option B, single code path):
  1. Reads the source template body (`tail -n +2`), applies the same
     placeholder substitutions setup would apply on CREATE
     (`[APP_NAME]` for `MEMORY.md.template`; no-op for `feedback_*.md`),
     and computes `TEMPLATE_BODY_SHA`.
  2. Reads the user file's marker SHA and computes the current body
     SHA on disk.
  3. If user body == user marker (dev did not edit) and user body !=
     template SHA → **UPDATE** (template body changed since install).
  4. If user body == user marker and user body == template SHA →
     **SKIP** (already at latest template content).
  5. If user body != user marker → **PRESERVE_WITH_WARNING** (dev
     edited; same as before).
  6. If file missing → **CREATE** (same as before).

  No marker shape change (`<!-- RSCT-GENERATED v=X created=Y
  sha256-body=Z -->` unchanged). No migration required — projects set
  up before v0.6.5 already carry `sha256-body=...` on line 1 and work
  transparently with the new classifier on the next re-run.

- **Side effect to expect:** the detector is now strictly more
  sensitive. Any body change in a source template (with the protocol
  version held stable) will surface as UPDATE on next setup. This is
  the intended behavior and matches the true semantics "is the user
  file the latest template?". The PRESERVE_WITH_WARNING flow continues
  to protect dev-edited files from being overwritten.

- **Roadmap moved:** the "Priority before tagging v1.0.0 release"
  section in [README.md](README.md) listed exactly one item
  (content-based update detection in Phase 4.6) — that section is
  now removed and the corresponding "Done" entry under "Done (in
  current dev cycle, pending first release)" was rewritten to describe
  the content-SHA mechanism.

### Added (v0.6.4 — §0 Session bootstrap rule)

- **New `rules/0-session-bootstrap.md` (§0)** — the missing bridge
  between the prose contract (§A–§H) and the M3 rsct-mcp tools.
  Discovered during runtime testing on the first dogfood project (Java + Windows)
  (2026-06-07): a task "add password-change confirmation email" was
  implemented without `rsct_status` / `rsct_classify_task` / any
  phase tool, leading to direct `Edit` on a protected branch with no
  scope contract and no auditable approval. Root cause: §A–§H were
  written in M1/M2 (before M3 phase machine existed) and never
  referenced the new tools. CLAUDE.md instructed Claude WHAT to do
  but not HOW with the new tools.

  §0 mandates the bootstrap chain at session start (and on every new
  task above `tier: trivial`):
  1. `mcp__rsct__rsct_status` — branch + protected_branches + hints
  2. `mcp__rsct__rsct_load_context` — plan + decisions + active_phase
  3. `mcp__rsct__rsct_classify_task` — tier + recommended_phases[]

  Then branches on tier: trivial skips the phase machine; small runs
  spec → code → test; standard runs research → spec → (V?) → code →
  test; complex mandates V phase. §0 also documents the persona
  pick (`rsct_auto_persona`) for `standard`+, the scope-gated edit
  flow (`rsct_check_edit_scope` before each `Edit`), the issue
  capture pattern (`rsct_capture_issue` for non-blocking findings
  during analysis), and the fallback when rsct-mcp is not installed.

- **`memory-templates/feedback_session-bootstrap.md`** — the matching
  feedback memory that lands in `~/.claude/projects/.../memory/`
  alongside the existing `feedback_*.md` entries. Cites the
  the first dogfood project (Java + Windows) drift incident as a concrete example.

### Changed (v0.6.4 — §B and §D point at the M3 phase machine)

- **`rules/B-architect-plan.md` updated** with a pre-§B note pointing
  to `rsct_phase_spec_start` / `_complete` (when rsct-mcp is
  installed) and a closing paragraph clarifying that the §B prose
  rules (2 options + reuse + Recommended) still apply — the phase
  tools BRACKET §B with state + audit + the §C OS dialog, they do
  not REPLACE it. `tier: trivial` from `rsct_classify_task` is the
  canonical detector of "§B exception" cases.

- **`rules/D-branch-protection.md` updated** with a pre-§D note
  pointing to `rsct_status` (whose hint flags protected-branch state
  explicitly) and a closing paragraph on the Code-phase wrapping:
  `rsct_phase_code_start` declares `scope_globs[]`,
  `rsct_check_edit_scope` gates each Edit, `rsct_phase_code_complete`
  closes via §C. The branch-derivation step PRECEDES the phase
  machine — derive `feat/<slug>` first, then open the code phase on
  the derived branch.

- **`memory-templates/feedback_architect-code-changes.md` updated**
  with a leading paragraph naming the §0 bootstrap chain and the
  spec-phase tools that wrap §B.

- **`memory-templates/feedback_branch-protection.md` updated**
  similarly: §0 bootstrap mandates `rsct_status` first, then
  Code-phase wrapping via `rsct_phase_code_start` /
  `rsct_check_edit_scope`.

- **`prompts/01-setup.md` updated** in three spots:
  - Phase 4.2 migration map gains a row for §0
    (`Bootstrap de sessão` / `Inicialização de sessão` / `Entry
    point` → `rules/0-session-bootstrap.md`).
  - Insertion order grows from 8 sections to 9: §0 lands as
    `section 1` (before §B), AFTER section 0 "Canonical
    architectural source" if present.
  - Phase 4.3 CREATE mode says "9 rule sections (§0 + §A–§H)"
    instead of "8 rules (§A–§H)".

- **`doc-templates/CLAUDE.md.template` updated** with a `[§0 —
  Session bootstrap content inserted here]` placeholder before
  `[§B — Mandatory plan content inserted here]`.

### Migration for existing projects

Projects set up before v0.6.4 do not have §0 in their `CLAUDE.md`.
Re-running `/rsct-setup` on those projects will detect the missing
§0 (UPDATE mode, Phase 4.2 migration map) and append it with
`source=inserted` marker, leaving the existing §A–§H sections
untouched. No breaking change — the §0 rule is additive prose.

### Why this matters

The framework's enforcement layer is sociotechnical: the §C OS
dialog is a hard gate on git mutations, but `Edit` / `Write` /
`Read` are native Claude Code tools that the framework does NOT
intercept. Compliance with the phase machine flow relies on Claude
following the CLAUDE.md prose contract. Before v0.6.4, that prose
did not mention the M3 tools at all. Adding §0 closes the most
common drift path observed in real-world usage.



M3 work + post-audit polish + docs coherence. v0.2.3 → v0.2.4 →
v0.3.0 → v0.4.0 → v0.5.0 → v0.5.1 → v0.5.2 → v0.6.0 → v0.6.1 →
v0.6.2 → v0.6.3 shipped sequentially 2026-06-06 → 2026-06-07.
**M3 is feature-complete** per the design memory plus the 3 additions
captured 2026-06-06; v0.6.2 is post-M3 i18n polish; v0.6.3 is
post-M3 docs coherence sweep + the CAP-7 "Project scope detail"
documentation fix from runtime testing.

### Changed (v0.6.3 — docs coherence audit + CAP-7 project scope detail)

- **Comprehensive sweep of all framework-owned documentation against
  the v0.6.x state.** Discovered during runtime testing on
  the first dogfood project (Java + Windows) (2026-06-07): the root README, mcp-server/README,
  examples/README, prompts/01-setup, and scripts/install.sh all
  carried v0.2.x-era references — "13 tools", "v0.2.1-track1-safety",
  "M3 — Personas + Tutor + Issue capture | ⏳ remaining", boot smoke
  example with `version=0.2.1`, etc. The framework had shipped 8
  milestone tags since the docs were last refreshed; the gap
  surfaced when a user comparing v0.6.1 in their IDE to the README's
  "v0.2.1-track1-safety" claim asked which was correct.
- **Surfaces updated:**
  - **`README.md` (root)** — phase line extended to
    `R → S → V → C → T` with a sentence describing the V phase tier
    behavior; versioning section updated to the `v0.6.x` train and
    `v0.6.2-i18n-pt-br-en` shipped state; "Done" section rewritten
    to cover all 9 M3 work items (V phase, CAPs batch 1, L4 phase
    machine, CAPs batch 2, issue capture, F3 personas, Tutor, i18n,
    docs audit) with per-tag detail; "13 tools + 5 resources"
    replaced with "30 tools + 5 resources"; "Trying rsct-mcp
    locally" section updated to mention the M3 entry point
    (`rsct_classify_task`) and the scope-choice flow.
  - **`mcp-server/README.md`** — intro paragraph: M3 status from
    "in progress" / "remaining" to "complete"; status table
    expanded with all M3 tags (v0.3.0 through v0.6.2);
    headline stats updated: 26 tools → **30 tools**, 400/400 →
    **473/473**, ~200 KB → **~250 KB**; boot smoke example bumped
    to `version=0.6.3` with the full 30-tool array; PowerShell
    fallback (`cmd /c "node dist\index.js < NUL"`) documented
    alongside the Unix `< /dev/null` form.
  - **`examples/README.md`** — tool count and tag updated; "M1 and
    M2 validation guides" expanded to mention M3 surfaces.
  - **`prompts/01-setup.md`** — dangling reference to the deleted
    `feat/rsct-mcp-v1` branch (line 876) replaced with a link to
    `mcp-server/README.md` and the canonical M1 Recall tool names.
  - **`scripts/install.sh`** — Project scope (option 2) output
    expanded from a 4-line snippet to a richer explanation
    covering: what `.mcp.json` is created, the `claude mcp list`
    verify step, the commit-or-gitignore decision for the team
    workflow, and a pointer to the "Project scope detail" section
    in the root README.
- **New section: "Project scope detail (when to use option 2)" in
  root README.md** — closes CAP-7. Covers what file gets created
  (`.mcp.json` with the rsct-mcp server entry), should-you-commit
  guidance for team workflows, the `claude mcp list` verify step,
  coexistence rules with user-scope registration (project scope
  wins for that specific project; user scope still applies
  elsewhere), removal via `claude mcp remove rsct --scope project`,
  and a 4-bullet troubleshooting checklist for "rsct_* tools do
  not appear after IDE restart".
- **Sweep silently confirmed clean** (no stale tokens found):
  `rules/A-H.md`, `memory-templates/feedback_*.md`,
  `prompts/02-canonical-source.md`, `prompts/04-init-universe.md`,
  `scripts/uninstall-framework.sh`, `doc-templates/*` (modulo
  intentional `v=1.0.0` protocol markers), `examples/java-spring/`.
- **Server version bumped 0.6.2 → 0.6.3** (`lib/version.ts`). All
  473 tests still pass; bundle size unchanged at 249.68 KB (docs-
  only change touches no code beyond the version constant).
- Tag: `v0.6.3-docs-audit`.

### Changed (v0.6.2 — CAP-6 i18n: pt-BR + EN vocabulary expansion)

- **`tools/classify-task.ts` keyword sets and `lib/personas.ts`
  persona keywords expanded with both pt-BR (Brazilian Portuguese)
  AND English domain-specific terminology that the original v0.6.0
  heuristic missed.** Discovered during the v0.6.1 runtime test on
  the the first dogfood project (Java + Windows) project (2026-06-07): the task
  "adicionar validação de CPF no cadastro de cliente" was
  classified as `tier=standard` (default) because the heuristic
  was English-only AND the English coverage itself was narrow —
  "adicionar" does not contain "add" as a substring (a-d-i vs
  a-d-d), and the original English vocabulary lacked common
  modern dev jargon (CQRS, terraform, OWASP, p99, hexagonal
  architecture, etc.). After this fix, the same task correctly
  classifies as `tier=small` with `mutation-verbs:[adicionar]` in
  signals — and English tasks using contemporary tech vocabulary
  are also captured precisely.
- **pt-BR additions (7 categories — formal + jargon):**
  - `MUTATION_VERBS`: adicionar, acrescentar, implementar,
    corrigir, consertar, alterar, mudar, atualizar, modificar,
    criar, remover, excluir, deletar, apagar, renomear, ajustar,
    substituir, refatorar + Brazilian dev jargon (pushar, comitar,
    deployar, dropar, bugar, crashar, logar, mockar, stubbar,
    lintar) + curated spec verbs (validar, verificar, tratar,
    calcular, listar, filtrar, ordenar, salvar, carregar, enviar,
    receber, processar, exibir, bloquear). Generic verbs
    "permitir" and "garantir" were deliberately skipped to avoid
    false positives.
  - `ARCHITECTURE_KEYWORDS`: +arquitetura, redesenhar, reformular,
    reestruturar, migração, migrar, refatorar em, autenticação,
    autorização, segurança, criptografia, multi-tenant,
    multi-região, camadas, DDD, domain-driven, bounded context,
    contexto delimitado, SOLID, clean architecture, arquitetura
    hexagonal, arquitetura limpa, inversão de dependência, baixo
    acoplamento, alta coesão.
  - `MULTI_FILE_KEYWORDS`: +renomear em todos / em todo, em todos
    os arquivos, em todo o projeto, em todo o codebase, em todos
    os módulos, em vários módulos, em vários arquivos, todos os
    chamadores, em todos os pacotes.
  - `TRIVIAL_KEYWORDS`: +corrigir typo, corrigir erro de
    digitação, atualizar comentário(s), documentação, renomear
    comentário.
  - Personas — pt-BR keywords per lens: architect (arquitetura,
    fronteira, contrato, acoplamento, agregado, adaptador, porta,
    SOLID, contexto delimitado, ...); security (autenticação,
    criptografia, vulnerabilidade, hash, hashear, OWASP, brute
    force, força bruta, refresh token, access token, ...); devops
    (implantação, monitoramento, métrica, subir/derrubar serviço,
    rolar deploy, hotfix, esteira CI/CD, cluster, pod, helm
    chart, balanceador, cache hit, TTL, circuit breaker, ...); qa
    (teste, regressão, cobertura, cenário de teste, caso de uso,
    critério de aceitação, DoD, smoke test, fixture, stub, happy
    path, ...); senior-dev (refatorar, legibilidade, padrão,
    clean code, código limpo, débito técnico, antipadrão, design
    pattern, ...); tutor (me ensine, passo a passo, me guie,
    debug ao vivo, tutorial, ...).
- **EN expansion (CAP-6 EN mirror — 7 same categories):**
  - `MUTATION_VERBS`: +refactor, adjust, replace, substitute,
    enable, disable, handle, process, calculate, list, filter,
    sort, save, load, send, receive, display, show, restart,
    patch, push, pull, sync, spin up, tear down, roll out, roll
    back, restore, rebuild, regenerate, bump, upgrade, downgrade,
    validate, verify, treat.
  - `ARCHITECTURE_KEYWORDS`: +decouple, decoupling, clean
    architecture, hexagonal architecture, onion architecture,
    aggregate, adapter, microservices, monolith, gateway,
    service mesh, CQRS, event sourcing, event-driven, breaking
    change, API contract, ports and adapters.
  - `MULTI_FILE_KEYWORDS`: +repository-wide, project-wide,
    system-wide, throughout the codebase, in all modules, in
    every module, in all packages, in every package.
  - `TRIVIAL_KEYWORDS`: +one-liner, comment fix, formatting fix,
    whitespace, spelling, spell check.
  - Personas — EN keywords per lens: architect (decouple, clean
    architecture, hexagonal, microservices, monolith, gateway,
    service mesh, CQRS, event sourcing, aggregate, adapter,
    port, ports and adapters, breaking change, API contract);
    senior-dev (clean code, tech debt, code smell, antipattern,
    DRY, KISS, YAGNI, design pattern, best practices, rewrite,
    simplify, generalize, encapsulate, abstract); qa (E2E test,
    end-to-end test, BDD, TDD, contract test, mutation testing,
    fuzz test, chaos test, chaos engineering, load test, stress
    test, soak test, A/B test, acceptance criteria, code
    coverage, branch coverage, line coverage, fake, spy); devops
    (spin up, tear down, spin down, roll out, roll back, canary,
    blue-green, blue/green, shadow traffic, staging, prod,
    production, IaC, terraform, ansible, puppet, chef, argocd,
    fluxcd, prometheus, grafana, kibana, elastic, splunk,
    pagerduty, opsgenie, runbook, postmortem, on-call, SRE,
    error budget, latency, p99, p95, p50, throughput, rps, qps);
    security (threat model, threat modeling, attack surface,
    privilege escalation, privesc, RCE, remote code execution,
    SSRF, server-side request forgery, OWASP top 10, CSP, HSTS,
    HTTPS, TLS, mTLS, zero trust, least privilege, defense in
    depth, input validation, output encoding, command injection,
    path traversal, session fixation, session hijacking, replay
    attack); tutor (mentor, mentoring, pair programming, pair,
    explain).
- **Why not translate-on-the-fly:** the framework's
  `feedback_design-zero-deps-hooks` premise forbids external deps
  (LLM call or translation lib). Substring scan against bilingual
  arrays is deterministic, dependency-free, and adds zero latency.
  Other languages (es, ru, fr, ...) follow the same pattern when
  added — just append entries to the existing arrays. Multi-locale
  typed structure (`{ en: [...], pt_BR: [...] }`) was considered
  and rejected as over-engineering for v1.
- +17 tests (9 pt-BR + 8 EN) validating the canonical real-world
  cases. Bundle: 232 → 250 KB (+18 KB for ~300 keyword entries).
  Tag: `v0.6.2-i18n-pt-br-en`.

### Added (v0.6.1 — M3 Tutor persona, closes M3)

- **Tutor as 6th persona** in `lib/personas.ts` — interactive
  step-by-step facilitator. Focus areas, questions, anti-patterns,
  and keywords curated for the "one step at a time" interaction
  style: human-in-the-loop pacing, explicit consent per action,
  observation before next step.
- **`Persona.auto_pickable` field** — new optional `boolean` (default
  `true`) on the `Persona` type. Tutor sets it to `false`, and
  `scorePersonas` skips personas with `auto_pickable === false`. This
  means `rsct_auto_persona` will NEVER recommend Tutor — the dev
  must opt in deliberately via `rsct_persona_review` with
  `persona='tutor'`, matching the memory's "must be opt-in" contract.
- **`rsct_tutor_step` tool** — audit-only logger for one step of a
  Tutor session. Inputs: `spec_ref` (correlates the session),
  `step_description`, `step_kind` (`propose|execute|read-batch|
  observe|complete`), optional `result` + `batch_commands[]`. Each
  call appends a `tutor.step` event to `.rsct/audit.log` and counts
  prior steps for the same `spec_ref` to return the 1-indexed
  `step_number`. Output includes a `resume_block` — a markdown
  snippet the dev can paste in a new chat after `/clear` to continue
  the session from the last step. `is_complete` flips when
  `step_kind="complete"`. Not §C-gated (audit append only). Hints
  when `batch_commands` exceeds 5 entries (suggests splitting so the
  dev keeps tracking).
- +13 tests covering step counting, kinds, batch warnings,
  resume_block truncation, audit shape, and validation.

### Added (v0.6.0 — M3 F3 personas)

- **L3 personas layer shipped.** 5 personas (Architect, Senior Dev,
  QA, DevOps, Security) defined as static data in `lib/personas.ts`:
  each carries `focus_areas[]`, `questions_to_ask[]`,
  `anti_patterns_to_check[]`, `knowledge_categories_to_consult[]`,
  and a `keywords[]` set used by the auto-picker. The `persona?`
  parameter that phase tools have accepted as no-op since v0.3.0 now
  resolves to one of these 5 slugs.
- **`rsct_persona_review` tool** — pure-query lens. Takes
  `subject` (≥10 chars) + `persona` (enum). Returns the full lens
  structured (focus / questions / anti-patterns / knowledge
  categories) plus `subject_signals[]` — the subset of the persona's
  keywords that hit the subject. When zero signals match, the tool
  emits a hint suggesting the better-fit persona based on a quick
  cross-score.
- **`rsct_auto_persona` tool** — heuristic recommender. Takes
  `task_description` (≥10 chars), scores all 5 personas via
  case-insensitive substring match against their keyword sets,
  returns the top match + ranked alternatives + `all_persona_slugs[]`.
  Returns `recommended_persona=null` when nothing matches and hints
  the dev to default to `senior-dev` as a generalist.
- **Out of scope (parked per memory):** persistent active-persona
  state, `rsct_persona_activate`, auto-injection of persona prompt
  into phase tools (Claude orchestrates instead). PM / CTO / Data
  Analyst personas (F3.5).
- **Reuse:** the auto-persona scorer lives in `lib/personas.ts`
  (`scorePersonas`) and is called from both `auto-persona.ts` and
  `persona-review.ts` (for the "no signal" hint). The lens output
  is read-only — no §C-gate, no INV-2.2 registry extension, no
  audit events.
- +28 tests (12 lib + 7 persona_review + 9 auto_persona).

### Added (v0.5.2 — M3 issue capture)

- **`rsct_capture_issue` tool** — captures a non-blocking finding as
  a GitHub issue, either as a draft body for manual creation or as
  an actual issue via `gh issue create`. Two modes:
  - `mode="draft"` (default): returns a formatted markdown body
    (severity badge + body + affected paths + captured footer) plus
    a suggested `gh issue create` command. No external mutation, no
    §C-gate. Use during scans / verification sweeps to log "we should
    fix this later" items without scope-creep.
  - `mode="create"`: requires `dev_approval` (action_scope starting
    with `capture_issue:`), invokes `gateRequest` (OS dialog),
    detects gh CLI availability, runs `gh issue create --title X
    --body Y --label l1 --label l2`, parses the URL from stdout,
    returns it. Distinguishes `gh_not_installed` /
    `gh_not_authenticated` / `gh_no_remote` / `gh_other` failure
    reasons so the dev gets a specific next step.
- **`lib/gh.ts`** — thin wrapper around the GitHub CLI. Exports
  `isGhAvailable()` and `createIssue()`. Uses `execFileSync` (same
  pattern as `lib/git.ts`) for consistency. Multi-provider
  (GitLab / Bitbucket) is deferred — the planned extension point is
  a `provider` field in `.rsct.json` schema.
- **Audit events:** `capture_issue.drafted`, `capture_issue.gh_unavailable`,
  `capture_issue.create.rejected`, `capture_issue.create_failed`,
  `capture_issue.created` — all carry `title`, `severity`,
  `affected_paths_count`, and `labels`.
- **INV-2.2 extension:** `rsct_capture_issue` added to
  `EXPECTED_SCOPE_TOKEN` registry with token `capture_issue` and to
  `TRUST_ALLOWED_TOOL_NAMES` (so it can appear in
  `approval_modes.trust_allowed_for[]` for headless flows).
- **Default labels** when `labels` is omitted in `create` mode:
  `["auto-captured", "rsct"]`. Override with any explicit labels[]
  the dev wants (must exist in the repo).
- +14 tests covering draft + create paths + gh failure modes + input
  validation.

### Added (v0.5.1 — CAP-4 phase_abandon + CAP-5 doc polish)

- **`rsct_phase_abandon` tool** (CAP-4) — §C-gated phase discard.
  Reads `.rsct/phase-state.json`, requires a human-readable `reason`
  (≥10 chars) + `dev_approval` with `action_scope` starting with
  `phase_abandon:`, pops the OS dialog, and on approval clears the
  active phase AND any verification sub-block (without advancing the
  RSCT cycle). Use when a phase was started against the wrong
  `spec_ref`, the task pivoted, or the spec was rejected after
  research. NOT a substitute for `rsct_phase_<phase>_complete` —
  abandon discards work; complete advances it. The `reason` lands in
  the `phase_abandon.complete` audit event so a future reader knows
  why work was discarded. `rsct_phase_abandon` also added to
  `lib/project-root.ts` `TRUST_ALLOWED_TOOL_NAMES` (Zod enum) and
  `lib/dev-approval.ts` `EXPECTED_SCOPE_TOKEN` (INV-2.2 scope_mismatch
  detection) for consistency with the rest of the §C-gated tools.
  +9 tests.
- **`mcp-server/README.md` updated to reflect the M3 phase machine**
  (CAP-5, partial) — header milestone summary expanded to mention M3,
  intro paragraph adds the entry-point guidance ("call
  `rsct_classify_task` for non-trivial tasks"), milestone status
  table refreshed with v0.2.4 → v0.5.1 tags, and the headline
  "tools/tests/KB" stats line bumped to 26 / 400 / ~200 KB. Out of
  scope for this batch: `prompts/01-setup.md` mentions of phase tools
  (huge surface; deserves its own batch), and `examples/*/CLAUDE.md`
  templates (currently empty directory).

### Added (v0.5.0 — M3 phase machine: classify_task + R/S/C/T pairs + status)

- **L4 phase machine closed.** The RSCT cycle (R→S→V→C→T) now has all
  phase tools. 10 new MCP tools:
  - `rsct_classify_task` — heuristic-only task classifier. Scans the
    task description for keyword signals (architecture / security /
    multi-file / mutation / docs / typo) and returns a tier
    (trivial|small|standard|complex) + the recommended RSCT phase
    sequence. Tier is advisory: phase tools do NOT enforce based on
    tier. Optional `use_active_plan_slug` lifts the most-recent
    `plan_<slug>.md` slug + status into the response. +9 tests.
  - `rsct_phase_status` — pure query returning the current state of
    the phase machine: active_phase, spec_slug, scope_globs,
    verification summary (when active), next_recommended_phase per
    the canonical R→S→V→C→T order. +6 tests.
  - `rsct_phase_{research,spec,code,test}_start` — symmetric `_start`
    tools for the 4 non-V phases. Write phase + spec_slug +
    started_at + scope_globs into `.rsct/phase-state.json`. Emit
    `<phase>.start` audit. Refuse with `phase_already_active` if a
    different phase is open.
  - `rsct_phase_{research,spec,code,test}_complete` — §C-gated `_complete`
    tools. Read phase-state, guard on phase + spec_slug match,
    `gateRequest` through the OS dialog, clear active phase on
    success, emit `<phase>.complete` audit. Suggested action_scope
    format: `<phase>_complete:spec_ref=<X>` (also detected by INV-2.2
    `scope_mismatch`). Next recommended phase auto-suggested in
    output + hint.
  - +4 phase-research integration tests + 6 spec/code/test smoke
    tests + 14 phase-machine unit tests = 39 new tests total.
- **`lib/phase-machine.ts`** — shared helpers backing the R/S/C/T pairs:
  `startPhaseGeneric` (state write + audit), `gatePhaseComplete`
  (§C-gate via `gateRequest` + clear + audit), `nextPhase` (canonical
  RSCT order). V phase tools own their own checklist/findings plumbing
  and do NOT route through this lib. Total ~410 lines.
- **`lib/version.ts`** — single source of truth for `RSCT_MCP_VERSION`,
  imported by `index.ts` (boot log), `tools/status.ts`, and
  `tools/load-context.ts`. Replaces the previously-duplicated
  `MCP_VERSION = '0.2.1'` literals that desync'd at every minor bump
  (caught load-context out of sync at v0.4.0; caught status.ts out of
  sync at v0.5.0).

### Changed (v0.5.0 — pre-existing CAP fixes opportunistically caught)

- **`lib/project-root.ts` `TRUST_ALLOWED_TOOL_NAMES` extended** with
  the 5 phase complete tools (`rsct_phase_verification_complete` +
  4 new `_research/_spec/_code/_test_complete`). Pre-existing gap from
  v0.3.0 V phase ship: the V phase complete tool could not be listed
  in `.rsct.json` `approval_modes.trust_allowed_for[]` because the
  Zod enum on this field rejected names outside the original 3
  `request_*` tools. Now any phase complete tool can legitimately
  appear there for headless / CI flows. Caught during this batch's
  pre-impl verification sweep.
- **`lib/dev-approval.ts` `EXPECTED_SCOPE_TOKEN` extended** with the 4
  new phase complete prefixes (`research_complete`, `spec_complete`,
  `code_complete`, `test_complete`). INV-2.2 `scope_mismatch` now
  fires correctly when a phase complete tool is called with an
  action_scope that does not match its phase token (e.g.,
  `rsct_phase_code_complete` invoked with `action_scope='spec:...'`).

### Security (v0.4.0 — CAP-1)

- **`lib/dev-approval.ts` INV-2.2 fabrication detection completed
  (5/5 signals shipped)** — `scope_mismatch` and `burst_pattern` added
  to the `FabricationSignal` union. `scope_mismatch` fires when the
  §C-gated tool name does not match the leading token of
  `dev_approval.action_scope` (e.g., tool=`rsct_request_commit` but
  action_scope=`push:origin:main`); per-tool prefix registry maintained
  in `dev-approval.ts`. `burst_pattern` fires when ≥3 prior approvals
  consumed within the last 10 seconds (this approval would be the 4th
  or later in the window). Both signals raise `must_force_dialog=true`
  so the OS dialog is mandatory regardless of project
  `approval_modes.trust_allowed_for[]`. `lib/request-gate.ts`
  `gateRequest` now forwards `toolName` to `validateDevApproval` via
  the new `ValidateOptions.toolName` field. Closes the original INV-2.2
  design that previously shipped at 3/5 signals
  (`reason_too_short`/`implausibly_fast`/`approvals_store_corrupt`).
  +9 tests (5 scope_mismatch + 4 burst_pattern).

### Added (v0.4.0 — CAP-2)

- **`rsct_load_context` now surfaces the active phase state** — new
  output field `active_phase: ActivePhaseInfo | null` carries
  `{ phase, spec_slug, started_at, scope_globs[], verification }` read
  from `.rsct/phase-state.json`. The `verification` sub-object is
  populated when the V phase is active and carries
  `{ spec_ref, spec_tier, findings_count, started_at }` —
  `findings_count` only (the full findings array is reachable via the
  phase-state file or by re-running `rsct_phase_verification_start` with
  the same spec_ref). New `next_action_hints` entry fires when the
  verification phase is active, naming the spec and finding count so
  Claude does not start editing code while V phase is incomplete.
  Closes the cross-cutting gap surfaced during the V phase §B
  verification sweep. +6 tests.

### Changed (v0.4.0 — CAP-3)

- **`lib/phase-scope.ts` `writePhaseState` is now guarded by an
  advisory file lock** at `.rsct/phase-state.lock`. The new lock semantics:
  exclusive-create on acquire (`flag: 'wx'`); on `EEXIST`, peek at the
  existing lock and overwrite if its `locked_at` is older than 30s
  (stale); otherwise return
  `{ ok: false, reason: 'locked', lock_age_ms, held_by_session }` so the
  caller can surface a wait-and-retry hint without clobbering a peer
  session's in-flight write. Lock is always released in `finally` so a
  failed write still unlocks. `WritePhaseStateResult` becomes a
  three-arm discriminated union (`ok: true` / `reason: 'write_failed'` /
  `reason: 'locked'`); both consumers (`rsct_phase_verification_start`
  and `rsct_phase_verification_complete`) updated to emit
  category-specific hints. Mitigates the single-writer assumption
  flagged for the M3 phase machine without requiring an OS cleanup
  loop. Per-process session ID generated via `crypto.randomUUID()` so
  diagnostics can attribute a stale lock to a dead session. +6 tests.

### Added (v0.4.0 — version)

- **`SERVER_VERSION` bumped from `0.3.0` to `0.4.0`** (SemVer minor —
  feature additions without breaking changes). `load-context.ts`
  `MCP_VERSION` constant also bumped to `0.4.0` to keep the
  load-context output in sync with the actual boot version.

### Added (v0.3.0 — M3 V phase)

- **M3 V phase: `rsct_phase_verification_start` and
  `rsct_phase_verification_complete` MCP tools** — RSCT acronym extends
  from R→S→C→T to R→S→V→C→T. The V phase runs between dev-approves-spec
  and Claude-edits-code: it walks reverse dependencies from the
  declared affected_paths, runs a categorized checklist (gap / breakage
  / redundancy / forgotten) against the project's decisions.md,
  anti-decisions.md, knowledge categories, architecture.md, and
  documentation/impact/*.md docs, and surfaces findings with suggested
  severities. `_complete` is §C-gated (validates dev_approval via
  lib/dev-approval, calls lib/request-gate which spawns the OS dialog,
  records consumed approval, writes verification.complete to audit
  log). Any finding with `action="block"` aborts completion before the
  §C dialog. Tier table: trivial+small skip the V phase; standard runs
  + finds; complex runs + mandates _complete before code-phase write.
  `spec_tier` is an input parameter today (defaults to "standard");
  forward-compatible with `rsct_classify_task` when that tool lands.
  `persona?` accepted and logged into audit as `requested_persona`,
  no-op until F3 personas ship.
- **`lib/reverse-dep-walk.ts`** — static-import-only reverse dependency
  walker for JS/TS (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`).
  Detects ES module imports, CJS requires, dynamic imports, and
  export-from re-exports via regex (no AST). Resolves relative + index
  + extension-elided imports; ignores bare package specifiers and
  tsconfig path aliases (v1 limitation, hinted on no-match). Default
  excludes node_modules, dist, build, .git, coverage. Default max
  depth 2 (configurable). +19 tests.
- **`lib/verification-checklist.ts`** — four-category finding catalog:
  `gap` calls `lib/premise-check` per spec claim against
  decisions+anti-decisions; `breakage` consumes the reverse-dep walk
  output + cross-references `documentation/impact/<name>.md` per
  declared path; `redundancy` flags basename overlap against
  optional `existing_project_files[]` (skips short names + common
  basenames index/utils/helpers/types); `forgotten` emits per-domain
  prompts for each present knowledge category + architecture overview.
  Tier-aware (skips on trivial/small; up to 5 prompts for standard, 10
  for complex). +18 tests.
- **`lib/phase-scope.ts` extended** — `PhaseVerificationBlock` typed
  sub-block on `PhaseState`; new `writePhaseState(projectRoot, state)`
  helper (atomic-ish writeFileSync, auto-creates `.rsct/`, pretty-prints
  2-space + trailing newline). Reader unchanged; verification block is
  opaque to the M2 `check_edit_scope` reader by design.
- **Audit log event types added:** `verification.start`,
  `verification.finding` (one per finding), `verification.action`
  (one per finding action chosen by dev), `verification.complete`,
  `verification.complete.rejected`, `verification.skip`. All carry
  `spec_ref` for correlation.
- **`SERVER_VERSION` bumped from `0.2.1` to `0.2.5-dev`** (boot log
  now reports the dev version). Per the §B decision, this bumps to
  `0.3.0` at the M3 V phase ship tag.
- **Bundle grew from 125.17 KB to 160.74 KB (+35.57 KB)** — the V
  phase additions (reverse-dep walker + checklist + two tools)
  expanded the surface beyond the original 130 KB target flagged in
  §B. Acceptable for a SemVer minor feature add to the phase machine;
  to be revisited if the next M3 phases (R/S/C/T tools) push further.

### Changed

- **install.sh + uninstall-framework.sh + root README now consolidate
  the "Manual Claude Code steps" disclosure** (post-v0.2.3 follow-up,
  not in the original 20-finding audit). The Claude Code CLI is the
  only path to write `.mcp.json` per project (`claude mcp add rsct
  rsct-mcp --scope project`) and to remove it (`claude mcp remove
  rsct`); the framework cannot run those for the dev. Each script
  now ends with an explicit `⚠ MANUAL STEPS STILL REQUIRED` block
  naming the commands, and the root README gains a small table that
  is the single source of truth for the full picture (install +
  uninstall + restart cadence).
- **Both install.sh and uninstall-framework.sh now refuse to run
  under WSL on Windows, and the root README mandates Git Bash for
  Windows installs** (real-world dev UX gap discovered during v0.2.3
  smoke test). Both scripts detect WSL via `/proc/sys/kernel/osrelease`
  containing `microsoft|wsl` and exit 1 with a clear message: WSL
  writes to `/home/<user>/.rsct/`, Claude Code on Windows reads
  `C:/Users/<user>/.rsct/`, the two never meet. The README gains a
  prominent block before the install code fence telling Windows users
  to open Git Bash from the Start menu — the `MINGW64` prompt is the
  signal that the install will land in the right place.
- **install.sh now asks where to register rsct-mcp with Claude Code
  during the install run** (real-world UX win discovered when a project
  with `.mcp.json` but no `claude mcp add` registration silently
  failed to load tools). Three options: `[1] User scope` (recommended;
  installer runs `claude mcp add rsct rsct-mcp --scope user` for you
  — one-time per machine), `[2] Project scope` (prints instructions
  for `cd <project> && claude mcp add … --scope project` per team
  workflow), `[3] Skip` (full manual control). User scope is the
  default so the solo-dev path is `bash install.sh → restart →
  /rsct-setup` — three steps, one restart. Previously this required
  per-project `claude mcp add` + a second restart and silently failed
  if the dev only had `.mcp.json` without the `add` step.
- **uninstall-framework.sh now detects and offers to remove the
  user-scope rsct registration symmetrically**. Project-scope
  registrations remain manual (we can't enumerate every project the
  dev opted in for) but are documented in the closing instructions.
- **README.md "Manual Claude Code steps" section restructured** into
  two tables: (a) the choice the install script offers for MCP
  registration, (b) the remaining manual steps the framework
  fundamentally cannot automate (restart + `/rsct-setup` per project).
- **install.sh + uninstall-framework.sh MCP detection now uses
  `claude mcp list | grep -qE "^rsct:"` instead of `claude mcp get
  rsct`** (immediate bugfix to the previous patch). The `claude mcp
  get` exit code differs across the Windows wrapper variants — in
  real-world testing on 2026-06-06 the PowerShell `.ps1` wrapper
  returned 1 on "not found" but the Git Bash no-extension stub
  returned 0, causing `install.sh` to false-positive
  "already registered" and never call `claude mcp add`. Grepping
  the `claude mcp list` output is deterministic regardless of shell:
  the line format `rsct: rsct-mcp - ✓ Connected` either appears or
  it doesn't. Discovered while smoke-testing the user-scope auto-
  register prompt on the second dogfood project (Vite + React).
- **install.sh + uninstall-framework.sh MCP detection now parses
  `~/.claude.json` directly** (second bugfix layer to the previous
  patch). Real-world testing surfaced that `claude mcp list` in
  non-TTY (pipe) mode INCLUDES project-scope `.mcp.json` entries
  in its output, while the TTY (direct terminal) mode only shows
  user-scope. The previous `claude mcp list | grep -qE "^rsct:"`
  check therefore false-positived "already registered" whenever the
  cwd had a project `.mcp.json` referencing rsct (the rsct-framework
  dev repo itself has one pointing at the sample fixture). Now we
  read `~/.claude.json` and inspect the top-level `mcpServers.rsct`
  key — that's exactly where `claude mcp add --scope user` writes,
  and project-scope `.mcp.json` files never touch it. Same fix
  applied symmetrically in uninstall-framework.sh so the
  "offer to unregister" prompt only fires when there's an actual
  user-scope registration to remove.
- **`prompts/01-setup.md` Phase 4.4 now omits the `universe` block
  from `.rsct.json` when no universe is configured** (bug discovered
  during v0.2.3 end-to-end smoke test on the second dogfood project (Vite + React)). When the dev
  answered "no universe / leave placeholders" in Phase 3, the prior
  prompt wrote `"universe": { "name": "", "local": "", "remote": "" }`.
  The strict Zod schema introduced for HIGH-4 (post-M2 audit) requires
  `min(1)` on those fields, so every subsequent rsct-mcp load
  emitted a `rsct_json.bounds_violation` event into the audit log.
  The schema treats the whole block as `.optional()` — omitting it is
  the correct null state. `02-canonical-source.md` is the path that
  adds the block later when the dev adopts a universe.
  `doc-templates/rsct.json.template` updated to match (no universe
  block at all; canonical source adds it).
- **`prompts/01-setup.md` Phase 4.4b now adds `.rsct/audit.log`
  and `.rsct/approvals-seen.json` to the `.gitignore` marker block**
  (bug discovered during the same smoke test). The two files are
  runtime state — every `mcp__rsct__rsct_request_commit/_push/_merge`
  call appends to audit and records the consumed approval, so
  tracking them in git means every commit dirties the very files
  that record the commit (an infinite loop). Each developer's clone
  keeps its own audit / anti-replay state per machine; they were
  never meant to ship across clones. The new entries live inside the
  existing RSCT-BEGIN/END marker block so `/rsct-uninstall` excises
  them with the same awk pass that handles `plan_*.md` /
  `progress_*.md`.
- **Provenance comments and docs now drop the dangling SHA + "parked
  branch" framing** (post-v0.2.3 polish, ref: this cleanup PR). When
  the early hook-based prototype branch (`chore/dogfood-init-and-hooks
  @ a1974f0`) was deleted on 2026-06-07 — its architectural approach
  had been superseded by the MCP-first design adopted in M1/M2 — four
  files still carried provenance references to the now-unreachable
  SHA. `mcp-server/src/lib/secrets.ts` and
  `mcp-server/src/lib/branch-protection.ts` doc-block headers, the
  runtime hint string in `mcp-server/src/tools/get-environments.ts`,
  and the `rsct_check_secrets` description in `mcp-server/README.md`
  all rewritten to say the canonical home is the TypeScript file
  itself (with a brief mention that the regex / branch logic was
  originally drafted in a Bash-hook prototype, where useful for
  context — but no SHA, no "parked branch" anchor). One additional
  in-body reference in `branch-protection.ts:36` ("matches the parked
  hook's behavior") dropped — the parenthetical no longer carries
  information now that the hook is gone. The historical CHANGELOG
  entry that records the original port (v0.2.0-m2 era) is left
  intact as immutable history. Same patterns, same logic, same
  behavior — only the dead references go.

### Security

- **`mcp-server/package.json` `devDependencies.vitest` bumped from
  `^2.1.0` to `^4.1.8`** (semver major-major jump, post-v0.2.3 polish).
  Closes 5 CVEs visible at every `npm install` in `mcp-server/` — 1
  critical (CVSS 9.8) and 4 moderate, all transitive dev dependencies:
  `vitest` (GHSA-5xrq-8626-4rwp: Vitest UI server arbitrary file
  read+execute), `vite` (GHSA-4w7w-66w2-5vf9: Path Traversal in
  Optimized Deps `.map` handling), `esbuild` (GHSA-67mh-4wv8-2f99: dev
  server lets any site read/forward responses), `@vitest/mocker` and
  `vite-node` (transitive). None touch the production runtime
  (`@modelcontextprotocol/sdk`, `pino`, `zod` are clean per
  `npm audit --production`) and none are exploitable in current
  usage — we don't run Vitest UI, we use `tsup` (not esbuild dev) for
  builds, and we don't run Vite dev server. Bumping anyway because the
  noise at every `npm install` was a UX gap for new contributors and
  vitest 2.x will not get backports. Migration cost was zero: 276/276
  tests still pass under vitest 4.1.8 with no syntax or config
  changes. `npm audit` now reports 0 vulnerabilities. Bundle size
  unchanged (125.22 KB). Captured during the v0.2.3 end-to-end smoke
  on the second dogfood project (Vite + React) per the M3 "GitHub issue capture for non-blocking bugs"
  pattern.

### Changed

- **`mcp-server/src/scripts/sanitize-permissions.ts` POISON_PILL_PATTERNS
  broadened** (post-M2 audit MED-12). Three new shapes are now stripped
  from `permissions.allow[]`:
  - Path-prefixed git mutations: `Bash(/usr/bin/git commit)`,
    `Bash(./bin/git push)`, `Bash(C:/Program Files/Git/bin/git merge)`.
    Lazy regex allows spaces inside the path (Windows installs).
    Word-boundary on the basename ensures `Bash(/usr/bin/git-credential-store ...)`
    (a different binary) is NOT caught.
  - Shell-wrapped git mutations: `Bash(sh -c "git commit ...")`,
    `Bash(bash -c 'git push ...')`, and the other POSIX shell
    variants (`zsh`, `dash`, `fish`, `ksh`, `csh`).
  - Wildcard-around-git blankets: `Bash(*git*)` and similar — the
    bash matcher would catch commit/push/merge inside the wildcard
    envelope, so the whole shape is treated as a bypass.
  Read-only forms (`Bash(git status)`, `Bash(/usr/bin/git log)`) are
  unaffected. +4 new test groups, 22/22 sanitizer tests still green.
- **`prompts/01-setup.md` Phase 1.8 now also feeds discovered
  sensitive var names into `.rsct.json` `secrets_extra_patterns[]`**
  (post-M2 audit MED-16). Phase 4.4 gains a `node -e` script that
  reads the project's existing `secrets_extra_patterns[]`, generates a
  word-boundary regex (`\b<VAR>\b`) for each entry in `SENSITIVE_VARS`
  (Phase 1.8), and **unions** with the existing list (never replaces).
  Var names with regex-unsafe characters are skipped with a comment so
  the dev knows to add the escaped form manually. Idempotent on re-run:
  prints `no-op` if the regex set already covers everything.
  `doc-templates/rsct.json.template` gains a `"secrets_extra_patterns": []`
  field so fresh installs start with the right shape.
- **`rules/C-reauthorize.md` + `memory-templates/feedback_commit-reauthorize.md`
  now point devs at the §C-gated MCP tools** (post-M2 audit MED-14).
  Both files gain a "mechanical enforcement" paragraph naming
  `mcp__rsct__rsct_request_commit` / `_push` / `_merge` as the tools
  that back the §C contract when `rsct-mcp` is installed. Without the
  MCP, the prose contract remains the only enforcement. Closes the
  adoption gap where Claude could use plain `Bash(git commit ...)`
  with only the sanitizer hook catching trust-forever bypass.
- **`prompts/01-setup.md` Phase 4.5b documents its uninstall
  counterpart** (post-M2 audit LOW-20). Knowledge-graph files created
  by 4.5b are removed by the generic `documentation/` scrub in
  `03-uninstall.md` Phase 4.4 — same SHA256-protection, same
  classification, same dev-choice flow. The note prevents the
  "missing phase" reading.
- **`mcp-server/src/lib/secrets.ts` is now the canonical home for
  `compileExtraPatterns`** (post-M2 audit LOW-19). The same compile
  loop used to live duplicated in `tools/check-secrets.ts` and
  `tools/request-commit.ts`; both call sites now import from
  `lib/secrets.ts` (request-commit reads `.compiled` and ignores
  `.invalid` since it surfaces nothing about regex compile errors).
- **`mcp-server/src/lib/io-utils.ts` extracts the `ensureParentDir`
  helper** (post-M2 audit LOW-18). `audit-log.ts` and `dev-approval.ts`
  both needed `mkdirSync(dirname(path), { recursive: true })` before
  their first write; both now call `ensureParentDir(path)` instead.
  audit-log also drops the redundant `existsSync` precheck (recursive
  mkdir is already idempotent). Bundle 125.41 → 125.22 KB.

## [v0.2.2-track2-complete] — 2026-06-06

Post-M2 audit Track 2 (adoption + install + setup hardening). Closes
9 audit findings (HIGH-1, HIGH-6, HIGH-7, HIGH-8, HIGH-9, MED-10,
MED-11, MED-13, MED-15) across three sub-PRs.

### Changed

- **`scripts/install.sh` now offers to install `rsct-mcp` interactively
  after the framework copy** (post-M2 audit HIGH-9). Detects Node 20+
  (and npm) at start, shows result in the summary, and after copying
  the framework runs `cd mcp-server && npm install && npm run build &&
  npm install -g .` if the dev confirms `[Y/n]`. Default-yes when Node
  is OK; default-skip with explicit instructions when Node is missing
  or too old. Failure of the npm install does NOT roll back the
  framework install (they're independent) — clear retry instructions
  are printed instead.
- **`scripts/install.sh` runtime-dir copy is now resilient to repo
  drift** (post-M2 audit MED-10). Top-level directories are still
  copied from an explicit `RUNTIME_DIRS` list (conservative default),
  but anything at the source root that is in neither `RUNTIME_DIRS`
  nor `KNOWN_NON_RUNTIME` now triggers a `⚠ WARN` so a new top-level
  directory can't silently skip the install on re-run.
- **`scripts/uninstall-framework.sh` now detects and optionally
  removes the global `rsct-mcp` install** (post-M2 audit HIGH-6).
  Symmetric to install.sh's MCP prompt: detects via `command -v
  rsct-mcp`, asks `[Y/n]` separately from the main framework removal
  prompt so a dev who wants to keep the MCP active for projects with
  `rsct` in their `.mcp.json` can do so.
- **`prompts/01-setup.md` Phase 4.V now stamps the copied sanitizer
  script with the `rsct-mcp` version that produced it** (post-M2 audit
  MED-11). Version is extracted from the adjacent `package.json` of the
  source bundle (global npm install or in-repo `mcp-server/`). On
  re-run, the installer reads the existing stamp on line 2 and prints
  one of: `installing` (fresh), `refreshing` (same version), or
  `⚠ updating sanitizer: vX → vY` (drift). The script is still
  overwritten unconditionally — the stamp adds visibility, not gating.
- **`prompts/01-setup.md` Phase 4.4b now wraps the `.gitignore`
  plan-tracking block in `# RSCT-BEGIN` / `# RSCT-END` markers**
  (post-M2 audit MED-13). Idempotency switches from grepping for the
  `plan_*.md` literal to grepping for the BEGIN marker. Legacy
  (pre-marker) blocks from older installs are detected and warned —
  not duplicated, not auto-converted. A new comment block documents the
  forward-looking `.mcp.json` marker convention (identify the rsct
  entry by its `"rsct"` key under `"mcpServers"`, since JSON has no
  inline comment marker).
- **`prompts/03-uninstall.md` Phase 4.4b excises the `.gitignore`
  marker block on uninstall** (paired with MED-13). awk-based scrub
  preserves every other line in `.gitignore`, drops a single empty
  line that preceded the block (the install side inserts one for
  readability), and removes the file outright if it becomes empty.
  Legacy pre-marker blocks emit a manual-cleanup hint.
- **Root README + CHANGELOG + per-README count refreshes** for the
  current v0.2.x train (HIGH-1 + HIGH-7). The "Trying rsct-mcp locally"
  section now describes M1 + M2 + Track 1 + sanitizer hook + audit log;
  per-readme test counts updated to 272/272, ESM bundle to ~125 KB.
  HIGH-8 sync: `mcp-server/package.json` `1.0.0` → `0.2.1` and three
  hardcoded SERVER_VERSION/MCP_VERSION literals in `src/` aligned. New
  "First project walkthrough (5 minutes)" tutorial section closes
  MED-15.

**Track 2 totals:** 9 audit findings closed (4 HIGH + 5 MED) across
three sub-PRs. ~291 LOC docs, ~200 LOC install/uninstall bash,
~174 LOC prompts. mcp-server: only the version literal sync; bundle
unchanged at 125.41 KB. 272/272 tests still green throughout.

## [v0.2.1-track1-safety] — 2026-06-06

Post-M2 audit-driven safety hardening. Closes 4 HIGH-severity audit
findings (HIGH-2, HIGH-3, HIGH-4, HIGH-5) surfaced by an exploration
audit run immediately after the M2 gate signed off.

### Added

- **`audit_error`, `anti_replay_persisted`, `anti_replay_error` output
  fields** on `rsct_request_commit` / `_push` / `_merge`
  (commit `1499d11`, HIGH-2/3). Audit append failure and approval-store
  write failure are now surfaced post-mutation via the tool output (with
  ⚠ warning hint) instead of silently passing through. Two new test
  seams (`auditWriter`, `approvalRecorder`) make these paths testable
  without monkey-patching the filesystem. 7 new tests.
- **`.rsct.json` Zod schema with hard bounds** in `lib/project-root.ts`
  (commit `739d5b2`, HIGH-4). Defends against config-side bypass vectors
  (`audit.enabled: false`, `timestamp_skew_seconds: ∞`,
  `protected_branches: []`, `trust_allowed_for: [<wildcard>]`).
  Out-of-bounds configs are rejected wholesale and a
  `rsct_json.bounds_violation` event is **force-written** to the audit
  log even when the attack vector was `audit.enabled: false`. Strict
  on the security-critical sub-objects (`audit`, `approval_modes`),
  `.strip()` at top-level for forward-compat. 15 new tests.

### Fixed

- **`trust_allowed_for[]` semantics documented honestly** in
  `mcp-server/README.md` (commit `a62b0a7`, HIGH-5). The list matches
  by **tool name** (`rsct_request_commit` / `_push` / `_merge`), not by
  `dev_approval.action_scope`. Code behavior unchanged; the prior README
  claim was stale.

**Track 1 totals:** +22 unit tests (250 → 272), +4 audit event types
(`audit_error`, `anti_replay_error`, `rsct_json.bounds_violation`,
`rsct_json.malformed`), +3 MCP output fields, Zod schema for
`.rsct.json`. ESM bundle 118.83 → 125.41 KB (+6.58 KB).

## [v0.2.0-m2] — 2026-06-06

### Added — rsct-mcp v1 M2 (Enforcement MVP)

Implementation tracked in `plan_rsct-mcp-v2.md` (branch-local on
`feat/rsct-mcp-v2`). M2 materializes §C/§D/§E from the governance
rules as enforceable contracts: an "always allow" entry in
`permissions.allow[]` no longer bypasses commit/push/merge on a
protected branch or with secrets in the diff.

- **F2.5.0 — `.rsct.json` schema extension + lib foundation (`a277578`)** —
  added `approval_modes`, `audit`, `protected_patterns_extra`, and
  `secrets_extra_patterns` fields to `RsctConfig`. New `lib/dev-approval.ts`
  (zod schema + anti-reuse store `.rsct/approvals-seen.json` + INV-2.2
  fabrication signals: `reason_too_short`, `implausibly_fast`,
  `approvals_store_corrupt`). New `lib/audit-log.ts` (single-source JSONL
  append writer for `.rsct/audit.log`).
- **F2.5.1 — `rsct_check_branch` (`223487b`)** — pure query reporting
  whether a branch is protected. `effectiveProtectedList(config)` honors
  `protected_branches[]` (replaces default) and
  `protected_patterns_extra[]` (appends regardless). `source` field
  attributes the match to default / config / config+extras.
- **F2.5.2 — `rsct_check_secrets` (`b33c96e`)** — scans `git diff --cached`
  against `LINE_VALUE_PATTERNS` (word-boundary variants of the INV-6
  regex) + `secrets_extra_patterns[]`. Defensive compile skips invalid
  regexes; returned in `invalid_extra_patterns[]` for diagnostics.
- **F2.5.3 — `rsct_check_edit_scope` (`f1cb828`)** — compares a file
  path against the active spec phase's scope globs in
  `.rsct/phase-state.json`. Glob support v1: `*`, `**`, `?` plus regex
  metachar escape. Schema intentionally forgiving — M3 owns the
  canonical phase-state shape.
- **F2.5.4 — `lib/os-dialog.ts` cross-platform Yes/No (`de10b4c`)** —
  Windows MessageBox via PowerShell, macOS `osascript display dialog`,
  Linux `zenity --question`. Three injection seams for testability
  (`platform`, `executor`, `env`). `RSCT_TEST_DIALOG_RESPONSE=yes|no`
  is the documented test/CI escape valve.
- **F2.5.5a — `rsct_request_commit` (`82507e4`)** — §C-gated; orchestrated
  by new `lib/request-gate.ts` (the single §C handler). Validate → dialog
  → mutate → record. Approval consumption rule: never burn on
  pre-mutation rejects. Internally calls `rsct_check_branch` (INV-5) and
  `rsct_check_secrets` (INV-6) before commit.
- **F2.5.5b — `rsct_request_push` (`845cfb4`)** — §C-gated push; INV-5
  + audit. `override_protected_branch.reason` is logged to audit on
  override invocation (INV-9 attribution).
- **F2.5.5c — `rsct_request_merge` (`fa78783`)** — §C-gated merge,
  extra-strict by default. `override_protected_branch` is dual-purpose:
  it also acks the force-like risk of `allow_unrelated_histories=true`.
- **F2.5.6 — SessionStart sanitizer hook + `01-setup.md` Phase 4.V (`5d51e37`)** —
  INV-2.3 poison-pill closer. New standalone Node CLI at
  `src/scripts/sanitize-permissions.ts` (bundled to `dist/scripts/`,
  ~4.6 KB, zero external deps). New `prompts/01-setup.md` Phase 4.V
  (4.V.a discover via `npm root -g` / source-clone fallback / 4.V.b
  copy idempotently / 4.V.c register hook entry via inline node -e /
  4.V.d verify). Patterns stripped: `Bash(git commit*)`,
  `Bash(git push*)`, `Bash(git merge*)`, blanket `Bash(git*)` /
  `Bash(*)` and their `:*` variants. Benign permissions preserved.
- **F2.5.7a — anti-decisions cross-check + fixture defects (`ec35fee`)** —
  new `lib/anti-decisions.ts` parsing `### AD-NNN —` entries from
  `documentation/knowledge/anti-decisions.md`. `rsct_check_premise` now
  reads anti-decisions alongside ADRs/premises and lets anti-decision
  hits dominate the recommendation (`conflict` even when only a
  premise also matches). Also fixed two M1 audit defects: phantom
  ADR-007 cross-reference in the sample fixture (added the missing
  entry); `plan_sample-task.md` test fixture was silently gitignored by
  the global `plan_*.md` rule (`.gitignore` gained `!mcp-server/tests/fixtures/**`
  negation; the previously-untracked plan plus a new pairing
  `progress_sample-task.md` fixture are now tracked).

**M2 totals (at v0.2.0-m2 close):** 13 tools (7 from M1 + 6 new),
5 resources unchanged, 250/250 unit tests (+158 from M1), ESM bundle
~119 KB (server) + ~4.6 KB (sanitize-permissions CLI). Gate signed off
by the dev on 2026-06-06 (5/5 sign-off items). Merged
`feat/rsct-mcp-v1` + `feat/rsct-mcp-v2` → `main` as `1e3646b` and
tagged `v0.2.0-m2`. F2.5.8b symmetric uninstall side shipped before
gate sign-off; only carry-over is F2.5.7b (YAML profile parser),
queued for M3.

### Added — rsct-mcp v1 M1 (Recall MVP)

Companion MCP server at [`mcp-server/`](mcp-server/README.md) — the
institutional consciousness layer for Claude Code. Implementation tracked
in `plan_rsct-mcp-v1.md` (branch-local on `feat/rsct-mcp-v1`).

- **F0 — Knowledge graph scaffolding (`91ad8fa`)** — 10 category templates +
  README + `infrastructure.md.template` and Phase 4.5b in
  `prompts/01-setup.md` to scaffold them at setup time.
- **F1 — MCP server skeleton (`b6d2dcb`)** — Node + TypeScript MCP server
  with `rsct_status` and `rsct_load_context` bootstrap tools, zod-strict
  input validation, pino stderr logger, tsup ESM build, vitest suite.
- **F2.1 — `rsct_get_decisions` (`f99297f`)** — premises + ADRs with
  `kind`/`tag`/`status` filtering. Parser also recognises optional
  `**Status**:` / `**Tags**:` lines within entries.
- **F2.2 — `rsct_get_knowledge` (`d5404aa`)** — read any
  `documentation/knowledge/<category>.md`, split by `## / ###` sections,
  optional case-insensitive substring query.
- **F2.3 — `rsct_get_environments` (`0493ae7`)** — `.properties` + `.env`
  parser with per-profile delta vs base; INV-6 secret masking
  (single-sourced in `lib/secrets.ts`, ported from the parked
  `sectionE-secrets-leak.sh` hook regex); structured
  `documentation/infrastructure.md` reader. YAML detected but not parsed
  in v1.
- **F2.4 — `rsct_get_architecture` (`306baa2`)** — read
  `documentation/architecture.md` and the `modules/` / `impact/`
  directories; scope enum + optional `module_name` filter. Shared markdown
  section parser extracted to `lib/markdown.ts`.
- **F2.5 — `rsct_check_premise` (`519559b`)** — heuristic check of a
  proposed claim against premises/ADRs; returns
  `proceed | conflict | requires_revision` with ranked matches
  (token overlap + negation-pattern detection in EN + pt-BR).
- **F2.6 — 5 MCP resources (`afe6eef`)** — passive endpoints:
  `rsct://decisions`, `rsct://architecture`, `rsct://plan`,
  `rsct://progress`, and the templated `rsct://knowledge/{category}`
  (category constrained to `[A-Za-z0-9_-]+` to block path traversal).

**M1 totals:** 7 tools, 5 resources, 92 unit tests, ~54 KB ESM bundle,
cross-platform (Windows / macOS / Linux). M1 implementation complete;
the dev-owned **M1 validation guide** in
[`mcp-server/README.md`](mcp-server/README.md#m1-validation-guide)
is the gate before starting M2 (enforcement + phase machine + personas).

### Added

- **8 governance rules (§A–§H)** covering bug-mode, mandatory plan,
  commit reauthorization, branch protection, secrets leak prevention,
  state reversibility, testing, ADR auto-learning.
- **4 prompt scripts**: `01-setup.md`, `02-canonical-source.md`,
  `03-uninstall.md`, `04-init-universe.md`.
- **Marker convention** (`<!-- RSCT-§X-BEGIN v=1.0.0 source=... -->`,
  `<!-- RSCT-GENERATED v=1.0.0 created=... sha256-body=... -->`) for
  reversibility tracking.
- **Auto-discovery for 7 language stacks** — Java, Node, Rust, Go,
  Python, Ruby, PHP, .NET.
- **Portable SHA256 helper** supporting Linux, macOS, Windows (Git Bash).
- **Version-aware memory entries update** with 4 states (CREATE,
  UPDATE, SKIP, PRESERVE_WITH_WARNING) — protects developer
  customizations from framework upgrades.
- **Universe templates and `04-init-universe.md`** for bootstrapping
  organization-wide canonical source repositories.
- **Install/uninstall scripts** (`scripts/install.sh`,
  `scripts/uninstall-framework.sh`).
- **Filled example for Java/Spring stack** at `examples/java-spring/`.
- **§B item 1 — Recommended option mandatory.** Plans with multiple
  options must explicitly mark one as **Recommended** with a 1-2
  sentence reason.
- **§B item 5 — Mandatory read of `documentation/decisions.md`** before
  formulating plan options (firm premises, ADRs, out-of-scope check).
- **§B item 6 — Plan tracking files.** After plan approval, generate
  `plan_<slug>.md` and `progress_<slug>.md` at project root from
  templates. Branch-local via `.gitignore` patterns added by
  `/rsct-setup`. AI must remind dev about `git add --force` requirement
  and never let these files reach `main`/`test`.
- **§D — Active branch verification at task boundaries.** AI runs
  `git rev-parse --abbrev-ref HEAD` at start of every task and after
  pauses. If branch differs from prior plan, asks dev which to continue
  in. Always recommends derived branch over main/test/dev.
- **`doc-templates/plan_slug.md.template`** — standardized structure
  for approved plans.
- **`doc-templates/progress_slug.md.template`** — execution log
  template.
- **`memory-templates/feedback_plan-tracking.md`** — reminder for AI
  about plan/progress file creation and gitignore protocol.
- **MIT license.**

### Fixed in this dev cycle (post-real-use testing)

- **Phase 1.10 + Phase 3 — discrepancy detection between `.rsct.json`
  and discovery values.** When the existing `.rsct.json` has a config
  field whose value diverges from current discovery (e.g.,
  `protected_branches=["main"]` vs git origin having both `main` and
  `test`), the discrepancy is now surfaced as a mandatory question in
  Phase 3 with Recommended option marked. Previously the conservative
  "never overwrite" rule silently preserved the stale value, hiding
  the inconsistency from the developer.
- **Phase 4.4 — explicit integrity-vs-config field categorization.**
  `install.setup_commit_sha_before`, `install.canonical_source_added`,
  and `install.mode` are integrity fields (always preserved).
  `app.*`, `protected_branches`, `test_framework`, and `universe.*`
  are config fields (updatable via Phase 3 discrepancy resolution
  with explicit dev OK). The previous blanket "never overwrite" rule
  applied to config fields too — corrected.
- **§C — universal override path documented.** Any framework
  restriction (§A–§H) can be bypassed by the developer with an explicit,
  single-action OK that follows §C's "authorization does not reuse"
  protocol. Example: "commit direto na main" → AI restates intent, waits
  for OK, applies once. Next similar action requires fresh OK. Override
  is logged in `progress_<slug>.md` if a plan is active. Principle:
  framework guides, developer decides.
- **§G — QA Tester Execution Mode added** alongside the existing QA
  Planner Mode. Planner designs the suite; Tester executes it. Tester
  activities: requirements analysis from `documentation/decisions.md`
  and `plan_<slug>.md`, manual testing including edge/error cases,
  detailed bug reports (numbered repro steps, expected vs actual,
  severity, suspected cause), activation of §A (bug mode) if dev
  approves investigation, identification of test automation gaps with
  proposals via §B. Tester does NOT auto-fix — documents and escalates.
- **§B item 6 — proactive session resume with context-pressure
  detection.** AI cannot directly introspect its context window, so
  the framework watches THREE observable signals: (1) platform
  reminders about auto-compaction; (2) operation-count heuristic
  (4+ commits, 6+ edits, 30+ dev messages, multi-agent runs);
  (3) plan milestone (section completed, commit landed, blocker hit).
  On any signal, AI updates `progress_<slug>.md` with a fresh "Session
  resume" block AND proactively asks the dev whether to continue in
  this session (risk: compaction loses nuance) or generate a final
  resume to start a new session. AI does NOT wait for the dev to
  bring it up. Always-fresh state is the safety net even when
  detection fails.

### Reverted in this dev cycle

- **Language preference field in `.rsct.json`** — added experimentally,
  reverted because Claude auto-detects language from the developer's
  first message; the explicit field added bureaucracy without value.

### Known limitations carried to future release

- **Version-based update detection in Phase 4.6** — pre-v1.0.0 limitation.
  During dev cycle the framework version stays static at `1.0.0-dev`,
  so content updates to templates do NOT propagate to existing user
  installations on re-run of `/rsct-setup`. Workaround: developer
  manually deletes the affected memory file before re-running setup.
  Permanent fix planned before v1.0.0 release: switch to content-SHA
  comparison ("Option B") — see README Roadmap. Implementation note
  inline in `prompts/01-setup.md` Phase 4.6.
- **Memory write protocol** (Feedback 1 from real-use testing) — AI may
  write to `MEMORY.md` and add memory entries without explicit dev OK.
  Will require new rule or expansion of §C, with proposal at end of
  planning and surfaced storage management.
- **Two-pass audit before proposing plans** (Feedback 2) — currently
  the plan template has a "Pass 2 — cross-check" section but the rule
  §B does not yet enforce a re-read step.
