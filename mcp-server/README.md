# rsct-mcp

MCP server for the [RSCT framework](../) — institutional consciousness layer
for Claude Code.

Implements the **Recall MVP (M1)**, the **Enforcement MVP (M2)**, the
**M3 phase machine** (V phase + R/S/C/T pairs + classify_task), and the
**post-M3 multi-repo / onboarding / REVIEW** additions (T1c/T2/T3 + the DX track):
- **M1 — Recall (`plan_rsct-mcp-v1.md`):** 7 tools + 5 resources that let
  Claude reach into a project's structured documentation (decisions, knowledge
  graph, environment profiles, architecture, infrastructure) before proposing
  changes.
- **M2 — Enforcement (`plan_rsct-mcp-v2.md`):** 6 new tools (3 pure queries +
  3 §C-gated mutating ops), a SessionStart sanitizer hook (INV-2.3 closer),
  cross-platform OS dialog for out-of-band dev approval (INV-2.1), and
  anti-decisions cross-check in `rsct_check_premise`.
- **M3 (complete) — Phase machine + L3 personas + Tutor + issue capture + i18n:**
  `rsct_classify_task` (heuristic tier classifier),
  `rsct_phase_status`, the V phase
  (`rsct_phase_verification_{start,complete}`) with reverse-dep walk
  + 4-category checklist, the five R/S/C/REVIEW/T phase pairs
  (`rsct_phase_{research,spec,code,review,test}_{start,complete}`) backed
  by the shared `lib/phase-machine.ts`, `rsct_phase_abandon` (§C-gated
  phase discard), `rsct_capture_issue` (draft + create modes via gh
  CLI), 5 personas (Architect, Senior Dev, QA, DevOps, Security) +
  `rsct_persona_review` + `rsct_auto_persona`, and Tutor as the 6th
  persona (opt-in only) with `rsct_tutor_step`. Bilingual EN+pt-BR
  vocabulary across the heuristic keyword sets.
- **Post-M3 — multi-repo, onboarding & the REVIEW phase:** the 30 M1+M2+M3
  tools are joined by 7 more, bringing the catalog to **37**: org-universe
  governance reads (`rsct_get_universe`, T1c), multi-repo topology + the
  contract-surface gate (`rsct_get_topology`, T2), the guided-onboarding detector
  (`rsct_detect_onboarding`, DX-1), plan-authorization batch tokens
  (`rsct_plan_authorize` / `rsct_plan_revoke`, T3), and the mechanical REVIEW
  phase (`rsct_phase_review_start` / `rsct_phase_review_complete`, DX-4 — the
  cycle becomes R→S→V→C→REVIEW→T; since 2.11.0 it is R→S→V→C→T→REVIEW).

**Entry point for non-trivial tasks:** call `rsct_classify_task` with the
task description. It returns a tier (trivial / small / standard / complex)
and the recommended phase sequence. Tier is advisory — the phase tools
accept any phase regardless of classify_task output. For trivial / docs-only
fixes, skip the spec and code phases — but any change that touches code still
needs a completed REVIEW before `rsct_request_commit` accepts it.

**REVIEW phase (#62, 2.11.0)** — the last phase of the cycle
**R→S→V→C→T→REVIEW**: code and tests are reviewed together, on a green suite.
It is **mandatory at every tier** and anchored mechanically at the commit gate —
`include_review` (spec_complete) and `override_review_skip` / `spec_tier` /
`dev_approval` (test_start) were removed and are rejected with
`reject_kind: 'review_option_removed'`.

- `rsct_phase_review_start` returns `comment_sweep`: every touched code file
  (git, against HEAD, untracked included), its remaining comments and the
  comments the change removed.
- `rsct_phase_review_complete` recomputes that sweep before any dialog. A code
  file that still has a comment rejects (`comments_remaining`). Each removed
  comment — renamed and deleted files included — needs a `comment_dispositions`
  entry: `discarded`, or `migrated` with a `destination` among
  `documentation/decisions.md`, `documentation/knowledge/anti-decisions.md`,
  `docs/decisions.md`, where the comment text (at least 20 characters) must be
  in the lines added to that file (`dispositions_missing` returns
  `pending_dispositions`; also `migration_missing`, `disposition_unknown`,
  `disposition_duplicate`). Functional comments are kept by a closed allowlist
  of full-body patterns (shebang, licence header up to 30 lines,
  `@ts-expect-error`, `eslint-disable…`, `# noqa`, `NOSONAR`, `stylelint-disable…`,
  MySQL `/*+ hint */`, HTML conditional comments, …).
- Files the sweep cannot verify (`unsupported_language`, `unknown_extension`,
  `sql_dialect_missing`, `parse_error`, `binary_or_encoding`,
  `engine_unavailable`, `git_filter`, `head_unverified` — the HEAD version could not be
  scanned) and files listed in `exempt_files`
  (generated / vendored / legacy_baseline) go to one forced OS dialog only the dev answers: Yes
  makes those exact file versions committable without a mechanical comment or
  dead-code check, No
  rejects the REVIEW (`unverified_declined`), no channel or a dialog that ends
  without a Yes or No rejects (`unverified_undecided`). `legacy_baseline` is for
  comments that predate the no-comments rule on the first commit of a branch: it
  is accepted only while the branch has no commit yet (`legacy_baseline_refused`
  otherwise, before any dialog), the dialog names the branch, how many commits the
  repository already has on its other refs and the comment count per file, and
  says RSCT did not check that the comments predate the rule; the approval counts
  at commit only while the branch is still unborn (ADR-037).
- When comments were removed, files are unverified or an allowlisted comment
  changed, the §C dialog is forced (`trust_allowed_for` ignored) and names a
  report under `.rsct/reports/`. On success the tool stamps a sweep ledger —
  path + git blob id — in phase-state (kept across `rsct_phase_abandon`) and
  audits `review.sweep_stamped` / `review.unverified_decision`.
- `rsct_request_commit` checks every staged code file against that ledger before
  any dialog and again right before `git commit`, on every authorization path.
  A pre-commit hook that slips unreviewed code into the commit returns
  `committed_with_drift` and blocks further commits (`review_drift`) until a
  REVIEW covers those paths; a hook that only reformats is re-stamped.
- That ledger and the drift record live in `.rsct/phase-state.json`. When the
  file cannot be read, `rsct_request_commit` rejects **every** commit —
  docs-only included — with `review_unreadable`, at both check points, until the
  file is repaired or deleted. An empty or absent file is not unreadable.
- **Dead code (JavaScript/TypeScript, 2.12.0).** In the same REVIEW, a symbol
  declared in a touched file that nothing in the project references — its own
  file included — rejects `dead_code_remaining`; `pending_dead_code` lists each
  one with its declaration text and `declaration_sha256`. References are
  resolved (imports, aliases, default and namespace imports, re-exports followed
  to the end, local export clauses, tsconfig `paths`/`baseUrl`, scope
  shadowing with values and types kept apart), so a name that merely appears in
  a comment, a string or an unrelated symbol does not keep code alive, and self
  or mutual recursion is dead. A declaration whose initializer runs code when
  the module loads (a call, `new`, `await`, an assignment, a decorator, a static
  block) is never reported: its binding may be unused, but removing the
  statement removes the effect. The developer decides each symbol: remove it,
  or keep it with a `dead_code_keeps` entry (`path`, `name`,
  `declaration_sha256`, `note` with the reason given). A new keep forces the §C
  dialog, is written to the REVIEW report the dialog names (the dialog itself
  shows ten), is audited as `review.dead_code_kept`, and holds only for those
  exact declaration bytes (`dead_code_keep_stale` once they change — a hook that
  reformats a kept declaration therefore lands as drift, and the next REVIEW
  asks again). `rsct_request_commit` re-derives the verdict from the STAGED
  bytes in the index — never the working tree — at both check points
  (`dead_code_staged`), honours a keep only when its audit line exists, and
  re-checks a file a pre-commit hook rewrote; if that check cannot run, every
  rewrite lands as drift. What the scan cannot settle — a file no resolved
  import reaches (an entrypoint), an importer it cannot parse, a namespace used
  as a value, an import it cannot resolve or that matches a file only in another
  letter case (by the names that import uses), a
  computed `import()`/`require()`/`import.meta.glob`, a classic script's
  top-level names, a file that calls `eval` — is left unknown and named in
  `hints`, never reported dead and never passed silently. A file that checks for
  `module`, `exports` or `define` before exporting is judged like any other, with
  a hint saying a page could still load it with a script tag and reach what was
  reported. A touched file over
  2 MB is not parsed: the REVIEW and the commit refuse it, named, until the
  developer lets it through `exempt_files`. A commit refusal also names the
  files not staged yet that mention a refused symbol. Build output
  (`dist/`, `build/`, `coverage/` directly under a package root), vendored
  code, files the developer allowed without a mechanical check, and touched
  files in other languages are reported as not checked. Types are not judged.
- The three scripts `/rsct-setup` installs (`.rsct/scripts/sanitize-permissions.js`,
  `.rsct/scripts/edit-scope-guard.js`, `.rsct/scripts/terminal-guard.js`) need no REVIEW when their bytes are exactly
  the copy this `rsct-mcp` ships — shebang, the version stamp of this server, the
  shipped body; CRLF tolerated, nothing else. Any other content, path or version
  takes the path above (2.11.1).
- A phase `_start` without `spec_slug`, while phase-state still holds a different
  task name and no phase is active, returns `previous_task_pending` and writes
  nothing: ask the developer, then call again with `spec_slug` set to the recorded
  name (continue) or to `spec_ref` (new task). Restarting the same active phase
  keeps its name (2.11.1).
- Engines: tree-sitter (WASM, vendored under `grammars/` with a sha256 manifest)
  for JS/TS/TSX, Java, Python, PHP and CSS; parse5 for HTML (inline
  `<script>`/`<style>` go through the JS/CSS grammars); an in-house lexer for
  SQL, parameterised by `.rsct.json` `sql_dialect` (`postgresql` | `mysql` | `none`).

NOTE: the REVIEW *phase* is distinct from `rsct_persona_review` (a stateless
advisory lens).

Third-party code shipped for the sweep: `web-tree-sitter` 0.25.10 and the tree-sitter grammars (MIT, WASM under `grammars/`, listed with their versions and sha256 in `grammars/manifest.json`), `parse5` 7.3.0 (MIT) and its dependency `entities` 6.0.1 (BSD-2-Clause), bundled into `dist/index.js`.

**Plan-tracking gate (PH-1)** — symmetrically, `rsct_phase_code_start` refuses
the Code phase for `spec_tier ∈ {standard, complex}` unless the plan is tracked
on disk: `plan_<slug>.md` + `progress_<slug>.md` must exist (a multi-phase plan
also needs the per-phase `spec_<slug>.md`). Pass `plan_slug` to name the plan the
gate checks; `override_plan_tracking=true` bypasses, and like every other
`override_*` flag it requires a `dev_approval` and forces the OS dialog.
`trivial`/`small` skip it when a classify verdict backs the tier. A well-behaved §B flow creates these files at planning, so it
never trips the gate.

**Run alone (2.16.0, ADR-029)** — `rsct_phase_code_start` with `run_alone=true`
and a `dev_approval`, at the root of the repository or worktree only
(`run_alone_not_at_root` elsewhere), asks the developer, in a forced OS dialog shown
after every other gate passed (`trust_allowed_for` ignored, no channel = refused),
whether the agent may run code → tests → review on its own and stop before the
commit. On Yes,
`.rsct/phase-state.json` gets a `run_alone` record and `rsct_phase_code_complete`
/ `rsct_phase_test_complete` close with no dialog (`status: "deferred"`), after the
same precheck and `dev_approval` validation as before; each phase waits in
`run_alone.pending`. `rsct_phase_review_complete` first shows one forced dialog per
pending phase, in order, before any sweep or file change, whatever spec the REVIEW
was started under; a Yes is kept even if a later dialog fails. A No sends the work
back to that phase (`run_alone_rejected`): that entry and every later one are
dropped, the mode ends, and `phase`, `scope_globs` and `started_at` are cleared. A No
to the REVIEW's own dialog, once nothing is pending, keeps the mode on: what is
redone closes again with no dialog and is asked again before any commit. `rsct_request_commit`
refuses (`run_alone_pending`), before any dialog and before a batch token is read,
while a record exists at the named folder or at its repository root — also after a
No — and a REVIEW named from a folder below that root is refused the same way. The
record ends when a REVIEW is approved with nothing pending, or with
`rsct_phase_abandon` while a phase is active; abandon forces its dialog while
phases are pending and names them first. `rsct_phase_status` reports the record
only when there is one. Research, spec, verification and REVIEW completions are
never deferred.

## Status

| Milestone | State |
|---|---|
| M1 — Recall MVP (F0 + F1 + F2) | ✅ gate passed 2026-06-03; merged to `main` (tag `v0.2.0-m1`) |
| M2 — Enforcement MVP (F2.5.0..F2.5.8b) | ✅ gate passed 2026-06-06; merged to `main` (tag `v0.2.0-m2`) |
| Post-M2 Track 1 (safety hardening) | ✅ closed 2026-06-06; merged to `main` (tag `v0.2.1-track1-safety`) |
| Post-M2 Track 2 (install + docs + adoption) | ✅ closed 2026-06-06; merged to `main` (tag `v0.2.2-track2-complete`) |
| Post-M2 Track 3 (audit train) | ✅ closed 2026-06-06; merged to `main` (tag `v0.2.3-audit-complete`) |
| M3 V phase (verification between spec and code) | ✅ shipped 2026-06-07; merged to `main` (tag `v0.3.0-m3-v-phase`) |
| M3 CAPs batch 1 (INV-2.2 5/5 + load_context active_phase + phase-state lock) | ✅ shipped 2026-06-07; merged to `main` (tag `v0.4.0-m3-caps`) |
| M3 L4 phase machine (classify_task + R/S/C/T + status) | ✅ shipped 2026-06-07; merged to `main` (tag `v0.5.0-m3-phase-machine`) |
| M3 CAPs batch 2 (rsct_phase_abandon + README polish) | ✅ shipped 2026-06-07; merged to `main` (tag `v0.5.1-caps-batch-2`) |
| M3 issue capture (rsct_capture_issue + lib/gh) | ✅ shipped 2026-06-07; merged to `main` (tag `v0.5.2-m3-issue-capture`) |
| M3 F3 personas (5 personas + persona_review + auto_persona) | ✅ shipped 2026-06-07; merged to `main` (tag `v0.6.0-m3-personas`) |
| M3 Tutor persona (6th persona + tutor_step) — closes M3 | ✅ shipped 2026-06-07; merged to `main` (tag `v0.6.1-m3-tutor`) |
| i18n pt-BR + EN vocabulary expansion (post-M3 polish from runtime testing) | ✅ shipped 2026-06-07; merged to `main` (tag `v0.6.2-i18n-pt-br-en`) |
| Post-M3 — T1c universe reads · T2 multi-repo topology + contract gate · T3 plan tokens · DX track (onboarding orchestrator, plain-language copy, guided contracts, `docs/`, REVIEW phase, producer-mismatch warning, version reframe) | ✅ shipped to `main`; ships in **v2.0.0** (brings the catalog 30 → **37 tools**) |
| flow-lock — plan-tracking gate (`code_start`) · consumer + `app.name` name-mismatch warnings (topology) · `/VERSION` single-source · `/rsct-clean-code` command · batch-token offer at planning · `pre_merge_ack` hygiene gate (merge/push) · worktree nudge (`classify_task`) | ✅ shipped to `main`; ships in **v2.1.0** (37 tools, unchanged) |
| plan-lifecycle-v2 — dialog-free free-commit lane (audit-anchored anti-rollback ceiling + sliding token) · integration gate (mechanical `plan_complete` cross-check + advisory-only cleanup + `rsct_plan_dispose` + retroactive reconciliation) · `rsct_request_rebase` (rebase/squash) · re-bootstrap `context_stale` flag + PreToolUse edit-scope guard · settings.json machine-path hygiene · unified idempotent `/rsct-universe` · `plan_file_retention` toggle | ✅ shipped to `main`; ships in **v2.2.0** (brings the catalog 37 → **39 tools**) |
| field-test-repairs — install-drift ranking (content evidence; `security` only when an enforcement script is **absent**) · V-phase stale-label repair + `clear_phase` deprecation · commit-message cap (`message_too_long`) · `rsct_capture_issue` adapts to the host repo's labels/types · advisory channel on every `request_commit` return path · `auditFields` collapsed 15 → 1 | ✅ shipped to `main`; ships in **v2.3.0** (39 tools, unchanged) |
| hook-registration — install drift also checks whether the enforcement **hooks are registered** in `.claude/settings.json`, not just whether the script files are current; a present-but-unwired script now escalates alongside an absent one · `stale_components` → `affected_components` (carries a `registration` state) · four doc pages corrected on where the hooks actually live | ✅ shipped to `main`; ships in **v2.4.0** (39 tools, unchanged) |
| backlog-sweep — unowned `.claude/settings.json` drift reported at the commit gate (#17) · REVIEW gains `findings_actions[]` + a `block` abort (#19) · the install-drift advisory reaches push/merge and the OS dialog, and suspends the free-commit lane (#25) · commit-message cap elicited at setup instead of imposed (#26) · sanitizer relocates machine paths out of `permissions.allow[]`, and every shared-JSON parse site tolerates a UTF-8 BOM (#12) · `verification_start` refuses to overwrite an active phase (#27) · `verify:dist` runs in CI (#28) · excerpt / section-query / finding-vocabulary helpers consolidated (#10) | ✅ shipped to `main`; ships in **v2.5.0** (39 tools, unchanged) |
| security patch — five `git` bypass forms closed in the poison-pill detector, incl. the wildcard `Bash(git -C:*)` that commits in ANOTHER repo (#32) · all four open Dependabot advisories cleared by hand, because `fast-uri` is bundled into the tracked `dist/` and a lockfile-only fix leaves the vulnerable code in the shipped artifact | ✅ shipped to `main`; ships in **v2.5.1** (39 tools, unchanged) |
| silent-drift-repairs — two mechanisms built to make drift visible were themselves reporting "fine". `install.sh` wrote a line of `version.ts`'s DOCSTRING into `~/.rsct/VERSION-CODE`, and since both sides of the comparison read that file the code axis said `same` forever (#44) · `CLAUDE.md` rule sections were FROZEN at their install release — Phase 2's "never overwrite present-en" meant a changed `rules/X-*.md` never reached a project, while Phase 4.4 kept restamping `rsct_version` so the field a dev would check said "current" (#45). New Phase **4.3b** reconciles the nine sections under one invariant: a body is rewritten only when its authorship is PROVABLE (hash matches the marker, or the body already matches the shipped rule) · section markers gain `sha256-body=` (additive — schema id stays `v=1.0.0`) | ✅ ships in **v2.7.0** (39 tools, unchanged) |
| legacy-command-references — `/rsct-universe` now **creates AND links in one run**: state B stopped at creation, leaving the dev with a universe and an unlinked project until they ran the command a second time · 27 places still pointed at `/rsct-init-universe` / `/rsct-canonical-source`, which `install.sh` deletes — nine of them runtime hints in `get_universe`, `topology` and the onboarding detector, i.e. the text an agent acts on | ✅ ships in **v2.6.1** (39 tools, unchanged) |
| review-binding — the V and REVIEW phases stop being completable by answering nothing (#40): every finding raised needs an action, ids are validated against the stored baseline, duplicates and stale answer sets are rejected, and `rsct_phase_review_start` gains a declared `findings[]` so REVIEW has a baseline at all · rejections return `open_findings` (and `rsct_phase_status` lists them) so a resumed session can answer without re-running `_start` · the test gate treats "a completed review has no pending findings" as an invariant, which also catches a downgraded binary stamping `completed_at` without the check | ✅ ships in **v2.6.0** (39 tools, unchanged) |
| update-check-default — the GitHub release check flips opt-IN → **opt-OUT** (#38): consent absent now means consult, so a dev who never answered stops being silent about security patches · declines become **per release** (`decline_update`), and only the release actually on offer is accepted · `RSCT_UPDATE_CHECK` env kill switch · `/rsct-setup` Phase 4.9 becomes echo-only (no question, no write) · fixes a retry storm and a future-timestamp freeze that were live for consenting users | ✅ shipped to `main`; ships in **v2.6.0** (39 tools, unchanged) |

**40 tools · 5 resources · tsc strict · ESM ~1.90 MB
(server) + ~17 KB (sanitize-permissions hook) + ~151 KB (edit-scope guard) +
~31 KB (terminal guard) + ~5.3 MB (tree-sitter grammars, `grammars/`) ·
cross-platform (Windows / macOS / Linux)**

---

## Install

Requirements: Node 20+, npm 10+.

From the repository root, run the installer:

```bash
bash scripts/install.sh
```

It copies the prebuilt package (`package.json` plus what its `files` field lists)
into `~/.rsct/mcp-server`, links the global `rsct-mcp` command to that copy, and
then checks that the `rsct-mcp` on PATH is that copy and starts. The clone is not
what runs: switching branches, moving or deleting it changes nothing until the
installer runs again.

Changed `src/`? Build first, then run the installer:

```bash
cd mcp-server
npm install
npm run build
```

To run a working tree as the machine's `rsct-mcp` on purpose — a link to the
clone — see [CONTRIBUTING.md](../CONTRIBUTING.md#running-your-working-tree-as-the-machines-rsct-mcp).

Verify the binary boots cleanly:

```bash
# Git Bash / macOS / Linux:
node dist/index.js < /dev/null
# Windows PowerShell (PowerShell does not accept `<` as stdin redirect):
#   cmd /c "node dist\index.js < NUL"
# OR via the global binary (after the installer ran):
#   rsct-mcp  # then Ctrl+C after the ready log appears
```

Expect on stderr (single JSON line, then clean exit 0):

```json
{"level":30,"time":"...","name":"rsct-mcp","version":"x.y.z",
 "tools":["rsct_status","rsct_load_context","rsct_get_decisions",
          "rsct_get_knowledge","rsct_get_environments",
          "rsct_get_architecture","rsct_get_universe",
          "rsct_get_topology","rsct_detect_onboarding",
          "rsct_check_premise","rsct_check_branch",
          "rsct_check_secrets","rsct_check_edit_scope",
          "rsct_request_commit","rsct_request_push",
          "rsct_request_merge","rsct_request_rebase",
          "rsct_plan_authorize","rsct_plan_revoke",
          "rsct_plan_dispose","rsct_classify_task",
          "rsct_phase_status","rsct_phase_research_start",
          "rsct_phase_research_complete","rsct_phase_spec_start",
          "rsct_phase_spec_complete","rsct_phase_verification_start",
          "rsct_phase_verification_complete","rsct_phase_code_start",
          "rsct_phase_code_complete","rsct_phase_review_start",
          "rsct_phase_review_complete","rsct_phase_test_start",
          "rsct_phase_test_complete","rsct_phase_abandon",
          "rsct_capture_issue","rsct_persona_review",
          "rsct_auto_persona","rsct_tutor_step","rsct_audit"],
 "resources":["rsct://decisions","rsct://architecture",
              "rsct://plan","rsct://progress"],
 "resource_templates":["rsct://knowledge/{category}"],
 "msg":"rsct-mcp ready"}
```

The immediate exit is correct: the server reads MCP protocol from stdin;
piping `/dev/null` (or `NUL` on Windows) gives it nothing, so it closes
after the ready log.

> The JSON above is an illustrative example — the `version` and exact tool list
> reflect whatever build you have installed, not a pinned snapshot.

---

## Register with Claude Code

From inside a project directory:

```bash
claude mcp add rsct rsct-mcp --scope project
```

This creates / updates `.mcp.json`:

```json
{
  "mcpServers": {
    "rsct": {
      "command": "rsct-mcp",
      "args": []
    }
  }
}
```

`args: []` — no path. The server auto-detects the project root from its cwd or
the `CLAUDE_PROJECT_DIR` env var Claude Code sets, or from an explicit
`project_root` tool argument. Do **not** put `["--project-root",
"${workspaceFolder}"]` here: Claude Code does not expand that placeholder, so
the server would receive the literal string and resolve it against its cwd
(`C:\Windows` on WSL-from-Windows) — reporting `rsct_installed: false`. To pin a
root explicitly, pass a real absolute path or set `RSCT_PROJECT_ROOT`.

**Restart Claude Code** so the new MCP server is picked up. The tools
`mcp__rsct__rsct_*` should appear in the tool list, and the `rsct://...`
resources should be browsable from the resource picker.

---

## M1 validation guide

This is the dev-owned checklist required to clear M1 and proceed to M2.
Each row is one prompt / one verification.

> Use the rsct-framework repo itself as the test project — it already has
> `.rsct.json`, `documentation/decisions.md`, `documentation/knowledge/*`,
> active plan/progress files, sample modules, and impact analyses. No
> sandbox needed.

### Pre-flight

- [ ] `rsct-mcp` is on PATH (`where rsct-mcp` on Windows / `which rsct-mcp` on Unix).
- [ ] `node dist/index.js < /dev/null` prints the ready log and exits 0.
- [ ] `claude mcp add rsct rsct-mcp --scope project` ran from the test project root.
- [ ] Claude Code restarted after registration.

### Tool checks (7)

Ask Claude each prompt in a fresh chat and verify it invokes the tool
listed (visible in the tool-use trace) and that the response matches the
file content on disk.

| # | Prompt | Expected tool | Verify |
|---|---|---|---|
| 1 | "What rsct project am I in?" | `rsct_status` | Returns project name, protected branches, current branch. |
| 2 | "Give me a session bootstrap — plan, decisions summary, knowledge graph coverage." | `rsct_load_context` | Lists active `plan_<slug>.md`, premise + ADR counts, knowledge categories present/missing. |
| 3 | "List the firm premises in this project." | `rsct_get_decisions` with `filter.kind=premise` | At least one entry from `documentation/decisions.md`. |
| 4 | "Show me business rules captured in the knowledge graph." | `rsct_get_knowledge` with `category="business-rules"` | Sections from `documentation/knowledge/business-rules.md`. |
| 5 | "What's the delta between prod and base profiles?" | `rsct_get_environments` with `scope="profiles"` | Per-profile added/modified lists; secret-shaped values masked as `***MASKED***`. |
| 6 | "What's the impact of changing the orders module?" | `rsct_get_architecture` with `scope="impact"`, `module_name="orders"` | Returns `documentation/impact/orders.md` parsed into sections. |
| 7 | "Check whether 'use DynamoDB for orders' conflicts with existing decisions." | `rsct_check_premise` with that claim | Returns `recommendation` (one of proceed / conflict / requires_revision) and matched entries with `shared_tokens`. |

### Resource checks (5)

| # | Prompt | Resource | Verify |
|---|---|---|---|
| 1 | "Read `rsct://decisions` and tell me the most recent ADR." | `rsct://decisions` | Returns the full markdown of `documentation/decisions.md`. |
| 2 | "Read `rsct://knowledge/anti-decisions`." | `rsct://knowledge/{category}` template | Returns the body of `anti-decisions.md`; non-existent category errors. |
| 3 | "Read `rsct://plan`." | `rsct://plan` | Returns the active plan body. |
| 4 | "Read `rsct://progress`." | `rsct://progress` | Returns the matching progress body. |
| 5 | "Read `rsct://architecture`." | `rsct://architecture` | Returns `documentation/architecture.md`. |

### Sign-off (4-bullet M1 gate)

- [ ] `rsct-mcp` registers and runs on the primary maintainer platform (e.g., Windows + Git Bash).
- [ ] All 7 tools and 5 resources respond as expected (tables above).
- [ ] Claude reads `decisions.md` via tool in a real conversation (Tool check #3 or #7 is the canonical proof).
- [ ] Dev signs off in progress_rsct-mcp-v1.md to start M2.

If any row fails, capture the failure (tool name, prompt, actual vs expected
response) in the progress file before opening a fix.

---

## Tools reference

All tools degrade gracefully outside rsct projects (return
`rsct_installed: false` + hints, never throw) and validate input with
`zod` in strict mode (unknown keys are rejected).

### `rsct_status`

Fast bootstrap check. Returns rsct identity, protected branches, git state, the
[`universe` block](#the-universe-block), and hints.

`protected_branches` is the list the §C gates actually enforce — `.rsct.json`
`protected_branches[]` plus `protected_patterns_extra`, or the built-in defaults
when the key is absent. A project with no `.rsct.json` reports none.

- Input: `project_root?`, `update_check?` (`"on"|"off"`), `decline_update?` (a release tag)
- Output: identity, git, `worktree`, `universe`, `topology`, hints

The bootstrap marker is **evaluated before it is stamped**, so the report describes the
session as it was on entry, not the state this call just wrote. `hints[]` carries one line
when §0 had never been recorded, when the recorded marker was older than the stale window,
or when the marker could not be written (another session holds the phase-state lock, or the
write failed) — and stays silent when it was already fresh. Stamping is still best-effort:
`rsct_status` never fails on a metadata write.

The two update-check parameters are the response channel for the release hint this
tool emits (the check consults by default since v2.6.0 — see
[README § Update check](../README.md#update-check-what-leaves-your-machine-and-how-to-turn-it-off)).

- `decline_update:"v2.6.0"` records that the dev declined **that release**: it is
  never raised again, a newer one asks once more. Only the release currently being
  offered is accepted — any other tag is rejected and nothing is written, so a
  mistyped or pre-emptive decline cannot silently swallow a future security patch.
  Pass it only when the dev actually declined.
- `update_check:"off"` turns the check off for the machine; `"on"` restores it.

The handler is tolerant by design: a value it does not recognise (including a
non-string) produces a hint rather than an error, because `rsct_status` is the tool
every session starts with and failing it would also cost the caller git state,
topology and the install-drift security advisory. Note the published `inputSchema`
still advertises `enum: ["on","off"]` — that is the contract the agent should follow,
and an MCP client that validates arguments locally may reject a variation before the
handler ever sees it.

`RSCT_UPDATE_CHECK=off` in the environment overrides both parameters; when it is set,
`update_check:"on"` says so instead of claiming an effect it cannot deliver.

### The findings gate (V and REVIEW)

Both phases raise findings and both refuse to complete while any of them has no
action (#40). The gate itself is one implementation, in `lib/findings.ts`, so its
rules cannot drift — though the two tools still call it from different points in
their own sequence (V after its `spec_ref` check, REVIEW before `gatePhaseComplete`,
which is why REVIEW passes the stored `spec_ref` into the gate).

- **Coverage** — every finding the phase raised needs an action. This is what makes
  the phase bind; before it, `findings_actions: []` closed a phase that had raised
  five problems.
- **Id validation** — an id not in the stored baseline is rejected rather than logged.
  Duplicates too: two actions for one finding is not a decision.
- **Run identity** — `_start` returns a `findings_run_id`; echo it at `_complete`.
  Supplying a stale one is rejected as a set. Omitting it is allowed: the id set is
  what the run id hashes, so a stale answer usually surfaces as unknown-or-unanswered
  anyway. It is not airtight — a re-run that happens to produce the *same ids* yields
  the same run id, and for REVIEW the ids are agent-chosen, so an agent reusing id
  strings defeats it by construction. It catches the accident, not the adversary.
- **Cross-spec** — a stored baseline whose `spec_ref` differs from the one being
  completed is refused outright. Without that, a re-plan could be completed by
  answering the previous spec's findings, which also pruned them.
- **Recovery** — a findings-gate rejection returns `open_findings`, and
  `rsct_phase_status` lists them, so a resumed session never has to re-run `_start`
  (which would rewrite the baseline it is being measured against). Other rejections
  (`block_actions_present`, the §C gate) do not carry the field.
- **Fail-open** — no usable baseline (absent, empty, `null`, not an array, or elements
  without ids) skips every check. An unreadable baseline must never make a phase
  uncompletable.

REVIEW's baseline is **declared**: `rsct_phase_review_start` takes `findings[]`,
because #33 established there is no viable mechanical producer for it. That closes
"declared five, answered none" — it does not close an agent that declares nothing,
and the tool descriptions say so rather than implying a stronger guarantee.

#### How a finding is known (#75)

The gate above could prove a finding was *answered* and never that it was *true*: a
measured fact and an untested guess were stored, counted and gated identically. Each
finding now carries an `evidence` class — `measured` (the command, an output excerpt,
and **what else would produce that same output**), `reported` (the source, and whether
it was checked against a commit or a working tree), or `hypothesis` (how to falsify
it). The two phases get it from different places, because they are structurally
different: **V** findings are machine-produced, so the framework classifies its own
from a static `source` table; **REVIEW** findings are agent-declared, so the agent
supplies it.

- **Optional at the door, degraded when absent.** Omitting `evidence` is never a
  rejection — the finding counts as an *unrecorded* hypothesis. What IS rejected is an
  inconsistent claim: `measured` with no command. Absent, malformed or unrecognised
  becomes `hypothesis`, never fact.
- **`open_findings` carries it.** The recovery payload returns the class with the
  finding, so a rejected or resumed session answers without re-deriving evidence it no
  longer has — and a legacy finding stored before this still parses, still gates, and
  reads as unrecorded.
- **The mix is surfaced** in `rsct_phase_status`, `rsct_load_context`, both `_complete`
  summaries, the approval dialog and the audit log — *"12 findings, 11 of them
  hypotheses"* before the dev approves. Three surfaces rather than one, because the
  `trust` channel renders no dialog at all.
- **What it does not do.** Nothing here checks whether `also_explained_by` is honest;
  the class separates *kinds* of knowing, not strengths within a kind, so two findings
  from the same source stay indistinguishable from each other. `findings_run_id` still
  hashes ids only, so re-declaring the same ids with weaker evidence does not read as a
  stale set.

Findings also record `head_sha` (full, never an abbreviation) and `observed_at` at the
phase start; `_complete` compares against HEAD and reports `head_stale`. It **marks,
never rejects** — HEAD moves while a review is open when non-code changes, or code an
earlier REVIEW stamped, are committed (unstamped code cannot be committed at all). Unknown is `null`, never `true`.

### `rsct_load_context`

Full session bootstrap — `rsct_status` plus active plan, decisions snapshot, knowledge index, next-action hints.

- Input: `project_root?`, `decisions_excerpt_count?` (default 3, max 20)
- Output: structured snapshot for session priming (identity, git, active plan,
  decisions, knowledge, `universe`, `next_action_hints`)

Same pre-stamp evaluation as `rsct_status`, reported in `next_action_hints[]`. One
difference: this tool also clears the `context_stale` re-bootstrap flag, and that clear
rides in the **same write** as the marker — so when the write does not land, the hint says
the flag was NOT cleared and the edit guard is still blocking.

### The `universe` block

Both `rsct_status` and `rsct_load_context` surface the org-level **universe**
(the layer created/adjusted and linked by the unified `/rsct-universe`
command). They compute it from a single shared source, so the two
outputs never drift, and it is **fail-graceful**: any error degrades to an empty
block and never throws into the bootstrap path. A project with no universe behaves
exactly as before this feature existed (`available: false`, no hint).

The block is **always present** with these fields:

| Field | Type | Meaning |
|---|---|---|
| `available` | boolean | `true` only when a universe was resolved AND its `.universe.json` was read. |
| `name` | string \| null | Universe name (from `.universe.json`, else `.rsct.json universe.name`). |
| `local_path` | string \| null | The resolved universe path that was chosen (transparency). |
| `registered_apps_count` | number | Count of `applications/<app>/` **directories** (ground truth — not the `.universe.json` list length). |
| `this_app_registered` | boolean | Whether this project's app is registered in the universe. |
| `note` | string \| null | Diagnostic for the degraded / configured-missing / reconciliation states. |
| `governance` | object | Index of the universe's org-level governance docs (slugs only): `{ available, governance_dir, docs[], has_index }`. Read their content with [`rsct_get_universe`](#rsct_get_universe). Empty when no universe or no `docs/governance/`. |

When the block carries an actionable message, a one-line `hint` is also pushed into
`hints` (status) / `next_action_hints` (load_context). States:

- **none** — no universe found (or project not rsct-managed): empty block, no hint.
- **found + registered** — `available: true`, `this_app_registered: true`, no hint.
- **found + NOT registered** — `available: true`, `this_app_registered: false`, plus a
  hint to run `/rsct-setup` to register the app (see [Phase 4.8 registration](../README.md#universe-app-registration)).
- **configured-missing** — `.rsct.json universe.local` points somewhere that does not
  exist: `available: false`, `note` "configured but not found", hint to fix it.
- **unreadable (degraded)** — the directory exists but `.universe.json` is missing or
  corrupt: `available: false`, `note` "found but unreadable".
- **reconciliation** — the `.universe.json registered_apps[]` index and the
  `applications/<app>/` directories disagree: `note` explains the mismatch.

### The `topology` block

Both `rsct_status` and `rsct_load_context` also surface a **topology** block (T2),
computed from the same single source, fail-graceful (absent config / universe → `mono`,
no hint). It reports the repo's place in a multi-repo org and is what the
contract-surface gate ([`rsct_request_commit`](#rsct_request_commit)) diverges on:

| Field | Type | Meaning |
|---|---|---|
| `confirmed_mode` | `'mono'\|'monorepo'\|'multi-repo'` \| null | The dev-confirmed mode from `.rsct.json topology.mode` (authoritative — what the gate uses). `null` until `/rsct-setup` confirms it. |
| `inferred_mode` | `'mono'\|'monorepo'\|'multi-repo'` | Silent inference from on-disk signals — only **pre-selects** the explicit ask; never gates. |
| `confidence` | `'high'\|'medium'\|'low'` | Confidence of the inference (monorepo is always `low`). |
| `effective_mode` | mode | `confirmed_mode ?? inferred_mode` (what to display when unconfirmed). |
| `signals` | object | `{ universe_available, registered_apps_count, this_app_registered, nested_app_markers, universe_external }`. |

The gate is enforced **only** when `confirmed_mode === 'multi-repo'` AND a `contracts.json`
exists at the universe root AND a produced surface is touched. When `confirmed_mode` is
`multi-repo` but the gate can't fire (no universe linked / no `contracts.json`), a HIGH
**inactive-gate** hint is pushed so the off gate is never silent. Read the contract graph
with [`rsct_get_topology`](#rsct_get_topology).

### `rsct_get_decisions`

Returns firm premises and ADRs from `documentation/decisions.md`, optionally filtered.

Headings parse at `##` or `###`, with `—`, `–`, `-` or `:` as the separator — §H
still prescribes one shape to write, the reader just tolerates the rest. A file that
exists but cannot be read, or that mentions decision ids yet yields no entry, is
reported in `hints` instead of returning a clean zero. Every tool that reads the
corpus carries that reporting: `rsct_load_context` in `next_action_hints`,
`rsct_check_premise` in `hints`, and the V-phase checklist behind
`rsct_phase_verification_start`.

- Input: `project_root?`, `filter?: { kind?: 'premise'|'adr', tag?: string, status?: 'active'|'superseded'|'deprecated' }`
- Output: matched decisions array + counts + hints

The parser also recognises optional `**Status**:` and `**Tags**:` lines
inside any premise or ADR section.

### `rsct_get_knowledge`

Reads `documentation/knowledge/<category>.md` and splits it into `##` / `###` sections.

- Input: `project_root?`, `category` (required), `query?` (case-insensitive substring across heading + body)
- Output: section list (level, heading, body, excerpt) + `available_categories` + hints

Non-canonical categories are accepted with a hint rather than rejected — projects may have custom categories.

### `rsct_get_environments`

Parses `application.properties`, `application-<profile>.properties`, and `.env*` files; computes per-profile deltas (added + modified); masks values matching INV-6 secret patterns.

- Input: `project_root?`, `scope: 'profiles'|'infrastructure'|'all'`
- Output: parsed files, detected profiles, profile deltas, infrastructure entries, masking summary

YAML files (`application*.yml`) are detected and listed in `yaml_files_detected_but_not_parsed` but not parsed in v1.

### `rsct_get_architecture`

Reads `documentation/architecture.md` and the `modules/` / `impact/` directories.

- Input: `project_root?`, `scope?: 'overview'|'module'|'impact'|'all'` (default `overview`), `module_name?` (narrows scope=module/impact)
- Output: overview file, modules set, impacts set + hints

### `rsct_get_universe`

Reads the linked **org-level universe's** governance content — `docs/governance/*.md`
and `docs/INDEX.md` — so Claude can consult org naming standards / the canonical-sources
map before proposing structure (the §0 rule treats org standards as authoritative over
local guesses). The universe layout is **not** the project layout: a universe has no
`documentation/{decisions,knowledge,architecture}`; its authority lives under
`docs/governance/`. Resolution reuses the same single source as the [`universe` block](#the-universe-block).

- Input: `project_root?`, `scope?: 'governance'|'index'|'all'` (default `governance`), `doc?` (governance slug, narrows scope=governance; ignored for scope=index), `query?` (case-insensitive substring across heading + body)
- Output: `universe_available`, `universe_path`, `governance` index, `docs[]` (each `{ slug, exists, path, sections[] }`) + hints

Fail-graceful: no universe linked, or governance unscaffolded → `universe_available: false`
/ empty `docs` with a hint (never an error). A `doc` slug containing a path separator,
`..`, or an absolute path is rejected (returns `exists: false`).

### `rsct_get_topology`

Reports the repo **topology** ([`topology` block](#the-topology-block)) plus the org-level
**contract graph** read from `contracts.json` at the universe root: the contracts this app
**produces** (its surfaces) and **consumes** (its dependencies). A contract is a *surface* —
path globs in the producer repo (`openapi/*.yaml`, `src/api/**`, `proto/**`) that consumer
apps depend on.

- Input: `project_root?`
- Output: `topology` block, `contracts` graph (`{ available, contracts[], note }`), `produced[]`,
  `consumed[]`, `app_name`, `universe_path` + hints

In **multi-repo** mode, [`rsct_request_commit`](#rsct_request_commit) **blocks** a commit that
touches a produced surface (listing the affected consumers) unless
`dev_approval.override_contract_surface: { reason }` is given. Surface globs support `*` `**`
`?` only (no `{a,b}` / `[abc]`); `dir/**` needs the trailing slash and does **not** match a
sibling `dir.ext` file. A leading `**/` spans whole directories, so `**/api/**` covers `api/`,
`src/api/` and `any/dir/api/`, never `webapi/` or `openapi/` (2.11.2). Fail-graceful: no universe / no `contracts.json` → empty graph + a
hint (never an error).

**Name-mismatch warnings.** Whenever the contract graph and the universe are both
readable, `rsct_get_topology` validates every contract `producer`, every contract `consumer`,
and this repo's own `app.name` against the **registered apps** (the union of the
`applications/` directories and `.universe.json` `registered_apps[]`). The gate compares names
exactly and case-sensitively (`===`), so an unregistered or mis-cased name silently never
gates/matches — a case-only difference is flagged as a likely typo with the correctly-cased
name to use. The **`app.name` check is load-bearing**: because the gate's own left operand is
`config.app.name`, a folder-cased `app.name` (e.g. `Api-AdminBluelt` vs the registered
`api-adminbluelt`) makes the gate silently never fire for **this** repo's own commits — that
case-drift is surfaced explicitly (an outright-unregistered `app.name` is just "not registered
yet" and is not flagged here). When the universe has **zero** registered apps, a single summary
hint replaces the per-name wall. Lists the offending name(s), not just a count.

### `rsct_detect_onboarding`

The onboarding orchestrator brain for `/rsct-setup`. Classifies the project's onboarding
**situation** — `is-universe` (a `.universe.json` is present → this is a universe repo, not an
app), `has-universe-linked`, `has-universe-unlinked`, `universe-configured-missing`,
`offer-register`, `siblings-no-universe` (same-org sibling repos detected, no universe yet →
offer to create one), or `solo` — and returns the recommended **route** for the setup prompt to
follow. The same-org sibling scan reads `../` one level (origin-pinned, CRLF-safe, case-folded
self-skip); universe discovery additionally probes the canonical candidate paths, which include
`$HOME/{projetos,projects,dev,workspace}/<org>-universe`. It never writes.

When the resolver returns nothing — typically before `.rsct.json` exists — a fresh project
sitting beside its org's universe used to be told to **create a second one**. Discovery closes
that: `discovered_universe_path` reports a universe found at a canonical path but not yet
resolved, and `universe.available` / `universe.local_path` keep meaning strictly what the
resolver returned.

- Input: `project_root?`
- Output: `rsct_installed`, `situation`, `route`, `discovered_universe_path`, the resolved
  universe/sibling signals + hints

### `rsct_check_premise`

Heuristic check: tokenises a claim, scores against decisions AND anti-decisions by shared-token overlap (`MIN_SCORE=2`), scans matched decision entries for negation patterns, returns a recommendation.

- Input: `project_root?`, `claim` (≥5 chars), `against?: 'premises'|'adrs'|'both'` (default `both`)
- Output: `recommendation: 'proceed' | 'conflict' | 'requires_revision'`, ranked decision matches (score, shared_tokens, negation_signal), anti-decision matches (score, shared_tokens), human-readable `reason`

`conflict` is returned when:
- a matched decision contains rollback / rejection language (`rolled back`, `superseded`, `deprecated`, `do not`, `rejected`, `anti-pattern`, `never`, `revogado`, `não usar`, etc.), OR
- the claim matches an anti-decision entry in `documentation/knowledge/anti-decisions.md` — the team explicitly abandoned that path. Anti-decision hits ALWAYS dominate the recommendation, even when an active premise also matches.

Anti-decision headings parse at `##` or `###` with `—`, `–`, `-` or `:` as the
separator; §H prescribes `### AD-NNN — <title>` as the one shape to write, and the
reader tolerates the rest. Either corpus — `decisions.md` or `anti-decisions.md` —
that exists but cannot be read, or that mentions ids yet yields no entry, is
reported in `hints` rather than silently reducing the corpus to zero. That matters
most here: nothing upstream reads `anti-decisions.md`, so an unreported miss would
be the last word, and a `proceed` built on it is the most expensive answer this
tool can give.

---

## M2 features — Enforcement layer

M2 adds **7 new tools** (3 pure queries + 4 §C-gated mutating ops — commit,
push, merge and `rsct_request_rebase`) plus a SessionStart sanitizer hook.
Counting note, because the headings below invite the wrong answer: the
`§C-gated mutating ops` section documents **six** ops, since `rsct_plan_authorize`
and `rsct_plan_revoke` are filed there by subject while belonging to the post-M3
group. M2 is four. `README.md`'s group breakdown is the arithmetic of record. Together they materialize §C/§D/§E from
[CLAUDE.md governance rules](../rules/) as enforceable contracts: an "always
allow" entry in `permissions.allow[]` no longer bypasses commit/push/merge
(nor, since #91, rebase/cherry-pick/revert or `gh pr merge`)
on a protected branch or with secrets in the diff.

### Pure queries (NOT §C-gated)

#### `rsct_check_branch`

Reports whether a given branch is in the project's protected list.

- Input: `project_root?`, `branch?` (defaults to current HEAD)
- Output: `branch`, `is_protected: boolean`, `protected_list[]`, `source: 'default' | 'config' | 'config+extras'`

Honors `.rsct.json` `protected_branches[]` (replaces default) and
`protected_patterns_extra[]` (appends regardless). Used internally by
`rsct_request_*` tools; exposed so Claude can pre-check without triggering
the §C dialog.

#### `rsct_check_secrets`

Scans `git diff --cached` against INV-6 secret patterns
(`mcp-server/src/lib/secrets.ts` — single source of truth for the
INV-6 regex).

- Input: `project_root?`, `staged_only?` (default true), `diff_override?` (programmatic test input)
- Output: `findings[]` (per-line classification: `key-name`, `value-shape`, etc.), `extra_patterns_used[]`, `invalid_extra_patterns[]`

Honors `.rsct.json` `secrets_extra_patterns[]` for project-specific
regexes. Invalid regexes are skipped (returned in
`invalid_extra_patterns[]` for diagnostics) — never abort the scan.

#### `rsct_check_edit_scope`

Compares a file path against the active spec phase's scope globs in
`.rsct/phase-state.json`.

- Input: `project_root?`, `file_path`
- Output: `status: 'in_scope' | 'out_of_scope' | 'unknown' | 'stale_context'`,
  `matched_glob` (`null` when none), `phase`, `spec_slug`, `scope_globs`,
  `rsct_installed`, `phase_state_exists`, `hints`

The answer comes from the same function the PreToolUse edit-scope guard runs, so
the tool and the hook agree on an absolute path in a managed project whose root
is the one holding `.rsct.json`. (Without a usable `.rsct.json` the hook lets
every scope through — it still refuses a Claude Code settings write that
switches hooks off, changes or removes an RSCT hook entry or sets `env.NODE_OPTIONS` /
`env.PATH`, and still exits 2 on a fault of its own; the tool still answers
from the recorded list. For a
relative path, or a root that is a subfolder, the tool walks up to the
`.rsct.json` while the hook takes the root it is given.) In order:
`stale_context` while the re-bootstrap flag
is set, whatever the path; `unknown` when `.rsct/phase-state.json` is missing or
empty or no phase declared `scope_globs`; `out_of_scope` for a path carrying a
line terminator, and on Windows for a network-style path (`\\server\share\…`)
on a different host than the project, which cannot be told apart from one
pointing back into it; `unknown` for any other path outside the project root
(a different share of the same host included) — the scope
governs the project tree only; `in_scope` with `matched_glob: null` for a
plan-tracking file at the project root (`plan_*.md`, `progress_*.md`,
`spec_*.md`); then the declared globs.

Both the project root and the file are resolved first (`..`, links, letter
case on a case-insensitive disk), so `src/../README.md` is judged as
`README.md` and a project opened through a link matches its own list. On
Windows a Git-Bash drive path (`/c/Users/…`) is read as `C:\Users\…`. A path
that still reads as outside is checked once more by file identity: if one of
its parent folders IS the project root under another spelling, it is judged as
inside; anything not shown to be inside is outside. The globs are matched
against the path below the project root and nothing else — the folders above
the project never count, and an entry written as an absolute path does not
match. The comparison is case-sensitive and uses the resolved spelling (the
on-disk one on Windows and macOS; the typed one inside WSL on `/mnt/c`, where
`realpath` does not fold case) — `src/**` does not cover a folder stored as
`Src`; when the answer is `out_of_scope` because the list did not match, a
second hint names the path that was judged. A relative
`file_path` is taken from the project root (the hook takes it from the
directory the client reports).

Glob support v1: `*`, `**`, `?` plus
regex metachar escape; `{a,b}` and `[abc]` are deferred to v2. A leading
`**/` spans whole directories, so a scope of `**/build/**` covers `build/`
and `a/b/build/`, never `webbuild/` (2.11.2 — a scope that relied on the
old wide match now answers `out_of_scope`).

### §C-gated mutating ops

There are **four** §C-gated mutating ops: `rsct_request_commit`,
`rsct_request_push`, `rsct_request_merge` and `rsct_request_rebase`. All four pop
an OS dialog for explicit dev confirmation (INV-2.1 out-of-band channel), and since
2.17.0 the dialog is FORCED on all four (ADR-030): `trust_allowed_for[]` does not
apply to them, and where no dialog channel exists they are refused
(`force_dialog_no_channel`; a dialog that ends without a Yes or No is
`dialog_failed`) — the developer commits, pushes, merges or rebases by hand. The one exception is a commit under a batch token the developer approved
(`rsct_plan_authorize`, below). Fabrication signals (INV-2.2) force the dialog as
before.

**Three of them require a `dev_approval` payload on every call** (INV-2
anti-reuse): push, merge and rebase. `rsct_request_commit` is the exception — its
authorization is EITHER a per-action `dev_approval` OR a plan-scoped batch token,
as described under its own heading below.

**Pre-integration hygiene pre-gate (PH-5):** `rsct_request_merge` (always),
`rsct_request_rebase` (always — a rebase/squash rewrites history, which is an
integration event) and `rsct_request_push` (only when the target branch is
protected) additionally require a `pre_merge_ack` hygiene checklist. It is checked
**before** the OS dialog — a missing/incomplete ack rejects **in chat with no
dialog**, so a rejected ack never spends an approval.

The four items — `plan_complete` / `adr_confirmed` / `issues_resolved` /
`hygiene_swept`, plus a `note` whenever ADRs, issues or the sweep are attested —
are honest **self-attestations**, not machine-verified. Two mechanical teeth back
them: you cannot integrate without assembling the checklist, and a declared
`false` is honored as a stop.

A fifth field, **`files_swept[]`**, is evidence rather than an attestation. RSCT
reads the paths the integration actually carries out of git (never a
caller-supplied value) and rejects when one of them is absent from your list —
**regardless of the four booleans**. Obtain it with `git diff --name-only
<base>...<head>`. Be precise about what this buys: it verifies **coverage**, that
the carried paths were *claimed* as swept. It does not verify that a sweep
happened, nor that one found anything.

The `dev_approval` shape (validated by `lib/dev-approval.ts`):

```ts
{
  timestamp: string         // ISO-8601, must be within `approval_modes.timestamp_skew_seconds` (default 180s — raised from 60s after the M2 gate run revealed AI-roundtrip latency)
  action_scope: string      // e.g., "commit:feat/foo:abc123"
  reason: string            // ≥10 chars to avoid 'reason_too_short' fabrication signal
  override_protected_branch?: { reason: string }  // INV-9 override path, audit-logged
  override_secrets_check?:     { reason: string }
}
```

#### `rsct_request_commit`

Commits if authorization is valid + no INV-5 (protected branch) violation +
no INV-6 (secrets) hits in the staged diff. **Authorization is EITHER** a
per-action `dev_approval` **OR** — when `dev_approval` is omitted — an active
**plan-scoped batch token** (see `rsct_plan_authorize`). The token path carries
no overrides, so a protected branch or a secret finding still rejects.

- Input: `project_root?`, `message`, `dev_approval?` (OPTIONAL — omit to use a plan token). The MCP surface has NO diff override — the secrets scan ALWAYS reads the real `git diff --cached` (the test-only diff seam is a function arg, not an MCP input).
- Output: `status: 'committed' | 'committed_with_drift' | 'rejected' | 'mutation_failed'`, `authorized_via: 'dev_approval' | 'plan_token' | null`, `channel` (gate channel or `'plan_token'`), `sha_before`, `sha_after?`, `reject_kind?` (incl. `'plan_token_invalid'`, `'contract_surface'`, `'message_too_long'`, `'review_missing'`, `'comments_present'`, `'migration_reverted'`, `'review_drift'`, `'review_unreadable'`, `'dead_code_staged'`), `branch_check`, `secrets_check`, `contract_check`, `bootstrap_marker`, `plan_token?` (budget summary on token commits), `audit_path: string | null`, `audit_error: string | null`, `anti_replay_persisted: boolean | null`, `anti_replay_error: string | null`, `hints: string[]`
- `hints[]` also carries **advisories** — reports that never gate, prepended ahead of the routine tail and present on rejected returns too. Two of them today:
  1. **Security-tier install drift** — an enforcement script under `.rsct/scripts/` is absent, is present with no hook entry pointing at it or with a guard entry in another form than `/rsct-setup` writes, or is an edit guard from a build that cannot block (2.2.0 to 2.12.3); or `"disableAllHooks": true` in the local, project or user settings switches every hook off. In each case what it enforces is not running. A script that merely *differs* from the shipped copy stays at the normal tier and is NOT an advisory. Carried by `rsct_request_commit`, `rsct_request_push`, `rsct_request_merge`, `rsct_request_rebase` and `rsct_plan_authorize`, and each of them also adds one line to its OS dialog — the one channel the agent cannot summarize away. A commit authorized by an active batch token lands with no dialog; the line was in the dialog that minted the token.
  2. **`.claude/settings.json` drift** (`rsct_request_commit` only) — the versioned settings file diverged from the baseline the SessionStart hook recorded and is not staged. Lists the new `permissions.allow[]` entries verbatim and offers three resolutions (stage / relocate to `settings.local.json` / discard). Report-only: it never stages, edits or discards, and it says nothing about a file you already staged.

Approval consumption rule: never burn the approval on pre-mutation
rejects. Only `recordConsumedApproval` AFTER a successful commit.

**Post-mutation write failure surface** (closes M2-gate HIGH-2 / HIGH-3):
on a successful commit, if `.rsct/audit.log` can't be appended OR
`.rsct/approvals-seen.json` can't be persisted, the mutation still
landed but the corresponding `_error` field is set to the underlying
reason and a `⚠` warning is appended to `hints`. The caller MUST
react: missing audit means forensic trail is incomplete; missing
anti-replay persistence means the same dev_approval is replayable
within the skew window. On rejected / mutation_failed outcomes,
`anti_replay_persisted` is `null` (never attempted — approval not
consumed by design).

#### `rsct_request_push`

Pushes the current branch if `dev_approval` is valid + branch is not
protected (or `override_protected_branch` is set with reason).

- Input: `project_root?`, `remote?` (default `origin` — must be a **configured remote name**; see below), `branch?` (default HEAD), `dev_approval`, `pre_merge_ack?` (PH-5 — required only when the target branch is protected; rejects in chat if absent/incomplete, no OS dialog)
- Output: `status: 'pushed' | 'rejected' | 'mutation_failed'`, `branch`, `remote`, `reject_kind?` (incl. `'pre_merge_ack_missing' | 'pre_merge_ack_incomplete' | 'unsafe_push_target' | 'unknown_remote'`), `audit_path`, `audit_error`, `anti_replay_persisted`, `anti_replay_error`, `hints` — same post-mutation failure surface as `rsct_request_commit`.

**Branch protection compares the push DESTINATION, not the string you passed.**
`branch` accepts a refspec, and several forms write to a protected branch while
comparing unequal to its name: `+main` (the force marker), `HEAD:main` and
`feat/x:main` (the destination is after the colon — git splits on the LAST one),
`refs/heads/main` and `heads/main` (qualified forms). RSCT resolves the
destination first and compares that. Refused outright, before git runs:
a value starting with `-` (git would read it as an option), a `*` glob refspec
(it can rewrite branches the protection check never sees), and an empty
destination (a bare `:` is git's "matching" refspec and pushes everything).

**`remote` must be a configured remote name — pushing straight to a URL or a
filesystem path is refused.** That capability sends the repository somewhere
branch protection cannot see, so it is not available through this tool. Add the
destination with `git remote add` first. Only an *unreadable* remote list (e.g.
outside a git repo) skips the check; an *empty* one rejects.

**The push sends an explicit refspec.** Since 2.22.0 git is called with
`[+]<sha>:refs/heads/<destination>` (or `:<ref>` for a delete), built from the
push the dialog shows, so a `remote.<name>.push` mapping cannot send it somewhere
else; a bare source prefers the branch over a tag of the same name. For a
protected destination with no `refs/remotes/<remote>/<destination>` (a first push,
or one never fetched), the tool first runs `git push --dry-run --porcelain` with
prompts and credential helpers off (20 s), reads what the push would carry — the
whole tree for a new branch — and checks it against `files_swept` before the
dialog; over 2000 files the push is refused and you push by hand. When that dry
run cannot answer, the push proceeds as before and the dialog says the carried
files were not checked; when it answered but the files cannot be read, the push
is refused (`hygiene_range_unreadable`), as merge and rebase are (ADR-036).

#### `rsct_request_merge`

Merges `source_branch` into `target_branch` (extra-strict — refuses
force-pushy patterns by default).

- Input: `project_root?`, `source_branch`, `target_branch?` (default current HEAD), `dev_approval`, `pre_merge_ack` (PH-5 — REQUIRED; the pre-integration hygiene checklist; rejects in chat if absent/incomplete, no OS dialog), `allow_unrelated_histories?` (default false)
- Output: `status: 'merged' | 'rejected' | 'mutation_failed'`, `sha_before`, `sha_after?`, `reject_kind?` (incl. `'pre_merge_ack_missing' | 'pre_merge_ack_incomplete'`), `audit_path`, `audit_error`, `anti_replay_persisted`, `anti_replay_error`, `hints` — same post-mutation failure surface as `rsct_request_commit`.

`override_protected_branch` is dual-purpose here: it ALSO acks the
force-like risk of `allow_unrelated_histories=true`. Documented so devs
don't accidentally pass the flag without the override.

#### `rsct_request_rebase`

The history-rewriting integration paths. `mode:'rebase'` runs `git rebase <ref>`;
`mode:'squash'` runs `git merge --squash <ref>`, which STAGES the combined change
without committing it — commit it afterwards through `rsct_request_commit`.

**Always per-action**: never covered by a plan token, and
it always requires a `pre_merge_ack`. Runs INV-5 on the CURRENT branch, since
rewriting a protected branch's history needs `override_protected_branch`.

- Input: `project_root?`, `mode?` (`'rebase' | 'squash'`, default `'rebase'`), `ref`, `dev_approval`, `pre_merge_ack` (REQUIRED)
- Output: `status: 'rebased' | 'squashed' | 'rejected' | 'mutation_failed'`, `mode`, `ref`, `current_branch`, `sha_before`, `sha_after`, `reject_kind?` (incl. `'detached_head' | 'same_ref' | 'pre_merge_ack_missing' | 'pre_merge_ack_incomplete'`), `audit_path`, `audit_error`, `anti_replay_persisted`, `anti_replay_error`, `hints`

Conflicts surface as `mutation_failed` carrying git's stderr; the working tree is
left as git leaves it and nothing is force-pushed. `ref` is refused before git
runs if it would be read as an option rather than a name.

#### `rsct_plan_authorize` (T3 — plan execution mode: batch)

Mints a **plan-scoped batch token**: one strong `dev_approval` (full §C gate +
forced OS dialog) authorizes up to `max_actions` **commits** of one multi-phase
plan, on the current branch, for at most 8 hours, so `rsct_request_commit` no
longer needs a fresh approval per commit. **Commit only** — push, merge and rebase
keep their own dialog. Requires a `plan_<slug>.md` with two or more phases at the
project root and a **non-protected** branch. The
token never bypasses INV-5/INV-6 (no overrides on the token path). The emitting
approval is consumed (cannot re-mint). Auto-revokes on branch switch, plan
completion/deletion, expiry, or exhaustion. An unreadable `phase-state.json`, or an
audit log that cannot record the mint, is refused (`status: 'state_write_failed'`): no token is minted, the approval is
not consumed and the file is left untouched.

Since 2.17.0 (ADR-030): the dialog is FORCED (`trust_allowed_for` ignored, no
channel = refused); the token is for a MULTI-PHASE plan only — a `plan_<slug>.md`
whose `## Phases` table lists at least two filled phases (a `spec_` file is never
taken as the plan); its lifetime is fixed from the approval, 8 hours at most, and a
commit never extends it. Before the dialog the tool checks the branch, the plan and
its phases; the dialog then names the number of commits, the expiry, the branch,
the plan and its phases (framework text first, plan and phases last, one line
each). The mint writes its `plan_authorize.authorized` audit line before the token,
and `rsct_request_commit` honours a token only while that line exists with the same
plan, branch, time, approval, expiry and number of commits, and no
`plan_revoke.revoked` line names it (the revoke writes that line before it clears
the token).

- Input: `project_root?`, `dev_approval`, `plan_slug?` (the `<slug>` of `plan_<slug>.md`; letters, digits, `.`, `_`, `-`; default the newest `plan_*.md`), `ttl_minutes?` (5–480, default 480), `max_actions?` (1–100, default 20). Defaults also configurable via `.rsct.json` `approval_modes.plan_token_ttl_minutes` / `plan_token_max_actions`.
- Output: `status: 'authorized' | 'rejected' | 'state_write_failed'`, `plan_slug`, `branch`, `expires_at`, `max_actions`, `covers`, `reject_kind?` (incl. `no_active_plan` / `not_multi_phase` / `invalid_plan_slug` / `protected_branch` / `no_branch` / `force_dialog_no_channel` / `dialog_failed`), `audit_path`, `audit_error`, `anti_replay_persisted`, `anti_replay_error`, `hints`.

#### `rsct_plan_revoke` (T3)

Revokes the active plan token. **NOT §C-gated** — revoking only tightens
security. After revoke, `rsct_request_commit` again requires a per-action
`dev_approval`. No-op (`status: 'no_token'`) when none is active. An unreadable
`phase-state.json` is refused (`status: 'state_write_failed'`, audited): nothing
is revoked and the file is left untouched.

- Input: `project_root?`, `reason?`
- Output: `status: 'revoked' | 'no_token' | 'state_write_failed'`, `revoked_plan_slug`, `audit_path`, `audit_error`, `hints`.

The active token + git-worktree context are also surfaced by `rsct_phase_status`
(`plan_authorization`, `worktree`) and `rsct_status` (`worktree`). The phase state
lives in each working tree, so each `git worktree` gets its own token; the audit
log and the anti-reuse store resolve at the repository (the main worktree), so
an approval spent in one worktree is spent in all of them.

### SessionStart sanitizer hook (INV-2.3 closer)

A standalone Node CLI bundled at `dist/scripts/sanitize-permissions.js`.
Installed by `/rsct-setup` Phase 4.V to the consuming project's
`.rsct/scripts/` and registered as a `hooks.SessionStart[]` entry in
`.claude/settings.json`. On every session boot it strips poison-pill
entries from `permissions.allow[]` in both `.claude/settings.json` and
`.claude/settings.local.json`.

**Patterns stripped:**
- `Bash(git commit*)` / `Bash(git commit:*)` / `Bash(git commit -m "x")`
- `Bash(git push*)` / `Bash(git push:*)`
- `Bash(git merge*)` / `Bash(git merge:*)`
- **Verbs that bypass a §C-gated outcome beyond commit/push/merge (#91):** `git rebase`
  (`rsct_request_rebase` is gated), `git cherry-pick` and `git revert` (they create commits that
  skip the commit gate) in every shape above, and `gh pr merge` (direct or path-prefixed — it
  merges the PR). Recovery forms (`git rebase --abort`) are stripped too, as `git merge --abort`
  already was. NOT stripped: a broad `Bash(gh pr:*)` / `Bash(gh:*)` grant (it also authorises
  read-only `gh pr view` / `gh issue` / `gh api`) — the PreToolUse terminal guard below refuses the
  merge itself whatever the grant says; and read-only `gh pr view` / `gh pr list`.
- `Bash(git*)` / `Bash(git:*)`
- Path-prefixed forms (MED-12): `Bash(/usr/bin/git commit)`, `Bash(./bin/git push)`, `Bash(C:/Program Files/Git/bin/git merge)`. Allows spaces in the path; pins basename to `git` so a different binary like `Bash(/usr/bin/git-credential-store)` is NOT stripped.
- Shell-wrapped forms (MED-12): `Bash(sh -c "git commit ...")`, `Bash(bash -c 'git push origin')` and the other POSIX shell variants (`zsh`, `dash`, `fish`, `ksh`, `csh`).
- Wildcard-around-git (MED-12): `Bash(*git*)` and similar — the bash matcher would catch commit/push/merge inside any wildcard envelope.
- `Bash(*)` / `Bash(:*)`
- **Global options before the subcommand (#32):** `Bash(git -C /repo commit)`, `Bash(git -c user.name=x commit)`, `Bash(git --git-dir=/r/.git push)`, `Bash(git --work-tree=/w merge x)` and quoted variants like `Bash(git -C "C:/Program Files/repo" commit)`. `git -C <path> commit` is the sharpest of these — it commits in ANOTHER repository, escaping both §C and the project-scoped reasoning everything else relies on.
- **A wildcard standing where the SUBCOMMAND belongs (#32):** `Bash(git -C:*)` authorises every subcommand, commit included. A wildcard in a pathspec (`Bash(git log -- src/*.ts)`) is NOT stripped — it authorises nothing extra.

Read-only subcommands that merely START with a mutating verb are preserved:
`Bash(git commit-graph write)`, `Bash(git merge-base a b)`, `Bash(git merge-tree a b)`. A hyphen is not a word character, so before #32 these matched `commit` and were being stripped.

Benign entries (`Bash(npm test)`, `Edit`, `Read`, `WebFetch(domain:*)`,
`mcp__rsct__*`, read-only git like `Bash(git status)`) are preserved.
Zero external deps; the script can be invoked directly via
`node dist/scripts/sanitize-permissions.js --project-root <path>`.

It also relocates entries carrying a machine home path (`C:\Users\`, `/home/`,
`/Users/`, `/mnt/<d>/Users/`, `//wsl.localhost/`) out of the VERSIONED
`settings.json` into the gitignored `settings.local.json`, verbatim — both from
`permissions.additionalDirectories[]` and from `permissions.allow[]`, where the
path is embedded inside a command string.

Audit events: appends `sanitize.stripped` / `sanitize.malformed` /
`sanitize.migrated` / `sanitize.migration_skipped` JSONL lines to the audit log
when something changes, plus a `settings.baseline` hash of `settings.json` on
every run — that baseline is what `rsct_request_commit` reads back to detect
unowned drift. Honours `audit.path` from `.rsct.json`. Never blocks session
start — malformed JSON logs to stderr and exits 0.

It runs at session start only. A grant or a machine path added to
`settings.json` in the middle of a session is handled at the next session start.

### PreToolUse edit-scope guard

A second standalone Node CLI, bundled at `dist/scripts/edit-scope-guard.js`,
installed by the same `/rsct-setup` phase and registered as a
`hooks.PreToolUse[]` entry with the matcher
`^(Edit|Write|MultiEdit|NotebookEdit)$`. It reads the hook payload on stdin and
exits 2 — the exit code the client treats as a refusal; 1 is not — when the
judgement above is `out_of_scope` or `stale_context` for a path the payload
carries (`file_path` and `notebook_path` are both judged when both are there).
An unmanaged project, an unreadable phase-state and a payload with no path exit
0. A fault inside the guard exits 2 with "STOP and tell the developer" (2.15.0;
it exited 0 before). It does not watch the terminal: a shell command that writes
a file is not seen.

In any project, managed or not, it also refuses (`claude_settings`) an `Edit`,
`Write` or `MultiEdit` of a Claude Code settings file — `settings.json` or
`settings.local.json` in a folder named `.claude` (the project's or `~/.claude`) — whose
resulting text would set `"disableAllHooks": true`, change or remove an entry for
one of the three RSCT hooks (its event, matcher or any field of the hook), leave a
settings file that holds RSCT hooks unparseable, or set or change
an env key that changes how a hook shell or node starts (`NODE_OPTIONS`, `PATH`,
`BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `CLAUDE_PROJECT_DIR`, every `LD_*` and
`DYLD_*` loader key, `BASH_FUNC_*`),
or add one of those keys to a result that does not parse. Any other edit of those
files passes.

It needs no server, which cuts both ways: it enforces in a session where
`rsct-mcp` is not connected, and there it cannot be told the context was
reloaded — see `docs/troubleshooting.md` for a project left in that state.

### PreToolUse terminal guard (#91)

A third standalone Node CLI, `dist/scripts/terminal-guard.js`, installed by
`/rsct-setup` (Phase 4.V.e) and registered with the matcher
`^(Bash|PowerShell|Monitor)$` — the three tools that run commands. It refuses
(exit 2) a `git commit`, `push`, `merge`, `rebase`, `cherry-pick`, `revert` or
`am`, naming the RSCT tool to call, and a `gh pr merge`, which it leaves to the
developer on GitHub. It reads the
command text the way a shell would: any word whose program name is `git`
(`env git`, `git.exe`, a full path, `git -C dir`, `git -c k=v`, letter case
ignored), commands joined with `;`, `&&`, `|` or a newline, `$(…)`, backticks
and `<(…)`, a heredoc fed to a shell that reads commands from it (not to one that names a script file other than `/dev/stdin`), and the text handed to `sh|bash|zsh -c`,
`eval`, `env -S`, `su -c`, `script -c`, `cmd /c`, `powershell|pwsh -Command`
(and `-EncodedCommand`, and Windows PowerShell's bare argument),
`Invoke-Expression`, `wsl`, a WSL distro launcher's `run`, `ssh host …`,
`git submodule foreach` and `git bisect run`, with their own options in
between (`bash -o pipefail -c`, `su -lc`). A verb that is not
one of git's own commands is looked up as an alias (`-c alias.x=…` first, then
`git config --get alias.x` in the folder the command runs in, 3 s budget); an
alias it cannot resolve is refused. Code passed to `node -e`, `tsx -e`, `python -c`,
`perl -e`, `ruby -e`, `php -r`, `deno eval` or `bun -e`, or fed to an
interpreter as a heredoc when it names no script or a stdin name (`-`,
`/dev/stdin`, `/dev/fd/0`) — flags in clusters such as `perl -lne`, or glued to
the flag as in `python3 -c"…"` and `node --eval=…`; every code flag on the line
is read, so a script's own `-c`/`-e` argument that calls git is refused — is
searched for a git call or `gh pr merge`, as text or as an argument list.
Refused as well: a word that is a whole variable or substitution, followed —
past git's global options — by a blocked verb (`"$G" commit`); in bash, a
command run from an unquoted variable or substitution (`$C`, `sudo -E $C`,
`do $C`), which the shell splits into a whole command line; a git or gh
subcommand that is a variable or holds one (`git $V`, `git "$@"`, `git co$X`);
a brace pattern or a glob read like a variable since 2.17.0 — as a git or gh
subcommand (`git {commit,}`, `git [c]ommit`), as the command when it is a brace
pattern, and as the command before a blocked verb when it is a glob; `Invoke-Expression`
or `pwsh -c` of a variable; interpreter code that is a whole variable in a code
flag before the script (a script's own `-p "$PORT"` passes); a `gh
alias set` whose definition runs `pr merge` or a refused git verb; git's own
`git-<verb>` binaries; and any command text that mentions `disableAllHooks`. A subcommand
passed together with its arguments in one string (`Start-Process git
-ArgumentList 'commit -m x'`) is split and judged, and `Start-Process` is read
as the command line it starts, whatever the order of its parameters. Array
assignments, arithmetic and `find -exec … {}` are not mistaken for commands.
Recovery forms pass when nothing else follows
the verb: `--abort`, `--quit`, `--continue` and `--skip` of merge, rebase,
cherry-pick, revert and am. Text a program only prints or searches
(`echo "git push"`, `grep "git commit"`) passes.

Since 2.22.0 (ADR-036) it also reads: code piped into a program that runs what
it reads — a shell, an interpreter with no script, `iex`, `cmd` without `/c`,
`xargs` into a shell or git, `curl … | sh` — which is refused and named; a git
call written inside another program's argument text (a database client's shell
escape, `awk 'BEGIN{system("git …")}'`, `vim -c`, a `git -c` value that stores a
program), while text a program only prints or searches still passes; and the
package scripts a manager runs (`npm|pnpm|yarn|bun run <x>`, the bare forms,
`composer <x>`, the lifecycle hooks of install, test, start, publish, pack and
version, composer's install events, `npx`, `pnpm|yarn exec|dlx`, `bunx`), read
from the `package.json`/`composer.json` the call would use — walking up from the
folder the command is in after any `cd`/`pushd` — and judged like typed commands;
a workspace-wide run reads that script in every package under the repository.
`--ignore-scripts`/`--no-scripts` skip the hooks but not the named script.
`npm|pnpm|yarn version <new>` is refused unless `--no-git-tag-version` is given.
A command that changes a package file and runs scripts in one go is refused. A
command over 64 KiB, or one command over 2048 words, is refused with a pointer to
the Write tool, and judging stops at 5 s with a refusal.

It fails **closed**: a payload it cannot read, a terminal call with no command
text and a fault inside it exit 2. A `Monitor` call that watches a WebSocket
(`ws`) runs no command and passes. It enforces whenever its hook runs, whether
or not `.rsct.json` is present or valid. It writes nothing.

**Database rules (#84, ADR-038).** The same guard refuses commands that change
a database; there is no RSCT tool for them, the developer runs them in their own
terminal:

- a database client (`psql`, `mysql`, `mariadb`, `mysqlsh`, `sqlite3`, `mongosh`,
  `redis-cli`, `cqlsh`, `clickhouse-client`, `sqlcmd`, `usql`, …) whose statement
  writes data or schema, or cannot be read — from `-f`, `<`, a pipe or a variable.
  A SQL statement passes only when it starts with a read keyword and carries no
  changing one; it is read under several dialect readings (comments, quotes,
  `/*! */`), psql meta-commands and sqlite dot-commands by closed read lists. A
  heredoc's statements are read; a bare client (an interactive session) passes;
- a migration, seed, reset, wipe or restore of the common tools (Prisma,
  Sequelize, Knex, TypeORM, Drizzle, Alembic, Flyway, dbmate, goose, Atlas, sqlx,
  Diesel, Phinx, Supabase, Wrangler D1, Turso, PlanetScale, MikroORM, Laravel
  `artisan`, Django, Rails/rake, Flask), while status, list, diff and
  print-only forms pass (`migrate:status`, `sqlmigrate`, `migrate --plan`,
  `--sql`, `pg_restore` without `-d`);
- a console fed code from a pipe or a file (`artisan tinker`, `rails console`,
  `manage.py shell|dbshell`, `flask shell`);
- `docker compose down -v` and other volume removals.

It reads these through `docker|podman exec|run`, compose `exec|run`, `kubectl
exec --`, Sail, `herd`, `winpty`, `cross-env`, `dotenv`, `bundle exec`, versioned
`php`/`python` and package scripts. In a Laravel project (`laravel/framework` and
an `artisan` file), `php artisan test`, `phpunit`, `pest` and `paratest` are
refused unless the phpunit configuration PHPUnit loads — the one named by
`-c`/`--configuration`, else the first of `phpunit.xml`, `phpunit.xml.dist`,
`phpunit.dist.xml` — forces (`force="true"`) `DB_DATABASE=:memory:` with
`DB_CONNECTION=sqlite`, or a `DB_DATABASE` named as a test database; a `DB_URL`
or `DATABASE_URL` set in `.env` and not forced, `--no-configuration` and `php
artisan dusk` are refused. `.rsct.json` `database_guard: false` turns the
database rules off and `database_test_guard: false` only the Laravel check; the
switches are read from the nearest `.rsct.json` above `CLAUDE_PROJECT_DIR` (or
the reported call folder when the host does not set it), an unreadable file counts
as on, the agent cannot set them (the edit guard and this guard refuse it), and
`rsct_status` says when one is off. What these rules do not see is listed in
ADR-038: a statement inside application code or a script file, a database MCP
server's tools, startup files such as `~/.psqlrc`, a function called inside a
`SELECT` that writes.

What it does not see: a script file the agent writes or downloads and then runs
(`./x.sh`, `make`), git called from a program it does not read,
git's plumbing commands other than `git commit-tree` (refused since 2.17.0, as are
`filter-branch`, `fast-import`, `quiltimport`, `replay`, and every `git pull` but a
`--ff-only` one with plain options, every word written out, from a repository not
spelled as a path — ADR-030), commands that move refs without creating a commit
(`git reset --hard`, `git branch -f`, `git update-ref`, `git fetch . a:b`, a
fast-forward pull from a URL or a local repository written as a name), hooks the
agent writes, `gh api`, aliases set through
`GIT_CONFIG_*` variables, gh aliases apart from a `gh alias set` in the command itself,
external `git-<name>` commands such as `git flow`,
command text assembled at run time from data it reads as text, a Claude Code
settings change made other than through the editor tools (a terminal command
that mentions `disableAllHooks` is refused), a command line carried in a
variable through a program it does not read or past a wrapper's option value, a program or subcommand name
assembled from parts of variables, and other MCP
servers' tools. The OS dialog of the RSCT tools remains the guarantee; the guard
closes the front door. The developer runs any of these commands in their own
terminal — the guard sees only the agent's tools. Subagent tool calls and the developer's own `!` commands were not measured.

The two PreToolUse guards are registered as
`NODE_OPTIONS= node "${CLAUDE_PROJECT_DIR}/.rsct/scripts/<name>.js" || exit 2`,
the SessionStart sanitizer as `node "${CLAUDE_PROJECT_DIR}/.rsct/scripts/sanitize-permissions.js"`.
The quotes are load-bearing: without them a project path containing a space is
split by the shell: the sanitizer then exits 1 without running, and a guard
entry would refuse every call. The guard starts with `NODE_OPTIONS` cleared, and `|| exit 2` turns a guard that cannot
start into a refusal — Claude Code lets the call through on any exit other than
2 (MEASURED on 2.1.173; its `onFailure` setting had no effect there). `/rsct-setup`
replaces any other form of a guard entry; `rsct_status` reports a guard entry in
any other form, and `"disableAllHooks": true` in the local, project or user
settings, as enforcement not running.

**Releases 2.2.0 to 2.12.3 shipped a guard that never refused an edit** (#114):
the bundle carried the sanitizer's entry block ahead of the guard's own code,
so the installed file ran the sanitizer and exited 0. A project still holding
such a copy gets the security-tier install notice until `/rsct-setup` runs again.

### Audit log

All §C-gated tools and the SessionStart hook write structured JSONL
entries to `.rsct/audit.log` (configurable via `.rsct.json` `audit.path`).
It cannot be switched off: `audit.enabled: false` gets the whole config
rejected (see the bounds table below).

**Where that resolves (#92).** The log — and the §C anti-reuse store — live at the
**git repository the action lands in**, not at the `project_root` a caller passed.
The two only differ in three shapes, and in all of them the repository is where the
commits actually go:

| setup | `.rsct/` resolves at |
|---|---|
| repository whose root carries `.rsct.json` (the common case) | unchanged |
| submodule | its own working root |
| **linked worktree** | the **main** worktree — so what the gates read from the audit log (classification evidence, review decisions) survives `git worktree add`; the downgrade record lives in `.rsct/phase-state.json`, one per checkout |
| **monorepo package with its own `.rsct.json`** | the repository root |
| **project nested inside an unrelated repository** | that repository's root |
| not a git repository | unchanged; the binding reports `not-applicable` |

When it relocates, every §C dialog and the tool's `hints[]` say so — a relocation is
never silent, and it is never a rejection. A configured `audit.path` that resolves
**outside** that base is refused (the log falls back to the default) and reported,
because a log outside the repository can be swapped for a blank one without touching
the project. Since 2.18.0 the same happens to a path no file can sit at — a control
character, a folder or a path through a file, and on Windows a stream (`:`), `< > " | ? *`,
a reserved device name or a trailing dot or space (ADR-031).

In the three relocating shapes the project's `.gitignore` block does not reach the
repository's `.rsct/`, so since 2.20.0 the server writes a `.rsct/.gitignore` there the
first time it writes the log, the approval store or an audit-prune file. It lists
exactly those files and itself, never `*`; an existing one is never replaced, and a
failure to write it never changes the result of the write it follows. It is written
only when the folder is relocated, and a read writes it only together with the
one-time copy of an old project log. `/rsct-uninstall` names that folder in its report
and never removes it: it is shared by every RSCT project of the repository (#82).
Files that versions 2.9.0–2.19.x committed there stay tracked until `git rm --cached`
(see `docs/troubleshooting.md`). Not covered: any configured `audit.path` other than
the default `.rsct/audit.log`.

Event naming convention: `<tool>.<outcome>` where outcome ∈
{`rejected`, `override_invoked`, `committed`, `pushed`, `merged`,
`mutation_failed`, `stripped`, `malformed`}.

The writer in `mcp-server/src/lib/audit-log.ts` only appends and never throws —
failures surface via `{ ok: false, reason }` so the caller can report I/O issues
without aborting tool execution. Three other places append directly (the consumed
approval record, the sanitizer hook, the one-off migration line), and the retention
cut below is the only thing that rewrites the file.

**Retention (#93, ADR-025).** The log is the only copy of what it holds — it is
gitignored on purpose — and it is not kept forever. About once a day, a commit that
**landed** through `rsct_request_commit` removes the entries older than **10 days**,
from the top of the file down, and stops at the first entry younger than that. A
refused, declined or unapproved call removes nothing. Three kinds of entry survive
whatever their age:

| kept | which entries |
|---|---|
| every entry a gate or a reader can still use | `classify.verdict`, `review.unverified_decision`, `review.dead_code_kept`, `review.public_api_approved`, `review.commit_drift`, `approval.consumed`, `plan_authorize.authorized` and `plan_revoke.revoked` (since 2.17.0: a batch token counts only while its mint line exists and no revoke line names it), `tutor.step`, and the `free_commit.*` entries older servers still read |
| every entry named as an override, a skip, a degraded check or a bypass | any event whose name contains `override`, `skip`, `degraded` or `bypass`; also `sanitize.stripped` and `audit_log.migrated` |
| only the **newest** of each repeating state record | `settings.baseline`, `rsct_json.malformed`, `rsct_json.bounds_violation`, `install.drift_detected`, `sanitize.malformed`, `sanitize.migration_skipped`, `settings.drift_detected`, `audit.pruned` |

The third row wins over the second: `sanitize.migration_skipped` is a state record.
So after ten days the log still shows THAT a config was rejected, or that enforcement
was not running, and when it last was — not for how long.

Everything else — phase starts and completions, findings, commits, pushes, merges,
refused or failed plan authorizations, bootstrap warnings and **refusals** — goes after 10 days. An
entry that cannot be parsed or carries no ISO timestamp is never removed. Kept
entries are never rewritten: the file is handled as bytes. A kept entry can point at
one that is gone — an `approval.consumed` whose commit entry was dropped.

Who is told, and how:

- **The hints of the call report every cut**, and an `audit.pruned` entry records how
  many lines went, the cutoff and a running total. (A cut interrupted right after the
  swap is reported as not completed; its count is in that entry alone.)
- **The approval dialog forecasts only a cut that reaches back more than 20 days** —
  the first cut after an upgrade, in a log that old; a cut after weeks without a
  commit. The test is the age of the oldest entry to go, not how many go. The daily
  cut is not forecast. The line is a forecast, counted before the commit.
- **No dialog, no forecast**: a commit under a plan token cuts with the hint and the
  entry alone.

There is no setting for it. `audit` is a strict block, so a new key would make every
older server reject the whole config, and `.rsct.json` is a file an agent can edit.

Where it does not run, and whether the hints say so:

| case | hints |
|---|---|
| a volume without hard links (measured: a project reached from Windows through `//wsl.localhost/`), or a 9p share, where replacing a file is not atomic (measured: a Windows disk reached from inside WSL, `/mnt/c`) | once per server process and log |
| a log larger than 512 MB; a log path that is not a regular file; an `audit.path` that names one of the cut's working files, or (on Windows) a stream inside a file — a colon after the drive | every commit |
| a cut that failed (for instance while another program holds the log open on Windows), or one an earlier call left interrupted | every commit, until a later one finishes it |
| git could not report the repository in this session | every commit |
| another cut holds the lock or took it over, or the log would not settle | silent — a later commit cuts |
| the project's `.rsct.json` is rejected, the top entry is stamped in the future, or no commit ever lands through `rsct_request_commit` | silent |

The cut works in `.rsct/reports/` (`audit-prune.lock`, `audit-prune-new.log`,
`audit-prune-old.log`), which the `.gitignore` block covers in projects set up since
2.11 — except where the log is relocated (see the limitation above: the working
files then sit at the repository root). The files exist for the length of one cut.
An interrupted one is finished or undone by a commit that lands once the lock file is
a minute old; that commit does not cut, the one after it does.

### OS dialog (INV-2.1 out-of-band channel)

Cross-platform Yes/No dialog implemented in
`mcp-server/src/lib/os-dialog.ts`. Each dialog program runs by its full
path, and the dialog's title and text reach it as data, never as part
of a script:
- **Windows:** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
  showing `[System.Windows.Forms.MessageBox]`. The title and text travel
  in two environment variables set for that process only.
- **macOS:** `/usr/bin/osascript -l JavaScript` (`displayDialog`), with the
  same two variables.
- **Linux:** `/usr/bin/zenity --question --no-markup` — the text is shown
  as written. A `zenity` installed anywhere else is not used, so the
  dialog is unavailable there.

A NUL character in the text is shown as `␀`. A title and text longer than
32,000 characters together are refused before any dialog, and
`trust_allowed_for[]` does not apply: the request is rejected with
`reject_kind: no_channel` and a reason that gives the length and says to
shorten the text (the REVIEW's unverified-files question treats it as
undecided).

When no dialog can be shown at all, the tool consults
`.rsct.json` `approval_modes.trust_allowed_for[]`: if the invoking
tool's name is on the list, accept silently; otherwise reject. Since 2.20.1
(ADR-034) "no dialog can be shown" means only that the dialog program is not
installed, that the system has no supported dialog program, or, on Windows, that
the session has no desktop. A dialog that
starts and ends without a Yes or No is refused for every tool
(`reject_kind: dialog_failed`), and the list never applies to it:

| Host | Result | `trust_allowed_for` |
|---|---|---|
| Windows with a desktop (GitHub's Windows runners included) | the dialog opens and waits | — |
| Windows with no desktop (a service, a non-interactive session; not measured, ADR-034) | no channel | applies |
| macOS with a desktop (GitHub's macOS runners included) | the dialog opens and waits | — |
| macOS where the dialog program fails (no GUI session, an error; not measured, ADR-034) | `dialog_failed` | never |
| Linux without zenity (GitHub's Ubuntu runners) | no channel | applies |
| Linux with zenity and no display | `dialog_failed` | never |

The list
accepts `rsct_request_commit`, `rsct_request_push`, `rsct_request_merge`,
`rsct_plan_authorize`, `rsct_capture_issue`, `rsct_phase_abandon` and the
six `rsct_phase_*_complete` tools. A call that forces the dialog ignores
the list — and since 2.17.0 commit, push, merge, rebase and
`rsct_plan_authorize` always force it (ADR-030): their four names stay
accepted, so a config that lists them still loads, and have no effect.
The match is by tool name — not by `dev_approval.action_scope` — so an entry
like `["rsct_phase_code_complete"]` trusts every code completion in headless
mode, independent of the specific scope value.

### `.rsct.json` bounds + tamper defense

`.rsct.json` is the source of truth for every enforcement decision in
this server: audit on/off, anti-reuse skew window, trust list,
protected branch set. An attacker that can write to it (a malicious
dependency, a supply-chain hook, or Claude itself with file access)
can silently disable enforcement by setting `audit.enabled: false`,
`approval_modes.timestamp_skew_seconds: 999999`,
`protected_branches: []`, or `trust_allowed_for: [<every tool>]`.

`lib/project-root.ts` validates every load against a strict Zod
schema. Bounds-violating configs are **rejected wholesale** —
`resolveProjectRoot()` returns `rsct_installed: false` (same surface
as a missing `.rsct.json`), every §C-gated tool degrades to safe-no-op,
and a `rsct_json.bounds_violation` (or `rsct_json.malformed`) event is
**force-written** to `.rsct/audit.log` (at the git repository the project
sits in — see "Audit log" above) even if the rejected config tried to
disable audit. A warning also goes to stderr on every load.
The audit entry is written once per hour for the same violation, not on
every load, so a config that stays rejected leaves an hourly trace instead
of a flood (ADR-024 names the exceptions). A project set up before 2.13.5
needs `/rsct-setup` again for its edit-scope guard to do the same: the
guard is a copy inside the project.

Bounds:

| Field | Bound | Why |
|---|---|---|
| `audit.enabled` | must be `true` or absent (literal in schema) | `false` defeats INV-3 forensic trail |
| `approval_modes.timestamp_skew_seconds` | `60 ≤ n ≤ 600` | M2 gate observed 78–155s AI roundtrip; 600s = 4× headroom while still bounding INV-2 replay window |
| `approval_modes.trust_allowed_for[]` | enum of the §C-gated tool names (12 entries — see `RsctApprovalModesSchema`) | unknown entries can't smuggle a wildcard trust |
| `protected_branches[]` | min length 1 if present | empty disables §D wholesale; if you want zero protected branches, uninstall the framework |
| `audit` sub-object | strict (unknown keys rejected) | blocks payloads like `audit: { enabled: true, force_disable: true }` that future versions could misinterpret |
| `approval_modes` sub-object | strip unknown silently (since 2.2.0) | a key from a newer version must not null the whole config on a downgrade; the dangerous fields inside carry their own bounds |
| `commit_message_max_lines` | unbounded in schema; clamped to `1 ≤ n ≤ 500` at use | nulling the entire config over a cosmetic message cap would be wildly disproportionate |
| `sql_dialect` | enum of `postgresql`, `mysql`, `none`; optional | an unknown dialect would make the REVIEW comment sweep read SQL with the wrong comment syntax; rejecting loudly beats sweeping wrongly |
| `public_api` | array of non-empty path globs, relative to the project root (the directory holding `.rsct.json`) or to the repository root; optional; a malformed value is dropped, not fatal | exports reachable through a matching file — a re-export barrel included — are consumed outside the repository and are never reported dead; each exempted export is put to the developer once — the REVIEW dialog is forced until the audit log holds their yes for that declaration and that list (`review.public_api_approved`), so a new export, a changed declaration or a changed list asks again, and `rsct_request_commit` refuses a staged export the exemption covers while that yes is missing — and every export it exempts is written to the report that dialog names, so a broad glob is visible rather than silent |
| `database_guard`, `database_test_guard` | `boolean`, optional; any other value is dropped (reads as on). The terminal guard reads them itself from the nearest `.rsct.json` above the project folder, so they hold even when the rest of the file is rejected | `false` turns the database rules (or only the Laravel test check) off; the edit guard refuses an agent edit that sets either to `false`, the terminal guard refuses a command that names either, and `rsct_status` reports one that is off |
| `conduct_rules_off` | not in the schema, so it is stripped like any unknown top-level key; `/rsct-setup` reads it (Phase 1.10 checks that it is there) and only its switch block (Phase 4.4c, also run from the chat) writes it (ids among `I`–`M`) | the §I–§M conduct rules are text in `CLAUDE.md`; no gate depends on them |
| top-level fields | strip unknown silently | forward-compat: new optional fields don't break older `mcp-server` |

If you legitimately need to operate outside a bound (e.g. very-long-running
automation that wants a wider skew), edit the bound in
`lib/project-root.ts` and rebuild — there is no runtime escape valve
by design.

---

## Resources reference

5 passive endpoints; all return raw markdown with mimeType `text/markdown`.

| URI | Backing file |
|---|---|
| `rsct://decisions` | `documentation/decisions.md` |
| `rsct://architecture` | `documentation/architecture.md` |
| `rsct://plan` | active `plan_<slug>.md` (most-recently-modified at project root) |
| `rsct://progress` | matching `progress_<slug>.md` |
| `rsct://knowledge/{category}` | `documentation/knowledge/<category>.md` (templated) |

The knowledge `{category}` segment is constrained to `[A-Za-z0-9_-]+` —
path traversal attempts return a "Resource not found" error.

---

## Environment variables

| Variable | Effect |
|---|---|
| `RSCT_PROJECT_ROOT` | Override project root resolution; takes precedence over `--project-root` CLI arg and over walking up from cwd. |
| `RSCT_LOG_LEVEL` | pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`). Default `info`. Logs go to stderr only — stdout is reserved for MCP protocol. |
| `CLAUDE_PROJECT_DIR` | Read by `dist/scripts/sanitize-permissions.js` (the SessionStart hook) as a fallback when `--project-root` is not passed. Set by Claude Code itself at hook fire time. |
| `RSCT_UPDATE_CHECK` | Set to `off` (also `0`, `false`, `no`) to disable the session-start GitHub release check entirely — no request is made, nothing is written. **Outranks both** `rsct_status`'s `update_check` parameter and the `consent` field in `~/.rsct/update-check.json`, and it is the only switch that applies before a session exists (CI, headless, a machine that must never emit the request). `tests/setup.ts` sets it for the whole suite. |

---

## Development

```bash
npm run dev         # tsup --watch
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:watch  # vitest watch mode
npm run typecheck   # tsc --noEmit — a SEPARATE gate; vitest does not type-check
npm run build       # one-shot ESM build to dist/
npm run verify:dist # rebuild and fail if the tracked dist/ is out of date
```

Unit tests live in [`tests/unit/`](./tests/unit/), cross-file suites in
[`tests/integration/`](./tests/integration/), and the prompt-block smoke tests in
[`tests/bash/`](./tests/bash/) (run with `RSCT_REQUIRE_BASH=1` so the `bash -n`
gate fails instead of skipping). Fixtures live in
[`tests/fixtures/`](./tests/fixtures/) — `sample-rsct/` is a fully populated rsct
project; `no-rsct/` is the graceful-degradation control.

[`tests/setup.ts`](./tests/setup.ts) is a global vitest setup file wired through
`vitest.config.ts`. It sets `RSCT_UPDATE_CHECK=off` for the whole suite, and it is
the only thing keeping the tests off `api.github.com` and out of your real
`~/.rsct/update-check.json` — `statusHandler` resolves the real `$HOME` and the
real `fetch` whenever nothing is injected, and many call sites inject nothing. A
test that exercises the update check on purpose passes
`update: { home: <tmpdir>, env: {}, fetcher }` through `statusHandler`'s `deps`
seam. Do not remove or bypass it.

### Architecture

```
src/
├── index.ts                 # MCP server entry (stdio); tools + resources wiring
├── resources.ts             # rsct:// URI routing
├── lib/
│   ├── project-root.ts      # locate .rsct.json (Windows-safe) + RsctConfig type
│   ├── version.ts           # RSCT_MCP_VERSION — derived mirror of /VERSION
│   ├── findings.ts          # finding vocabulary + the shared findings gate (#19/#40)
│   ├── update-check.ts      # opt-OUT GitHub release check + per-release declines (#38)
│   ├── version-drift.ts     # install drift: LOCAL compare only, never network
│   ├── git.ts               # minimal git state + GitExecutor + commit/push/merge
│   ├── plan.ts              # find active / list all plan_<slug>.md + progress_<slug>.md
│   ├── decisions.ts         # parse documentation/decisions.md
│   ├── anti-decisions.ts    # parse documentation/knowledge/anti-decisions.md (AD-NNN)
│   ├── knowledge.ts         # detect + read documentation/knowledge/<category>.md
│   ├── env-files.ts         # parse .properties + .env, profile delta computation
│   ├── infrastructure.ts    # parse documentation/infrastructure.md (INFRA-NNN entries)
│   ├── architecture.ts      # read documentation/architecture.md + modules/ + impact/
│   ├── secrets.ts           # INV-6 secret patterns + maskIfSecret + scanDiffForSecrets
│   ├── premise-check.ts     # tokenize + score + recommend (decisions + anti-decisions)
│   ├── markdown.ts          # shared section parser (## / ###)
│   ├── branch-protection.ts # INV-5 protected branch check
│   ├── phase-scope.ts       # INV scope-glob match for .rsct/phase-state.json
│   ├── dev-approval.ts      # zod schema + anti-reuse store + fabrication detection
│   ├── audit-log.ts         # JSONL append writer for .rsct/audit.log (and where it resolves)
│   ├── audit-retention.ts   # the ten-day cut of .rsct/audit.log (#93, ADR-025)
│   ├── os-dialog.ts         # cross-platform Yes/No dialog (Win/Mac/Linux)
│   └── request-gate.ts      # §C orchestrator (validate → dialog → audit)
├── tools/
│   ├── status.ts            # rsct_status
│   ├── load-context.ts      # rsct_load_context
│   ├── get-decisions.ts     # rsct_get_decisions
│   ├── get-knowledge.ts     # rsct_get_knowledge
│   ├── get-environments.ts  # rsct_get_environments
│   ├── get-architecture.ts  # rsct_get_architecture
│   ├── check-premise.ts     # rsct_check_premise (M1; extended in F2.5.7a)
│   ├── check-branch.ts      # rsct_check_branch          (F2.5.1)
│   ├── check-secrets.ts     # rsct_check_secrets         (F2.5.2)
│   ├── check-edit-scope.ts  # rsct_check_edit_scope      (F2.5.3)
│   ├── request-commit.ts    # rsct_request_commit (§C)   (F2.5.5a)
│   ├── request-push.ts      # rsct_request_push (§C)     (F2.5.5b)
│   └── request-merge.ts     # rsct_request_merge (§C)    (F2.5.5c)
└── scripts/
    ├── sanitize-permissions.ts  # launcher: SessionStart hook → lib/sanitize-permissions.ts
    ├── edit-scope-guard.ts      # launcher: PreToolUse hook → lib/edit-scope-hook.ts
    └── terminal-guard.ts        # launcher: PreToolUse hook → lib/terminal-guard-hook.ts
```

The three files under `scripts/` are launchers: they read their input, call one
function from `lib/` and exit with its code. They export nothing and nothing
imports them (`tests/unit/script-entries.test.ts`), so a bundle can never carry
a second program's entry block again.

Each tool: zod schema for input, structured output type, pure handler.
Adding a new tool — create `src/tools/<name>.ts` and register it in
`src/catalog.ts` (`TOOLS` array + `HANDLERS` map). The catalog lives apart from
`src/index.ts` because `index.ts` ends in a module-scope `main()` that connects a
stdio transport, so importing it from a test would boot a server;
`tests/unit/tool-count.test.ts` imports the catalog to cross-check the documented
tool count and the boot-log tool list above against the live one. Update those
docs in the same change — the test will tell you which.

`tsup` builds four ESM entry points:
- `dist/index.js` — the MCP server (registered via `bin: { "rsct-mcp": ... }`).
- `dist/scripts/sanitize-permissions.js` — the SessionStart hook CLI; copied to
  consuming projects' `.rsct/scripts/` by `/rsct-setup` Phase 4.V.
- `dist/scripts/edit-scope-guard.js` — the PreToolUse edit-scope guard CLI, copied
  to the same place by the same phase.
- `dist/scripts/terminal-guard.js` — the PreToolUse terminal guard CLI, copied to
  the same place by Phase 4.V.e.

All four are **tracked** in git (`dist/` ships prebuilt so the install needs no
build toolchain) and are mode `100755` — a new bundle needs
`git update-index --chmod=+x` or `verify:dist` fails on the Linux CI cell.

---

## Known issues / follow-ups

- **YAML profile support (F2.3.1 / F2.5.7b).** `application*.yml` files are
  detected by `rsct_get_environments` but not parsed; output surfaces them
  via `yaml_files_detected_but_not_parsed`. Closing this needs a dep decision
  (`yaml` npm package ~50 KB vs hand-rolled subset parser ~100 LOC).
  Deferred to M3 backlog.
- **`~/.rsct/update-check.json` survives `/rsct-uninstall`.** The uninstall
  inventory is project-local; the machine-global `~/.rsct/` is out of its scope by
  design, so the recorded consent and the declined-release list persist across a
  full uninstall and reinstall. Documented in `prompts/03-uninstall.md` Phase 6;
  removing it is `rm ~/.rsct/update-check.json`.

---

## M2 validation guide

Dev-owned checklist required to clear M2 and start M3. Runs after the
companion install (`bash scripts/install.sh`) and after
`/rsct-setup` re-runs to install the SessionStart hook in the project.

> Use the rsct-framework repo itself OR a copy of the M1 validation test
> project. Either works — sample-rsct fixture is also a fast canary.

### Pre-flight

- [ ] M1 validation gate signed off (per progress_rsct-mcp-v1.md).
- [ ] `rsct-mcp` on PATH and `node dist/index.js < /dev/null` prints the
      ready log including all 13 M1+M2 tool names (the full catalog is 40 now).
- [ ] `/rsct-setup` re-run in the test project; Phase 4.V reports either
      "Installed RSCT SessionStart sanitizer hook" (fresh) or "already
      present — no change" (idempotent).
- [ ] `.rsct/scripts/sanitize-permissions.js` exists in the test project.
- [ ] `.claude/settings.json` contains the `hooks.SessionStart[]` entry
      with command `node "${CLAUDE_PROJECT_DIR}/.rsct/scripts/sanitize-permissions.js"`.
- [ ] Claude Code restarted after registration.

### Tool checks (6 new in M2)

Ask Claude each prompt in a fresh chat; verify the trace shows the
expected tool and the response matches the docs above.

| # | Prompt | Expected tool | Verify |
|---|---|---|---|
| 1 | "Is the current branch protected?" | `rsct_check_branch` | Returns `is_protected: boolean`, `source: 'default'/'config'/'config+extras'`. |
| 2 | "Scan the staged diff for secret leaks." | `rsct_check_secrets` | Returns `findings[]` with line-level classification; honors `secrets_extra_patterns[]`. |
| 3 | "Is `mcp-server/src/lib/foo.ts` in scope for the active phase?" | `rsct_check_edit_scope` | Returns `status: 'in_scope'/'out_of_scope'/'unknown'/'stale_context'` based on `.rsct/phase-state.json`. |
| 4 | "Commit the staged changes with message 'feat: x'." | `rsct_request_commit` | Rejects without `dev_approval`; pops OS dialog when given a valid approval; commits + writes `commit.committed` audit entry. |
| 5 | "Push the current branch." | `rsct_request_push` | Same flow as 4; rejects on protected branch unless `override_protected_branch.reason` is set. |
| 6 | "Merge `feat/something` into the current branch." | `rsct_request_merge` | Same flow; extra-strict — refuses force-pushy patterns by default. |

### Hook check (INV-2.3 closer)

1. Add a poison-pill entry to the test project's `.claude/settings.local.json`:
   ```json
   { "permissions": { "allow": ["Bash(git commit:*)", "Edit"] } }
   ```
2. Close and restart Claude Code (triggers SessionStart).
3. Verify the file now contains only `"Edit"` in `allow[]`.
4. Verify `.rsct/audit.log` has a new line:
   ```json
   {"event":"sanitize.stripped","file":".../settings.local.json","stripped":["Bash(git commit:*)"],"count":1,"ts":"..."}
   ```

### OS dialog smoke (cross-platform)

| Platform | Channel | Verify |
|---|---|---|
| Windows | PowerShell MessageBox | Dialog appears with project name + action_scope. Yes → tool proceeds; No → tool rejects with `reject_kind: 'dialog_no'`; a dialog that ends any other way → `dialog_failed`. |
| macOS | `/usr/bin/osascript` (JavaScript `displayDialog`) | Same. Run only on the CI macOS cells so far (ADR-027). |
| Linux | `/usr/bin/zenity --question` | Same. Requires `zenity` at `/usr/bin/zenity`; if absent, `trust_allowed_for[]` is the documented fallback for the tools it still applies to — never commit, push, merge, rebase or `rsct_plan_authorize` (ADR-030). With zenity installed and no display the request is refused (`dialog_failed`). |

If only one platform is available, document the rest as "untested on
target platform" in the M2 sign-off — does NOT block the gate.

### Audit log shape

- [ ] After 1 successful `rsct_request_commit`, `.rsct/audit.log` has a
      `{"event":"commit.committed", "head_sha":"...", ...}` line.
- [ ] After 1 rejected `rsct_request_push` (protected branch without
      override), audit shows `{"event":"push.rejected","reject_kind":"protected_branch", ...}`.
- [ ] After 1 override invocation, audit shows `{"event":"<tool>.override_invoked", "override":"...", "reason":"..."}`.

### Sign-off (5-bullet M2 gate)

- [ ] All 6 new M2 tools respond correctly on the primary platform.
- [ ] SessionStart hook strips a poison pill in a real session restart.
- [ ] OS dialog pops on the primary platform; Yes/No path both behave
      correctly.
- [ ] Anti-decisions cross-check fires `conflict` for a claim shared with
      an AD-NNN entry (verifiable via tool check #7 from M1 with a claim
      like "use DynamoDB for orders").
- [ ] Dev signs off in progress_rsct-mcp-v2.md
      to start M3 (or to merge v1 + v2 → main as the planned M2 close).

If any row fails, capture the failure (tool/hook, prompt or step, actual
vs expected) in `progress_rsct-mcp-v2.md` before opening a fix.
