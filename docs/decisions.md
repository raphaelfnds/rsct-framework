# Architectural decisions — RSCT Framework

Decisions, measured facts and anti-decisions for the framework's own source. The
framework is deliberately not installed in its own repository, so this file plays the
role `documentation/decisions.md` plays in a managed project.

**Why it exists.** Source code here carries no comments (see ADR-001). Everything a
comment used to explain that is still load-bearing lives here instead, keyed by the
symbol it constrains, so it can be found and — unlike a comment — cannot silently drift
out of step with a line of code it no longer sits beside.

**What belongs here.** A decision someone could reasonably reverse without knowing why it
was made; a fact that was measured and cost something to learn; an alternative that was
tried and rejected. Not a restatement of what the code says.

---

## Firm premises (non-negotiable)

### #1 — The config loader fails closed on any dangerous value

`.rsct.json` is attacker-reachable: Claude itself, a malicious dependency or a
supply-chain hook can edit it. The loader therefore treats an out-of-bounds value as a
rejection of the **entire** config (`rsct_installed: false`, the same surface as a
missing config) and forces an `rsct_json.bounds_violation` event into the audit log so the
developer can see what happened.

Bounded fields and their ranges live in `mcp-server/src/lib/project-root.ts`:
`plan_token_ttl_minutes` 5–480, `plan_token_max_actions` 1–100 (`plan_token_ttl_slide_minutes` and
`plan_token_ttl_abs_minutes` were removed in 2.17.0, ADR-030: `approval_modes` is `.strip()`, so a
config that still has them loads and they drop). `sql_dialect`
is a closed enum (`postgresql`, `mysql`, `none`): an unknown dialect would have the REVIEW
sweep read SQL with the wrong comment syntax.

The vectors this closes: audit off, skew set to infinity, `protected_branches: []`,
`trust_allowed_for: *`.

### #2 — A phase bypass is a per-call decision, never a pre-authorised tool

Anything that removes the V phase or plan tracking must reach the developer through the
OS dialog on the call that does it. REVIEW cannot be removed at all (ADR-011). `trust_allowed_for` is ignored
on those paths. Recording a bypass in the audit log is not a substitute: the developer
learns only afterwards, and only if they think to look.

### #3 — A tier that skips phases needs evidence, not a declaration

`trivial` and `small` skip V and plan tracking by design (never REVIEW, ADR-011). Because `spec_tier` is
declared by the caller at `rsct_phase_code_start` (the only gate that still reads it —
`rsct_phase_test_start` rejects it as a removed option), that declaration is refused unless
an `rsct_classify_task` verdict is on record for the project.

---

## Durable architectural decisions (ADRs)

### ADR-001 — Source code carries no comments (2026-09-12)
**Status**: active
**Tags**: style, documentation
**Context**: A comment sits beside code and is not checked against it, so it drifts and
becomes a confident false statement — the same failure class the framework exists to
prevent in an agent. Measured on 2026-09-12: `mcp-server/src` held 5,291 comment lines
against 18,802 code lines (22%) across 92 files.
**Alternatives considered**: Detecting comments that disagree with the code. Rejected —
issue #33 measured that approach at 163 findings and **zero** true positives over four
real commits, because it needs diff context that `-U0` does not produce and a heuristic
for "disagrees".
**Decision**: No comment is written into source. Decisions, ADRs, anti-decisions and
conventions live in their own files. Files are cleaned as they are touched, in the REVIEW
phase, and a comment carrying a measured fact migrates here rather than being deleted.
**Consequences**: Detection becomes a lexical sweep instead of a heuristic — any comment
in a touched file is a finding, with no false positives. The cost is that this file must
be kept honest; an entry that stops being true is worse here than in a comment, because
this file is where people will look.

### ADR-002 — Tier `trivial`/`small` bypasses ceremony; `standard`/`complex` does not (ref: CAP-28, PH-1, DX-4)
**Status**: active for V and plan tracking; the REVIEW part is superseded by ADR-011 (2.11.0), and the free-commit-lane part by ADR-023 (#80, 2.13.4)
**Tags**: gates, tiers
**Context**: The canonical RSCT tier table (`rules/B-architect-plan.md`) makes ceremony
proportional to risk.
**Decision**: One shared set, `TIERS_BYPASSING_CEREMONY`, drives the verification gate and
the plan-tracking gate in `phase-code-start.ts`; `TIERS_BYPASSING_REVIEW_GATE` mirrors it
in `phase-test-start.ts`. Standard and complex must run V (or override it) and must have
`plan_<slug>.md` + `progress_<slug>.md` (or override it), each with an audit trail.
**Consequences**: The tier is the single lever that controls three gates, which is why
premise #3 requires evidence for it.

### ADR-003 — The plan-tracking gate keys on the PLAN slug, never the phase slug (ref: PH-1)
**Status**: active
**Tags**: gates, plan-tracking
**Context**: A multi-phase plan has both `plan_<slug>.md` and per-phase `spec_<slug>.md`
files.
**Decision**: `plan_slug` is required for standard/complex and the gate reads it, so a
per-phase `spec_` file can never masquerade as the plan. The only self-attested choices
left are declaring single-phase (omitting `spec_slug`, or setting it equal to `plan_slug`)
and the tier; `plan_` and `progress_` stay mechanically enforced.
**Consequences**: `is_multi_phase` implies `plan_slug` is present, including on the
override path — the invariant telemetry depends on.

### ADR-004 — The REVIEW gate matches `spec_ref` strictly (ref: #40)
**Status**: superseded by ADR-011 (2.11.0) — the test-start review gate, its decision block and its override no longer exist
**Tags**: gates, review
**Context**: A re-planned task produces a new `spec_ref` while an old review block is
still in phase-state.
**Decision**: A review block for a different `spec_ref` neither satisfies nor poisons the
gate, mirroring the V gate's `vMatchesSpec`.
**Consequences**: Additionally, findings still present alongside a `completed_at` mean the
completion did not pass this binary's gate — an older `rsct-mcp` stamped it (the global
binary is a symlink to a worktree, so switching branches swaps it) or the prune failed.
Either way the findings were never answered, so `passed` is suppressed; the suppression
does not return, because the override must stay reachable.

### ADR-005 — `approval_modes` is `.strip()`, not `.strict()` (ref: plan-lifecycle-v2 Fork 3/A)
**Status**: active
**Tags**: config, compatibility
**Context**: `.strict()` rejected the entire config on any unknown key inside
`approval_modes`.
**Alternatives considered**: Keeping `.strict()`. Rejected on two measured harms: a config
written by a newer server and read by an older one nulled out, silently dropping the
developer's custom `protected_branches` and `secrets_extra_patterns` back to defaults; and
it created a hard downgrade cliff.
**Decision**: `.strip()` drops an unknown or misspelled key to its safe default
(fail-closed) while the per-field bounds in premise #1 keep the dangerous-value defense
intact. `.strip()` is at least as strict as `.strict()` in every unknown-key case.
**Consequences**: Downgrading below plan-lifecycle-v2 still requires stripping the new
keys first — an already-shipped `.strict()` server cannot be patched retroactively.

### ADR-006 — `topology` and `audit` stay `.strict()`, `commit_message_max_lines` stays unbounded
**Status**: active
**Tags**: config
**Context**: The `.strip()` decision in ADR-005 is not uniform, and the exceptions are
deliberate.
**Decision**: `topology` keeps `.strict()` because a silently dropped `mode` would turn
contract enforcement off with no signal — rejecting loudly is the better failure.
`audit.enabled` is `z.literal(true).optional()` because `false` is the documented bypass
vector. `protected_branches` is `.min(1)` because an empty array disables protection
wholesale; a project that genuinely wants none should uninstall `.rsct.json`.
`commit_message_max_lines` is deliberately unbounded and type-forgiving
(`.catch(undefined)`): for a cosmetic cap, a JSON typo such as `"20"` instead of `20`
would otherwise disarm the edit guard and drop `secrets_extra_patterns`; the resolver
clamps the range at the point of use.
**Consequences**: `plan_file_retention` is named that way, not `plan_tracking`, because the
latter is the PH-1 code-start gate vocabulary and would collide.

### ADR-007 — `commit_message_max_lines` is top-level, not under `approval_modes` (ref: #20)
**Status**: active
**Tags**: config, compatibility
**Decision**: `approval_modes` only became `.strip()` in 2.2.0, so a key placed inside it
would null the entire config on any downgrade below that version. It stays top-level.

### ADR-008 — `RsctConfig` and the Zod schema are compared by key set at compile time
**Status**: active
**Tags**: config, types
**Context**: The hand-written interface and the schema that validates the file are
maintained separately and joined by an unchecked `as RsctConfig` cast in `readRsctConfig`.
**Decision**: A compile-time key-set comparison, because assignability alone does not
catch the failure: every field is optional, so both directions pass.
**Consequences**: Without it, a key added to only one side fails in the worst direction —
`.strip()` drops it at runtime while the cast tells TypeScript it is there, and the feature
reading it is dead forever.

### ADR-009 — Project-root resolution order, and why `${...}` is rejected (ref: CAP-49, CAP-50)
**Status**: active
**Tags**: project-root, windows, wsl
**Decision**: Precedence is (1) the `project_root` tool argument, (2) the
`--project-root` CLI arg or `RSCT_PROJECT_ROOT` env var, both taken as the root directly,
(3) `CLAUDE_PROJECT_DIR` as the start of an upward walk, (4) `process.cwd()` as the final
fallback.
**Context**: `CLAUDE_PROJECT_DIR` is what lets the server find the project under
WSL-from-Windows, where the MCP server's cwd is `C:\Windows` (Windows rejects a UNC cwd)
so a plain cwd walk could never reach a `//wsl.localhost/...` project.
**Consequences**: A value still carrying an unsubstituted `${...}` placeholder — for
example `args: ["--project-root", "${workspaceFolder}"]` that the launcher never expanded —
is rejected with a one-time stderr warning rather than resolved against the cwd. Silent
resolution produced the `C:\Windows\${workspaceFolder}` false negative in the CAP-49 field
report. Resolution returns a root even when `.rsct.json` is absent, so the tool surface
degrades to `rsct_installed: false` instead of failing.

### ADR-010 — Every gated `_complete` tool belongs in `TRUST_ALLOWED_TOOL_NAMES` (2026-09-12)
**Status**: active; since 2.17.0 (ADR-030) the enum still accepts `rsct_request_commit`, `rsct_request_push`, `rsct_request_merge` and `rsct_plan_authorize`, so a config that lists them still loads, but listing them has no effect: those tools always force the dialog
**Tags**: config, gates, headless
**Context**: `rsct_phase_review_complete` shipped with DX-4 and was never added to the
enum, while `rsct_plan_authorize` was added when it shipped — so the list is maintained and
this was drift, not design. Measured: a config listing the missing name is rejected whole
(`rsct_installed: false`, `bounds_violation`), so a developer on a machine with no dialog,
trying to make the REVIEW phase completable, turns the entire framework off and gets one
stderr line for it.
**Decision**: The enum carries every gated `_complete` tool. Adding a gated tool means
adding it here in the same change.
**Consequences**: The fail-closed posture for genuinely unknown names is unchanged and is
pinned by a test — widening the enum by one known name must not become widening it to
`z.string()`.

### ADR-011 — REVIEW is mandatory, runs after the tests, and is anchored at the commit gate (#62, 2.11.0)
**Status**: active; the free-lane consequence ("the free lane carries only reviewed bytes") is superseded by ADR-023 (#80, 2.13.4)
**Tags**: gates, review, comments
**Context**: REVIEW was opt-in end to end. MEASURED on `ed648d9`: `rsct_request_commit`,
`_push`, `_merge` and `lib/request-gate.ts` never read review state, and a trivial task
never entered the phase machine, so no REVIEW ran unless the agent chose to and ADR-001 was
enforced by nothing. The earlier placement failed in the field: a hygiene ack at the
integration boundary (`pre_merge_ack`) passes without a file being opened, because it can
only check that paths were claimed.
**Alternatives considered**: (1) keep REVIEW between Code and Test — rejected: tests are
written after it, so every commit carrying tests would need a second REVIEW; code review is
normally done on a green suite, tests included. (2) a push/merge backstop over the commit
range — rejected for this release: it blocks the first push of every new branch (the range
base does not exist yet, the reason push already fails open), can never be re-stamped for
code committed on another machine, and adds nothing for commits that already passed the
commit gate. (3) a project-level list of excluded paths for generated code — rejected: an
agent-editable list is a hiding place.
**Decision**: The cycle is R→S→V→C→T→REVIEW. `include_review` and `override_review_skip`
are removed (and `spec_tier` / `dev_approval` from `rsct_phase_test_start`, which no
longer gates anything); old callers get `review_option_removed`. `rsct_phase_review_complete`
sweeps every touched code file for comments, requires a disposition per removed comment,
checks each migration against the lines added to a decisions file, sends unverifiable and
exempt files to a developer-only dialog and stamps a ledger of git blob ids.
`rsct_request_commit` refuses any staged code file that is not in that ledger or still has a
comment, on every authorization path, before any dialog and again right before `git commit`.
**Consequences**:
- The free lane survives, but carries only reviewed bytes. A ledger entry with channel
  `trust` means no dialog was shown anywhere: a clean sweep with nothing removed can be
  trust-approved (ADR-010), so the claim is "the bytes were swept", not "the developer saw
  them".
- Residual, not closed: phase-state and the audit log are writable by a same-user agent.
  Always re-scanning the staged blob makes a forged `clean` entry useless for supported
  languages; a forged `unverified_authorized` entry plus a forged audit line still passes.
  Same Fork 1/A limit as `deriveAuditCeiling`: this raises the cost, there is no privilege
  boundary to close it.
- Residual, not closed: a commit made outside `rsct_request_commit` (a developer-accepted
  permission prompt, or the developer's own terminal) is not checked. The SessionStart
  sanitizer keeps the agent from holding a standing allow for `git commit`.
- A pre-commit hook can change the index after the check. The committed blobs are compared
  after `git commit`: a clean reformat is re-stamped (`review.commit_hook_rewrite`),
  anything else returns `committed_with_drift` and blocks further commits (`review_drift`)
  until those paths are covered again (see the drift rule below).
- Outside a git repository the commit check is skipped (the commit itself needs a
  repository); `rsct_phase_review_complete` rejects with `not_git_repo`.
- A behaviour fix made during the REVIEW changes stamped blobs: the commit gate forces a new
  REVIEW, re-running the tests is instruction.
- The sweep ledger survives `rsct_phase_abandon` and ignores the `spec_ref` carry guard:
  it is bound to bytes, not to a task.
- `review_findings` are pruned only after `completed_at` is stamped — if the stamp fails the
  findings stay, which is the recoverable direction.
- Every REVIEW rejection (findings gate, block actions, sweep) happens before any dialog, so
  a rejected completion never spends an approval; phase/spec checks run first.
- The approval dialog detail is set after the caller's `internal` options, so a test
  injecting `internal` cannot shadow the production text it asserts on.
- `review.evidence_mix` stays its own audit line rather than extending the generic
  `review.complete` event, which four other phases share; per-finding `review.action`
  entries are written only after the gate approves.
- HEAD moving between declaring findings and completing is marked (`head_stale`), never
  rejected: non-code changes, or code an earlier REVIEW stamped, can be committed while a
  review is open.
- The commit gate reads the whole repository index, not the `project_root` subdirectory —
  `git commit` commits the whole index (measured: a subdirectory `project_root` let a staged
  comment outside it through). Submodule gitlinks carry no content. A symlink entry (mode
  120000) is skipped only when its blob reads like a link target — on Windows with
  `core.symlinks=false` such an entry is a real file, measured committable with a comment
  before this rule. The same rule runs on the committed paths: without it a symlink the
  commit carries was scanned as code and became `review_drift` that no REVIEW could ever
  clear, because the REVIEW skips symlinks and never stamps one (measured by the test). A staged deletion of a file whose HEAD version has comments needs a
  deletion stamp from a REVIEW, and its HEAD version is scanned without the working-tree
  filter attribute (an untracked `.gitattributes` line otherwise hid it).
- Working-tree blob ids come from `git add` into a temporary copy of the index: measured,
  `git hash-object --path` disagrees with the id `git add` stores for a file whose blob
  already holds CRLF under `text=auto`, which made such files uncommittable forever. The
  copy keeps the real index's mtime (`utimesSync`), because git's racy-file protection keys
  on the index's own mtime: a copy stamped "now" makes a stale stat entry look trustworthy.
  MEASURED 2026-09-17, 20 runs each, bare `cp` + `git add -f` into the copy: the stale blob
  id came back 3/20 on Git Bash (NTFS) with a fresh mtime and 0/20 with `cp -p`; 0/20 both
  ways on WSL (ext4). Through `readWorkingBlobIds` itself the fresh mtime did not reproduce
  it (0/20 on Windows), so this line is insurance against a mechanism that exists, not a
  repaired failure — do not remove it because a test still passes without it.
  The temp-index git runs with
  `core.hooksPath` pointed at an empty directory, `core.splitIndex=false`,
  `core.safecrlf=false` and `core.fsmonitor=false` — measured: the repository's
  `post-index-change` hook fired, `sharedindex.*` files accumulated, and one unaddable file
  (safecrlf, skip-worktree) failed the whole REVIEW. A path `git add` still refuses is
  named in the rejection; anything else falls back to `hash-object --path`.
- Drift is settled against git, never against the working tree: a `review_drift` path is
  covered when the ledger holds its HEAD blob or when HEAD no longer has the path (measured:
  deleting the file in the working tree alone used to clear it). The commit that carries the
  reviewed fix for a drifted path is allowed through and clears the drift; a hook rewrite of
  a file the commit already checked is re-stamped and named in the hints, while a file a hook
  ADDS behind the review stays drift. The post-commit re-stamp never prunes ledger entries,
  and the plan-token re-arm re-reads phase-state before writing
  (measured: writing from the pre-commit snapshot erased a recorded drift).
- The unverified-files dialog appears only after the approval itself validated, names at most
  40 files and always points at the written report (measured: a PowerShell dialog carrying
  ~400 paths fails with `ENAMETOOLONG` and the REVIEW cannot be completed at all). The
  approval dialog lists allowlisted comments added or changed.

### ADR-012 — Comment engines per language (#62, 2.11.0)
**Status**: active
**Tags**: review, comments, packaging, cross-os
**Context**: A text search corrupts source (`'https://x//y'`, a `//` inside a template
literal or a regex). Engines were measured against independent reference lexers on real
code, Windows, 0 extra / 0 missed: TS/JS 5,730 comments (TypeScript scanner, 284 files),
Python 40,769 (`tokenize`, 400), PHP 4,480 (`token_get_all`, 400), Java 2,464 (javac
scanner, 400), CSS 1,162 (css-tree, 232). Dropping one comment per file was reported as a
miss in every language, so the zeros are not a comparator that never ran.
**Decision**:
- tree-sitter 0.25 (`web-tree-sitter` 0.25.10) with the official grammar packages
  (javascript 0.25.0, typescript/tsx 0.23.2, java 0.23.5, python 0.25.0, php 0.24.2,
  css 0.25.0), vendored in `mcp-server/grammars/` and pinned by a sha256 manifest test —
  not installed from npm, because those packages run a native `node-gyp-build` install
  script. `tree-sitter-wasms` is not used (different licence, 0.20-era grammars).
- parse5 7 for HTML; inline `<script>`/`<style>` text goes through the JS/CSS grammars;
  PHP inline HTML goes through parse5; `<?xml … ?>` and CDATA are not comments.
- A dialect-parameterised SQL lexer written here (see AD-005), dialect declared in
  `.rsct.json` `sql_dialect` and never inferred. A dollar-quoted body is lexed as SQL when
  the statement declares `LANGUAGE sql` or `plpgsql` (a quoted `LANGUAGE 'plpgsql'` counts,
  and string literals are blanked before that match so a default value cannot spoof it); a
  body under another declared language that contains `--`, `/*`, `#` or `//` is a
  `parse_error`, because those are comments in PL/Python and PL/Perl; a dollar string with
  no `LANGUAGE` clause is a literal and is left alone.
- Any tree-sitter parse error, a NUL byte, a UTF-16 BOM or invalid UTF-8 → `unverified`:
  a UTF-16 file read as UTF-8 parses with errors and zero comments in every grammar, which
  would otherwise read as clean. Measured cost: TS 9/284 and 2/196 files, CSS 16/232,
  Python/PHP/Java 0. Comments stayed correct in every error file measured (423/423 TS, 5/5
  CSS, 18 synthetic probes) — the rule is a safety margin, paid for with a dialog.
- Engines load lazily; the runtime WASM is read and checked with `WebAssembly.validate`
  first. MEASURED: a missing or corrupt runtime through the default loader aborts the whole
  MCP process uncatchably. Emscripten output goes to stderr (stdout is the MCP stream).
- Unknown extensions go to the developer; `not_code` is a closed list. MEASURED: Node
  executes `require('./payload.txt')` as JavaScript.
- The allowlist is full-body patterns, never prefixes: `// @ts-expect-error <paragraph>`
  would otherwise carry any prose, and a body that reads as prose (four ordinary words in a
  row) is never allowlisted, whatever its shape. A body over 1000 characters is not matched
  at all — measured, the earlier Python `type:` pattern backtracked exponentially (2.2 s at
  150 characters, doubling per union member) and the sweep runs synchronously inside the MCP
  server. Licence headers are kept as a whole group (block or consecutive line comments, at
  most 30 lines, containing a licence marker), because per-line filtering deleted real Apache,
  MIT and SPDX headers. Python docstrings and JS/PHP bare string statements are runtime
  values (`__doc__`, directives), not comments, and are not swept — a residual.
- Git reads run from the repository top level and cover the whole repository: the diffs
  carry no pathspec at all, and the reads that do take paths (the temporary index) pass
  `--literal-pathspecs`.
  MEASURED: `git ls-files -s -- 'app/[id]/page.tsx'` returns three entries (glob);
  `git rev-parse :0:<path>` returns one. With `project_root` below the top level,
  `hash-object --path` resolves the file relative to cwd and `ls-files -s` returns empty
  with rc 0. Working-tree ids come from a temporary index (see ADR-011) rather than
  `hash-object --path`, which disagrees with `git add` on a CRLF blob under `text=auto`.
  A path with a `filter` attribute is `unverified` (LFS pointers, clean filters), except when
  scanning a HEAD blob for a deletion.
**Consequences**: About 5.5 MB of WASM ships in the package. The standalone-dist test runs
the packaged `dist/index.js` beside `grammars/` and sweeps one file per engine, which is what
makes CI exercise Linux and macOS.

### ADR-013 — The scripts setup installs are recognised by exact bytes, not by path (2.11.1)
**Status**: active
**Tags**: review, commit-gate, setup
**Context**: Field test of 2.11.0, two projects: the setup commit was refused. The two
`.rsct/scripts/*.js` copies are bundles with comments (bundled libraries, bundler module
markers, the line-2 version stamp), and the commit gate asks a REVIEW for every staged code
file. They cannot be gitignored: the shared `.claude/settings.json` hooks call them.
**Decision**: a staged or touched `.rsct/scripts/<name>.js` (name in `ENFORCEMENT_SCRIPTS`,
relative to the project root) skips the REVIEW sweep and the staged check, and enters the
checked list, only when its bytes, with CRLF pairs turned into LF and nothing else changed,
equal `#!/usr/bin/env node\n// rsct-mcp v=<this server's version> — installed by
/rsct-setup\n<shipped body>\n`, the shipped body read once per process from the server's own
`dist/scripts/`. A git filter attribute, another version, another path, one changed byte,
or an unresolvable shipped directory keep today's path (REVIEW, exempt_files dialog).
MEASURED in V: comparing line 2 by pattern and splitting on `\n` let code hide after the
stamp — Node ends a `//` comment at U+2028 and at a lone CR, and both payloads executed.
Exact byte equality closes that class.
**Rejected**: exempting the path (any code placed there would skip the gate); shipping
comment-free bundles (a REVIEW would still be required on every setup); gitignoring the
scripts (teammates' hooks break).
**Consequences**: the post-commit check needs no change — the file is in `checked`, so an
unchanged blob passes it. A pre-commit hook that rewrites the script becomes drift, as for any
other file. Deleting the scripts (uninstall) still follows the deletion rule.

### ADR-015 — One glob semantics: a leading `**/` spans whole segments (#76, 2.11.2)
**Status**: active
**Tags**: globs, v-phase, edit-scope, contracts
**Context**: `globToRegex` compiled a leading `**` to `.*` and then swallowed the following `/`,
so `**/build/**` became `^.*build/.*$`. MEASURED as the walk calls it (`dir + "/probe"`):
`webbuild`, `packages/app-build`, `redist`, `test-coverage` and `my_node_modules` were all
excluded from the V walk. Five call sites share the matcher: the walk's language and exclude
globs (`reverse-dep-walk.ts:201,222,225,226`), the edit-scope guard (`edit-guard.ts:66`),
`check-edit-scope.ts:142` and the contract surface (`contracts.ts:124`).
**Decision**: one semantics for all of them — a `**/` at the start of a segment is zero or more
WHOLE segments (`(?:[^/]*/)*`); a trailing `**` (and a trailing `**/`) is everything below; a `**`
glued inside a name keeps today's `.*`, because narrowing that would lose a DECLARED contract
block (`openapi/**.yaml` vs `openapi/v2/b.yaml`). Compiled regexes are memoised per glob.
**Direction of each gate**: walk — sees more, the V answer is more complete; edit-scope — matches
fewer paths, so it refuses more; contract surface — blocks exactly what the surface declares.
The developer weighed the contract case three times and chose to remove the excess: `api/`,
`src/api/` and `any/dir/api/` still block under `**/api/**`; `webapi/` and `openapi/billing.yaml`,
which no declaration asked for, no longer do. A block the declaration never asked for is noise,
and noise is what makes a gate get ignored. The four places that teach the rule were corrected
with it (template `_help`, `docs/multi-repo.md`, `prompts/01-setup.md` Q&A, `mcp-server/README.md`),
and the template already promised these semantics.
**Line terminators, decided in REVIEW**: `[^/]` matches `\n`, so narrowing `**/` changed what a
path containing a line terminator matches — and the direction FLIPS by consumer: for the edit-scope
guard (match = allow) a wider match is weaker, for the walk exclusions and the contract surface
(match = skip / block) a narrower match is weaker. One regex cannot be strict for both, so the
regex keeps `[^/]` — consistent with `*` and `?` — and the two allow-side consumers
(`lib/edit-guard.ts`, `tools/check-edit-scope.ts`) refuse a path carrying `\n`, `\r`, U+2028 or
U+2029 outright. Both ends fail closed.
**Consequences**: the V walk scans directories it used to skip (MEASURED: no change on this repo —
`node_modules`, `dist` and `.git` are still excluded, `files_scanned` unchanged). A project whose
scope glob relied on the wide match now sees `out_of_scope` — the stricter direction.

### ADR-016 — The walk resolves NodeNext specifiers, case-exactly, as a last resort (#77, 2.11.2)
**Status**: active — the `.mjs`/`.cjs` gap named in the Decision was closed in 2.12.0 (#101 Part A, which added `.mts`/`.cts` and the mapping); candidates outside the project root are ADR-020
**Tags**: v-phase, blast-radius, cross-os
**Context**: under `"module": "NodeNext"` TypeScript source imports `'./x.js'` for a file stored as
`x.ts`. The walk probed `target + ext` only, so the specifier resolved to nothing. MEASURED on this
repository (seed `src/lib/phase-scope.ts`, depth 2): 216 files scanned, **611 unresolved
specifiers, 0 importers** — the blast radius was empty for the framework's own code, and for any
NodeNext project. #54 stage 1 shipped the honest hint for exactly this, and
`reverse-dep-walk.test.ts` pinned the gap as "REPORTED, not fixed"; that decision is superseded
here, and the test now pins a specifier that truly resolves to nothing.
**Decision**: after today's probes fail, map the specifier extension to its source extensions
(`.js` → `.ts`, `.tsx`) and accept a candidate only when `readdirSync` of its directory holds that
exact basename, memoised per walk. The case check is not optional: `existsSync('widget.ts')` is
true for `Widget.ts` on Windows and macOS, so without it one project would get two different import
graphs on two operating systems — the invariant this module's own header states. `.mjs`/`.cjs` are
NOT mapped: `.mts`/`.cts` are not in `DEFAULT_LANG_GLOBS`, so the walk would list importers for a
seed it also calls uncoverable. That gap is its own issue.
**Consequences**: MEASURED after, same repo and seed: **81 importers, 1 unresolved**, 166 ms.
`unresolved_js_specifiers` keeps counting what still fails and the hint keeps firing on a partial
under-report, so the honest-coverage rule of #54 stands. The case check walks EVERY segment from the
project root, not just the basename: REVIEW measured that `readdirSync` of a wrongly-cased directory
succeeds on NTFS, so an import of `'./Sub/widget.js'` resolved on Windows (importer counted, no
hint) and failed on a case-sensitive filesystem (importer missing, hint fired) — the same divergence
this ADR forbids, one level up.

### ADR-017 — A phase-state writer refuses an unreadable file, and the tier ratchet survives an abandon (#77, 2.11.2)
**Status**: active — the four tools named below as "still unguarded" now refuse a file that is unreadable when the call starts (ADR-019, #101)
**Tags**: phase-state, gates
**Context**: `readPhaseState` reports `{exists:true, state:null, parse_error}` on a corrupt file
(`phase-scope.ts:317-324`), and four writers started from `{}` regardless, replacing whatever the
file held — the review ledger, the drift record, the plan authorization — with their own block.
#53 closed the bootstrap path the same way in 2.8.0, through the `readThenStampBootstrap` wrapper.
**Decision**: `stampContextStale`, `stampClassifyVerdict`, `stampReviewCompleted` and
`stampPlanDisposition` return `reason: 'unreadable_state'` and write nothing; the result carries
the same `error` string shape the existing hints print, so every caller reports it without a new
branch. An ABSENT file is not an unreadable one and is still created. `last_classify` is decided
explicitly, as the issue demands: it is PRESERVED — added to `PHASE_STATE_PRESERVED_ON_ABANDON`,
so abandoning a phase no longer resets `tier_max`, the ratchet `rsct_phase_code_start` reads to
refuse a downgraded tier. That closes the abandon route only; the other ways to reset the verdict
are #89.
**Extended after REVIEW (2026-09-19, dev decisions)**: the guard also covers the sweep-ledger write
in `rsct_phase_review_complete` — insurance, not a hole that was measured open: a reviewer reported
that write as overwriting the corrupt file, and re-measuring the TOOL (corrupt state, valid
approval, guard present and then removed) returned `no_active_phase` both times with the file
byte-identical, because the phase precheck rejects first. The claim held only for raw
`writePhaseState`, which reads nothing by design; the guard stays for the race where the file is
corrupted mid-call. Also `startPhaseGeneric`, which covers the five
`rsct_phase_*_start` tools that route through it, and `rsct_phase_verification_start`, which has
its own plumbing and was measured still replacing the file. An ABSENT, empty or whitespace-only
file is not corruption — `writePhaseState` writes with `writeFileSync`, so an interrupted write
leaves exactly an empty file and blocking on it would strand the project; a UTF-8 BOM is stripped
before parsing, and an array at the top level is corruption, not state. `rsct_classify_task` reports a refusal instead of answering as if it had
stamped, and its audit line carries `recorded`. Reason the starts had to follow: with the stamps
refusing, `last_classify` was never written, and `rsct_phase_code_start` reads a missing record as
"no ratchet", so the tier gate silently turned OFF — a fix that made a gate more permissive, which
this repo does not accept. Still unguarded, and named rather than implied: `rsct_plan_authorize`,
`rsct_plan_revoke`, `rsct_request_commit`'s bookkeeping writes and `rsct_phase_abandon`.
**Not covered by a test, recorded rather than claimed**: the two "could not be written" hints inside
`phase-review-complete.ts` fire only if the state becomes unwritable BETWEEN the phase precheck and
the stamp; a held lock or a corrupt file is caught earlier and reports through a different message,
which is the one the new test pins. `stampContextStale` has no production caller
(`grep stampContextStale dist/index.js` → 0) — its guard is insurance for the next caller.
**Consequences**: a project with a corrupt `phase-state.json` stops recording these stamps until
the file is repaired or deleted, and says so — the same posture #53 chose for the bootstrap marker.
The existing abandon test that pinned `last_classify` as cleared was updated with the developer's
OK; its nine other keys are still asserted, and the allowlist test beside it is untouched.

### ADR-014 — A leftover task name stops the start and asks the developer (2.11.1)
**Status**: active
**Tags**: phases, spec_slug
**Context**: `spec_slug` is carried across phases on purpose (multi-phase plans, ADR-003),
so a `_start` without `spec_slug` inherited whatever name the state held — including a task
finished days earlier. Its `_complete` under the new name then failed `spec_ref_mismatch`.
**Decision**: a `_start` without `spec_slug`, while the state holds a different name and no
phase is active (the stale V label counts as not active), returns `previous_task_pending`,
writes nothing and asks the agent to put the choice to the developer: continue the recorded
task (`spec_slug=<old>`) or start a new one (`spec_slug=<spec_ref>`). Restarting the same
active phase inherits as before. `rsct_phase_verification_start` gained the same optional
`spec_slug`.
**Residual, accepted by the developer**: no OS dialog — the agent could answer on its own.
**Consequences**: every start without `spec_slug`, with no phase active, whose `spec_ref`
differs from the recorded name stops with that question — a multi-phase plan (ADR-003) that starts the phases after
Code under the plan name included, since `_complete` clears `phase`. The hint asks the agent
to keep passing the chosen `spec_slug` on every later start of the task. Known and left as
is: `rsct_phase_code_start` runs its override dialog before this check, as it already did
before `phase_already_active`, so a start that asks shows that dialog again on the retry.

### ADR-018 — Dead code is decided by resolved references in the touched files, and the developer disposes (#62, 2.12.0)
**Status**: active
**Tags**: review, commit-gate, dead-code, cross-os
**Context**: release 2 of #62. The 2026-09-10 decision said validation follows the graph, but the
walk is file-level — `DiscoveredImporter` is `{file, via_paths, depth}` and its regexes capture the
specifier, never the imported names — so a graph verdict cannot settle a symbol question. MEASURED on
this repository: every source file but the entrypoint has importers, so "the graph wins" would have
rejected nothing. A name search was tried and rejected (AD-006).
**Decision**:
- **Scope**: symbols declared in the touched JavaScript/TypeScript files; the rest of the project is
  read as evidence and never edited. A symbol that dies because its last caller was removed in another
  file is caught when that file is touched — the ceiling the comment sweep also has.
- **Predicate**: referenced nowhere, its own file included, the declaration excluded, through resolved
  references — named, aliased, default and namespace imports; named, star and `export * as ns`
  re-exports followed to the end (the walk's depth cap does not apply); local `export { a as b }` and
  `export default a`; a re-export of an imported binding; `import m = require()`. References are
  scope-aware and owned per declarator; values and types are separate namespaces (a type parameter
  hides only types, a parameter only values), a parameter default does not see the body's `var`, and
  a signature's parameters are local to it. A bare use of a binding is told apart from `x.member`.
  Liveness is reachability from a real use, so self and mutual recursion are dead. Types are excluded
  unless asked for.
- **A file that also runs as a plain script** — it checks `typeof module`, `exports` or `define`
  before exporting — is judged like any other module (developer decision 2026-09-23). What it hands
  to `module.exports` or to a `define` factory is a reference, so its public surface stays alive by
  itself; what is left is reported, with a hint saying a page could load the file with a script tag
  and call those names as globals, so the developer can keep them. Leaving every name in such a file
  unknown was tried for a day and REVERTED: MEASURED (Rv4 lens 2), pasting that one guard line into
  any CommonJS file hid every dead symbol in it, which an agent can do at will.
- **Never reported — code that runs at load** (developer decision 2026-09-22): a declaration whose
  initializer runs code when the module loads — a call, `new`, `await`, an assignment, `delete`, a
  decorator, a static block, a call in `extends` — is a root. Its binding may be unused, but removing
  the statement removes the effect. MEASURED: when self-reference stopped counting, `got` went from 0
  to 8 false findings (`const server = app.listen(…, () => server.address())`). The cost is
  detection: an unused `z.object(…)` schema or `new Map()` is not reported.
- **Unknown, never dead** — each reason is a hint naming the files: a file no resolved import reaches
  (an entrypoint); an importer the grammar cannot parse (its imports are read by the walk's regex, so
  the taint stays scoped; `.vue`, `.svelte`, `.astro`, `.html`, `.mdx` importers the same way); a
  target of `import()`, `require()` or a query import (`./w.ts?worker`); files under the static
  prefix of a computed import (`` import(`./locales/${l}`) ``, `import.meta.glob`, `require.context`),
  and EVERY export when an import has no static part at all; a namespace used as a value (passed,
  spread, destructured, read with a computed key); a nested namespace (`ns.inner.x`); an import the
  scan cannot resolve, by the names that import actually uses (a workspace package narrows it to its
  directory — an unused import rescues nothing); a classic script's top-level names (no import,
  export or CommonJS marker at all; `.mjs`/`.cjs`/`.mts`/`.cts` are modules); a target of
  `require('<literal>')` even
  through a parameter named `require` (AMD factories receive it) — but a COMPUTED `require(x)` counts
  only through the real `require`, never through a shadowed one, since otherwise one parameter named
  `require` blankets every export in the project (MEASURED, Rv4 lens 2); a file calling direct `eval`; and
  every verdict when a file cannot be read for a reason other than absence. A private helper used
  only by an unknown symbol is unknown too. A declaration that only a `@jsx` pragma of its own file
  names stays alive (a classic JSX build calls it) but is named in a hint, never silently.
  `const _name: Type = value` — a leading underscore, a declared type and a plain value (a name, a
  member, a literal) — is a compile-time type check, unknown with a hint (developer decision
  2026-09-22; MEASURED: the one "dead" report on `zod` was such a type-test line, `_sameTree`).
- **Resolution** reuses the walk's resolver, never a second one: the file and its extensions before a
  directory index (the TypeScript and Node order — the walk itself now matches, which changes the V
  phase only where both `x.ts` and `x/index.ts` exist), except that `.`, `..` and a trailing `/` mean
  the directory, as in Node; a directory holding a `package.json` also credits its `main`/`module`/
  `source`/`types`/`exports` entries; a `.js` specifier whose `.ts` source sits beside it credits
  both; tsconfig/jsconfig `paths` (most specific pattern), `baseUrl`, relative `extends` and
  `references` (for paths and the JSX settings), read as JSONC. `paths` and `baseUrl` are tried
  BEFORE the Node builtins, as tsc does (MEASURED, Rv3 lens 1: `baseUrl: "src"` plus
  `import 'domain/user'` read as the builtin `domain`, and live code was reported dead); `node:` is
  always external, and so are declared dependencies; a package whose `name` a `package.json` here
  declares is a place in this repository. A specifier is an asset only by a known asset extension
  (`.css`, `.json`, `.png`, …) and only after resolution fails — `./users.service` is code. A
  relative import that matches only when letter case is ignored (`./Utils` for `utils.ts`) resolves
  nowhere, as on Linux, but the names it uses are unknown, on every OS, in exactly the files the
  same resolution names once the case is corrected — one file, or a directory's index or
  `package.json` entry, never everything under a prefix (MEASURED, Rv3 lens 2: `./Utils` beside
  `./utils` made a used `helper` read dead; Rv4 lens 2: a prefix let `import * as z from './'`
  blanket a whole directory). A `/`
  specifier or glob is tried against the importer's package root, then the repository root; a glob
  that matches nothing there has no fixed target. `jsxImportSource` makes every file with JSX an
  importer of `<source>/jsx-runtime` and `/jsx-dev-runtime`.
- **Corpus**: JavaScript/TypeScript plus the importers above (`.md` included: a VitePress or
  Docusaurus page imports components); in `.md`/`.mdx` EVERY import is read from the import/export
  lines and `<script>` blocks alone — fenced code and prose are not code, so neither a fenced
  example nor a sentence reading "callers do import { x } from '…'" reaches the graph (MEASURED,
  Rv4 lens 2: reading the prose let one sentence in any `.md` file blanket a file's exports).
  The shared import reader also matches braces holding a
  comment with a quote in it. Excluded: `node_modules` and `.git`
  anywhere, and `dist/`, `build/`, `coverage/` directly under a package root (the repository root or
  a directory holding `package.json`), so build output never keeps code alive. MEASURED (Rv2 lens 1):
  an unanchored `**/build/**` hid a real `src/commands/build/` and made its uses read dead.
- **Bytes**: the REVIEW reads the files git knows plus the untracked non-ignored ones, as the
  developer sees them: from disk, with the index used only for a file that is not on disk and is
  marked skip-worktree or assume-unchanged (a sparse checkout). Reading every file git calls
  unchanged from the index instead was tried and REVERTED (Rv4 lens 1, MEASURED): `git diff` does
  not compare an `assume-unchanged` path at all, and skips the comparison whenever its stat cache
  matches, so "unchanged" is not "identical" — the REVIEW judged committed bytes while the disk
  held the caller, and reported a live symbol dead. The commit gate reads the INDEX
  (`git ls-files -s` + `git cat-file --batch` in batches bounded by bytes; a blob git cannot hand over
  alone makes every verdict unknown, named; a failing multi-file batch refuses). Line endings are
  normalised at read, so both share parses. A path the pre-read did not cover — a config an
  `extends` names, whatever it is called — is fetched from the index on demand, so the commit gate
  resolves exactly what the REVIEW does (MEASURED, Rv3 lens 3: before that, a `configs/base.json`
  read as absent at the commit gate, the alias stayed unresolved and a dead export passed). MEASURED
  before: reading the disk at commit let an unstaged edit flip the verdict both ways. MEASURED
  (2026-09-22, idle machine, 5,000 files): opening them one by one off the disk took 2.4 s on every
  round, against 1.7 s for the first read through `git cat-file --batch` and 0.3 s for each round
  after — which is why the commit gate, which must read the index anyway, is the cheap one, and why
  replacing the REVIEW's disk reads was tempting. Analysis runs from the repository top level.
- **Size**: a file whose UTF-8 bytes pass 2 MB is not parsed (bytes, not characters: a file of
  accented or CJK text is judged by its real size). Touched, the REVIEW and the commit refuse it, named
  (`dead_code_unreadable` / `dead_code_staged`), until the developer lets it through `exempt_files`
  — refusing rather than skipping keeps a padded file from hiding its dead code; untouched, it is
  read for its imports only, and what it imports is unknown. MEASURED (Rv3 lens 2): one 20 MB
  generated `.ts` made the first REVIEW take 87 s and left the server at 1.5 GB for its lifetime
  (tree-sitter's memory never shrinks).
- **Fails closed**: an exception in the scan rejects the REVIEW (`dead_code_unreadable`) and the commit
  (`dead_code_staged`, every asked path named); after the commit, every hook rewrite becomes drift.
  MEASURED before (Rv2 lens 2): a throw after `git commit` skipped drift, anti-replay and the audit
  line, and an analysis failure re-stamped rewrites as clean — a lock loosened.
- **Disposition**: the developer, per symbol. A keep is bound to the sha256 of the declaration text
  (export keyword included, CRLF normalised) and keyed by path and name. A NEW keep forces the §C
  dialog (`trust_allowed_for` ignored), is written to the REVIEW report the dialog names (the dialog
  itself lists ten) and to the audit log as `review.dead_code_kept`; the commit honours a stored keep
  only when that audit line exists — the bar ADR-011 sets for `unverified_authorized`. Keeps survive
  `rsct_phase_abandon` and are pruned only when their file is gone from the index, HEAD and the
  working tree. A hook that reformats a kept declaration un-keeps it: the commit lands as drift and
  the next REVIEW asks again. A stale keep and an unkept symbol are reported together.
- **Not judged**: files the developer allowed without a mechanical check (`exempt_files`, unscannable
  files, the scripts setup ships) — the dialog says "comment or dead-code check" — and build output.
- **`public_api`** (`.rsct.json`, path globs through `matchesAnyGlob`, relative to the project root or
  the repository root): an exported symbol exposed through a matching file — a barrel included — is
  exempt. The project root is the directory git names (`--show-prefix`), so a root reached through a
  junction or symlink matches too — MEASURED (Rv3 lens 2): a junction made `api` read dead. Every
  exemption is written to the REVIEW report, and the commit gate refuses a staged export the
  exemption covers while the audit log holds no approval for it — the bar a keep already had. Each
  exempted export is put to the developer once
  (developer decision 2026-09-22): the §C dialog is forced while any of them lacks a
  `review.public_api_approved` audit line for that exact declaration sha256 AND that exact
  `public_api` list (sha256 of the sorted globs), and the line is written only after the developer
  answers yes. A new export, a changed declaration or a changed list asks again. Asking on every
  REVIEW instead would leave a library project that has no dialog channel unable to finish one, and
  trains the developer to click yes; the keep rule this mirrors was already decided that way. Setup
  does not ask for `public_api` (developer decision; the uninstall note is on #82).
- **Commit gate**: at both existing sweep points, before authorization and right before `git commit`;
  after the commit, a pre-commit hook's rewrite is re-derived and a dead symbol lands as drift. The
  verdict is reused while the index listing (hashed), the project root and the inputs are unchanged,
  so the two checks of one commit analyse once. A refusal names the code files not staged yet that
  mention a refused name exactly — MEASURED (Rv3 lens 2): committing a library before its consumer
  otherwise loops, since the REVIEW then has nothing left to keep.
- `DEFAULT_LANG_SUFFIXES` is derived from `DEFAULT_LANG_GLOBS`, so the coverage hint cannot drift
  from the scan list (#101 Part A).

**Measured** (2026-09-22, every file a target, idle machine): this repository, 228 files — 0 dead
(`readFullSha`, its one true finding, is deleted in this release); cold 2.0–2.4 s, warm 0.2 s.
`got`, 90 files — 0 dead, 12 unknown; at the previous commit 8 live declarations were reported dead,
`const server = app.listen(…)` among them. `zod`, 549 files — 1 dead, `const _sameTree: T =
userSchema` in a type-test fixture; 397 exports unknown (102 with `public_api` declared, 272 exempted):
three files load a module through a computed path (benchmarks, a tree-shake test), so any export may
be their target, and four files the grammar cannot parse taint what they import. Before this
revision, imports inside MDX code fences, prose reading "import (" and an aliased `.png` blinded it
too. Cold 3.3–3.9 s, warm 0.6 s. A cached parse holds ~21 KB (522 files: 10.8 MB), so the cache
stops at 4000 files (~85 MB). Above that, a check keeps the parses it already holds — an entry an
earlier check put there gives way, one this check has used does not — instead of evicting in a
cycle. MEASURED (2026-09-22, 5,000 generated files, idle machine, through the gate): the first
REVIEW parsed 5,001 files in 4.1 s and every later one 1,001 in 1.1–1.4 s, where before it
re-parsed all 5,000 every time; a commit's second check, with the index unchanged, reuses the
verdict — 0 parses, 0.24 s. The
spec's "scan only the files that can reference the touched symbols" is NOT done: a cheap pre-filter
would read imports from text, and the text reader misses forms the parser sees (template and glob
imports), which would turn into false "dead".
**Stated limit**: the vendored tree-sitter-typescript 0.23.2 cannot parse variance annotations
(`interface X<in T>`, `<out T>`) or `export type * from`; such files are unreadable, taint what they
import, and a touched one is named as not checked. A bundler alias no config declares resolves by
name only. Case-exact resolution (ADR-016) holds on every OS; a case-only match is unknown, never
resolved.
**Not reported, by construction (false negatives, never false "dead")**: a value that only a type
names (`type K = ReturnType<typeof f>`, types being out of scope), only an ambient declaration names
(`declare const k: typeof f`), or only a destructuring initializer names (`const [x] = [f]`) stays
alive; so does anything a JSX pragma names.
**Residuals, not closed**: a forged `phase-state` keep plus a forged audit line passes (as ADR-011);
a commit outside `rsct_request_commit` is not checked (#91); dead code in an untouched file; every
language other than JavaScript/TypeScript is uncovered — and said so in a hint, including when an
export is reported dead in a repository that holds files in other languages.

### ADR-019 — Authorize, revoke, abandon and commit refuse an unreadable phase-state, and no commit is made on one (#101)
**Status**: active. Since 2.17.0 (ADR-030): in named limit (2), "the reserve and refund writes start from the state read before authorization" no longer holds — they read the state again just before writing and write only if the stored token is unchanged (a check before the write, not under the lock), and the re-arm is gone; named limit (4) no longer holds — `rsct_plan_authorize` checks its pre-conditions and an unreadable state before its dialog. Since 2.18.0 (ADR-031), in named limit (1), the refusal text no longer recommends deleting — it says to stop and ask the developer, as `rsct_load_context` and `rsct_status` now do; deleting still drops the drift lock and the tier ratchet.
**Tags**: phase-state, gates, commit-gate
**Context**: ADR-017 named four tools as still unguarded. MEASURED before this change, by driving
the real handlers on a file cut mid-object: only two of the four wrote. `rsct_plan_authorize`
replaced the file with `{ plan_authorization }`; `rsct_request_commit` replaced it with
`{ review_drift }` when a pre-commit hook slipped code into a docs-only commit. `rsct_plan_revoke`
and `rsct_phase_abandon` wrote nothing and answered `no_token` and `no_active_phase` ("the state is
already clean"). And one consequence nobody had listed: `rsct_request_commit` read `review_drift`
from a `null` state, so a docs-only commit with a `dev_approval` LANDED past an armed drift lock
(control, same repository, readable file: rejected, `review_drift`).
**Decision**: each of the four refuses a file that is unreadable when the call starts, leaves it
byte-identical and says so, reusing `refuseUnreadableState`. Authorize refuses through its
`state_write_failed` branch, the approval unconsumed. Revoke and abandon answer
`state_write_failed` — abandon before any dialog — and each writes an audit line, because every
other `state_write_failed` answer does and a refused revoke leaves a token sitting in the file.
The commit gate's sweep check returns `review_unreadable` at both of its check points, so no commit
is made, docs-only included, until the file is repaired or deleted. `review_unreadable` was reused
instead of a new kind: it already means the REVIEW gate could not read what it needs, nothing
branches on it, and the ledger and the drift lock are what the file holds. `rsct_audit` stops
saying "Commits still work" when the fault is `phase_state_corrupt`. An absent, empty or
whitespace-only file stays what ADR-017 says it is: not corruption.
**Consequences**: stricter — a commit that used to land on a corrupt state is refused. Before any
new test existed, a full-suite run with the guards applied gave the same totals as the run without
them (2538 passed, 2 skipped), so no existing test relied on the old answers. The two new audit
lines are written by calls that pass no gate, like the refused starts of ADR-017; they give the
audit-history signal of #80 nothing those did not already give it.
**Left as they are, named rather than implied**: (1) DELETING the file still drops the drift lock
and the tier ratchet, and the refusal text itself recommends deleting — that is #89; this change
closes the silent route, not that one. (2) The post-commit writes of `rsct_request_commit` are
unguarded. They can only meet an unreadable file that was corrupted after the second check, and
MEASURED with a hook that corrupts it mid-commit the sweep write replaces it with
`{ review_sweep }` (hook that only reformats) or `{ review_drift }` (hook that slips code in): the
drift lock survives, `last_classify`, `context_stale` and every other key are reset, and the
response does not say so. Refusing that write would leave a landed drift unrecorded, so the trade
between the two gates was not made inside a fix. The reserve and refund writes start from the state
read before authorization, so they put a good copy back; the token re-arm re-reads the file
(ADR-011) and falls back to that state only when the re-read gives nothing. (3)
`rsct_phase_abandon`'s own write follows its dialog: a file corrupted while the dialog is open is
replaced by the abandon result. (4) `rsct_plan_authorize` still shows its approval dialog before it
refuses — its pre-conditions run after the gate by design; the approval is not consumed. (5) Tools
that only READ still answer "nothing there" about a file they could not read: `rsct_phase_status`
("present but no active phase field"), the `_complete` tools (`no_active_phase`,
`no_active_verification` — measured, they write nothing), the open-phase block of `rsct_audit`, the
active-phase block of `rsct_load_context` (which prints the parse warning elsewhere), and
`rsct_phase_code_start`, whose gates read the same `null` state and answer
`classify_evidence_absent` or `plan_tracking` without naming the file (measured at all four tiers);
the call each of those answers points to refuses and names it.

### ADR-020 — An import candidate outside the project root is matched on its file name only (#101)
**Status**: active
**Tags**: v-phase, blast-radius, cross-os
**Context**: ADR-016 made the NodeNext case check walk every segment from the project root.
`hasExactPath` hands a candidate OUTSIDE the root to `hasExactEntry` instead, and that branch had no
test: a `throw` planted in it fired in none of the walk test files.
**Decision**: the branch stays, and is pinned. The per-segment walk cannot be used outside the
root — it would compare the root's own ancestors with whatever spelling the caller passed for the
root. MEASURED on win32 with the branch deleted: a project root passed in another letter case stops
resolving `'../../outside/x.js'` (0 → 1 unresolved), while the exact-case and the wrong-file-name
cases answer the same with and without it. So three tests pin it, and the one that sees the branch
deleted runs only where a respelled path exists (a case-insensitive disk); it is reported as
skipped elsewhere.
**Consequences**: known and left to #54 — an outside DIRECTORY spelled in the wrong case resolves
on a case-insensitive disk and not on a case-sensitive one (MEASURED for `'../../Outside/x.js'`:
0 unresolved on NTFS, 1 on ext4), the divergence ADR-016 forbids, outside the root. The
different-drive arm (`isAbsolute(rel)`) has no portable fixture and stays uncovered.

### ADR-021 — The companion runs from a copy the installer owns, and the global command is a link to it (#74)
**Status**: active
**Tags**: install, npm, cross-os
**Context**: `scripts/install.sh` ran `npm install -g .` inside the clone's `mcp-server/` and printed
"✓ rsct-mcp installed globally". npm LINKS a folder spec (every version measured from 6.14.18 to
11.1.0 except 9.0.0–9.4.1 — see "Measured facts"), so the global command was the clone: the branch
checked out there was the enforcement binary of every project on the machine,
moving or cleaning the clone broke it everywhere, and nothing on screen said so. With the clone on a
network path (`//wsl.localhost/…`) npm for Windows left a link to `C:\wsl.localhost\…`, which does
not exist, and exited 0.
**Decision**: the installer copies `package.json` plus the entries of its `files` field into
`~/.rsct/mcp-server` and runs `npm install -g . --install-links=false` from that copy. The global
entry stays a link — to a folder the installer owns. The flag is explicit because a user config, or
npm 9.0.0–9.4.1, would copy into npm's tree instead (AD-007).
The copy is replaced by a swap: built in `mcp-server.new`, checked for `dist/index.js`, the live
folder renamed to `mcp-server.old`, the new one renamed in, and the old one renamed back if that
fails. MEASURED on a first prototype that wiped and then copied: a `files` entry that did not exist,
a failing npm, or on Windows a native process sitting in the folder left a companion that had been
working broken.
Nothing is claimed without a check. `mcp_command_is_copy` proves by FILE IDENTITY that the
`rsct-mcp` on PATH is the copy: `[ cmd -ef copy/dist/index.js ]` (POSIX — the command is a symlink
chain ending there) or `[ <dir of cmd>/node_modules/rsct-mcp/dist/index.js -ef … ]` (Windows — the
command is a shim beside npm's `node_modules`). A name that resolves proves nothing: inside WSL it
is the Windows shim, and in the test suite it was the developer's own install. Only a command
proven to be the copy is started, with `</dev/null`; the server exits 0 on EOF and writes nothing
(measured in an empty cwd and HOME). Success prints one of three outcomes: it is the copy and
starts; it is the copy and did not start; the command on PATH could not be confirmed as the copy —
named, never run. The check proves "is the copy" and nothing else: behind a version manager's shim
the command may well be the copy, so the message never says it is not.
Failure prints only what two checks establish: whether the copy is this version (`cmp -s` of the
clone's and the copy's `dist/index.js`) and whether the command on PATH runs from it. It names no
cause it did not observe.
The uninstaller keeps `~/.rsct/mcp-server` while the companion is kept (answer "n", `--skip-mcp`,
npm missing or failing). On removal `npm uninstall -g rsct-mcp` runs FIRST — npm reads `bin` through
the link to remove the command — and `rsct-mcp` is then resolved again: still the copy (another npm
prefix) and the folder stays; otherwise the folder goes, and anything still on PATH is named instead
of "Removed".
**Consequences**: `git pull` no longer changes the running server; running the installer again
does. A contributor who wants the command to follow a working tree links it on purpose and passes
`--skip-mcp` afterwards (`CONTRIBUTING.md`). The package has no `dependencies` and no `prepare` or
install script, so linking it downloads nothing and builds nothing — a test pins both, because the
copy holds neither `node_modules` nor `src/`. `~/.rsct/VERSION-CODE` still records the incoming code
version when the companion step is declined or skipped; the copy then stays at the previous version.
A declined step says the installed server was left as it is; `--skip-mcp` says "framework files
only". Limits, each repaired by running the
installer again: an uninstaller older than this change deletes `~/.rsct` first, which on Windows
leaves the three shims behind and, with the companion kept, a link to a deleted folder; `~/.rsct`
deleted by hand leaves npm's link (Linux, invisible to the uninstaller) or the shims (Windows, named
by it). `files` entries must be plain existing names, because they are copied with `cp -R` — a test
pins it. The scripts are bash, not sh: measured with dash, the previous installer already died at
`${BASH_SOURCE[0]}` and the previous uninstaller did not parse. macOS and a `sudo` prefix were not
measured locally; one test drives a real npm on the CI matrix.

### ADR-022 — The hook programs are launchers, and the edit-scope guard judges resolved paths (#114)
**Status**: active; the dialog-free-lane-suspension consequence is superseded by ADR-023 (#80, 2.13.4), and the named limit "each edit there now writes one `rsct_json.*` audit line" is bounded to about one per hour by ADR-024 (#93, 2.13.5), once `/rsct-setup` has refreshed the guard copy; for the PreToolUse guards, ADR-028 (#91, 2.15.0) replaces the edit guard's fail-open on an internal fault (its behaviour before 2.15.0) and supersedes "any other command carrying the marker is … left alone", and the named limits "a command the developer edited by hand is never rewritten" and "the dialog that mints it does not carry the warning line"
**Tags**: hooks, edit-scope, setup, install-drift, cross-os
**Context**: from 2.2.0 to 2.12.3 the installed `edit-scope-guard.js` never refused an edit. Three
causes, each MEASURED. (1) `src/scripts/edit-scope-guard.ts` imported one helper from
`src/scripts/sanitize-permissions.ts`; tsup (`splitting: false`) inlined that whole module, entry
block included, ahead of the guard's code, and inside the bundle `import.meta.url` is the guard's
own file — so the sanitizer's "am I the entry?" check was true, it ran and called `process.exit`.
(2) The registered command `node ${CLAUDE_PROJECT_DIR}/.rsct/scripts/<name>.js` is split by the
shell when the project path has a space; node exits 1, which the client does not treat as a refusal.
(3) A guard that did run would have been wrong: the matcher strips the project root by string
prefix, so a project typed in another letter case or reached through a link had its own files
refused; `src/../README.md` passed a `src/**` list; every path outside the project was refused,
the client's memory folder included; and `progress_<slug>.md` sat outside the declared list in 316
of 421 recorded code phases.
**Decision**:
- **Launchers.** `src/scripts/*.ts` only read their input, call one function from `src/lib/` and
  `process.exit` with its code. They export nothing and nothing imports them, pinned by
  `tests/unit/script-entries.test.ts` on the source and on the compiled files (one module banner
  each, no `process.argv[1]`, no `export` line). There is no "am I the entry?" check left (AD-008).
- **Quoted command.** Setup writes `node "${CLAUDE_PROJECT_DIR}/.rsct/scripts/<name>.js"` and
  rewrites only the exact unquoted command older setups wrote. Any other command carrying the
  marker is the developer's and is left alone.
- **One judgement, resolved paths.** `judgeEditScope` serves the hook and `rsct_check_edit_scope`.
  Order: stale context → no list → line terminator → network-style path on a different host →
  outside the project → plan-tracking file → the declared globs. Root and file go through `canonicalPath`
  (`..`, links, letter case, a tail that does not exist yet) before any comparison. A relative path
  is taken from the directory the client reports (`payload.cwd`) by the hook and from the project
  root by the tool. The hook judges `file_path` and `notebook_path` when both are present and
  refuses if either is refused.
- **The list is matched against the path below the project root, and nothing else.** MEASURED in
  REVIEW: the shared matcher also tries the absolute path, so with the project under a folder named
  `src` a list of `**/src/**` put every file in scope. An entry written as an absolute path
  therefore never matches (2 of 6,131 recorded entries were written that way).
- **Plan-tracking files** (`plan_*.md`, `progress_*.md`, `spec_*.md` at the project root) are
  `in_scope` while a list is active. Decided by the developer; less strict than the written rule.
- **Outside the project is not governed** (`unknown`, the edit goes through). Decided by the
  developer; less strict than the written rule, equal to what happened in the field. A path is
  INSIDE when it resolves under the project root, or when one of its parent folders is the
  project root under another spelling: a path that reads as outside is walked up folder by
  folder, and a folder with the file identity of the root makes it inside, judged by the list.
  MEASURED in REVIEW inside WSL with the project on the Windows disk: `realpath` leaves
  `/mnt/c/USERS/…` as typed, both spellings report one `dev:ino`, and the first used to pass as
  outside. Whatever is not shown to be inside is outside; a `stat` that fails, or an `ino` of 0,
  is no identity. An identity that collides by accident can only turn an allowed outside path
  into a judged one, never the reverse. On Windows the identity is the file number alone, and
  only between folders on the same drive root: MEASURED, `dev` from a path `stat` is 0 for a
  plain local folder and the volume serial for a junction to that very folder, and every NTFS
  drive root carries the same file number. A network-style path (`\\…`) on a different HOST than
  the project is refused, before the disk is asked about it, and again after resolution for a link
  or a mapped drive that lands on one. A different SHARE of the same host is not refused: MEASURED
  with the built hook, `path.win32.relative('\\host\shareA\p', '\\host\shareB\x')` is a relative
  `..\..\shareB\x`, so it reads as outside and is allowed — see the named limit below. On Windows
  a Git-Bash drive path (`/c/…`) is read as `C:\…`, which is what the client does with it before
  it writes.
- **An inert copy is enforcement not running.** `readScriptEvidence` reports `inert` for a file
  named `edit-scope-guard.js` whose normalised text has a line equal to `if (isCliEntry()) {`,
  checked before the shipped-copy comparison and whatever the registration. `isNotRunning` is true
  for it, so the security tier applies: notice, dialog line, one audit line per commit, push,
  merge or `rsct_load_context` call, dialog-free lane withheld. The commit dialog had never
  carried that line — only push and merge read it, while the rules said the dialog a suspended
  lane falls back to shows the warning; it carries it now.
- **The sanitizer runs at session start only.** It ran on every edit only through the defect.
  Decided by the developer; less strict on two points (a grant, or a machine path, that appears in
  the middle of a session waits for the next session start).
**Rejected**: keeping the entry check and comparing real paths (it can go silent again — AD-008);
`splitting: true` (changes the set of shipped files, which setup copies one by one); refusing
everything outside the project (refuses the client's memory folder and temp files in every phase
that declares a list); using file identity for a network path on another root as well (MEASURED
through `\\localhost\C$`: same `ino`, different `dev`, 400–520 ms per `stat` against 0.2–1 ms
locally — it is refused instead); supporting an absolute list entry by stripping the root from it
(two entries in the field; a second place where a spelling would have to be compared).
**Consequences**: every project installed before this change shows the security notice until
`/rsct-setup` runs again. A teammate on an older `rsct-mcp` who re-runs setup puts the inert copy
back. A hook that was already registered starts refusing the moment setup replaces the file.
Named limits:
- a phase with no `scope_globs` leaves nothing to enforce, and a `_start` replaces the list with
  no dialog; the terminal, PowerShell and MCP writers are not watched (#91);
- a rejected `.rsct.json` makes the project unmanaged, which switches the guard off — and each
  edit there now writes one `rsct_json.*` audit line, since the guard reads the config every time;
- plan-tracking files are read back by gates as evidence and stay agent-writable;
- **the stale flag outlives the server.** The guard is a standalone file and only
  `rsct_load_context` clears `context_stale`: where `rsct-mcp` is not connected, or was removed
  from the machine while the project kept its hooks, every edit is refused. The message tells the
  agent to stop and tell the developer; `docs/troubleshooting.md` has the two ways out;
- a command the developer edited by hand is never rewritten, so an unquoted one in a path with a
  space keeps exiting 1 and still reads as `registered` (the check is a marker substring);
- an entry the matcher cannot express never matches and says so only by refusing: `{a,b}`,
  `[abc]`, a leading `./`, a trailing `/`. None occurs in 6,131 recorded entries;
- an entry is compared, case-sensitively, with the resolved spelling — the on-disk one on Windows
  and macOS, the typed one inside WSL on `/mnt/c` (where `realpath` does not fold case): `src/**`
  never covers a folder stored as `Src`, nor `alias/**` a link named `alias` whose target is
  `real/`. The refusal names the path that was judged;
- the hook judges from the project root the client gives it (`CLAUDE_PROJECT_DIR`, else
  `payload.cwd`) without walking up, so pointed at a SUBFOLDER it governs only that subtree, while
  `rsct_check_edit_scope` walks up to the `.rsct.json` — the two then answer differently. Same as
  HEAD, and in the installed layout the hook is not registered in a subfolder;
- a folder that differs from the project folder only in letter case, in a directory Windows
  treats as case-sensitive, is judged as the project (the stricter way);
- a hard link outside the project to a file inside it is outside; making one needs a shell (#91);
- a batch token keeps authorizing commits while the lane is withheld, and the dialog that mints
  it does not carry the warning line;
- a worktree kept inside the project (`.claude/worktrees/…`) is judged by the main checkout's
  list when the client leaves `CLAUDE_PROJECT_DIR` there — not measured;
- `\\?\C:\…` typed for a file inside the project is refused as network-style; a project opened
  through a share of its own machine is not recognised when the file is typed by drive letter;
- a project opened through a network path, whose server exposes the same tree under a SECOND share
  name, has an in-project file reachable through that second share and judged as outside (allowed).
  The refusal only fires for a different HOST. MEASURED: the "allowed" verdict for a different
  share of the same host (built hook). NOT MEASURED: a server actually aliasing the project under
  two shares — it needs a share created with admin rights, so this stays a reasoned gap, in the
  same class as the hard-link and terminal holes (the guard is a soft ceiling, defeated by Bash —
  #91). Closing it would mean refusing every different-share path, which false-blocks a genuinely
  separate share of the same host; left as a limit rather than that.
macOS, Linux and the IDE extension were not measured with a real client; the compiled programs
run on the CI matrix, and by hand on Windows and in the three WSL combinations.

### ADR-023 — The dialog-free free-commit lane is removed (#80, 2.13.4)
**Status**: active. Supersedes the free-lane consequences of ADR-002 (the lane that
`trivial`/`small` tasks used), ADR-011 (the "free lane carries only reviewed bytes"
consequence) and ADR-022 (the "dialog-free lane withheld" install-drift consequence). Those
ADR bodies are left intact as the historical record; only their free-lane clauses no longer hold.

**Context**: plan-lifecycle-v2 Bloco 1 gave `trivial`/`small` tasks a dialog-free "free commit"
path — budget-capped and audit-anchored. MEASURED over 663 field commits: none used it (see
"Measured facts" below). It carried a whole subsystem — eligibility, a per-plan budget, a lock
latch, a health gate in front of it, and the install-drift suspension — for a privilege nobody took.

**Decision**: remove the lane. `rsct_request_commit` without a `dev_approval` now goes straight
to the batch plan token (`rsct_plan_authorize`); no token means a coherent
`plan_token_invalid` (`absent`) refusal. Removed: `evaluateFreeEligibility`, `reserveFreeBudget`,
`resolveFreeBudgetLimits` and the `free_commit.committed`/`free_commit.locked` ledger; the
`free_commit` channel / `authorized_via` / output field; the `free_commit_budget` phase-state
field; the `free_commit_max`/`_files`/`_lines` config keys.

**Kept**: the batch plan token is untouched (33 of 663 commits used it). `deriveAuditCeiling`
stays, trimmed to the tier ratchet and the review decision sets the ceremony evidence gate and
the REVIEW/dead-code gate read. The install-drift SECURITY NOTICE stays (it rides `hints[]` on
every outcome, advisory-only); only the lane-suspension consequence is gone. `rsct_audit` keeps
the mechanical-layer fault diagnostic under `mechanical_health` (torn phase-state / stale lock /
corrupt config, separated from the benign "no audit history yet"); the #101 "a fault is named a
fault" guarantee is preserved — `lib/health.ts` now backs that report instead of the lane.

**Consequences**: a project that set any `free_commit_max*` key is unaffected — `approval_modes`
is `.strip()` (ADR-005), so the keys drop silently. The test suite drops by exactly the removed
lane tests; no shared guarantee was lost (the no-dialog-on-review-refusal assertion moved to the
plan-token test).

### ADR-024 — A rejected `.rsct.json` is recorded once per hour, not once per call (#93, 2.13.5)
**Status**: active. Bounds the ADR-022 named limit "each edit there now writes one `rsct_json.*`
audit line", for guard copies that carry this change; the other half of that limit — a rejected
config switches the guard off — stands. Its decision "do not build a retention policy" is
superseded by ADR-025 (#93, 2.14.0): of its last named limit, the missing retention is closed
there and the whole-file scans remain; "lines the flood already wrote stay where they are" holds
only until the first cut, which keeps the newest of them; and "roughly for how long" now holds for
the last ten days only.
**Tags**: audit-log, config, growth

**Context**: `.rsct/audit.log` is kept out of git (`/rsct-setup` writes the ignore block) — there
is no git history to fall back on — and gates re-derive state from it. MEASURED on `main` after
#80, what reads the log by event name:
`classify.verdict` (as presence and as a MAX — the evidence gate and the tier ratchet);
`review.unverified_decision` / `review.dead_code_kept` / `review.public_api_approved` (the REVIEW
and commit gates); `settings.baseline` (newest only; a report, not a gate); `tutor.step` (a count,
for the step number); and `approval.consumed`, in one pass with two results, both after the skew
check — whether THIS approval was already consumed (one of two witnesses, store ∪ log, and it can
only matter while the approval's own timestamp is inside the skew tolerance, 60–600 s either
side), and whether ANY approval was ever consumed (no time limit; it tells a deleted store from a
fresh project). `lib/health.ts` reads only whether the file is non-empty. One writer fired on
nearly every tool call and on every edit, whatever the call did: `emitConfigViolation` appended an
`rsct_json.malformed` / `rsct_json.bounds_violation` line each time `resolveProjectRoot` met a
rejected `.rsct.json` — in the server, and in the edit-scope guard, which is a fresh process per
edit. Nothing reads that class by name.

**Decision**: bound that writer, do not build a retention policy. The same violation is written
to the log once per hour instead of once per call. Before appending, `emitConfigViolation` reads
the last 64 KB of the log it is about to write to; if any line there is the same entry (everything
but `ts`) with a stamp between one hour ago and now, it appends nothing. Nothing else changes: the
entry carries every failure in full, as before, and the stderr warning still prints on every
rejected load. The check lives in `emitConfigViolation`, not in `appendAuditEntry`, so no other
writer is gated.

**Direction**: for the audit trail this is more permissive than before, in two ways, and was
decided by the maintainer (bound the noise; the hourly window over the last-line check). There are
fewer lines; and the write, unconditional before, now depends on what the log already holds — a
file a same-user process can write (see the planted-line limit below). Firm premise #1 still
holds in this form: after every rejected load the log holds this exact entry with a stamp from the
last hour — appended now, or already there — unless the append itself failed, as before. For every
gate the change is neutral, since none reads the class. The stderr warning is unchanged.

**Alternatives considered**:
- A memo in process memory — rejected: the edit-scope guard is a new process per edit.
- Comparing against the last line only — built first, rejected in REVIEW. MEASURED by simulation,
  1080 calls over 3 hours: 1 line for one violation, but 1080 lines — no bound at all — when two
  violations alternate. That happens with two rejected configs in one repository (the log is one
  per repository) or with a server and a hook on different Node versions (the `malformed` entry
  embeds the engine's parse message). It also kept only the time of the FIRST rejection, and a
  config repaired and then broken the same way left no trace. The hourly window gives 3 and 6
  lines for the same two runs.
- Deduplicating the stderr warning along with the line — built second, rejected in REVIEW: it made
  a warning that nothing could suppress depend on a file a same-user process can write.
- Bounding the entry (the first 10 failures, messages cut at 600 characters) so that it always
  fits in the tail — built third, rejected in REVIEW: zod reports failures in schema order
  (MEASURED, zod 3.25.76), and `approval_modes` and `audit` sit after twelve other keys, so ten
  harmless failures placed first would have pushed the dangerous ones out of the record. The price
  of not bounding it is the oversized-entry limit below.
- Reading the whole log to find the entry — rejected: it would run on nearly every tool call and
  every edit while the config is rejected, on exactly the logs the flood had bloated (see "Measured
  facts": a full scan costs 87.5 ms at 50k lines).
- Compaction or rotation carrying derived state forward — not attempted: an entry carries a
  free-form `event` name and nothing that declares whether a reader depends on it.
- A sidecar marker file — rejected: a second managed file to ignore, migrate and clean up.

**Consequences**: while something keeps calling the loader, a config that stays rejected leaves
about one line per hour instead of one per call. The log still shows that the config was rejected
and roughly for how long — to the hour, not to the call: the last line can precede the last
rejected load by up to an hour, a first line is missing when an identical one was written in the
hour before, and the number of calls or edits made in that state is no longer in the log. Nor do
two lines an hour apart prove the config stayed rejected in between: a repair and an identical
break inside the hour leave the same two lines. The resolution is stated because that state
switches the edit-scope guard off (ADR-022).

A log that cannot be read — absent, or unreadable — falls back to the append, so a read error
never suppresses the record; lines that are not entries, or carry no usable stamp, are skipped. A
directory sitting where the log should be does not throw, by two routes (MEASURED, Node 22, NTFS
and ext4): Windows opens it and reports size 0, so nothing is read; Linux reports 4096 and the
read throws `EISDIR`, which is caught. When the append itself fails — a directory there, a
read-only tree — nothing is recorded, exactly as before this change.

Projects already set up get the guard half only when `/rsct-setup` runs again: the guard is a
copy inside each project (ADR-013, ADR-022), and a copy installed before this release keeps
writing one line per edit. The server half applies as soon as `rsct-mcp` is updated. The notice
that names a stale copy (`install_drift`) is computed only while the config is valid; while it is
rejected, `rsct_status` and `rsct_load_context` suggest `/rsct-setup` as they do for an unmanaged
project, and no tool names the stale guard. A `/rsct-setup` run from an older `rsct-mcp` puts the
old copy back (`docs/troubleshooting.md`).

Named limits:
- within the hour a repeat adds no line: a config repaired and broken again the same way, or a
  new session on a still-rejected config;
- each DISTINCT violation gets its own line, so a config rewritten to fail differently on every
  load still writes on every load. This bounds an accident, not a process that keeps changing the
  file — which could write the log directly anyway (ADR-011);
- a `.rsct.json` that cannot be read at all returns before this writer: no warning and no line,
  before this change or after it;
- an entry must fit whole in the 64 KB tail to be found. One that is larger — MEASURED (zod
  3.25.76) at 100 KB for a single 100,000-character value, because the message repeats it — is
  appended on every call, as before; and more than 64 KB written by other events inside the hour
  lets one more line through;
- an identical line planted in the log with a stamp from the last hour suppresses the real one
  until that hour passes, and one planted with a future stamp does the same once the clock reaches
  it, so a row of them can cover the hours ahead. A same-user process could already rewrite the
  file (ADR-011), and the stderr warning does not depend on the log;
- the hour runs from the stored stamp to the reader's clock: a clock set back makes a recent line
  look future, and one more line goes through;
- the entry carries no root and the log is one per repository, so the same violation in two
  packages, or two linked worktrees, of one repository is recorded once per hour, not once each;
- two values that fail the same key with the same message serialize alike and count as one
  violation (`validation_errors` carries path, code and message, not the value), and so do two
  malformed files that draw the same parse message;
- the entry always goes to the default `.rsct/audit.log`, never to a configured `audit.path`: a
  rejected config is not trusted for where to write, before this change or after it;
- two processes that read before either writes both append (no lock); bounded by the burst;
- lines the flood already wrote stay where they are;
- entries written by real work still accumulate with no retention, and every commit still scans
  the whole file. That is growth proportional to use, left as it was — #93 stays open for it.

### ADR-025 — The audit log keeps ten days of routine history; what gates read and bypass records stay (#93, 2.14.0)
**Status**: active. Supersedes ADR-024's decision "do not build a retention policy". Closes #93. Since 2.17.0 (ADR-030) `plan_authorize.authorized` and `plan_revoke.revoked` are pinned too: the commit gate reads them to decide whether a batch token counts. Since 2.18.0 (ADR-031) an `audit.path` that names a stream is ignored when the path is decided, so the named limit "Only retention refuses such a path; the log is still written there" no longer holds: the log is written to the default path, and retention still cuts nothing while the config names a stream. Since 2.19.0 (ADR-032) a Claude Code inside WSL can be installed with `--wsl`, so the named limit "That combination has no supported install today (#110)" no longer holds: a project on `/mnt/c` is reachable from such an install, and its log is still never cut there.
**Tags**: audit-log, retention, growth, cross-os

**Context**: `.rsct/audit.log` is the only copy of what it holds and had no bound. MEASURED on 19
real logs from one machine (2026-10-10; that machine still ran 2.12.3, so the per-edit
`settings.baseline` fixed in 2.13.0 was still being written): 9.38 MB and 33,072 lines in all;
`settings.baseline` about a third of the lines; the `rsct_json.*` class ADR-024 bounded, 3 lines;
the largest log 3.4 MB and 12k lines, 46.5 ms for one whole read and parse (real entries are
several times longer than the synthetic ones timed under "Measured facts") — and an approved commit
reads the whole file several times (`tools/request-commit.ts`: the baseline, the ceiling at each
sweep and dead-code check, and `consumedInAudit`). Growth on an updated install was not measured.
Six readers consulted the log before this change, and nothing else in `src` compared an `event`
(the cut itself now reads two: its own `audit.pruned` marker and `settings.baseline`):
`deriveAuditCeiling` (`classify.verdict` as presence, and the three `review.*` decision sets),
`readBaselineFromLog` (the LAST `settings.baseline` in file order with a non-empty
`hash`), `countPriorSteps` (`tutor.step` per `spec_ref`), `consumedInAudit` (`approval.consumed`:
this approval, reachable only inside the 60–600 s skew, and "any ever"), `evaluateMcpHealth`
(size), and the hourly check of ADR-024 (last 64 KB). ADR-024's Context calls the MAX over
`classify.verdict` a tier ratchet; MEASURED, no gate reads it — it reaches one output field, and
the downgrade guard reads phase-state. One human reader is documented: `docs/troubleshooting.md`
sends the developer to a `review.commit_drift` entry before deleting a corrupt phase-state. The
maintainer decided the direction: delete what is older than ten days, from the top of the file
down, keeping fixed the entries the gates read and the records of an overridden rule.

**Decision**: a commit that LANDED cuts the log (`lib/audit-retention.ts`, called from
`rsct_request_commit` after the commit, on either authorization path, when the project is
managed). A refused, declined or unapproved call removes nothing. The hints of the call report
every cut, and an `audit.pruned` entry records it.

The approval dialog — the channel an agent cannot summarise away (the #25 precedent) — carries a
forecast, "N lines older than 10 days are due for removal with this commit", only when the cut
reaches an entry more than twenty days old: the first cut after an upgrade, or after weeks without
a commit, not the daily one. With two logs, only one that goes back that far is counted. It is a
forecast: counted before the approval is validated and the commit is made, while the cut reads
the log again. Nobody sees it on a commit under a plan token, or on an approval trusted
with no dialog channel (`trust_allowed_for`) — no dialog is shown there, and the hint and the entry
are all there is. Before it forecasts, once per server process and log, the call tries the hard
link the cut needs — it takes the lock, links, unlinks and releases — so the dialog does not
promise a cut the volume cannot do; an attempt that fails for any other reason forecasts nothing
and is made again on the next such call. That attempt is the only thing retention does to the
project's files on a call that ends up refused, and it leaves none behind; a call rejected at the
validation of its approval has read the log as well.

The scan goes from the top. An entry that cannot be parsed, is not an object, has no string
`event`, or whose `ts` is not a strict `YYYY-MM-DDTHH:MM:SS(.sss)Z` is kept and the scan goes on.
The first entry stamped within the last ten days — or in the future — stops it: that entry and
everything below stay untouched and are not scanned (only the last `audit.pruned` entry is looked
up, for the running total). Above the stop, an entry older than ten days is:
- **kept if it is the last of its kind** above the stop, when its event is a repeating state
  record: `settings.baseline` (only one the reader accepts — that reader uses the last one and
  nothing else), `rsct_json.malformed`, `rsct_json.bounds_violation`, `install.drift_detected`,
  `sanitize.malformed`, `sanitize.migration_skipped`, `settings.drift_detected`, `audit.pruned`.
  This list is consulted first, so `sanitize.migration_skipped` is newest-only although its name
  contains `skip`;
- **kept**, every one, when its event is pinned: `classify.verdict`, `review.unverified_decision`,
  `review.dead_code_kept`, `review.public_api_approved`, `review.commit_drift`,
  `approval.consumed`, `tutor.step`, `free_commit.committed` and `free_commit.locked` (servers up
  to 2.13.3 read them), `sanitize.stripped`, `audit_log.migrated`, and any other event whose name
  contains `override`, `skip`, `degraded` or `bypass`. `approval.consumed` was newest-only in the
  first build — its reader gave the same answers in the equivalence test either way — and was
  pinned in REVIEW: it is an entry a gate reads, and the decision was to keep those;
- **dropped** otherwise — phase starts and completions, findings, commits, pushes, merges,
  plan authorizations, bootstrap warnings, and refusals.

A cut is due only when something droppable is more than eleven days old, so there is about one a
day and a log with nothing old is never written to. Kept entries are never re-serialised: the file
is handled as bytes split at `0x0A`, and order is preserved. Both the configured log and the default
one are cut when they differ, since `rsct_json.*` always goes to the default one. Each cut appends
`audit.pruned` — `dropped`, `kept`, `cutoff`, `source_bytes`, `dropped_total`, `first_cut_at`, `cut`.
There is no config key.

The swap, under `audit-prune.lock` in `<anchor>/.rsct/reports/` — the lock holds the log's path and
a cut id: hard-link the log to `audit-prune-old.log`; read it again and write the survivors to
`audit-prune-new.log` through one descriptor, with the log's mode, never copying bytes past the
last newline; copy what was appended meanwhile (five rounds at most, else give up as busy); append
the `audit.pruned` entry, which carries the cut id and, as `source_bytes`, the offset copied so far;
`fsync`; check that the lock still carries this cut's id — give up as busy if it does not, so a
cut that took long is not swapped under a lock someone else already cleared — and renew its time;
rename the new file over the log; then read the linked old file past that offset and append what
is there to the log, look again after 20 ms, until it stops growing (two looks at least, five at
most, on every platform); unlink. Before the rename a failure removes what this call created — if
the lock still carries its id — and leaves the log untouched. After it, the link and the lock
stay, and a later call, once the lock is a minute old, finishes the job: it rescues from
`source_bytes` only when the newest `audit.pruned` entry carries the lock's cut id, and simply
unlinks when the two names are still one file. If the rescue had completed and only the unlink
failed, the lock goes and the link stays, so the later call unlinks without rescuing twice. A lock
stamped within a minute of the clock, on either side, is a cut in progress. A call that repairs
never cuts.

The hints say so, on every commit where it happens: a cut; an interrupted cut that was finished or
undone; a log over 512 MB; a log path that is not a regular file; an `audit.path` that names one
of the working files or, on Windows, a stream inside a file (nothing is cut then); a session in
which git could not report the repository; a cut that failed, or threw. For a volume without hard
links, and for a 9p share, they say it once per server process and log, which then stops trying. They say nothing when nothing is due, when
another cut holds the lock or took it over, or the log would not settle (busy — a later commit
cuts), and when the project is not managed, a rejected `.rsct.json` included.

**Direction**: neutral for every gate — each event a reader consults is pinned or kept as that
reader needs it. One test compares the ceiling, the baseline, both approval results and the health
verdict before and after a cut that dropped lines, then runs the tutor's own counter; the hourly
check reads the last hour only. A static test fails when `src` compares an `event` to a name the
rule would drop. Firm premise #3 is untouched: `classify.verdict` is pinned.

More permissive for the audit trail, decided by the maintainer: routine history, refusals
included, is gone after ten days, and it was the only copy. Keeping the bypass-shaped names,
`review.commit_drift`, the `free_commit.*` pair and the newest of each state record goes beyond what
was asked, in the stricter direction — and is still less than `main` kept: once ten days have
passed, the log shows THAT a config was rejected, or that enforcement was not running, and when it
last was, not for how long. ADR-024's "roughly for how long" holds for ten days. Firm premise #1
now reads: the newest entry of each `rsct_json.*` event is always in the log, and every one from
the last ten days. A commit from the project whose config is rejected cuts nothing; another
project that shares the repository's log still can. Firm premise #2 is untouched.

**Alternatives considered**:
- Cutting every entry by age — rejected: it drops what the readers above consult.
- Judging each entry wherever it sits — rejected for the top-down form the maintainer described:
  a back-dated entry below a recent one is kept, and nothing below the stop is scanned.
- Cutting at the top of the call, before the gates — built first, rejected in REVIEW: a refused or
  unapproved call deleted history, and the dialog of a call refused early never showed it.
- A forecast line in every approval dialog — built next, narrowed in REVIEW to the cut that reaches
  entries more than twenty days old: a line that shows up on the first commit of every day teaches
  the reader to skip the dialog, and the dialog is the channel the gates depend on. The threshold
  is one constant (`ANNOUNCE_MS`).
- A forecast that only reads the log — built with it; on a volume without hard links it promised
  a cut that never came. The one-off link attempt replaced it.
- Deciding up front, by file identity (same device and inode), that "the log sits on a working
  file" — built in REVIEW and dropped: while a cut runs, the old-file name IS the log, so a second
  process took a cut in progress for a misconfigured path. Adding "and the file has a single name"
  did not save it — the two looks are not one instant — and neither did comparing resolved paths
  with the operating system's resolver (`realpathSync.native`): MEASURED in the stress run on
  NTFS, one to three calls in about 1,400 still reported a misplaced log. The cause was not
  isolated; HYPOTHESIS: Windows names a file by its open handle, so a file opened just before a
  rename answers with the name it was renamed to. What shipped is two plain checks. Up front, the
  spelling: the same path, or the same ignoring case on Windows and macOS. And whenever a working
  file exists, before a cut or a repair goes on: a refusal when that file and a log are one file
  with a single name — looked at before and after the comparison, because the new file does
  become the log at the rename. MEASURED: a version that looked once reported a misplaced log in
  one call of about 1,400, on NTFS and on ext4; the final module, in none of about 8,800 calls
  on NTFS and 7,200 on ext4.
- Read, write a temp, rename — built in a prototype and MEASURED (four writers at about 600
  lines a second each, a rewrite every millisecond, Node 22.14): 5,042 of 10,000 lines lost on
  NTFS, 7,312 lost and 8 torn on ext4.
- The same, copying over what arrived before the rename — MEASURED: 35–45 lines lost per ~500
  rewrites on NTFS, 10–12 per ~340 on ext4. The gap between the last size check and the rename is
  real.
- Keeping a handle on the old file — works on Linux; on Windows `renameSync` over a target any
  process holds open is `EPERM` (MEASURED, Node 22.14, libuv 1.49.2). The hard link gives the old
  file a second name instead, the same code on every platform.
- A lock every writer takes — rejected: installed hook copies of older versions cannot be changed.
- A marker in the tail to limit scans to one a day — replaced: a busy log pushes any marker out of
  a tail, and existing logs would all gain a line. The eleven-day threshold needs no state.
- Cutting in the SessionStart sanitizer, or inside `appendAuditEntry` — rejected: the keep rule
  would live in a per-project copy that goes stale against a newer server's readers, and every
  project would need `/rsct-setup`.
- Truncating by size — rejected: noise would push evidence out; age cannot be flooded.
- Rotating to a second file, or working files beside the log — rejected: a new name under `.rsct/`
  needs an ignore line, a backfill and uninstall handling; `.rsct/reports/` already has the first
  two. Names ending in `.log` and `.lock` are also ones the REVIEW sweep never takes for code.
- A config key — rejected: `audit` is `.strict()`, so every older server would reject the whole
  config, and `.rsct.json` is a file an agent can edit.

**Consequences**: the first commit that lands after an upgrade does the first cut, which can remove
months at once; its hints — and its dialog, in a log that goes back more than twenty days —
`CHANGELOG.md` and `docs/troubleshooting.md` say so. Nothing changes until `rsct-mcp` is updated,
and nothing needs `/rsct-setup` — the cut is server-side and the hook copies are untouched.
Simulated on the 19 logs with the shipped planning function (2026-10-11): 9.38 MB → 2.78 MB,
22,881 of 33,072 lines dropped in 17 logs, two with nothing due; 2,399 pinned lines (661 KB) kept
above the stop — 809 of them `approval.consumed`, 1,112 the `override_invoked` events of commit,
push and merge — and 16 newest-only ones; no entry without a usable stamp, no old entry below a
recent one. `/rsct-uninstall` removes the three working files. `README.md`,
`mcp-server/README.md`, `rules/C-reauthorize.md` and `SECURITY.md` no longer describe the log as
unbounded history.

MEASURED on the shipped module (2026-10-11, Node 22.14; two processes that forecast and then cut,
three writers of pinned lines and one of routine lines at about one line a millisecond each, and a
clock advanced so that every call could cut): NTFS, 884 cuts in three runs, 0 lines lost,
duplicated or torn, 13–18 cuts per run abandoned cleanly on `EPERM`; ext4, everything inside WSL,
245 cuts in five runs, 0 lost — those with one more process reading the whole log in a loop:
254,032 looks, never missing, empty or unreadable; 100 KB lines, 0 lost or torn on both; no
working file left after any run, and none visible to `git status` under the installed ignore
block. The same reader on NTFS — 50,429 looks, same answer — holds the log open and turns most
swaps into `EPERM`: 130 cuts in three runs, 669 abandoned, still 0 lost. In an earlier run of the
same harness one call failed creating the working folder while the other process was removing
it, and said so. Linux Node with the files on `/mnt/c`, before the refusal that now stops it: the
swap is not atomic there — see the named limit — and the shipped module does not cut. Windows
Node with
the files under `//wsl.localhost/`: `linkSync` is `ENOTSUP`, the forecast says nothing, each
process reports the volume once and does not try again, and nothing is cut. Cuts per run vary
with the load on the machine: while one process holds the lock — an `fsync` and a 20 ms look-back
at least — the other is busy. The same harness caught defects that reading had not: a lock
created in the current millisecond read as older than the clock and was torn down by the second
process; and, twice in different builds, a cut in progress was taken for a log placed on a
working file (see the alternatives).

Named limits:
- no cut on a volume without hard links — MEASURED on `//wsl.localhost/` from Windows, the one WSL
  combination the installer reaches — and none for a log that sits on another volume than
  `<anchor>/.rsct/reports/` (`EXDEV`, expected, not measured). FAT and exFAT have no hard links
  either; not measured, and the code the link answers with decides how it is told: one of the
  listed codes, the volume is reported once; any other — libuv's table suggests `EISDIR` on
  Windows — every commit reports a cut that failed and says a later one retries, which it does,
  to fail the same way. None for a log over 512 MB or a path that is not a regular file, a symbolic link
  included, none when git cannot report the repository, and none from a project whose
  `.rsct.json` is rejected. The log keeps growing there;
- a project that never lands a commit through `rsct_request_commit` is never cut;
- no cut on a 9p share — a Windows disk reached from inside WSL (`/mnt/c`) is one — because
  replacing a file is not atomic there. MEASURED with the stress harness before that refusal, in
  six runs: twice a reader found no log (2 of 362 looks, 1 of 406), and in one run 3 of 900 lines
  written by other processes were lost. On Linux the cut asks the volume for its type and stops
  at 9p (`0x01021997`; MEASURED: ext4 answers `0xef53`); the hints say so once per server
  process and log, and the log keeps growing. Other volumes where a rename is not atomic are
  not recognised. That combination has no supported install today (#110);
- the dialog forecast covers only a cut that reaches entries more than twenty days old, and only
  where a dialog is shown: the daily cut, a commit under a plan token and an approval trusted with
  no dialog channel are reported in the hints and the `audit.pruned` entry alone — text the agent
  relays;
- a writer stalled between its open and its write for longer than the look-back, across the swap,
  loses that line — any entry, a pinned one included; for `approval.consumed` the store is the
  other witness;
- recovery is not serialised: two calls repairing at once may append the rescued lines twice. A
  call killed between the rename and the look-back is finished later and may do the same. With an
  unreadable lock, or a newest `audit.pruned` entry from another cut, nothing is rescued — and
  nothing either when the lock names a log the repairing call does not use: in a repository where
  one package moved its log (`audit.path`), a commit from another package undoes that package's
  interrupted cut and drops what had reached the old file after the copy;
- the only proof that a cut died is a lock a minute old, or working files with no lock beside
  them. The lock is renewed once, right before
  the swap, so a cut that takes longer than a minute — hundreds of megabytes on a slow volume — is
  abandoned as busy when another call clears it meanwhile, and the log stays as it was. What
  remains is a window of milliseconds around the rename in which a repair that had already judged
  the lock dead can lose or double the lines that arrived during it, and a volume whose file times
  run a minute off the machine's clock, where a live lock reads as dead (not measured);
- a cut that keeps failing — a log another program holds open on Windows, a full disk during a
  repair — leaves the log uncut and says so in the hints of every commit. A lock file that cannot
  be deleted blocks every cut: each commit reports an interrupted cut and none follows;
- the working files are ignored only where the block lists `.rsct/reports/` (set up or re-set-up
  since 2.11) and the anchor is the project root; in a relocated project (#82) they sit at the
  repository root, where the block and `/rsct-uninstall` do not follow. An interrupted cut leaves
  them there until a commit lands once the lock is a minute old;
- pinned entries are bounded by use, not by construction: `approval.consumed` adds one line per
  approved action for good, and `tutor.step`, `verification.skip` and `classify.verdict` are
  written by calls no dialog gates;
- the cut compares `ts` with the pruner's clock: a clock set forward deletes more — the routine
  history of the last days included — and an idle project cannot be told from a clock that
  jumped; a future-stamped entry at the top blocks every cut, silently, as a planted line could
  (ADR-011);
- the `audit.pruned` entry is a line like any other: a log trimmed by hand cannot be told from a
  cut one, and `dropped_total` is what earlier entries said, not something the cut can check
  (ADR-011);
- the oversized-entry flood of ADR-024 is written only while the config is rejected, when that
  project cuts nothing; a log it pushed past 512 MB is not cut afterwards either;
- every commit still reads the whole — now small — log several times; the forecast adds one read
  to every call that carries an approval and reaches the dialog step, shown or not, and the cut
  one to every commit that lands, two when it cuts;
- the legacy log of a relocated project and `approvals-seen.json` are not cut;
- a kept entry can point at a dropped one — an `approval.consumed` whose
  `request_commit.committed` is gone, an override record whose push is gone;
- an unterminated last line is carried over with a newline added;
- a log with two names (a hard link) is cut once per name the project uses, each as its own file;
- an `audit.path` spelled like a working file — or like one ignoring case, on Windows and macOS —
  is refused up front. Reached another way — through a junction or a symbolic link to the folder,
  tested; an 8.3 short name, or another case on a volume Linux reaches case-blind, not measured —
  it is refused once the file exists, before a cut or a repair touches anything: a working file
  that is a log's only name is never deleted. MEASURED on Windows before that check: the log was
  deleted and the call reported a repair. It protects the project whose config names the file,
  and only where the volume reports a file identity: a commit from a project with another config
  — another package of the repository, or the same project once its `audit.path` is changed back
  — and `/rsct-uninstall` see a leftover and remove it. macOS runs these tests in CI only;
- on Windows an `audit.path` with a colon after the drive names a stream inside a file, and no
  log is cut while it does. MEASURED before that refusal, with `audit.path: .rsct/audit.log:x`:
  cutting the default log replaced the file, the stream that held the configured log went with
  the old one, and the call reported an ordinary cut. Only retention refuses such a path; the
  log is still written there. The resource fork of a file on macOS was not measured;
- a cut replaces the file. Its bytes and, outside Windows, its mode are carried over; anything
  else the old file held — an NTFS stream, extended attributes, permissions set on it by hand —
  is not. So the refusal above lasts only while the config names the stream: entries written to
  `audit.log:x` are gone at the first cut after `audit.path` is changed back, as they would be
  had the file been deleted (ADR-011);
- a default log that `audit.path` reaches through another folder name, or through a symbolic
  link in either direction, is one log, cut under whichever of the two names is the regular
  file, where the volume reports a file identity; elsewhere it counts as two, the second pass
  finds nothing due and the dialog forecast counts its lines twice. Those identities are taken
  to be unique; a volume that does not guarantee it (ReFS, by its documentation — not measured)
  could see a normal cut refused. On a case-sensitive folder of Windows or volume of macOS, a
  path that differs from the default only by case is another file and is taken for the same
  one: only one of the two is cut. A repair looks for the log a lock names by spelling, among both
  names, so a lock written under a third spelling of the same path is undone without a rescue;
- the hints report a cut that completed. One interrupted after the swap — the lines are gone,
  the rescue or the unlink failed — is reported as a cut that did not complete, and the repair
  that follows as an interrupted cut finished: its count is in the `audit.pruned` entry alone;
- the static test matches `event ===` / `!==` against a literal or an upper-case constant, and
  accepts newest-only as known: a reader of another shape, or one that needs every entry of a
  newest-only event, must be added to the rule by hand;
- the stress runs covered NTFS and ext4 on Node 22.14; macOS is covered by the deterministic tests
  in CI only, and the field logs came from a machine that had not been updated.

### ADR-026 — The companion is not published to a package registry (#112, 2.14.0)
**Status**: active. The decision #112 asked for; ADR-021 and AD-007 stand. The line "a Claude Code
that runs inside WSL still has no supported install (#110)" is superseded by ADR-032 (2.19.0).
**Tags**: install, supply-chain, npm

**Context**: a user gets the companion only through `scripts/install.sh`, run from a source tree
(ADR-021); a contributor can also link a working tree (`CONTRIBUTING.md`). #112 asked whether to
publish it. MEASURED 2026-10-10 (npm 11.1.0, registry `https://registry.npmjs.org/`):
`npm view rsct-mcp name version` answers `E404` — the unscoped name is unregistered. A mirror
configured in `npmrc` would answer the same; the error names the default registry. npm's policy,
re-read the same day (<https://docs.npmjs.com/policies/disputes>): "It is against npm's Terms of
Use to publish a package, register a username or an organization name simply for the purposes of
reserving it for future use", and "Package names are considered squatted if the package has no
genuine function". So the name cannot be held with a placeholder; only the real server could be
published.

**Decision**: not published — not under the unscoped name, a scope, or GitHub Packages. The
installer is the only channel for a user. The reasons, each verified in the repository:
- a registry install would deliver the server alone (`files` is `dist`, `grammars`, `README.md`,
  `LICENSE`); the prompts, rules, templates and slash commands come only from the installer. The
  result looks installed and then tells the user to run a `/rsct-setup` that machine does not have;
- a registry install is a copy in npm's tree, replaced by name on `npm update -g` (AD-007), so
  every release would have to be published — and there is no release automation: CI runs on push
  and pull request only, and releases have come several a week;
- it adds a credential to protect and a second trust root: today the only way code reaches a
  machine is a `git pull` plus the installer, and an npm account would be a push channel to every
  registry install at once;
- no request for a registry install is on record (REPORTED: the issue list on the decision date).

**Direction**: neutral for every gate.

**What is given up, by name**:
- the unscoped name stays unregistered. If someone else ever registers it, publishing under this
  name is no longer an option: the fallback is a scope, or renaming a command written in about
  400 lines of about 50 tracked files (lockfile and bundle excluded) and in files projects commit;
- a package of that name on the registry would not be this project's. `SECURITY.md` says so, says
  not to install it, and asks for a private report. A link is not replaced on `npm update -g`
  (MEASURED on npm 10.9.2 and 11.1.0 only); an explicit registry install over the link was not
  measured;
- a Claude Code that runs inside WSL still has no supported install (#110).

**Alternatives considered**:
- Publish on every release — the only option that puts the name in the project's hands. Rejected
  for the reasons above.
- Publish under a scope — the same cost plus a rename, and it does nothing for the unscoped name.
- Publish the real package once, then deprecate it — reservation in purpose, an ageing enforcement
  binary frozen under the project's name, and an account that can publish as the project.
- A placeholder, or a pointer package on the unscoped name — forbidden by the policy quoted.
- A tarball on each GitHub Release, installed by URL — the shape AD-007 measured with a local
  tarball: a real folder in npm's tree, resolved by name. The URL form itself was not measured.
- A `postinstall` that makes the package whole — the package must install and build nothing when
  npm links it (pinned in `tests/bash/script-install.test.ts`), and npm lets a user skip install
  scripts.
- `"private": true` — not a rival: by npm's documentation it stops a publish by the project and
  nothing else. Left out of this change because it alters the package the installer links, and
  that needs the installer's install, update and uninstall proof; its effect was not measured.

**Consequences**: `README.md` says in the install section where the companion comes from.
`SECURITY.md` narrows its immunity sentence to the case that was measured and points here. The
contributor command in `README.md` and `CONTRIBUTING.md` carries `--install-links=false` — without
it a user config, or npm 9.0.0–9.4.1, copies instead of linking (ADR-021). The test #112 cited pins
`npm install -g .` on four pages, not the registry form; `tests/unit/no-registry-install.test.ts`
now fails on a line that installs the name from a registry or runs it through a package runner
(the npm, pnpm, yarn and bun forms) — in the docs, prompts, rules, templates, scripts, workflows,
`CHANGELOG.md` and the server's source — on a `SECURITY.md` that stops saying where the companion
comes from, and on a `publishConfig`, or a publish step in a workflow or a package script. It is
a lint over the project's own pages, not a proof: it reads shell text one line at a time and JSON
server entries one object at a time, and it also fails on a warning that quotes the command.

Reopen this decision when: the name is found registered; a release workflow exists, so publishing
costs one step; someone outside the project asks for a registry install; the package becomes
self-sufficient or the install channel is redesigned (#110); the project opens an npm account for
any other reason; and at 3.0.0 at the latest.

Not measured: the two channels on one machine, a registry install over a link, the effect of
`"private": true`, and anything on macOS, pnpm, yarn or bun.

### ADR-027 — The approval dialog gets its text as data, runs by full path, and has no test override (2.14.1)
**Status**: active. Since 2.17.0 (ADR-030) the named limit "a dialog program that starts and then fails, or is stopped, still counts as no channel, so where the tool is listed in `trust_allowed_for` the call is trusted" no longer holds for commit, push, merge, rebase and `rsct_plan_authorize`, which always force the dialog. Since 2.18.0 (ADR-031) the given-up item "agent text is shown as written, in some dialogs before framework lines" no longer holds: every dialog shows the framework lines first and the agent text last, on one line per value; text that imitates framework lines is still not addressed. Since 2.20.1 (ADR-034) the first limit no longer holds for any tool: a dialog that starts and ends without a Yes or No is refused as `dialog_failed`, and only a missing dialog program, a system with no supported dialog program or a Windows session with no desktop is no channel.
**Tags**: security, dialog, cross-os

**Context**: every approval the framework treats as human goes through `lib/os-dialog.ts`
(INV-2.1). Up to 2.14.0 the dialog's title and text — which carry values the agent writes: a commit
message, a branch name, a spec ref, a reason — were part of the script that showed the dialog on
Windows and macOS. MEASURED 2026-10-16 (Windows 11, Windows PowerShell 5.1): a typographic
apostrophe, as in ordinary prose, stopped the dialog from opening. The module also honoured `RSCT_TEST_DIALOG_RESPONSE`,
which answered every dialog without showing one when set in the server's environment; only the
module's own tests used it. The dialog programs ran by bare name, and a `no-channel` result fell to
`trust_allowed_for` whatever caused it.

**Decision**:
- Windows and macOS run a constant script. The title and text travel in `RSCT_DIALOG_MESSAGE` and
  `RSCT_DIALOG_TITLE`, set for the dialog process only and read as data — `$env:` in PowerShell,
  `NSProcessInfo` in JavaScript for Automation (`osascript -l JavaScript`). The arguments are
  byte-identical for any text. Linux passes the text as zenity's own `--text=` argument (argv, no
  shell) with `--no-markup`.
- The programs run by full path: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
  (`C:\Windows` when `SystemRoot` is missing or relative), `/usr/bin/osascript`, `/usr/bin/zenity`.
- Before any platform: U+0000 becomes U+2400, and a title plus text over 32,000 UTF-16 units
  returns `no-channel` with `input_fault`. `gateRequest` refuses it before anything else, forced
  dialog or not, without consulting `trust_allowed_for` (`reject_kind: no_channel`, the reason gives
  the length and says to shorten the text); the REVIEW's unverified-files question treats it as
  undecided.
- `RSCT_TEST_DIALOG_RESPONSE`, the `env` seam of `promptYesNo` and the `env-override` channel are
  removed. Tests inject `promptFn` or `executor`.

**Direction**: stricter. No text an agent writes reaches the dialog program as code; a program of
the same name earlier on `PATH` is not run; an input the dialog cannot show is refused instead of
trusted; nothing answers a dialog without one.

**Alternatives considered**:
- Escape more characters — the text would still be part of the script.
- Base64 inside the script — MEASURED verbatim for 11 of 11 texts on Windows, but the text grows
  (4/3 for ASCII, 4 characters per CJK character, so about 8,000 CJK characters would pass the
  command-line limit) and it does not cover macOS.
- Arguments to `osascript` after the script — a text starting with `-` may be read as an option
  (not measured, no Mac here); the environment makes the question moot.
- Keep the override behind a test flag — whoever can set the variable can set the flag.

**What is given up, by name**:
- whoever controls the server's environment or files (`.mcp.json` `env`, `NODE_OPTIONS`, `PATH`,
  `SystemRoot`, the installed `dist/`) controls the server. Removing the override is defence in
  depth, not a closed path;
- a `zenity` outside `/usr/bin` is not used: no dialog, so the request is refused, or trusted where
  the tool is listed;
- text that imitates framework lines, and bidirectional control characters, are not addressed. Agent
  text is shown as written, in some dialogs before framework lines, and how much of a long text a
  dialog shows depends on the platform;
- a dialog program that starts and then fails, or is stopped, still counts as no channel, so where
  the tool is listed in `trust_allowed_for` the call is trusted. The list is the developer's, and a
  `.rsct.json` that lists every tool is within bounds (`mcp-server/README.md`, "`.rsct.json` bounds
  + tamper defense");
- another program of the same user acting on the dialog is not addressed;
- headless users of the override move to `trust_allowed_for`.

**Consequences**: `tests/unit/os-dialog.test.ts` pins the constant arguments, the text only in the
environment, the full paths, the NUL replacement, the limit and the absence of the override.
`tests/integration/os-dialog-real.test.ts` runs the real `powershell.exe` (Windows) and `osascript`
(macOS) with only the dialog call swapped for an echo that returns what it was given, and requires
every text of a corpus back verbatim. `tests/unit/request-gate.test.ts` pins that an input fault is
refused when the tool is listed and when the dialog is forced.

Not measured: macOS outside the CI macOS cells, `--no-markup` on screen, a NUL on a real
MessageBox, and zenity other than 4.0.1.

### ADR-028 — A terminal guard refuses git's gated verbs from the agent's tools; the PreToolUse guards fail closed (#91, 2.15.0)
**Status**: active. Supersedes, from ADR-022 (#114): "any other command carrying the marker is …
left alone" in `/rsct-setup` for the PreToolUse guards (the sanitizer's 4.V.c still leaves an
edited command alone), and the named limits "a command the developer edited by hand is never
rewritten" and "the dialog that mints it does not carry the warning line". It also replaces the
edit guard's fail-open on an internal fault, its behaviour before 2.15.0. Since 2.17.0 (ADR-030)
the guard also refuses `git commit-tree` and a `git pull` that is not `--ff-only`, which narrows
two named limits below ("git plumbing (`commit-tree` + `update-ref`)" and "`git pull`") and
supersedes the alternative "Refusing `git pull` — breaks a daily command"; it reads brace and glob
patterns like variables and refuses a git or gh subcommand built partly from a variable, which
narrows the named limit "a program or subcommand name assembled from parts of variables" to the
program name. Since 2.22.0 (ADR-036) the guard also reads code piped into a program that runs
it, git written inside another program's argument text and the package scripts a manager runs
(`npm run …` and its siblings); ADR-038 adds the database rules to the same guard. Since 2.23.0
(ADR-041) the settings write guard refuses every agent add, change or removal of an `env` entry,
which replaces the fixed list of env keys described below.
**Tags**: gates, hooks, terminal, cross-os

**Context**: every commit, push, merge and rebase gate lives inside an RSCT tool; the agent's
terminal was watched by nothing but a session-start cleanup of standing permissions. MEASURED
2026-10-17 (Claude Code 2.1.173, Windows, Git Bash hook shell, throwaway projects, `claude -p`):
a `PreToolUse` hook that exits 2 refuses the call under `bypassPermissions` and
`--dangerously-skip-permissions` too, and its stderr reaches the model; three tools run commands —
`Bash`, `PowerShell` and `Monitor` (a hook matched on `Bash` alone missed the other two: the commit
landed, the hook was never called); the hook receives `tool_input.command` exactly as written,
multi-line included; any hook exit other than 2 — a missing or crashing script — lets the call
through, and the documented `onFailure: "block"` changed nothing on that version; a hook entry
written to the settings mid-session runs from the next call on.

**Decision**:
- A third hook, `terminal-guard.js`, matcher `^(Bash|PowerShell|Monitor)$`. It refuses `git
  commit|push|merge|rebase|cherry-pick|revert|am` and `gh pr merge`, naming the RSCT tool. It judges
  dequoted words, not command positions: any word whose last path segment, lower-cased and without
  `.exe`, `.cmd`, `.bat` or `.com`, is `git` is followed past its options to the verb (and one that is `git-<verb>`, git's own binary for a refused verb, is that verb), so wrappers need no table. It re-reads
  nested code — substitutions, heredocs fed to a shell, the text handed to `sh -c`, `eval`, `env
  -S`, `su -c`, `cmd /c`, `powershell -Command` and `-EncodedCommand`, `Invoke-Expression`, `wsl`,
  distro launchers' `run`, `ssh`, `git submodule foreach`, `git bisect run` — joined as each
  program joins it (re-parsed text for shells; argv kept for `wsl -e` and `bisect run`).
  Runner options are read too: `bash -o pipefail -c`, `script -qc`, `su -lc`, `cmd //c` (Git
  Bash's spelling of `/c`), Windows PowerShell's bare argument (`powershell "…"` is a command;
  `pwsh`'s is a file), and `Start-Process` is rebuilt as the command line it starts — its program
  and argument list in any parameter order, its own parameters dropped. Interpreter code (`node
  -e`, `tsx -e`, `python -c`, `perl -e`, `ruby -e`, `php -r`, `deno eval`, `bun -e`, and a heredoc fed to an
  interpreter that names no script or a stdin name — `-`, `/dev/stdin`, `/dev/fd/0`,
  `/proc/self/fd/0`; flags in clusters such as `perl -lne` or `python3 -Bc`, and code glued to its
  flag as in `python3 -c"…"` or `node --eval=…`; every code flag on the line is read, so a script's
  own `-c`/`-e` argument that calls git is refused, by choice) is searched for a git call or `gh pr
  merge`, as text or as an argument list; `su -c`, `script -c` and `env -S` read the glued form
  too. A shell that names a script file (other than `/dev/stdin`, `/dev/fd/0` or `/proc/self/fd/0`) runs
  that file, so its heredoc is data, and a heredoc inside
  `$(…)` is read as a heredoc (an apostrophe in its body hides nothing after it). Aliases: inline `-c alias.x=` first, else `git config --get alias.x`
  in the call's folder, only for verbs that are not git's own commands, 3 s budget, refused when
  unresolved. `--abort|--quit|--continue|--skip` of merge/rebase/cherry-pick/revert/am pass when
  every word after the verb is one of them (`git merge -m --abort x` merges, MEASURED on git 2.45.1):
  the operation was approved, and `rsct_request_rebase`'s conflict path tells the agent to run them.
  A word that is a whole variable or substitution, quoted or not, followed — past git's own global
  options only, so `find "$D" -name commit` and PowerShell's `$s -match 'rebase'` pass — by a
  refused verb that is not a recovery form, or by `pr merge`; in bash, an unquoted whole variable
  or substitution run as the command or right after `sudo`, `doas`, `env`, `command`, `exec`,
  `nohup`, `time`, `nice`, `xargs` or `builtin` (the shell splits it into a whole command line:
  `C="git commit"; $C`); a git or gh subcommand that is itself a variable, a substitution or a
  PowerShell splat, also once an alias is expanded or a Start-Process argument string is split into words;
  `Invoke-Expression` (at a command position in PowerShell, also after `&` or `.`) or `-Command` of a
  variable; interpreter code that is a whole variable, separate or glued, in a code flag before the
  script (`python3 -c "$CODE"`, while `node server.js -p "$PORT"` is the script's own option),
  `node --eval="$CODE"`, `deno eval "$CODE"`); a program from a variable whose verb is an inline
  `-c alias.x=…` that runs a refused verb; a `gh alias set` whose
  definition runs `pr merge` or a refused git verb; and any
  text that mentions `disableAllHooks`, are refused. The command position skips assignments and
  shell keywords (`do $C`, `then eval …`), and a wrapper may carry options written as one word starting with `-` (`sudo -E $C`), except
  `command -v`/`-V`, which only looks the name up;
  a wrapper name used as an argument (`docker exec $CID`) is not a wrapper. `$@`, `$1` and the other
  special parameters are variables, `"$@"` and `"${a[@]}"` split like unquoted words, array
  assignments (`files=($(…))`) and arithmetic (`(( $n > 0 ))`) are not commands, a substitution
  inside `${…}` or `$((…))` is judged, and in PowerShell a parenthesised argument (`git ('push')`)
  is a substitution. A
  subcommand passed with its arguments in one string (`Start-Process git -ArgumentList 'commit -m
  x'`, the same for `gh`) is split and judged, and a variable program or argument-list item after
  `Start-Process` is read against the command line Start-Process joins (MEASURED: `Start-Process git -ArgumentList
  " -C .", $v` commits, Windows PowerShell 5.1); a redirect target is not
  read as an argument (`git >out commit` commits, MEASURED in Git Bash); ANSI-C quoting is decoded (`\xHH`, octal,
  `\u`). Interpreter code is matched in its text form and its argument-list forms (`'git', ['push']`,
  `['git', 'push']`, `'git', { args: ['push'] }`), past `-C`/`-c` and their values. Comments, quotes
  left open and PowerShell's backtick are read, not refused.
  It enforces whenever its hook runs; it imports Node built-ins only.
- Both PreToolUse guards are registered as `NODE_OPTIONS= node "${CLAUDE_PROJECT_DIR}/.rsct/
  scripts/<name>.js" || exit 2`, and both exit 2 on an internal fault. `version-drift` counts a guard
  entry only in that exact form with its matcher (`altered` otherwise, enforcement not running);
  `/rsct-setup` replaces any other entry carrying the marker and leaves other hooks alone.
- The edit guard refuses, before any scope check and in any project, an Edit/Write/MultiEdit of a
  `settings.json` / `settings.local.json` in a folder named `.claude` whose
  resulting text sets `disableAllHooks: true`, changes or drops an RSCT hook entry, or sets or
  changes an env key that changes how a hook shell or node starts (`NODE_OPTIONS`, `PATH`, `BASH_ENV`,
  `ENV`, `SHELLOPTS`, `BASHOPTS`, `CLAUDE_PROJECT_DIR`, every `LD_*` and `DYLD_*` loader key,
  `BASH_FUNC_*`; the keys past the first two are a
  defensive list from the shell and loader documentation, not measured). When the file parses, each RSCT entry — event,
  matcher and the whole hook object, key order ignored — must survive unchanged, so narrowing the
  matcher, wrapping the command or adding a `timeout` is refused while the marker text stays; a
  write that leaves such a file unparseable is refused; an unparseable file falls back to the
  marker text. Line endings are compared as LF (the editor matches LF text against a CRLF file),
  a `::$DATA` suffix names the same file on Windows, an empty matcher equals a missing one, and
  any of those env keys added to a file that does not parse is refused.
- `disableAllHooks: true` — first boolean in `.claude/settings.local.json`, `.claude/settings.json`,
  then `~/.claude/settings.json` — is enforcement not running, with its own sentence and a
  `hooks_disabled` field; the dialog line reaches the rebase and batch-authorization dialogs as
  well. The server names no host-config variable (the #73 boundary, pinned by
  `tests/bash/script-install.test.ts`), so a user folder moved with `CLAUDE_CONFIG_DIR` is not read.

**Direction**: stricter. Today's prompt blocks all pass the guard (pinned); recovery commands and
quoted text a program only prints or searches (`echo "git push"`, `grep "git commit"`) pass; the
same words unquoted (`echo git push`) are refused.

**Alternatives considered**:
- Settings `permissions.deny` rules — they see chains and leading assignments but not `sh -c`, a
  path, `git -C` or `git -c` (REPORTED from the docs), and the agent can edit them.
- A table of wrapper programs for finding git — misses every wrapper not in it; the word scan
  needs none. (The unquoted-variable rule does use a short list: there is no git word to find.)
- Refusing every verb that is not git's own command instead of resolving aliases — breaks `git lfs`.
- Refusing `git pull` — breaks a daily command; named below.
- Refusing every agent edit of the settings files — breaks permission edits the developer asks for.

**What is given up, by name**: a script file the agent writes or downloads and runs; other
interpreters' files; a command line carried in a variable through a program the guard does not
read or past a wrapper's option value; a program or subcommand name assembled from parts of
variables; git plumbing (`commit-tree` + `update-ref`); `git pull`; external `git-<name>`
commands such as `git flow`; `gh api`; aliases through `GIT_CONFIG_*`; gh aliases, apart
from a `gh alias set` in the command itself; other MCP servers' tools;
command text assembled at run time from data the guard reads as text; a
settings change made other than through the editor tools is not refused (a terminal command that
mentions `disableAllHooks` is), and `rsct_status`
reports the cases it can detect; Windows without Git Bash, where hooks run in PowerShell — Windows
PowerShell 5.1 cannot parse the command, so the guards would not run, and PowerShell 7 runs it as
an unknown command, so every call would be blocked (from the docs; not measured); a machine
where `node` is not on the PATH Claude Code gives its hooks — a teammate with Claude Code and no
Node, or Claude Code inside WSL without Node — where both guards refuse every call, since the
repository's settings file carries them to every session; subagent tool calls and the developer's
own `!` commands were not measured.

**Consequences**: `tests/unit/terminal-guard.test.ts` (both dialects, every runner, aliases,
recovery flags, false-positive cases), `tests/unit/terminal-guard-prompts.test.ts` (every bash
block of `prompts/` judged allow), `tests/unit/terminal-guard-hook.test.ts`,
`tests/integration/compiled-hooks.test.ts` (the installed program), `tests/bash/
hook-registration.test.ts` (4.V.d, 4.V.e, the fail-closed command, the uninstall scrub),
`tests/unit/settings-write-guard.test.ts`, `tests/unit/hooks-off-detection.test.ts`,
`tests/unit/version-drift.test.ts` (`altered`). A project set up with 2.13.0–2.14.1 shows the
security notice until `/rsct-setup` runs again (an older one shows its inert or not-installed
sentence first). `/rsct-uninstall` removes both guard entries whenever it removes the
enforcement state, from `settings.json` and `settings.local.json`, before
`.rsct/scripts/`: a guard entry whose script is gone refuses every call it matches.

### ADR-029 — Run alone: code and tests close with no dialog when the developer chose it, and are approved before any commit (#128, 2.16.0)
**Status**: active. Since 2.18.0 (ADR-031) the unreadable-state message no longer calls deleting the file a safe recovery; it says to ask the developer and names what deleting drops, the run_alone record included. Since 2.20.1 (ADR-034) `run_alone.declined` is also written for a dialog that ended without a Yes or No (`dialog_failed`), and the given-up item that on macOS a non-zero `osascript` exit reads as No and ends the mode no longer holds: such a failure keeps the pending phases.
**Tags**: gates, phases, dialog

**Context**: every phase completion opens an OS dialog and the tool call waits for the answer
(`gatePhaseComplete`, `lib/phase-machine.ts`; no timeout in the server), so the agent stops at
`rsct_phase_code_complete` while the developer is away. Starts open no dialog; a start is refused
only while another phase is active, never because the previous one was not approved. The only
approval bound to the work itself is the REVIEW's: it stamps each file's exact blob and
`rsct_request_commit` refuses a staged blob no stamp covers (`review_missing`).

**Decision**:
- `rsct_phase_code_start` takes `run_alone`, only at the root of the repository or worktree
  (`git rev-parse --show-toplevel`; elsewhere `run_alone_not_at_root`), so the record lives where
  every commit and REVIEW of that tree reads it. With `dev_approval`, it opens a forced OS dialog
  (`trust_allowed_for` ignored; no channel = refused) after every gate that has no dialog, and only
  when the state file parses and the start's own refusals (another phase active, another task
  recorded) do not apply. Framework text comes first; the spec comes last, on one line (every line
  break, U+000B, U+000C and U+0085 included, becomes a space), capped at 200 characters; the
  enforcement warning line appears when the guards are not running. On Yes, the same state write
  that sets `phase='code'` stores `run_alone = { spec_slug, approved_at, active: true, pending: [] }`;
  a start refused after the dialog leaves nothing. Refused while a record exists. The developer's
  choice is the OS dialog: a confirmation word typed in the chat was rejected, because the agent
  relays what is typed and already knows the word.
- While the record is active and names the state's `spec_slug`, `rsct_phase_code_complete` and
  `rsct_phase_test_complete` run their precheck and `dev_approval` validation but show no dialog:
  the phase closes as before, `{ phase, completed_at }` joins `pending` (`status: "deferred"`,
  audit `<phase>.complete.deferred`), and the approval is recorded as used once that write lands.
  The fabrication signals that would force a dialog are recorded, not acted on: the deferred phase
  is approved later in a forced dialog anyway. The deferral lives in those two tools only.
- `rsct_phase_review_complete`, whenever `pending` is non-empty — whatever spec the REVIEW runs
  under — shows one forced dialog per entry, in order, right after its precheck and before any
  sweep or file change. A Yes removes the entry its dialog named (by phase and time, so a second
  session cannot make one Yes approve another phase) and is written at once; a No drops that entry
  and every later one, sets `active: false`, clears `phase`, `scope_globs` and `started_at`, and
  refuses (`run_alone_rejected`); a write that fails changes nothing; no channel leaves the rest
  pending. A No to the REVIEW's own dialog, once nothing is pending, keeps the mode on: what is
  redone closes again with no dialog and is asked again before any commit. Named from a folder
  below the root while the root holds a record, it refuses (`run_alone_pending`).
- `rsct_request_commit` refuses (`run_alone_pending`) before any dialog and before a batch token
  is read while a record exists at the named folder or at its repository or worktree root, also
  after a No; an unparseable state file falls to the existing `review_unreadable`.
- The record ends when a REVIEW is approved with nothing pending, or with `rsct_phase_abandon`
  while a phase is active: abandon drops it and, while entries are pending, forces its dialog and
  names them first, then the repository line, with the spec and the reason last, one line each.
  `rsct_phase_status` reports the record of the folder it names, only when there is one. The audit
  line `run_alone.declined` means the dialog did not approve it (a No, or no dialog channel); a
  refusal before the dialog — a malformed, reused or stale `dev_approval` — is
  `code.start.rejected`. The unreadable-state message, which calls deleting the file a
  safe recovery, also says that this drops the record.

**Direction**: stricter for commits (a new refusal that holds until the REVIEW is approved) and for
abandon while phases are pending. More permissive in timing — code and tests close without the
developer watching — by the developer's choice, per task, in a forced OS dialog (decided with the
maintainer, #128).

**Alternatives considered**:
- Leaving the dialogs open while the developer is away (non-blocking dialogs, or the last one
  waiting) — the dialog call blocks every RSCT tool (`execFileSync`), and the approvals can wait
  for the developer to be present instead; no dialog opens during the run.
- One summary dialog for code, tests and review at the end — rejected by the maintainer: one
  dialog per phase.
- A No sending everything back to the code phase — rejected: the work goes back to the rejected
  phase.
- A typed confirmation word in the dialog — the agent cannot reach the OS dialog, so Yes already
  proves a human answered.

**What is given up, by name**: `run_alone.pending` lives in `.rsct/phase-state.json`, like every
other gate record, and an agent that writes that file directly can erase it — the commit dialog
stays the guarantee, and under a batch token (`rsct_plan_authorize`) there is no commit dialog;
a second worktree the agent creates has its own state, with no record — its commits still need
their own dialog (a batch token is per worktree), and its merge back needs the merge dialog; the
commit's batch-token writes reuse the state read before the dialog, so a record another session
writes during that dialog can be lost (this predates run alone); the test completion carries no
proof that tests ran; after a No, phase order is not enforced (a start checks
only that no phase is active); on macOS any non-zero, non-negative `osascript` exit reads as No, so
a dialog failure there ends the mode and the work is redone with dialogs; a server older than
2.16.0 — a Claude Code session opened before the upgrade — ignores the record and does not refuse
the commit, until it restarts.

**Consequences**: `tests/unit/run-alone.test.ts` (the choice, the deferral, the approvals in
order, a No, no channel, the spec-slug switch, a second session, a failed write, a subfolder, the
commit refusal, abandon, status, and the unchanged flow without a record). A project that never
chooses it sees no change apart from the longer unreadable-state message: every new behaviour is
keyed on the record, and the existing tests of every touched tool pass unedited. Run alone is not
available in a monorepo package or a nested project whose root is below the repository root.

### ADR-030 — Commits go through the developer's dialog; the only exception is a batch token for a multi-phase plan, 8 hours at most (2.17.0)
**Status**: active.
**Tags**: gates, commit, plan-token, dialog, terminal

**Context**: the maintainer's rule (2026-10-18): every commit is locked by the framework and needs
the developer's OS dialog; the one exception is a batch token the developer approves for a plan
with several phases, valid at most 8 hours from that approval; merge, rebase and push are never
automatic. MEASURED on `main` @ `90f3015` (2.16.0), reading the code: `trust_allowed_for` accepted
`rsct_request_commit`, `rsct_request_push`, `rsct_request_merge` and `rsct_plan_authorize`, so with
no dialog channel — or a dialog that starts and fails (ADR-027) — those calls passed with no human;
none of those gates was forced; the token re-armed on every commit (8 h slide by default, up to
24 h, under an absolute cap of 24 h by default and 7 days by config), so it outlived its approval;
`plan_token_ttl_minutes` had no effect; the mint dialog said "this plan" without naming it, and the
plan was the newest `plan_`/`spec_` file by mtime (#86); rule §B said not to offer a token for a
single-phase plan, and nothing enforced it; the token was plain JSON in `.rsct/phase-state.json`.

**Decision**:
- `rsct_request_commit` with a `dev_approval`, `rsct_request_push`, `rsct_request_merge`,
  `rsct_request_rebase` and `rsct_plan_authorize` force the dialog: `trust_allowed_for` is ignored
  and no channel is a refusal (`force_dialog_no_channel`). The four listable names stay in the enum,
  so a config that lists them still loads (removing them would reject the config and switch the
  guards off — ADR-010, ADR-022); they have no effect.
- The token lives `ttl_minutes` (or `plan_token_ttl_minutes`, else 480) from the approval, 5–480,
  and nothing extends it. `tokenExpiryMs` is the one expiry everything reads (validation, the
  commit output, `rsct_phase_status`): min(`expires_at`, `absolute_expires_at`, `authorized_at` +
  480 min); a missing or unreadable `authorized_at`, or one more than 5 minutes ahead of the clock,
  is expired — so a token an older server wrote is held to the same 8 hours.
  `plan_token_ttl_slide_minutes` and `plan_token_ttl_abs_minutes` leave the schema (`.strip()`).
- The token is for a multi-phase plan: a `plan_<slug>.md` — named by `plan_slug`
  (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, no `..`, present in the root's listing) or else the newest
  `plan_*.md`, never a `spec_` file — whose first table after a `## Phases…` heading outside code
  fences, read by its `Phase` and `Goal` columns, has at least two rows with both cells filled
  (`<…>`, `TBD`, `todo`, `n/a`, `—`, `-` are placeholders). The branch, plan and phase checks run
  before the dialog. The dialog, framework lines first, names the number of commits, the expiry,
  the branch, "commit only: merge, rebase and push keep their own dialog", the warning line, the
  repository; then the plan and up to eight phases, one line each, capped.
- The mint writes `plan_authorize.authorized` — plan, branch, `authorized_at`, `expires_at`,
  `max_actions`, the approval's scope and time, the phase count — before the token, and mints
  nothing when that write fails; an unreadable state is refused before the dialog. A token counts
  only while the log holds that line with the plan, branch, `authorized_at`, `expires_at`,
  `max_actions` and the approval's scope and time equal to the token's (so the count and the expiry
  the developer saw cannot be raised in the state file), and no `plan_revoke.revoked` line names it
  (plan, branch, `authorized_at` — the revoke line carries it since 2.17.0), so a revoked token
  written back does not count. The revoke writes its line before it clears the token, so a revoke
  whose state write fails still ends the token, and a revoke the log could not record says that a
  copy written back would count. Both events are pinned by the retention rule (ADR-025). At commit
  the token's plan is looked up as `plan_<slug>.md` only. `rsct_phase_status` says "NOT usable"
  for a token that is expired or unrecorded; a token the commit refuses for another reason (branch,
  plan, count) still reads as active there.
- The commit's reserve and refund read the state again just before they write, and write only if
  the stored token is still the one they read (same plan, branch, `authorized_at`,
  `actions_used`), so a token revoked or re-minted meanwhile is not brought back. The check runs
  before the write, not under the state lock.
- The terminal guard (ADR-028) also refuses `git commit-tree`, `filter-branch`, `fast-import`,
  `quiltimport` and `replay`, and every `git pull` except a closed form: every word after the verb
  written out (no variable, substitution, or brace or glob pattern, whole or inside a word, quoted
  or not), `--ff-only` among them, every option in a short list (`--ff-only`, `-q`/`--quiet`,
  `-v`/`--verbose`, `--prune`/`-p`, `--no-rebase`, `--rebase=false`, `--tags`/`--no-tags`,
  `--stat`/`--no-stat`/`-n` — so `--no-ff`, `-r`, `--reb` and PowerShell's `--%` are refused), no
  `-c pull.*`, `branch.*` or `rebase.*` before the verb (an alias keeps the options written before
  it), and a repository not spelled as a path (`.`, `..`, `./x`, `../x`, `/x`, `C:…`, `file:`).
  Those verbs are also read in code passed to `node -e`, `python -c` and the like, and in `gh alias
  set`: there a `git pull` is refused in any form, since the flags inside code are not read.
- The terminal guard reads a brace pattern (`{a,b}`, `{1..3}`, bash only) and a glob (`*`, `?`,
  `[…]`) like a variable: a word it cannot know before the shell runs. As a git or gh subcommand it
  is refused (`git {commit,} -m x`, `git [c]ommit -m x`); a brace pattern run as the command is
  refused, and a glob run as the command is refused when a refused verb follows (a `case` pattern
  such as `*"$X"*)` is not a command). In bash a `{` or `}` separates commands only as a word of its
  own, so `co{mmit,}` is one word. A git or gh subcommand built partly from a variable (`git co$X`,
  `git "co$X"`) is refused too.
- Dialog texts: `specLabel` also removes zero-width, bidirectional and other invisible format
  characters (U+061C, U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+2069, U+FEFF); the mint
  dialog's expiry says UTC.

**Direction**: stricter on every path. Given up, by design: a machine with no dialog channel cannot
commit, push, merge, rebase or mint a token through RSCT; a single-phase plan gets no token; a
`git pull` that would merge or rebase is the developer's to run. The default lifetime grows from
the documented 120 minutes to 480, and shrinks from what really ran (24 hours or more).

**Alternatives considered**:
- Removing the four names from the trust enum — rejected: the config would be rejected whole and
  the project would become unmanaged, guards off.
- Requiring a code phase to have started before the token counts — dropped by the maintainer: the
  token counts from its approval.
- Taking "multi-phase" from per-phase `spec_` files, or from `spec_slug` ≠ `plan_slug` — rejected:
  three definitions were in use (template "3+", rule §B "each with its own `spec_`", ADR-003); the
  plan's own table is the one the developer reads, and the dialog lists it.
- Refusing a token commit while a merge is in progress (`MERGE_HEAD`) — not taken: that merge had
  its own dialog, and refusing would break the approved conflict flow.

**What is given up, by name**: the token, the plan file and the audit log are files a same-user
agent can write — a forged token needs a forged audit line too (the bar of ADR-011 and ADR-018);
editing `actions_used` in the state file still resets the count of a genuine token within its
8 hours and its granted `max_actions` per reset (no per-commit record is checked), and a plan file
can claim phases it does not have, which is why the dialog lists them; the terminal guard does
not refuse commands that move refs without creating a commit (`git reset --hard`, `git branch
-f`, `git update-ref`, `git fetch . a:b`, a fast-forward `git pull --ff-only` from a URL or from a
local repository not spelled as a path — `.git`, `~/x`, a bare folder name), `git hash-object -w
-t commit`, hooks the agent writes, a script file the agent runs, or other MCP servers (ADR-028);
a program name built partly from a variable stays given up (ADR-028); on git older than 2.34 a
repository config `pull.rebase=true` can make `git pull --ff-only` rebase (not measured), and so
can `--config-env`, `-c include.path` and `GIT_CONFIG_*`, which the guard does not read (`-c
pull.*`, `branch.*` and `rebase.*` are refused); a server older than 2.17.0 — a session opened
before the upgrade — keeps trust and the sliding window until it restarts; the reserve's check
before the write is not covered by a test (the window between the token check and the reserve has
no seam a test can reach).

**Consequences**: `tests/unit/commit-lock.test.ts` (the phases reader, the mint dialog and its
checks, the forced dialog, the audit line, the token path: unrecorded, `spec_` plans, the 8-hour cap,
the refund, the revoke order), `tests/unit/plan-authorization-lifetime.test.ts` (replaces the
sliding-window tests), forced-dialog cases in the push, merge and rebase tests, and the terminal
guard lists, with the brace, glob and partial-variable cases and the forms that must still pass.
`tests/unit/terminal-guard-prompts.test.ts` caught the first draft refusing the prompts' own `case`
patterns. Edited
tests, each with the guarantee it still holds: the token fixtures gained the audit line an approved
mint writes; the mint fixtures gained a two-phase table; "cuts when the approval was trusted with
no dialog channel" became "refuses … and cuts nothing"; `git pull` moved to the refused list with
`--ff-only` forms allowed; a Start-Process example passes a variable to `fetch` instead of `pull`.

### ADR-031 — Dialogs put the framework first; plan lookups are deterministic; the REVIEW names the process; an audit.path no file can sit at is ignored (2.18.0)
**Status**: active. Since 2.20.1 (ADR-034) the given-up item that on Linux and macOS a dialog program that cannot open still reads as No no longer holds: it is `dialog_failed`, a refusal that is not recorded as the developer's decision. Since 2.22.0 (ADR-036) the push dialog names the commit it sends — the refspec git is called with is built from it — and, for a protected push whose carried files could not be read, says that `files_swept` was not checked. Since 2.23.0 (ADR-040) the commit dialog lists every
exception it approves (protected branch, secret findings, contract surfaces) before the agent's
reasons and the commit message.
**Tags**: dialog, gates, plan, classify, audit-log, cross-os

**Context**: MEASURED 2026-10-21 on `main` @ `bfa4946` (2.17.0), Windows 11 / NTFS, real handlers
bundled with esbuild.
- Dialogs: a commit message of one line, 300 blank lines and one more line made a 307-line
  dialog whose repository line was the last; a `spec_ref` carrying 200 line breaks put a line
  reading `Repository: …` 200 lines above the framework's bypass list; the code-complete dialog
  began with the spec and had no repository line. In the V review: a push branch, the reason of an
  abandon, issue labels, a relocated folder name inside the repository line, and branch names git
  accepts with line separators did the same. In the REVIEW: combining marks stacked on one letter of
  the agent's text drew over the framework lines above it (MEASURED by rendering the commit dialog
  text off-screen with the MessageBox font). Whether a dialog program cuts a long text on screen was
  NOT measured (the developer declined an on-screen test); the order is fixed regardless.
- Plans (#86): two `spec_` files on one branch with equal mtimes — the winner was the
  alphabetically first on NTFS (readdir order; ext4 and APFS order otherwise), so `plan_complete`
  passed or failed by file name alone. `findPlanByBranch` compared the raw string: a merge of
  `refs/heads/x`, `heads/x` or `X` (git resolves loose refs ignoring case on NTFS and APFS), a push
  of `HEAD:main` or `x:main`, and a squash of `x` found no plan and skipped the check.
- Tier (#89): `rsct_phase_code_start` is optional — classify complex, then REVIEW start, REVIEW
  complete and commit landed with three dialogs, none naming V, a plan or the tier. The messages for
  an unreadable `.rsct/phase-state.json` (the refusal, `rsct_load_context`, `rsct_status`) called
  deleting the file a safe recovery or a clean start.
- `audit.path`: `.rsct/audit.log:x` wrote every entry into an NTFS stream while the file a
  developer opens stayed empty; a NUL, a control character, `? * < > | "` or a folder (`.`, `.rsct`)
  made every write fail; a bare reserved name such as `NUL`, `COM` with a superscript digit, or a
  name ending in a dot created a file ordinary tools do not open (names such as `nul.log` open on
  Windows 11 and are reserved on older Windows). The config loaded in every case.

**Decision**:
- `lib/dialog-text.ts`, a module with no imports: `specLabel` (format characters removed, line
  breaks and tabs → one space, control characters removed, a run of more than four combining marks
  cut to four; cut by code point when a limit is given), `dialogList` (one flattened line per item,
  then "… and N more") and `commitMessageView`. Every dialog shows the question, its warnings and the
  repository line first, and what the agent supplied last, one line per value: commit, push, merge,
  rebase, the completion of research, spec, code, test, review and V (these gain the repository
  line), the ceremony bypass, abandon on both paths, the REVIEW's unverified-files question (Yes/No
  meaning right after the question) and issue creation (where gh runs and the label warnings, then
  labels, then title). Values on the question line — branch, ref and remote names, the phase of an
  abandon — and folders in the repository line are flattened and cut past 1,000 characters, so a
  name cannot wrap the framework lines off the dialog; the push dialog names the destination on its
  own line when it differs from the source. Every other agent value is flattened and not cut; the
  cuts that existed before stay (comment excerpts 80, kept-code notes 100, allowlisted comments 120,
  the run-alone spec 200, the plan-authorization labels). The protected-branch notice of the footer
  and the times of pending run-alone phases are flattened too.
- The commit message is shown last, after the repository line, under "Commit message:". CRLF,
  CR, VT, FF, NEL, U+2028 and U+2029 become line breaks; trailing whitespace is dropped; runs of
  blank lines collapse to one and leading or trailing blank lines go; any other control or format
  character, and the part of a mark pile past four, is shown as U+FFFD — it is in the message git
  records, so it is marked, not hidden. No line cap and no width cap.
- One enumerator in `lib/plan.ts` feeds `findActivePlan`, `findPlanByBranch`, `findNewestPlanFile`
  and `listPlans`: newest mtime first, then the NFC file name in code-unit order (never
  `localeCompare`, which depends on the locale). `branchKey` is `stripRefsPrefix` over the trimmed,
  NFC, lower-cased name; `findPlanByBranch` takes a `Branch` row written exactly as the name first,
  then one that matches by key. The integration gate reads `branchPlansHaveOpenItems`: merge — the
  source branch; rebase — the current branch; squash — the current branch and the squashed ref;
  push to a protected branch — the pushed source of the refspec, `HEAD`/`@` meaning the current
  branch, an empty source (a delete) reading none.
- The REVIEW-complete dialog carries a framework line: "Process: classified '<latest>' by
  rsct_classify_task (highest on record '<max>'); V phase for this spec: completed | not run." —
  latest from `last_classify`, highest from `readClassifyEvidence` (state and audit log), V from a
  verification block of this `spec_ref` with a `completed_at`. `UNREADABLE_STATE_ADVICE`, shared by
  the refusal, `rsct_load_context` and `rsct_status`, says to stop and ask the developer and names
  what deleting drops.
- `decideAuditPath` reads the part of the configured path below the base (`path.relative`, after
  the existing outside-the-project check, split on the platform separator) and ignores the value —
  default log, `unusable: { path, reason }` — when it is empty, or on Windows holds `:` (a stream,
  checked first), when it holds a control character, on Windows `< > " | ? *`, a reserved device
  name (CON, PRN, AUX, NUL, COM and LPT with a digit or a superscript digit, CONIN$, CONOUT$, any
  case, any extension) or a segment ending in a dot or a space, or when it names a folder or a path
  through a file (every OS). A stat that throws counts as not a file. `escaped` is unchanged.
  `anchorHints` names the value (`JSON.stringify`, so a NUL shows) and the reason. Retention
  refuses to cut while the configured value names a stream (`stream_path`), keyed on that decision.

**Direction**: stricter on every part. No refusal is removed; the new refusals are the integration
gate finding the plan it used to miss. A dialog hides nothing it showed before except a name on a
framework line past 1,000 characters and a pile of more than four combining marks.

**Alternatives considered**:
- A dialog at `rsct_phase_code_start` for every trivial/small start (the first approved option)
  — dropped after V: the start is optional, so it would cost the honest path a dialog and leave the
  documented and the deliberate path open; the REVIEW line reaches both.
- The downgrade check reading the higher of the state file and the audit log, so that deleting the
  state file no longer drops it — built, and dropped in REVIEW: the audit log is shared by linked
  worktrees and the state file is not, so after one complex verdict anywhere in the repository every
  smaller start in a new worktree would need the override dialog, and the start is optional anyway.
  The REVIEW line shows the highest classification from the log instead.
- Reading every plan of the branch for `plan_complete` — rejected: a multi-phase plan's progress
  tracks later phases as open, so every mid-plan integration would be refused (the
  `lib/pre-merge-ack.ts` note on non-final merges), and the progress files are agent-writable.
- A 40-line cap on the commit message, and an 80-character cut of names — dropped in V and REVIEW:
  they hid text the dialog showed, the destination of a push included.
- Refusing the whole config on an unusable `audit.path` (premise #1's usual answer) — rejected: a
  rejected config makes the project unmanaged, which switches the edit-scope guard off (ADR-022);
  ignoring the value keeps the project managed and the log where the developer looks, as for a
  path outside the project.
- Removing retention's stream refusal once the path falls back — rejected in V: the next cut would
  replace the default log and the stream with it, erasing what the old config wrote there.
- A colon refused outside Windows too — rejected: on Linux and macOS it is part of a file name, the
  check runs on the machine that reads the config, and a POSIX test pins that.
- Resolving the integrated ref to a commit and taking every branch at it — not taken: heavier, and
  branches that share a commit right after branching would bring in unrelated plans.

**What is given up, by name**: text that imitates framework lines, letters that render blank, and a
long line in some dialog programs (ADR-027); the issue body is not shown in the capture dialog; the
progress files and the `Branch` row stay agent-written, a plan saved later still wins a lookup by
key, case folding joins names a case-sensitive file system keeps apart, any revision that is not a
branch name (a sha, a tag, a remote-tracking name, an expression) finds no plan, and there is no
`rsct_plan_start` (#86); `rsct_classify_task` stays ungated, `rsct_phase_code_start` optional, and
deleting the state file still drops the downgrade record (ADR-019) — the REVIEW line makes the
outcome visible, it does not refuse it, and it reads the audit log the config names; a V block from
an older task with the same `spec_ref` still reads as completed; `code_start` still shows its
override dialog before refusals that need none (ADR-014); for `audit.path`, links inside the project
are not resolved (as before), a path longer than the classic Windows limit is kept, and entries an
older guard or sanitizer copy writes keep going to the old path until `/rsct-setup` replaces it; on
Linux and macOS a dialog program that cannot open still reads as No (ADR-027).

**Consequences**: `tests/unit/dialog-text-order.test.ts`, `plan-lookup-spellings.test.ts`,
`tier-record-review-line.test.ts`, `audit-path-unusable.test.ts`. Edited tests, each with the
guarantee it still holds: `version-drift-inert.test.ts` — the warning sits once right after the
question and a healthy guard shows none, now with the message under "Commit message:" last;
`audit-retention.test.ts` — a stream naming a working file cuts nothing and leaves both files as
they were (one outcome now, since the value is no longer a second log), and a NUL path no longer
counts as a second log: the default one is still forecast and cut; `audit-log.test.ts` — a failed
write returns `write_failed` and never throws, now provoked by a file where the default `.rsct`
folder goes (a configured path through a file is ignored, pinned by `audit-path-unusable`);
`run-alone.test.ts` imports `specLabel` from its new module. The edit-scope guard and the sanitizer
bundle `decideAuditPath`, so a project needs `/rsct-setup` for its copies to follow the new rule.

### ADR-032 — `--wsl` installs for a Claude Code inside WSL; the uninstaller reads Claude Code's host config; hook scripts only through a link (#110, #82, 2.19.0)
**Status**: active. Supersedes ADR-026's line "a Claude Code that runs inside WSL still has no
supported install (#110)" and ADR-025's "That combination has no supported install today (#110)";
the rest of both stands.
**Tags**: install, uninstall, wsl, cross-os

**Context**: MEASURED on `main` @ `9d188c1` (2.18.0), Windows 11 with WSL2 (Ubuntu, kernel
`5.15.167.4-microsoft-standard-WSL2`) and Git Bash 5.2.26.
- Both scripts stopped under WSL, so a Claude Code whose CLI runs inside a distro had no install.
  Inside WSL the Windows PATH comes along: `command -v claude`, `npm` and `rsct-mcp` answer the
  Windows programs under `/mnt/c/...` with nothing installed in Linux, and the Windows npm acts on
  the Windows prefix (CLAUDE.md, WSL table, #74).
- `/usr/bin/wslpath -w` answers `\\wsl.localhost\<distro>\…` for a path on the Linux disk and a
  drive path for `/mnt/c/…`, also when the path goes through a link into `/mnt/c`.
- The uninstaller looked for the user-scope entry in `$HOME/.claude.json`, only when `claude` was
  on PATH. Claude Code keeps it in `$CLAUDE_CONFIG_DIR/.claude.json`, else in `os.homedir()` — on
  Windows `USERPROFILE` (the installer's `HOST_CFG`, #73). So an entry under `CLAUDE_CONFIG_DIR`, or
  any entry on a machine without the CLI, was not seen; a machine with only the registration left
  answered "Nothing to remove" before looking for it; and the closing line said "RSCT framework
  removed" with the entry in place.
- `/rsct-setup` 4.V.a also read `RSCT_FRAMEWORK_SOURCE`, an override no page documented.

**Decision**:
- Both scripts take `--wsl`. The `osrelease` check stays inline; the shared functions live in
  `scripts/rsct-lib.sh`, sourced with `.` — a tree without it stops before any write. Not WSL and no
  flag: as before. `--wsl` outside WSL: stop. WSL without the flag: stop, and the message names
  `--wsl`. WSL with the flag: the steps below.
- A path is on the Linux side only when `/usr/bin/wslpath -w` (called by full path; missing → stop)
  answers `\\wsl.localhost\` or `\\wsl$\`. Any other answer, or none, counts as not Linux. Without
  asking, these count as not Linux too: a path that is not absolute (a relative `HOME` would be
  judged against the folder the script starts in, and the installer later `cd`s into the clone),
  including a Windows-form value such as `C:\…`; a path with a `.` or `..` segment (the kernel
  resolves `..` on disk, so the deepest existing folder of `a/missing/../..` is not where a write
  lands); a link whose target is gone. A path that does not exist yet is judged by its deepest
  existing folder or link, found without external tools. A program counts as Windows unless it is
  confirmed on the Linux side, readable, and does not start with `MZ` (read with a bash builtin).
  Shell functions named `node`, `npm`, `claude` or `rsct-mcp` (an exported one, or one from
  `BASH_ENV`) are dropped after the PATH rebuild, so a call runs the file that was checked.
- PATH is rebuilt once, before the first `node`, `npm` or `claude` call (a test pins the order),
  keeping only absolute Linux-side entries, split on `:` with globbing off; an empty result stops
  the run. A `node`, `npm` or `claude` that still resolves to a Windows program stops the run. The
  installer also stops when no Linux `claude` is left. `~/.rsct`, `~/.claude/commands`, the
  host-config folder, the host-config file itself and `npm prefix -g` must all be on the Linux side,
  or the run stops before writing and names the path. `npm prefix -g` runs only after the other
  destinations pass — npm writes its log folder under `HOME` (measured: with `HOME` on `/mnt/c` it
  created `.npm` there before the stop, found in the REVIEW) — and an answer of nothing stops the
  run. Under `--wsl` the `claude` commands both scripts print name the Linux `claude` by full
  path; when the uninstaller has no Linux `claude` or npm, its hints say to edit the file, install
  the tool inside WSL or run the uninstaller again, never a bare `claude` or `npm` that the
  developer's shell could resolve to the Windows one. Two hints stay bare. `sudo npm`: with a
  `secure_path` in sudoers, as on Ubuntu, `sudo` does not search `/mnt/c`; without one it may (not
  measured). The project-scope step of the uninstaller's manual steps, when there is no Linux
  `claude`: what a Windows `claude` writes besides that project's `.mcp.json` was not measured.
- Installer: when the `rsct-mcp` the original PATH resolves is a Windows program after the install,
  it does not report the companion as installed, registers nothing and leaves the recorded scope as
  it was; the message names the Linux folder to put first. A Linux shim is not a Windows program, so
  ADR-021's version-manager case is unchanged. Uninstaller: no Linux `claude` needed; a Windows
  `rsct-mcp` is named as the Windows install's and not touched.
- Uninstaller, every OS (#82): the host config is resolved as in the installer
  (`rsct_host_config`, which turns backslashes into slashes on Windows only); the entry is detected
  whenever node is present; "Nothing to remove" counts a registration (under `--skip-mcp` it names
  the one it leaves); after `claude mcp remove` the file is re-read and the CLI's exit code is not
  used. When the entry stays (no CLI, still present, answered `n`, `--skip-mcp`) the closing line
  says so; when the file can no longer be read it says the removal is not confirmed; without node it
  says the registration was not checked.
- 4.V.a takes the hook scripts from `$(npm root -g)/rsct-mcp` only when that entry is a link
  (`[ -L ]`) holding them — the link the installer creates to its copy (ADR-021) and the link a
  contributor makes to a clone (`CONTRIBUTING.md`); a plain folder under that name is reported and
  Phase 4.V is skipped. `RSCT_FRAMEWORK_SOURCE` is removed. The "not installed" texts point at
  `bash scripts/install.sh`.

**Direction**: more permissive by design for one path, decided by the maintainer in the #110 plan:
the refusal under WSL gains an opt-in, `--wsl`, and every check on it stops the run or holds back
the step (the Windows `rsct-mcp` case registers nothing, the uninstaller leaves it untouched).
Every existing path is unchanged, stricter (4.V.a; the uninstaller's closing line; both scripts
need `scripts/rsct-lib.sh` beside them) or corrected: the uninstaller now finds a user-scope entry
it used to miss (under `CLAUDE_CONFIG_DIR`, without the CLI, or when it was the only thing left)
and, with a `claude` CLI, removes it when asked or under `-y`; on Linux and macOS the host-config
path keeps a backslash, and on every OS, without node, it follows `CLAUDE_CONFIG_DIR`. Apart from
these, what ran before still runs the same way: on Windows the whole lifecycle with a real npm
10.9.2 (install, update, keep or skip the companion, uninstall, and the 2.18.0 scripts against
these in both directions) gave the 2.18.0 results, and Git Bash with the clone under
`//wsl.localhost/` installed and uninstalled as before (MEASURED 2026-10-21); for Linux and macOS
the CI matrix (ubuntu, windows, macos) runs the suite on the release pull request (which `bash` the
macOS runner puts first, and so whether bash 3.2 itself runs, was not checked). ADR-026's reopen condition "the install channel is redesigned" is not
met: the same installer, one option, nothing published.

**Alternatives considered**:
- Putting the Linux npm folder first on PATH (the first plan) — dropped in V: every Windows program
  not shadowed by name stayed reachable.
- An environment variable that makes a test machine look like WSL — rejected: an agent can set an
  environment variable, and a check it can switch off is not a check (ADR-027). CI covers the pure
  functions and the non-WSL verdicts; the WSL runs are proven by hand.
- Refusing any `rsct-mcp` not proven to be the copy — rejected: a version manager's shim cannot be
  proven (ADR-021) and would stop working.
- 4.V.a reading `~/.rsct/mcp-server` only — rejected in V: the contributor link points at a clone,
  and contributors would lose their hooks.
- Detecting WSL by `WSL_DISTRO_NAME` or `uname` — not taken: the environment variable can be set,
  and `osrelease` is what the guard read before.

**What is given up, by name**: a container that shares the WSL kernel (Docker Desktop's) matches
`osrelease`, has no `wslpath` and stops; WSL1 was not measured; a custom kernel whose `osrelease`
names neither "microsoft" nor "wsl" is not detected, as before; a folder shared on purpose between
the Windows and Linux homes stops a `--wsl` run; a Windows `HOME` that differs from `USERPROFILE`
without `CLAUDE_CONFIG_DIR` cannot be reproduced through the test harness; the WSL runs are proven
by hand on one machine, not in CI. The checks judge folders and the host-config file, not what a
program does: a Linux-side program named `node`, `npm` or `claude` that itself starts a Windows
program passes; a Windows folder reached through a mount other than `/mnt/<drive>` is judged by
what `wslpath` answers (not measured); npm's own cache and log folders are not checked; a link to
the Windows side placed inside `~/.rsct` or `~/.claude/commands`, rather than the folder itself, is
not seen. Both scripts now need `scripts/rsct-lib.sh` beside them: a script copied alone or run
through a link stops before doing anything; piped into bash it has no file name, so it reads an
`rsct-lib.sh` from the current folder, and stops when there is none (undocumented use). The
uninstaller still stops at a closed stdin before its closing line, as before. A relative PATH entry
that wins the lookup of `rsct-mcp` makes that command read as the Windows one (fails closed). The
uninstaller names a Windows `rsct-mcp` only when it comes first on the original PATH; behind a
Linux one it is not mentioned. A host config node cannot parse counts as holding no entry at
detection (the re-read after a removal tells that case apart).

**Consequences**: `tests/bash/rsct-lib.test.ts`, `tests/bash/hook-source-link.test.ts`, and new
blocks in `tests/bash/script-install.test.ts` (both scripts stop without the lib and find it under
an exported `CDPATH`, `--wsl` outside WSL, the PATH order — a call after `if`, `elif`, `then`, `do`,
`exec`, `env`, `!`, `{` or an assignment, quoted, or inside `$(…)` on an `echo` line counts —, and
the #82 cases, two of which put the entry only in the `CLAUDE_CONFIG_DIR` file so a detection or a
re-read of `$HOME` fails). Edited tests, each with the guarantee it still holds: the
`osrelease` matcher test re-typed the grep — it now reads the pattern from both scripts, and the
WSL2, WSL1 and plain-Linux strings it pinned are pinned there; the `--skip-mcp` wording test (A4)
runs through `runScript`, so its host config is the sandbox's; the bash lint expects three scripts
(the lib is linted as one). The session rules and the memory template name the installer, so a
project picks the new text up through `/rsct-setup`.

Proven by hand inside WSL (2026-10-21, a stub `claude`, the official node 22.14.0 for Linux unpacked
in a temporary folder, the sandbox removed afterwards): without `--wsl` it stops; without a Linux
`claude` it stops and names the Windows one; `HOME`, `CLAUDE_CONFIG_DIR` or npm's prefix on
`/mnt/c` stop it before anything is written there; a clone on the Linux disk and one on `/mnt/c`
install, update and uninstall; with no Linux node, or node without npm, the companion is skipped
and the Windows npm is never run; with the Windows `rsct-mcp` first on PATH the companion is linked
in Linux, nothing is registered and the message names the Linux folder; with the Linux folder first
the command is the copy, starts, and is registered and later removed from the Linux host config.
After the REVIEW fixes: a `~/.claude.json` that is a link into `/mnt/c`, a `HOME` with `..` behind
a missing folder, a `HOME` plainly on `/mnt/c` with a Linux npm present (npm never ran, the folder
stayed empty), a PATH with only Windows-side folders, and an `npm prefix -g` that answers nothing
all stop both scripts with nothing written or removed; so does a relative `HOME`; an exported
shell function named `claude` is not what runs (the checked file is); the uninstaller's hints name
the Linux `claude` by full path, or say to edit the file or install npm inside WSL. Before and
after every WSL run the Windows install's global link, user-scope entry, `~/.rsct` and slash
commands were identical.

### ADR-033 — The uninstall keeps the developer's text and names what it keeps; setup never replaces a CLAUDE.md with content; the repository's `.rsct/` gets its own ignore file (#82, 2.20.0)
**Status**: active. Changes one acceptance criterion of #82 (2026-09-10): "the uninstall also
cleans the relocated location" becomes "the uninstall names the relocated location and never
removes it" (maintainer, 2026-10-22). The rest of #82 stands.
**Tags**: uninstall, setup, claude-md, relocation, gitignore, upgrade

**Context**: MEASURED on `main` @ `210b6d6` (2.19.0), Windows 11, Git Bash 5.2.26, running the real
prompt blocks in temporary folders.
- Setup's CREATE writer replaced a `CLAUDE.md` that held the developer's text and no RSCT rules:
  Phase 2 sent "exists, no rules" to CREATE and the block wrote the template over the file.
- The uninstall left the header lines and the conventions pointer: setup writes `RSCT_APP` in 29
  places and the uninstall in none; `RSCT-CONVENTIONS-REF` 5 and none. "Delete the file when only
  the header is left" was prose with no command, and could not be reached while those lines stayed.
- The 4.2 `sed` range delete removed section bodies that are the developer's text
  (`source=migrated-from-ptbr-preserved`, `hand-merged`, never named in the uninstall) and, on a
  BEGIN with no END, would delete to the end of the file.
- The unmarked placeholder of an install from before #66 that was linked and then refreshed
  survived: the awk took the heading inside the filled section (`SKIP hl=3 tl=15`).
- From a monorepo package, `git cat-file -e $SHA:CLAUDE.md` reads the repository root's file;
  `$SHA:./CLAUDE.md` reads the package's. From a subfolder, `git ls-tree --name-only "$SHA:./"`
  prints nothing with exit code 0 (the folder filter is applied a second time to that folder's own
  tree); `--full-tree` lists its entries from a subfolder and from the root, and a folder missing at
  that commit exits 128 (git 2.45.1). Found by mutation in the T phase: the first version of 4.3c
  never saw a package's own `CLAUDE.md` at the commit.
- Phase 1.0 captured `HEAD` and `INITIAL` on two lines in a repository with no commit.
- Since #92 a linked worktree, a monorepo package or a project inside another repository keeps
  `audit.log`, `approvals-seen.json` and the audit-prune files in the repository's `.rsct/`, which
  the project's `.gitignore` block does not reach, so they showed in `git status`; the uninstall was
  project-relative. That folder is shared by every RSCT project of the repository: removing it
  resets the others' audit ceiling, their `plan_revoke` records and their approval store.
- `rsct_status`, `rsct_audit`, `rsct_classify_task`, rules §B and §C and `mcp-server/README.md` said
  the approval store was per worktree.
- 4.6 (partial uninstall) was prose only, so nothing kept an agent from parsing and re-writing
  `.rsct.json` (anti-pattern #5).

**Decision**:
- Setup: CREATE only when `CLAUDE.md` is absent or empty (a byte-order mark and whitespace count as
  empty); 4.3 checks again and stops on a file with content, and without node it stops on any file
  that is not zero bytes. A read-only Phase 1.5 block classifies the file: a column-1 marker pair
  decides a rule's presence, and the keywords are searched only outside every RSCT block, header
  line and `[§X — … inserted here]` line. Step E anchors after the `RSCT_APP` header, else the
  `# CLAUDE.md` heading, else the first column-1 `# ` heading outside a code fence, else the top;
  a byte-order mark stays at byte 0. Phase 1.0 uses `git rev-parse --verify -q HEAD || echo INITIAL`.
- Uninstall, in `CLAUDE.md`: 4.2 is one node pass over column-1 marker pairs that writes nothing
  when a pair is nested, stray or never closed; `inserted` and `migrated-from-ptbr` go whole, any
  other `source=` keeps its body; line endings and a byte-order mark are kept. The slot and
  canonical-section removals match their markers at column 1 only, like the sections, and the
  legacy placeholder search skips the filled section. 4.3b removes the exact header lines of the
  leading block and the pointer whose text hashes to the one setup writes, only once no section,
  canonical section or slot marker is left; an edited pointer is kept. 4.3c decides the file by
  git: deleted when there was no `CLAUDE.md` at `setup_commit_sha_before` or one with only framework
  text, and only framework text is left; restore offered when an older CREATE replaced the
  developer's file; kept otherwise, and always when the commit or the file there cannot be read.
  It only prints its decision unless `CLAUDE_MD_APPLY=1` is set, so Phase 1 runs it as written and
  Phase 4 sets the variable. A `CLAUDE.md` that is a symbolic link is touched by no block: its
  target can be a file another project uses, and the awk removals would replace the link with a
  copy (MEASURED in the REVIEW with an MSYS link: the link became a regular file and 4.3c then
  deleted it).
- Uninstall, elsewhere: without an `install` block it still stops, and now lists the leftovers
  read-only and gives the route (`/rsct-setup`, then `/rsct-uninstall`). The report says that a
  framework section goes whole, edits included, worded by whether git keeps a copy (Phase 1.3). A
  Category K list of what is kept on purpose appears before the OK and in the final report. Phase
  1.6 finds the repository's `.rsct/` with the server's rule (bash, `-ef`, pinned to
  `lib/repo-anchor.ts` on eight layouts) and names it; it is never removed. In the main worktree of
  a repository with linked worktrees it prints `SHARED_WITH_WORKTREES`, and 4.V.c keeps the
  approval store, which those worktrees use. A kept `audit.log` gets
  a `.rsct/.gitignore` (4.V.c), removed in 4.7 only when its content is RSCT's and nothing else is
  left; an empty `.claude/` is removed. 4.6 turns `canonical_source_added` off in a kept
  `.rsct.json` by a text splice of that one value. An artefact table maps every setup block and
  every server file to what the uninstall does with it; a test fails when a setup block or a name of
  the server's shared and local lists has no row.
- Server: `protectRelocatedState` writes `<repository>/.rsct/.gitignore` with every write to the
  shared files (after it, or before the retention cut writes its working files, and only when a log
  or a pending cut exists), only when the folder is relocated, never replacing an existing file
  (`wx`), never throwing, and writing no audit event. A read writes it only together with the
  one-time copy of an old project log (#92). It lists the shared files and itself, never `*`.
- The per-worktree claim is corrected in the tool texts, rules §B and §C and the server README: the
  phase state and a batch token are per worktree; the audit log and the approval store are the
  repository's, so an approval spent in one worktree is spent in all.

**Direction**: stricter or neutral; nothing is looser. No gate reads anything new and none changes
its answer; the server's ignore file changes no write result and adds no audit event. The
uninstall removes less of the developer's text than before (bodies that are theirs, malformed
files refused, a deletion of `CLAUDE.md` that needs git's proof) and more framework text (header
lines and pointer, as #82 asked). The relocated shared state is not removed, which keeps the other
projects' records intact. The rules text that reaches every project through `/rsct-setup` only
corrects a false sentence about worktrees.

**Alternatives considered**:
- Removing the relocated shared state, as #82 first asked — rejected (maintainer, 1A): it resets
  the other projects' audit ceiling and revoke records.
- Counting the RSCT projects of the repository to decide that removal — refuted: `git ls-files`
  from a package undercounts.
- Deciding the deletion of `CLAUDE.md` by `install.mode` — refuted: a re-setup over leftovers is
  UPDATE, and a CREATE that replaced the developer's file would have deleted it.
- Step E at the top of the file when there is no header — refuted in V: it breaks the check in
  `02-canonical-source.md` that the section comes after the first heading.
- `*` in the ignore file — rejected: it would hide the developer's own files in that folder.
- Removing the abort when `.rsct.json` has no `install` block — rejected (2A): it loosens an
  absolute stop; the listing gives the information without acting on a guess.
- Asking per edited framework section (a hash check) — not taken (3A): the report line says the
  sections go whole and whether git has a copy.

**What is given up, by name**: an edit inside a framework section goes with the section (the
report says so). A `HOME` that is itself a git repository makes `~/.rsct` the shared folder of every
project under it; it is named like any relocation and never removed, but nothing tells it apart
from the machine install folder. When the project is the repository root, the uninstall still
removes the `approvals-seen.json` that packages relocated to that root use (as before: git cannot
list them reliably); for linked worktrees, which git lists, the store is kept. Any `audit.path`
other than the default `.rsct/audit.log` is not covered by the ignore file. The slot and
canonical-section removals use awk, so on Git Bash a file they change comes back with LF line
endings (as before); the section pass keeps them on every system. Files
that 2.9.0–2.19.x committed in the shared folder stay tracked until `git rm --cached` (the release
note gives the command; the framework never changes the git index). With Category E out of scope
4.V.c does not run, so the kept state files lose their ignore lines (the report says so). Leftovers
that were never committed and are adopted by an UPDATE setup keep their template lines as the
developer's text, so that `CLAUDE.md` is kept. 4.2, 4.3b and 4.3c need node (4.2 used only sed). A
symlinked `CLAUDE.md` keeps every RSCT part: the developer removes them from its target by hand.
On a git older than 2.7 (no `worktree list`) the main worktree does not say it is shared and
4.V.c removes the store there.

**Consequences**: new tests `tests/unit/relocated-state-ignore.test.ts`,
`tests/bash/setup-claude-md.test.ts`, `tests/bash/uninstall-claude-md.test.ts` (with the helper
`tests/bash/lib/chain-harness.ts`, which runs several blocks in one folder, each in its own shell)
and `tests/bash/uninstall-inventory.test.ts`; no existing test was edited. Rules §B and §C and the
hook bundle changed, so each project needs `/rsct-setup` after the installer.

### ADR-034 — A dialog that ends without a Yes or No is refused for every tool; only a missing dialog program or a Windows session with no desktop is "no channel"; the Windows dialog script calls only .NET (2.20.1)
**Status**: active. Narrows what ADR-027 counts as "no channel".
**Tags**: security, dialog, gates, cross-os

**Context**: MEASURED on `main` @ `7cfe603` (2.20.0).
- `lib/os-dialog.ts` read any failure of the dialog program as "no channel" on Windows, and on Linux
  and macOS a program with no exit status, an unexpected exit code or unexpected output.
  `lib/request-gate.ts` then approved through `approval_modes.trust_allowed_for` for the tools that
  can still be listed: the phase completions, `rsct_phase_abandon`, `rsct_capture_issue`. ADR-027
  named this as given up; ADR-030 had already closed it for the five tools that always force the
  dialog.
- On GitHub's hosted runners, measured from a temporary private repository: the Windows
  (win25-vs2026) and macOS (macos26) runners have a desktop, so a real dialog opens and waits; the
  Ubuntu runner has no zenity, so the program is missing. None of them reaches the failure path, so
  narrowing it changes nothing there.
- zenity 4.0.1 (Ubuntu 24.04) with no display exits 1 with "Failed to open display" on stderr,
  which read as the developer's No: `dialog_no`, and run-alone then dropped the phases closed on their
  own.
- The Windows dialog script relied on PowerShell command lookup.
- Node's error message repeats the program's arguments, and on Linux the dialog text is one of them,
  so a classification can read the exit status, the error code and stderr, never the message.

**Decision**:
- `DialogResponse` gains `failed`. `no-channel` is left only for: text over the limit (refused, as
  before), an unsupported platform, a dialog program that is not installed (`ENOENT`, from the error
  code), and a Windows session with no desktop. For the last one the script checks
  `[Environment]::UserInteractive` right after turning module autoloading off and writes a fixed word;
  it counts only with
  exit code 0 and an exact match.
- Every other ending that is not a clear Yes or No is `failed`. On Windows, a non-zero exit or any
  unexpected output. On macOS, no exit status, a non-zero exit whose stderr is not the user-cancel code
  `(-128)`, or unexpected output. On Linux, an exit code other than 0 or 1, no exit status, or exit 1
  whose stderr says zenity could not open a display.
- The gate consults `trust_allowed_for` only for `no-channel` exactly. `failed`, and any value it does
  not know, is refused as `dialog_failed` on the forced and the normal path, with a reason that says
  the list does not apply. Run-alone keeps the pending phases on `dialog_failed` (only `dialog_no` is
  a decline); the REVIEW's unverified-files question stays undecided and records no answer;
  `rsct_phase_code_start` writes `run_alone.declined` for it, as it does for a missing channel.
- The Windows script turns PowerShell's module autoloading off first and calls only .NET: it loads
  `System.Windows.Forms` by its full name and writes its answer through `[Console]::Out`.
- zenity gets its exit codes explicitly (`ZENITY_OK=0`, `ZENITY_CANCEL=1`, `ZENITY_ESC=1`,
  `ZENITY_ERROR=255`, `ZENITY_TIMEOUT=5`).

**Direction**: stricter; nothing is looser. A Windows host where the dialog program starts and fails
no longer reaches `trust_allowed_for`: PowerShell restricted (Constrained Language mode under
application control), or a dialog program that cannot start; on Linux and macOS the same holds for a
dialog program that was stopped. zenity with no display and macOS errors were already refusals; they
no longer count as the developer's decision. What is recorded changes in one value: such a failure
is `dialog_failed` in the `*.rejected` lines instead of `dialog_no`, `no_channel` or
`force_dialog_no_channel`, or instead of an approval through `trust_allowed_for`; the event names stay
the same. Unchanged: GitHub's runners, a missing dialog program, a system with no supported dialog
program, a Windows session with no desktop.

**Alternatives considered**:
- Linux with zenity and no display as "no channel", like Windows with no desktop — rejected: it is a
  refusal today, and the display can be broken from the user's own files, so it would loosen the gate.
  The two systems differ on purpose.
- Pinning the child's module settings — rejected in V: a script that calls no PowerShell command does
  not depend on them.
- A timeout on the dialog — not taken: the dialog waits for the developer by design.

**What is given up, by name**: a Windows session with no desktop was not measured (the check rests on
.NET's documented behaviour; GitHub's Windows runner answers True). macOS was not measured (no Mac):
the `(-128)` rule and the "no GUI session" case are documented. zenity's exit-code variables are
documented, not measured. A visible desktop nobody watches still waits. Another process of the same
user acting on the dialog, and whoever controls the server's environment, stay as in ADR-027.

**Consequences**: tests in `tests/unit/os-dialog.test.ts` (each platform's endings, the fixed script
preamble, the explicit zenity exit codes, a real missing program read through `defaultExecutor`),
`tests/integration/os-dialog-real.test.ts` (Windows: a session with no desktop is no channel and
nothing after the check runs), `request-gate.test.ts`, `run-alone.test.ts`, `review-sweep-gate.test.ts`.
Edited tests, each with the guarantee it held: the three missing-program fakes now carry `code`
(missing program is still no channel); the "unexpected output or exit code → no channel" cases now
expect `failed` ("unexpected is never Yes" still holds, and trust is no longer reached); the Windows
echo follows the script's new last statement; the `ceremony-gate` and `phase-verification-complete`
fakes returned `'unavailable'`, a value the dialog never returns, and now return `no-channel` (the
refusal they pin is unchanged). No hook script bundled into projects contains the dialog code
(measured in `dist/scripts/`), so the installer and an IDE restart are enough; no `/rsct-setup`.

### ADR-035 — Five conduct rules §I–§M ship on by default and are switched only through one setup block; §G and §C ask which database a test or migration reaches (#129, 2.21.0)
**Status**: active. Since 2.22.0 (ADR-038) the terminal guard backs §G mechanically: it refuses commands that change a database and, in a Laravel project, a test run whose phpunit configuration does not force a disposable database.
**Tags**: rules, setup, uninstall, cross-os

**Context**: MEASURED on `main` @ `1181794` (2.20.1), unless marked.
- None of the five rules of #129 shipped. A shipped rule is a marked `RSCT-§X` section of the
  project's `CLAUDE.md`, kept current by `sha256-body` in setup 4.3b. The server never reads rule
  sections, and the `.rsct.json` top level strips unknown keys, so a new key needs no server change.
- The section ids were written out by hand in seven places across setup and uninstall.
- Setup's `extract_json_array` gives the same empty result for a missing key, for `[]` and for a list
  spread over several lines.
- A section hash taken without the trailing newline 4.3b adds (`printf '%s\n'`) reads as "edited
  after install" after the next rule change, and the section then stops updating.
- REPORTED (Laravel sources, read, not run): tests that use `RefreshDatabase` run `migrate:fresh`
  on the test connection unless it is in memory; laravel/laravel 10.x ships the in-memory lines of
  `phpunit.xml` commented out, so tests use the database in `.env`. A developer reported an agent
  suggesting that test command in a real project where it would have wiped a database that was not
  a disposable test one.
- MEASURED in REVIEW on the first version of the block: splitting `CLAUDE.md` on one line ending
  for the whole file glued the LF lines of a mixed file onto the line before them, so switching a
  section off removed the developer's text after it and printed OK; the terminal guard refuses
  `node -e "$VARIABLE"` (it cannot read the code), so every node script of the block is written out
  inside a shell function.

**Decision**:
- Five sections, one file each in `rules/`: §I critical review, §J short answers, §K questions in
  the chat text, §L verify before claiming, §M an RSCT reference in commits, ADRs and issues. The
  maintainer's texts in #129, adjusted in S and V: third person ("the developer"); §I states a
  disagreement once, then follows the developer's decision, and a gated action still needs its own
  OK (§C); §J's length limit is for chat answers, not for recorded files nor for the reports, plans
  and questions RSCT's rules, prompts and tools require; §K keeps those required questions and says
  RSCT's Yes/No approval windows are not the option box; §L's checks that back a claim change
  nothing outside a disposable test environment, and a shared or production system is checked only
  with the developer's OK; §M's trailer sits in
  the commit's trailer block and counts toward `commit_message_max_lines`, the message is shortened
  and the cap never raised, and with a cap of 1 the trailer is left out; the ADR and issue line ends
  the text the agent writes (a tool may add its footer after it). English, the repository's
  language; the chat language stays the user's choice. No memory entries for them.
- `.rsct.json` `conduct_rules_off` lists the ids switched off; `[]` means all on. Setup asks once,
  when the key is absent.
- Setup Phase 4.4c is the only step that adds or removes §I–§M (4.3b keeps their bodies current)
  and the only writer of that key. It takes the whole new off-list
  (`none` = all on; unset keeps the stored list), accepts only `I`–`M`, reads the key with a
  read-only `JSON.parse`, and stops with nothing changed on any other id, on a stored value that is
  not such a list, on malformed markers, on a missing rule file, a missing file or a symbolic link.
  Without `CONDUCT_APPLY=1` it only reports. It writes `CLAUDE.md` first — a section switched on goes
  after the nearest earlier RSCT section, with the hash 4.3b computes — then `.rsct.json`, and checks
  both after writing. Every line keeps its own line ending, as in the uninstall. A section switched
  off goes whole when its `source=` is exactly framework text; any other value, no `source=` or more
  than one is the developer's own text, and switching it stops the block so the developer edits it
  by hand and asks again (keeping its body would leave the rule in force, and switching it back on
  would add a second copy). A `CLAUDE.md` that is not valid UTF-8 text stops the block.
- Setup 4.3b's splice and uninstall 4.2 also gain the UTF-8 stop, and 4.3b splices line by line
  with the section's own line ending, so a section in a file with mixed line endings can still be
  updated (before, its splice could fail on every run, safely).
- §0 item 10: the developer can ask in the chat to switch rules; the agent runs the block without
  `CONDUCT_APPLY` first, restates what it reports (an edited body that would go with a section
  included), waits for the OK, applies, and logs it in the progress file when a plan is active;
  with a phase open it waits until the phase closes. Never on its own initiative.
- §C's override covers §A–§M. §G asks which database a test suite, migration, seed or reset
  reaches, before running or suggesting it; §C's authorization list keeps "Execute migration in
  real environment" and adds running those commands, or a test suite, against a database not known
  to be a disposable test one; the memory entry for §C says the same.
- Every section id list in setup and uninstall carries §I–§M, pinned to `SECTION_RULES` by a test.

**Direction**: stricter or neutral; nothing is looser. The rules and the §G/§C text are new
instructions, and no gate changes. The switch can remove only §I–§M; an id outside them stops the
block. Whoever can edit `.rsct.json` or `CLAUDE.md` could already delete these sections by hand, and
both files show the change in the diff. What is recorded: one new `.rsct.json` key; the audit log is
unchanged.

**Alternatives considered**:
- Memory entries for the five rules — dropped in S: one source per rule.
- A fixed phrase in chat answers (the issue's rule 5, item 2) — dropped in S: the chat language is
  the user's choice.
- Rule 5 as a check in `rsct_request_commit` / `rsct_capture_issue` — not taken: text only.
- Placeholders for §I–§M in the CREATE template — rejected in V: two writers, and a placeholder left
  behind for an id switched off.
- The database text inside §L — rejected: §L can be switched off, and a safety rule must not be.
- A ban on a named test command — rejected: other stacks have the same shape; the rule asks which
  database a command reaches.

**What is given up, by name**: the rules are text; nothing blocks an agent command, or a
recommendation, that reaches a production database — that is #84. A section switched on lands after
the nearest earlier RSCT section, so in a `CLAUDE.md` laid out by hand it can land mid-file. A
framework section switched off is removed whole, a body edited after install included: the block
names that case before anything is written, and the edit is lost unless it was committed. The
switch writes no audit line; the diff of `CLAUDE.md` and `.rsct.json` is the record. Switching §L
off also drops its lines on checks that change nothing and on the OK for production; what destroys
data stays in §C and §G, which cannot be switched off. Like 4.3b and the uninstall, the block reads
markers at column 1 even inside a fenced code block; like the uninstall, it drops text written after
an END marker on the same line; and it drops a byte-order mark from `.rsct.json` when it writes the
key. Other setup and uninstall steps that rewrite `CLAUDE.md` (setup 4.2 Step E, uninstall 4.3b)
still replace bytes that are not valid UTF-8 — a gap from before this change, left as it was.

**Consequences**: tests in `tests/bash/conduct-rules.test.ts` (report only without
`CONDUCT_APPLY`; insertion order; 4.3b reads what it wrote as up to date and updates it after a rule
change; off and back on gives the same bytes, with and without a final newline; a rerun says
nothing changed; ids outside I–M; invalid stored values; a second key; a list over several lines or
in another order; malformed markers; CRLF with a byte-order mark; LF lines inside a CRLF file and
the reverse; a section the developer owns stops it; a `CLAUDE.md` that is not UTF-8 stops it and
4.3b; 4.3b updates a section in a mixed file; `.rsct.json` in CRLF, another indent or one line,
with the key name as a value elsewhere, or with a byte-order mark; a blank list; a stale marker
hash; a missing rule file; no RSCT section; symbolic links; an edited body named; the rule file
list), `setup-claude-md.test.ts` (the conduct sections count by their markers, and rule
keywords inside them never read as another rule), `uninstall-claude-md.test.ts` (a `CLAUDE.md`
setup created with §I–§M on is still deleted, and the dry run says so; a `CLAUDE.md` that is not
UTF-8 is left byte for byte), `uninstall-inventory.test.ts`
(every id list equals `SECTION_RULES`), `terminal-guard-prompts.test.ts` (unchanged; it caught the
node code passed through a variable). Edited tests, each with the guarantee it held: the
default-removal list test expects 14 ids (it still pins the uninstall default to `SECTION_RULES`);
the classifier's rule pattern widens to `[0A-M]` and "every rule missing" lists §I–§M (a
`CLAUDE.md` with no rules still reads every rule missing); the uninstall fixture's placeholder
pattern widens to `[0A-M]` (it still fills only the template's placeholders, which stay §0–§H).
Migration: `/rsct-setup` asks once, adds the sections that are on, records the key, and updates §0,
§C, §G, two memory entries and the anti-decisions knowledge file wherever they were not edited.

### ADR-036 — The terminal guard reads code piped into a shell, git written inside another program's arguments and the package scripts a manager runs; the push tool sends an explicit refspec and reads a protected first push from a dry run (2.22.0)

**Status**: active. Extends ADR-028 (the terminal guard) and ADR-031 (the push dialog).

**Tags**: gates, hooks, terminal, push, cross-os

**Context**: MEASURED on `main` @ `94eb8ad` (2.21.0), built guard and real git, throwaway repos.
- The guard (ADR-028) read a git verb only where git ran as a program. It did not read: code piped
  into a shell or interpreter (`echo '…' | sh`, `printf … | python3`, `… | iex`); a git call
  written inside another program's argument text (psql `\!`, sqlite3 `.shell`, mysql `system`, awk
  `system()`, `vim -c '!…'`, a `git -c core.sshCommand=…` value); or the package scripts a manager
  runs (`npm run release`, where `release` is `git push`). Each let the AI reach a gated verb with
  no dialog. MEASURED on the shipped guard.
- Two regexes (CODE_GIT_TEXT, CODE_GIT_ARGV) and CODE_GH_MERGE backtracked exponentially: a crafted
  interpreter string of ~12 repeated option tokens took 9 s, and ADR-028 reads any guard outcome
  other than "refused" as letting the call through, so a slow input is a bypass.
- The push tool ran `git push <remote> <branch>`. A `remote.<name>.push` mapping could send that to
  another branch (MEASURED: a `feature` push updated `main`). The coverage check (files_swept) read
  `git diff <remote>/<dest>...<source>`, which a local branch literally named `origin/main` made
  ambiguous and empty, and which a first push to an empty remote skipped silently.

**Decision**:
- **G1 (bounds).** The three code regexes are rewritten linear (a possessive/anchored shape, no
  nested quantifier over the option run). A command over 64 KiB (`MAX_COMMAND_BYTES`) or a single
  command over 2048 words (`MAX_COMMAND_WORDS`) is refused with a message pointing at the Write tool;
  judging runs under a 5 s budget (`denySlow`). A folder path over 4096 chars reads as unknown.
- **G2 (code read from a pipe or another command).** The lexer marks pipe elements and `<(…)`
  process substitutions. A program that runs what it reads — a POSIX shell reading stdin or a
  procsub script, `source`/`.` of stdin, PowerShell `-Command -`/`iex` with no argument, `cmd`
  without `/c`, an interpreter with no script, `at`/`batch`, `su` without `-c`, `ssh` with no
  command, `xargs` targeting a shell or git, docker/podman/kubectl exec's inner command — is refused
  when it is piped into or given a procsub, naming the program and asking for the commands written
  out. `curl … | sh` and `iwr|iex` are refused and named.
- **G3 (git in argument text).** At a program position that is not itself re-read as a shell, the
  guard searches the program's argument values and heredoc bodies for a git gated verb or `gh pr
  merge`, with exemptions: text-only programs (echo, printf, cat, tee, grep family, rg, curl, jq,
  yq, gh, glab, the PowerShell output cmdlets), programs the guard already parses as shell, shell
  test/declaration builtins, and PowerShell statements whose first word is a variable, operator or
  literal. For `git` only `-c`/`--config-env` values and `git config` values are searched (they can
  store a program a later git runs); for `find`, each `-exec` span is judged by its program.
- **G4 (package scripts).** An npm/pnpm/yarn/bun/composer call is resolved to the scripts it runs —
  the script-name position(s) per manager plus the lifecycle hooks of install/test/start/restart/
  publish/pack/version and composer's install/archive events — read from the package.json/
  composer.json found by walking up from the call's folder, and each script's text is judged by the
  same guard (depth-bounded, memoised, sharing the byte budget). Folder changes are tracked across
  `cd`/`pushd`/`popd` and the PowerShell equivalents, with a subshell or pipe element not carrying a
  change out; after a folder change the guard cannot read, the starting folder is judged. A
  workspace-wide run judges that script in every package file under the repository root (bounded
  listing; an incomplete listing is refused). `npm|pnpm|yarn version <new>` without
  `--no-git-tag-version` is refused as a commit. Exec forms (`npx`, `pnpm|yarn exec|dlx`, `bunx`,
  `bun x`, `npm exec`, `-c`/`--call` strings, a non-builtin word) judge the executed command. A
  command that writes a package file and runs package scripts that read the same folder, in one go,
  is refused (the guard reads the scripts before anything runs). A write-only call (`npm init`,
  `npm pkg set`, `composer config <k> <v>`) and a global call (`-g`) run no project script. A
  PowerShell call operator (`&`/`.`) is read through to the program it invokes. A `~N.JSO`/`~N.YAM`
  8.3 short name counts as the package file it stands for.
- **Push (G4/push).** `rsct_request_push` now always sends an explicit full refspec
  `[+]<sha>:refs/heads/<dst>` (or `:<ref>` for a delete), built from the parsed request and the SHA
  the dialog shows, so a `remote.<name>.push` mapping cannot redirect it; a bare source prefers
  `refs/heads/<name>` over a tag of the same name. For a PROTECTED destination with no
  `refs/remotes/<remote>/<dst>`, it runs `git push --dry-run --porcelain --no-verify -- <remote>
  <refspec>` (no prompts: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, askpass/credential helper
  blanked, 20 s) and takes the carried files from it — the whole tree for a new branch or unknown
  old tip, else `diff <old>...<sha>`. The carried set must all be in `files_swept`, before any
  dialog; over `MAX_FILES_SWEPT` (2000) the push is refused, by hand. A probe that git ends other
  than exit 0/1 is unavailable → today's degraded proceed plus a framework line in the dialog (which
  does not claim "whole branch" for a delete). A probe that parsed but whose files cannot be read is
  refused `hygiene_range_unreadable`, as merge and rebase do. The range base is fully qualified
  `refs/remotes/<r>/<d>`.

**Direction**: stricter; nothing new is allowed. Every bash block in `prompts/` still passes
(pinned). Quoted text a program only prints or searches still passes (`echo "git push"`, `grep "git
commit"`). The push always sends the refspec the dialog showed.

**What is given up, by name**: a script file the agent writes and runs (ADR-028); ORM calls in
application code; release tools run as their own binary (`release-it`, `semantic-release`); a PHP
callback in a composer script; a dependency's own scripts; Makefile/justfile/turbo/nx/lerna targets;
a package file written by a program that does not name it (an archive, a folder copy, a download);
a workspace package nested deeper than the listing bound; a folder change inside a background job;
a config changed between the push probe and the push; a stale or hand-forged
`refs/remotes/<r>/<d>`, which makes the coverage check read an empty range (the push dialog still
opens — defense in depth, not the primary gate; tracked for a follow-up).

**Consequences**: `tests/unit/terminal-guard-pipes.test.ts`, `-arguments.test.ts`, `-packages.test.ts`,
`-limits.test.ts`, the existing `terminal-guard*.test.ts` and `-prompts.test.ts`;
`tests/unit/request-push.test.ts`, `-destination.test.ts`, `push-refspec.test.ts`; a named mutant per
rule. A project set up before 2.22.0 keeps the old guard until `/rsct-setup` runs again (the guard
is a bundled copy in `.rsct/scripts/`); the push tool updates with the installer and an IDE restart.

### ADR-037 — The REVIEW accepts comments that predate the rule on the first commit of a branch only (#130, 2.22.0)
**Status**: active.
**Tags**: review, gates, comments

**Context**: MEASURED on `main` @ `94eb8ad` (2.21.0), real git.
- A repository with no commit yet, whose first-party files carry comments written before the
  no-comments rule, could not reach its first commit through RSCT: `rsct_phase_review_complete`
  rejected them (`comments_remaining`; the sweep compares against the empty tree when there is no
  HEAD), `exempt_files` accepted only `generated | vendored`, and the only RSCT path was a false
  `vendored` attestation. The other path was the developer committing by hand, with no secret scan,
  no branch check and no audit.
- `git symbolic-ref HEAD refs/heads/x` makes any repository look like "no commit yet" on branch x,
  and an unverified decision is keyed by (path, blob), so a decision taken on such a faked unborn
  HEAD would let the same file version commit later on a branch that has commits (found by a
  refuter, confirmed by reading `review.ts` and `free-commit.ts`).
- Second item of #130 (a protected first push skipped the coverage check): see ADR-036.

**Decision**:
- `exempt_files` gains a third reason, `legacy_baseline`. The REVIEW accepts it only when HEAD is
  positively unborn: `git symbolic-ref -q HEAD` names a `refs/heads/` branch and `git show-ref
  --verify --quiet` of that ref exits 1. Any other answer (detached HEAD, a ref that exists, a git
  error) refuses with `legacy_baseline_refused`, before any dialog.
- The files go to the developer-only unverified dialog, bound to their exact versions, like
  `generated`/`vendored`. Before the agent's text, the dialog names the branch, the number of
  commits the repository already has on its other refs (`rev-list --all --reflog --count`), the
  comment count per file, and says RSCT did NOT check that the comments predate the rule.
- A `legacy_baseline` decision (`review.unverified_decision`, reason `legacy_baseline`) is kept
  apart from the generic (path, blob) decisions and honoured by `rsct_request_commit` only while
  HEAD is still unborn. Once the branch has a commit, the same file version with comments is refused
  (`comments_present`).

**Direction**: neutral to stricter. The same developer-only channel as `vendored`, with a narrower
reach (the first commit of a branch only) and more information in the dialog. Nothing new is
recorded: the decision is the existing audit event with a new reason value.

**What is given up, by name**: RSCT does not check the comments are older than the rule; the
developer reads that in the dialog. An orphan branch's first commit qualifies (the dialog shows the
repository's commit count, so a large number tells the developer the branch is not a new project).

**Consequences**: `tests/unit/review-legacy-baseline.test.ts` (first commit, refused once born,
not carried to a branch with commits, orphan branch, declined dialog, the git answers read one by
one).

### ADR-038 — The terminal guard refuses commands that change a database; a Laravel test run needs a disposable test database; the developer switches these rules in `.rsct.json` (#84, 2.22.0)
**Status**: active. Extends ADR-028 (the terminal guard) and ADR-035 (§G "Which database?").
**Tags**: gates, hooks, terminal, database, cross-os

**Context**:
- REPORTED (2026-10-22, a developer using RSCT): an agent suggested `php artisan test` in a project
  whose tests used `RefreshDatabase` against the database in `.env`; run, it would have wiped a
  database that was not a disposable test one. 2.21.0 added §G "Which database?" and a §C line —
  text only.
- The terminal guard (ADR-028) already reads what the agent's tools run, including nested shells,
  heredocs and, since ADR-036, the package scripts a manager runs. A database rule set plugs into
  the same reading.
- Refuters, before the code (2026-10-24/25): a grant per exact command (a tool that approves a
  database command) is looser — the agent can write the grant file in one command and change `.env`
  between the approval and the run; the rule set must be a CLOSED read-only allow-list, not a write
  deny-list; redis, mongosh and sqlite are not SQL and need their own readers; `php artisan`,
  `python manage.py`, `rails`/`rake`, `bundle exec` must be mapped to their tools explicitly; a
  statement in a variable, a file, stdin or a pipe cannot be read and is refused; MySQL `/*! */`
  comments run; the Laravel check must fire only on a Laravel project; two hook registrations would
  do the expensive reading twice per command.
- MEASURED in PHPUnit's source (`src/TextUI/Configuration/Xml/Loader.php`, `booleanFromString`):
  the `force` attribute counts only when it reads `true` (any case); `force="1"` is not forced.
- REVIEW (3 reviewers, 2026-10-25): wrapped commands passed unread (`docker compose exec`, `sail`,
  `herd`, `dotenv`, `cross-env`, `php8.3`, options before the artisan command); `.env.testing` is
  loaded without overwriting variables already set, so a value there loses to the environment;
  PHPUnit loads only the first configuration file it finds.

**Decision**:
- **Refuse only** (no approval tool): the developer runs a refused command in their own terminal.
- A database **client** (psql, mysql, mariadb, mysqlsh, sqlite3/sqlite, mongosh/mongo,
  redis-cli/valkey-cli, cqlsh, clickhouse-client, sqlcmd, mssql-cli, usql) is refused when its statement changes data or
  schema, or cannot be read. SQL: comments and quoted text removed (MySQL `/*! … */` kept as code),
  each `;`-separated statement must start with a read keyword (select, show, explain, describe,
  with, values, table, pragma, use, transaction control, a closed list of session `set`s) and carry
  no data- or schema-changing keyword; `SELECT … INTO <table>`, `FOR UPDATE/SHARE`, `EXPLAIN ANALYZE`
  and psql meta-commands other than a closed read list (`\d…`, `\l`, `\conninfo`, …) are refused;
  meta-commands that run a shell or read a file (`\!`, `\i`, `\copy`, `\gexec`, sqlite `.shell`,
  `.read`, mysql `system`, sqlcmd `:r`/`:!!`) are refused. redis by verb (writes, `SORT`/`GEORADIUS`
  with `STORE`, `GETEX` with an expiry, `--eval`, `-x` refused); mongosh by method
  (insert/update/delete/drop/findAndModify/…, `$out`/`$merge`, `require`/`eval` refused); sqlite dot-commands by a closed read list. A statement from `-f`/`-i`/`--file`, `<`, a
  pipe or a variable is refused; a heredoc's statements are read. A bare client (an interactive
  session) passes.
- **Migration, seed, reset, wipe and restore** commands are refused by closed per-tool lists:
  prisma, sequelize, knex, typeorm (and `typeorm-ts-node-commonjs|esm`), drizzle-kit, alembic
  (`upgrade|downgrade|stamp`; `--sql` only prints and passes), flyway, dbmate, goose, atlas,
  node-pg-migrate, db-migrate, golang-migrate, sqlx, diesel, phinx, supabase, `wrangler d1
  migrations apply`, pscale/planetscale deletes, mikro-orm (and `mikro-orm-esm`); the libpq utilities
  `dropdb`, `createdb`, `vacuumdb`, `reindexdb`, `clusterdb`, `dropuser`, `createuser`;
  `mysqladmin`/`mariadb-admin` `drop|create|shutdown|kill|password|reload|refresh|flush-*` and
  replica control (`status`, `ping`, `processlist` pass); Laravel `artisan
  migrate*`, `db:wipe`, `db:seed`, `tinker --execute`; Django (`manage.py`, `django-admin`,
  `python -m django`) `migrate|flush|loaddata|reset_db|createcachetable`, `shell -c`, `dbshell --
  …`, while `sqlmigrate`, `sqlflush` and `migrate --plan|--check` only print and pass; Rails and
  rake: any task that is, or sits under, `db:migrate`, `db:rollback`, `db:drop`, `db:create`,
  `db:reset`, `db:setup`, `db:prepare`, `db:schema:load`, `db:structure:load`, `db:seed`,
  `db:purge`, `db:truncate_all`, `db:fixtures:load` (`db:migrate:redo`, `db:seed:replant`,
  `db:migrate:primary`), except a `:status` task, plus `rails runner|r`; Flask `db
  upgrade|downgrade|migrate|stamp` unless `--sql`; `mysqlimport`, `mongoimport`, `mongorestore`, and
  `pg_restore` with `-d`/`--dbname` (without it, it writes a script). `wrangler d1 execute` and
  `turso db shell` statements go through the SQL reader; `--file`, stdin and pipes are refused;
  `pscale shell` with `--execute` or piped input is refused. Status, list, diff and generate
  subcommands pass.
- **Unwrapping**: the guard reads the command a wrapper runs — `php[version] artisan` (options such as
  `--env` before the subcommand), `python[version] manage.py`, `./manage.py`, `python -m
  alembic|flask|django`, `bundle exec`, `ruby rails|rake`, `flask --app … db`, `docker|podman exec|run`
  and `docker container exec` (global options such as `--context` skipped), `docker compose`,
  `docker-compose` and `podman-compose` `exec|run` (global options such as `-f`/`-p` skipped),
  `kubectl exec --`, Sail (`sail test|dusk|tinker` are artisan; `sail mysql|mariadb|psql|redis|mongodb`
  are the clients; `sail bin <tool>`; any other `sail <program>`), `herd`, `winpty`, `cross-env
  VAR=…`, `dotenv … --` (without `--`, both readings of its options are judged). A command
  through more than eight such wrappers is refused, as too many to read.
- **Consoles fed from a pipe or file**: `artisan tinker|db`, `rails console|c|dbconsole|db`,
  `manage.py shell|dbshell|shell_plus` and `flask shell` reading stdin are refused; typed
  interactively they pass.
- **Containers**: compose `down|rm` with `-v`/`--volumes` (also clustered, `-fsv`), `docker volume
  rm|remove|prune`, `docker system prune --volumes`, `podman system reset`, `docker [container]
  rm|remove` with `-v` are refused, global options skipped.
- **Laravel test run** (`php artisan test|dusk`, `phpunit`, `pest`, `paratest`): fired in a Laravel
  project (`laravel/framework` in a readable composer.json, or an unreadable one, next to an
  `artisan` file), found from the script's own path first and then from the current folder.
  Refused unless the phpunit configuration PHPUnit would load forces (`force="true"`, any case,
  either quote style, any attribute order, comments ignored) a disposable database: a forced
  `DB_DATABASE` of `:memory:` with a forced `DB_CONNECTION=sqlite`, or a forced `DB_DATABASE` whose
  name carries a `test`/`tests`/`testing` word. The configuration is the one named by
  `-c`/`--configuration` (a folder means the files inside it), otherwise the first of
  `phpunit.xml`, `phpunit.xml.dist`, `phpunit.dist.xml` that exists, in the folder phpunit runs in
  (`artisan test`: the project root); one that cannot be read refuses. `.env.testing` does not
  count. Also refused: a forced non-empty `DB_URL`/`DATABASE_URL`; one set in `.env` or
  `.env.testing` and not forced in phpunit.xml; `--no-configuration`; a configuration path from a
  variable; a folder the guard lost track of; `artisan dusk` (it swaps in its own environment
  file). Runs that run no test (`--version`, `--help`, `-h`, `--list-*`) pass. The refusal names the
  lines set without `force="true"` and the two lines to add.
- **Package scripts**: a database command in an npm/composer script is refused like one typed in
  the terminal (ADR-036 reads the scripts). Composer's create-project events count only for
  `composer create-project`; `--no-scripts`/`--ignore-scripts` skip the hooks but not the script
  named on the command line nor npm's `test|start|stop|restart`; a `true`/`false` after an npm-style
  flag is that flag's value.
- **Escaped dollar**: inside double quotes, `\$` (bash) and `` `$ `` (PowerShell) are text, so the
  statement is read instead of refused as built from a variable.
- **Switches**: one hook, one reading. `.rsct.json` `database_guard: false` turns the database rules
  off, `database_test_guard: false` turns only the Laravel test check off; absent, unreadable or
  any other value = on. The file is the nearest `.rsct.json` walking up from `CLAUDE_PROJECT_DIR`,
  or, when the host does not set it, from the folder the tool call reports — not from a folder the
  command `cd`s into. Switching off is the developer's own edit, protected like `disableAllHooks`
  (ADR-028): the edit guard refuses an Edit/Write/MultiEdit of `.rsct.json` (by any spelling of the
  name) that sets either key to false (`rsct_config`), also when the current file is not valid JSON;
  the terminal guard refuses a command that names either key, also written with a unicode escape;
  `rsct_status` reads the switches the same way the hook does, whatever the rest of `.rsct.json`
  says, and tells the developer when one is off. Turning a key back on by editing `.rsct.json` is
  allowed (the edit guard permits it); a terminal command that names either key is refused either
  way, so the developer makes that edit in their own editor.
- **Exact edits**: an Edit or MultiEdit of `.rsct.json` or of a Claude Code settings file whose old
  text is not found exactly in the file is refused, because the guard cannot tell what the edit tool
  would write.
- §C, the §C memory entry and setup 4.V.e say what is refused and who switches it.

**Direction**: stricter. Nothing that was refused passes. Every bash block in `prompts/` still
passes with the database rules on (pinned).

**Alternatives considered**:
- A grant per exact command through a new tool — looser (the agent can write the grant file and
  change `.env` between approval and run).
- The tool runs the database command itself — the strongest, but the server would need the agent's
  shell (Git Bash, PowerShell, WSL) to run arbitrary command lines; left for later if refusing
  proves too strict.
- A second hook registration for the database rules (the first plan) — the same toggle at twice
  the cost per command (package files, aliases and phpunit.xml read twice); replaced by the
  protected `.rsct.json` switch.
- Reading `docker-compose.yml` to learn which database a container test uses — would err towards
  allowing; inside a container only phpunit.xml's forced values count.

- Counting `force="1"` as forced, or a forced sqlite connection without a forced database as
  disposable (both proposed in REVIEW) — looser: PHPUnit does not force on `"1"`, and sqlite without
  a forced database falls back to the project's own `database.sqlite`.
- Accepting `.env.testing` — looser: a variable already set in the environment wins over it.

**What is given up, by name**: a function called inside a SELECT that writes (`SELECT my_func()`)
— a leading-keyword reader cannot tell; an interactive client session (what is typed after it
opens); ORM calls in application code; a script file the agent writes and runs (ADR-028); recipe
and task runners (`make`, `just`, `task`, `turbo`, `nx`) and composer callbacks; database MCP
servers' tools; startup files (`~/.psqlrc`, `my.cnf`); a statement interpolating a shell variable
is refused even when the variable only holds a value (friction, by choice); `COPY … TO STDOUT` and
`EXPLAIN ANALYZE SELECT` are refused (they read, but the guard cannot tell them from writes); a statement is read under every dialect reading (backslash escapes and `#` comments on and off), so a MySQL `#` comment or a backslash-escaped string that holds a write keyword is refused; a
Laravel test database configured only in code, or a `DB_URL`/`DATABASE_URL` set in the real
environment rather than in `.env`; a test database named without a `test` word; a container or
wrapper option that takes a value and is not in the guard's list (the next word is read as the
program); a command handed to a tool as one string (`cross-env-shell`, `make` recipes); with a
workspace filter (`pnpm --filter x`, `npm -w x`, `yarn workspace x`) every workspace's script of
that name is read, not only the filtered one (a refusal the developer may not expect, never a
pass); an application command that deletes rows without a migration/seed verb the per-tool lists
name (`php artisan model:prune`, `queue:flush`); an inline `DB_URL=…`/`DATABASE_URL=…` written on
the command line before a Laravel test run (an environment value, like one exported in the shell);
a migration tool invoked as a relative `.ps1` through the PowerShell call operator (`& .\x.ps1`); a
`.rsct.json` changed by a program that does not name the key (detected by `rsct_status`, not
refused).

**Consequences**: `tests/unit/database-guard.test.ts`, `database-laravel-test.test.ts`,
`database-switches.test.ts`, the prompt-block test now run with the database rules on, a named
mutant per rule. A project keeps the old guard until `/rsct-setup` refreshes `.rsct/scripts/`;
§C and the memory entry update through setup 4.3b like any rule change.

---

### ADR-039 — The commit secrets scan reads exactly what git will commit, and a read that fails refuses the commit (2.23.0)
**Status**: active. Extends INV-6 (the secrets scan).
**Tags**: gates, secrets, git, cross-os

**Context**: MEASURED on `main` @ `148f108` (2.22.0), git 2.45.1.windows.1, throwaway repositories.
- `getStagedDiff` ran `git diff --cached --no-color -U0`, which repository config and attributes
  can change. A staged `.gitattributes` marking the file `-diff`, a file with a NUL byte (git calls
  it binary), a `textconv` driver, `diff.external` in `.git/config` (empty output) or
  `GIT_EXTERNAL_DIFF` each produced a scan with zero findings, and the commit went through with no
  override.
- `diff.relative` and `diff.mnemonicPrefix` changed which files and which names the scan saw.
- The parser took an added line whose text starts with `++` for a file header, dropped the current
  file, and stopped scanning the rest of it.
- A git error, a timeout or an output over 16 MiB returned `null`, and the caller scanned an empty
  string.
- The key/value pattern backtracked quadratically on a long run of identifier characters: 40k
  characters took about 0.9 s, 256 KiB about 42 s, synchronously.

**Decision**:
- Every diff the secrets scan reads runs `git -c core.fsmonitor= -c diff.relative=false diff
  --no-color -U0 --text --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/
  --ignore-submodules=none`, on the staged changes (`--cached`), the working tree, or the two tree
  ids the commit records (ADR-040).
  - `diff.relative=false` is set through `-c` rather than `--no-relative`, which needs git 2.28 and
    exits 129 on an older git.
  - `core.fsmonitor` is set empty. MEASURED on git 2.45 and 2.43: an fsmonitor command in the
    repository config ran 4 times across `diff --cached` and `write-tree`, and 0 times with the
    empty value or with `false`. Before git 2.36 the setting is a command path, so `false` would
    run a program of that name; the empty value turns it off on every version (from git's
    source, not measured on an old git).
  - The read is streamed line by line into the scanner, so its size has no cap; it is bounded by a
    120 s time budget.
- File headers are recognised only outside a hunk: the hunk header's counts decide what is content.
  Each line loses its NUL bytes and one trailing carriage return before matching, so UTF-16LE text
  and lines stored with CRLF are read. A C-quoted path is decoded.
- `gitRepoStatus` tells a folder git definitively calls "not a git repository" (nothing to commit,
  an empty scan) from any other answer. A read that fails refuses the commit (`secrets_unreadable`,
  `staged_paths_unreadable`) and says to split the commit or commit by hand. `rsct_check_secrets`
  reports the failure in `read_error` instead of "no findings".
- The key/value pattern matches an atomic key run from the first letter of a run only. A test
  compares its matches with the previous pattern on 60,000 seeded lines plus hand-written shapes,
  and checks that the time grows linearly.
- The staged path list (`--no-renames`) carries both sides of a rename. The range reader keeps
  `--diff-filter=d`, because deleted files cannot be swept.

**Direction**: stricter. Every input that produced zero findings now produces the findings git
would commit, and every read that failed now refuses.

**What is given up, by name**:
- Content that lives outside the repository is not scanned: Git LFS and git-annex store a pointer.
- A file encrypted on the way in (git-crypt) is scanned as ciphertext.
- A clean filter's output IS scanned, because the scan reads the staged blob.
- With `--text`, a genuinely binary file is scanned as bytes; a credential-shaped byte run can raise
  a false finding, which the developer answers in the dialog.
- `secrets_extra_patterns` are the developer's own regexes and are not bounded.

**Consequences**:
- `tests/unit/secrets-scan.test.ts`: the parser, normalisation, quoting, the seeded equivalence and
  the linear-time ratio.
- `tests/unit/secrets-git-reads.test.ts`: each blind spot above in a real repository, every refusal
  path, and the real-repository read that the injected git executor does not replace.

### ADR-040 — The commit dialog shows every exception it is asked to approve, and the commit is exactly what was approved (2.23.0)
**Status**: active. Extends ADR-031 (dialog text order).
**Tags**: gates, dialog, commit, secrets, contracts

**Context**: MEASURED on `main` @ `148f108` (2.22.0), the real `requestCommitHandler` with the
dialog captured.
- The commit dialog showed the branch, fixed advisories, the repository line and the message.
- Branch protection, the secrets scan and the contract gate ran after the developer answered. The
  agent put `override_protected_branch`, `override_secrets_check` and `override_contract_surface`
  into the `dev_approval` it sent.
- A staged secret plus a pre-filled override produced one generic dialog and `committed`. Without
  the override, the dialog was shown and answered, and the commit was refused afterwards.
- A pre-commit hook that runs `git add` put a file the developer never saw into the commit.

**Decision**:
- Before any dialog, `rsct_request_commit` computes the protected-branch check, the secrets scan
  (ADR-039) and the contract surfaces. A check that needs an exception the request does not carry
  is refused before a dialog opens. The token path carries no exceptions, as before.
- The dialog shows, framework lines first:
  - the protected branch;
  - each secret finding as `"file":line — rule` (never the value), up to 10, with the full list in
    `.rsct/reports/commit-secrets-<sha16>.md`;
  - the contract surfaces and their declared consumers, up to 10 of each, with the full lists in
    `.rsct/reports/commit-contracts-<sha16>.md`;
  - an inactive contract gate.
  Then the agent's reason for each exception, quoted and flattened, then the commit message, last.
  A commit with nothing to approve beyond itself shows the same dialog as before.
- The staged tree (`git write-tree`), HEAD and branch are recorded before the dialog (or token).
  The secrets scan and the contract paths read that recorded tree against HEAD's tree (the empty
  tree for a first commit), so what is scanned is what was recorded. The same three values are
  read again right before `git commit`, after the existing sweep and dead-code re-checks; anything
  different refuses (`staged_changed`). A state that cannot be read refuses
  (`staged_state_unreadable`); a `write-tree` that finds `index.lock` is retried for about a
  second first.
- The branch is read from HEAD's symbolic ref. MEASURED: `rev-parse --abbrev-ref HEAD` fails on a
  branch with no commit yet, so the branch was unknown there and the protected-branch check did
  not apply. A first commit on a protected branch now needs the exception like any other commit
  there. The recorded branch must be the one the protection check and the dialog used; a branch
  switched in between refuses (`staged_changed`).
- After `git commit`, a commit whose tree or parent differs from what was approved returns
  `committed_with_drift`. RSCT scans the difference, and the hints and the audit log
  (`request_commit.tree_drift`) name the changed paths, how many secret findings they carry, and
  the command that undoes the commit (`git reset --soft HEAD~1`, or `git update-ref -d HEAD` for a
  first commit). Code files a hook changed stay under the existing `review_drift` lock. Other files
  are reported, not locked: a REVIEW stamps code files only, so a lock on a README or a JSON file
  could never be cleared. A commit RSCT cannot read back is `committed_with_drift` too, and so is
  a commit that lands with HEAD on another branch than the approved one (a hook that switched it;
  `request_commit.branch_drift`).
- MEASURED: a `pre-commit` hook that runs its own `git commit` makes RSCT's `git commit` fail
  (`cannot lock ref 'HEAD'`), while the hook's commit stays on the branch. When the commit fails
  and HEAD moved, the hints and the audit (`head_moved_to`) say so, the approval is recorded as
  used and a plan token's action is not refunded.
- When a report under `.rsct/reports/` cannot be written, the dialog shows the whole list instead
  of the first 10; a dialog over its size limit is refused, as every dialog is.
- `rsct_plan_authorize`, `rsct_request_merge` and `rsct_request_rebase` keep refusing a branch
  with no commit yet, as they did while its name could not be read.

**Direction**: stricter. The developer now sees in the dialog every exception the agent asks for,
the commit is refused if the staged tree, HEAD or branch moves after the approval, and a commit
that a hook changed is reported.

**What is given up, by name**:
- The developer's own git hooks still run on the commit; skipping them would weaken their checks.
- What a hook changes is caught after the commit, not before.

**Consequences**:
- `tests/unit/commit-dialog-exceptions.test.ts` covers, with real git:
  - the dialog lines, the overflow reports for secrets and contracts, and refusal before the
    dialog;
  - staging, a HEAD move and a branch switch while the dialog is open, a branch that differs
    from the one checked, a detached HEAD;
  - the first commit on a protected branch;
  - a hook that adds a file with and without a secret, and the undo hint (also on a first
    commit);
  - a hook that makes its own commit (and the approval it used), a hook that switches the branch,
    a commit RSCT cannot read back, a failed commit that leaves HEAD alone;
  - a report that cannot be written;
  - a formatting hook on a non-code file that does not lock later commits;
  - a hook that changes nothing.
- `tests/unit/secrets-git-reads.test.ts` covers the tree scan, the empty tree, the
  `index.lock` retry and a repository fsmonitor command that must not run.

### ADR-041 — The agent cannot add, change or remove any env entry in Claude Code settings (2.23.0)
**Status**: active. Extends ADR-028 (the settings write guard).
**Tags**: gates, hooks, settings

**Context**: READ on `main` @ `148f108`.
- The settings write guard refused only a fixed list of `env` keys (`NODE_OPTIONS`, `PATH`,
  `BASH_ENV`, `LD_*`, …).
- Keys that redirect Claude Code's traffic or trust (`ANTHROPIC_BASE_URL`, proxy and certificate
  variables, `NODE_TLS_REJECT_UNAUTHORIZED`) and `GIT_*` keys the MCP server inherits passed.

**Decision**:
- In `.claude/settings*.json`, every agent add, change or removal of an `env` entry is refused.
- The same applies when the write leaves the file unreadable with an `env` block in it.
- The per-key list is gone. An `env` block that the write leaves exactly as it was passes.

**Direction**: stricter. A developer who asks the agent to set an env value now edits the file by
hand.

**What is given up, by name**:
- The guard judges the agent's Write/Edit/MultiEdit calls only. A write from a shell script is not
  refused here (ADR-028).
- The guard is a hook: it reaches a project only through `/rsct-setup`.

**Consequences**: `tests/unit/settings-write-guard.test.ts` covers every env case. Two earlier
assertions said an ordinary env key and an env removal were allowed; by this decision they are now
refusals.

## Anti-decisions (tried, rejected, do not retry)

### AD-001 — Do not detect stale comments by diff heuristic
Issue #33: 163 findings, zero true positives, over four real commits. The diff the
approach needs does not exist (`getStagedDiff` / `getUnstagedDiff` pass `-U0`, so there are
no context lines for "adjacent to a changed line" to mean anything), and dead-code
detection is static analysis in a language-agnostic framework — the only import-graph tool
is hard-coded to JS/TS and yields zero findings forever in a Java project while charging
its runtime at every REVIEW. ADR-001 removes the need for the heuristic rather than
improving it.

### AD-002 — Do not add the `_start` tools to `trust_allowed_for`
Trust matches on the tool **name** (`request-gate.ts`), not on the action, so listing
`rsct_phase_code_start` would pre-authorise every code start rather than the bypass. The
bypass forces the dialog instead (premise #2).

### AD-003 — Do not use `git rev-parse --path-format=absolute`
It requires git ≥ 2.31 and the project declares no minimum git version anywhere, so a
capability failure would fail closed and brick every commit. The bare form returns a
relative `.git` for a plain repository and an absolute path elsewhere; resolving it against
the root yields the identical answer with no version floor.

### AD-004 — Do not use tree-sitter-html for the comment sweep
`tree-sitter-html` 0.20 and 0.23.2 report `<!-- -->` inside a quoted attribute value and
inside `<textarea>` as comments; removing them would cut real content. parse5 7
(spec-compliant) gets both right.

### AD-005 — Do not use tree-sitter-sql for the comment sweep
`tree-sitter-sql` 0.3.11 (no published WASM; built with `emscripten/emsdk:4.0.4`, 2.4 MB)
fails to parse 655 of 927 real `.sql` files, fails dollar-quoted bodies, nested block
comments, MySQL `#` and backtick identifiers, and reports
`-- inside body $$ LANGUAGE sql; -- real1` as one comment — deleting code. Comments in SQL
are lexical but dialect-specific: `#` only in MySQL, nested blocks only in PostgreSQL, MySQL
`--` needs a following space (`SELECT 1--1` is arithmetic), `/*! … */` is executable
code in MySQL, and 84 of 927 real files carry `--` inside dollar-quoted function bodies.

### AD-006 — Do not decide dead code by searching for the name
MEASURED on this repository: "named anywhere else in the project" produced **348 findings, 1 true
positive** — "else" drops the only evidence that keeps a module-private helper alive. Corrected to
"anywhere, own file included", a name still collides with an unrelated symbol of the same name, a word
in a comment or a string (`walk` occurs 113 times, `'walk through'` among them), and cannot see
through an alias or a re-export. MEASURED by mutation: an injected dead `walk` escaped, and a dead
callee hid behind its dead caller. ADR-018 resolves references instead.

### AD-007 — Do not copy the companion into npm's global tree
`npm install -g . --install-links=true`, and `npm pack` + `npm install -g <tgz>`, both leave a real
folder under npm's global `node_modules`. MEASURED on npm 10.9.2 (Linux) and 11.1.0 (Windows), in
isolated prefixes: npm then resolves that package BY NAME against the registry. `npm update -g`
exits 1 with `E404 rsct-mcp` and updates none of the machine's other globals; with a link it exits 0
and they update. A copied local package whose name exists on the registry is REPLACED by the
registry's on `npm update -g`, even as a downgrade (local 99.0.0 → registry 3.0.1, local files
gone); a link is never replaced. The companion is not distributed through npm, so a registry package
carrying its name would not be this project's — and the server that enforces the gates must never be
replaceable that way. A temporary staging folder adds a second failure:
an npm that ignores the flag (6.14.18, 7.24.2, 8.7.0) links to the stage, which is then deleted.
ADR-021 keeps the link and moves its target.

### AD-008 — Do not let a module decide at load time whether it is the program being run
`if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) { main(); process.exit(…) }` at
the bottom of a module that is also imported. MEASURED (#114): bundled into another entry with
`splitting: false`, `import.meta.url` is the importing bundle's file, the check is true there, and
the imported module's `main` runs first and exits — 25 releases shipped an edit guard that ran the
sanitizer instead of itself, with every unit test green because they imported the functions and
never launched the file. Launched by hand through a link, the same equality is false and the
program does nothing, silently. ADR-022 removes the check: a file under `src/scripts/` always
runs, and exports nothing that could tempt an import.

---

## Measured facts worth not re-deriving

- **The Claude Code Bash tool on Windows cuts a command at about 8,186 characters** (2.11.1).
  The tool sends `eval '<text>'` with every `'` written as `'"'"'` (four characters more), and
  the argument reaching Git's `bash.exe` stops there; a cut inside the quote reports
  `unexpected EOF while looking for matching` a quote and nothing runs. Counter-test: a
  quote-free 8.8k-character command fails the same way. The limit counts characters, not
  bytes. Five `01-setup.md` blocks were over it, so they carry `▶ Run from a file` and
  `mcp-server/tests/bash/block-size.test.ts` refuses a new oversized block without that mark
  (threshold 7,000, `'` costing 5). Linux and macOS were not measured.
- **A `git rev-parse` subprocess costs ~32 ms on Windows 11.** `readWorktreeInfo` spends
  three of them, and deriving the repository anchor adds a fourth on the worktree branch —
  about 130 ms per resolution. `resolveAuditPath` runs on every audit write, so the anchor
  cache in `repo-anchor.ts` is a requirement, not an optimisation.
- **Paths must be canonicalised before comparison, and its absence broke 4 of 6 CI cells.**
  On macOS `tmpdir()` returns `/var/folders/…` while git returns `/private/var/folders/…`
  (`/var` is a symlink); on Windows `C:\Users\RUNNER~1\…` versus `C:\Users\runneradmin\…`
  (8.3 short name). Linux passed, which is why this had to be caught by CI rather than
  locally. `realpathSync.native` is required for the Windows case — the JS implementation
  does not expand 8.3 names.
- **Canonicalisation decides equality only.** Returning the realpath'd form to callers
  changed `resolveAuditPath`'s output for every project on macOS and reddened five
  pre-existing tests unrelated to that change.
- **`deriveAuditCeiling` full-scans the audit log**: 2.1 ms at 1k lines, 15.1 ms at 10k,
  87.5 ms at 50k. ADR-024 bounded the one writer that fired on every call and every edit, and
  ADR-025 keeps the file to about ten days of routine history, so the scan stays small; it is
  still a whole-file read — several on an approved commit, and retention adds one for the dialog
  forecast and one after the commit, two when it cuts. Any new reader of the log should ride an existing
  pass rather than add one — and must add its event to the keep rule in
  `lib/audit-retention.ts`, or a cut will drop what it reads (`tests/unit/audit-anchors.test.ts`
  catches a comparison of `event` against a name the rule would drop, not every shape a reader
  can take). The config-violation check cannot ride a pass — it runs in the config loader, before
  any — so it reads the last 64 KB instead of the file.
- **Replacing a file that other processes append to loses lines unless the old file keeps a
  name** (2.14.0, Node 22.14, four writers at ~600 lines a second each). Read, write a temp,
  rename: 5,042 of 10,000 lines lost on NTFS, 7,312 on ext4. Copying over what arrived before the
  rename still lost 35–45 per ~500 rewrites on NTFS and 10–12 per ~340 on ext4. A hard link to the
  old file, read once more after the rename: 0 lost on both. On Windows `renameSync` over a target
  ANY process holds open — for read or for append, this process included — fails with `EPERM`
  (libuv 1.49.2); on Linux it succeeds and an open descriptor keeps writing to the old inode.
  `linkSync` is `ENOTSUP` on a `//wsl.localhost/` share reached from Windows and works on
  `/mnt/c` reached from WSL.
- **What an audit log holds in the field** (19 logs, one machine on 2.12.3, 2026-10-10): 33,072
  lines, 9.38 MB. `settings.baseline` 11,416 lines (the per-edit defect fixed in 2.13.0);
  `verification.finding` and `verification.action` 8,653 between them; `review.sweep_stamped`
  1,707; `approval.consumed` 1,167; the `override_invoked` events of commit, push and merge
  1,202 (none for rebase); `classify.verdict` 343; `rsct_json.*` 3. No line without a usable stamp, and no old line below a recent one — a
  log is chronological in practice.
- **`fast-uri` executes but is not exposed.** With every export instrumented and the SDK's
  own Ajv configuration fed the 40 tool schemas read from the running server, `parse` runs
  81 times — over exactly two constant strings, `""` (80×) and
  `"http://json-schema.org/draft-07/schema"` (1×). No RSCT tool schema declares `format`,
  `$ref`, `$id` or `$schema`, and the one server-side path that hands a third party's schema
  to Ajv is elicitation, which this server never calls. A schema declaring `$id` and `$ref`
  does move the counters, so the zero is a measurement rather than a probe that never ran.
- **Only 21 packages reach `dist/index.js`** (2.11.0; 18 before the comment engines).
  Measured from the sourcemap: `ajv`, `zod-to-json-schema`, `zod`, `pino`,
  `@modelcontextprotocol/sdk`, `pino-std-serializers`, `thread-stream`, `fast-uri`,
  `ajv-formats`, `tsup`, `fast-deep-equal`, `json-schema-traverse`, `@pinojs/redact`,
  `quick-format-unescaped`, `atomic-sleep`, `sonic-boom`, `on-exit-leak-free`,
  `safe-stable-stringify`, `web-tree-sitter`, `parse5`, `entities` (BSD-2-Clause). The
  grammar WASMs are not bundled; they ship beside `dist/` in `grammars/`. A dependency advisory matters
  to users only if the package is on that list; everything else is build- or test-time.
  Counting a package's name in the bundle text does not work — "nanoid" appears 13 times as
  a zod validator name.
- **What `npm install -g .` does depends on the npm version, and the default flipped twice** (#74).
  Link on 6.14.18, 8.7.0, 9.6.4, 10.0.0, 10.9.2 and 11.1.0; COPY on 9.0.0 and 9.4.1, where
  `install-links` defaulted to `true`. With `--install-links=false` all eight link, without a
  warning on the versions that predate the flag. Node 20.0.0 ships npm 9.6.4, so the copying
  versions are below `engines`.
- **`rm -rf <link>/` with a trailing slash empties the link's target** (#74). Measured on Git Bash
  with a junction and on Linux with a symlink: the link survives and the target's files are gone.
  Without the slash only the link is removed, and removing a folder that contains a link leaves the
  target alone. No `rm -rf` or `mv` in the scripts may end in a slash.
- **npm for Windows cannot install from a network path** (#74). With the current directory on
  `//wsl.localhost/…`, `npm install -g .` exits 0 and leaves a link to `C:\wsl.localhost\…`; the
  `--install-links=true` form gives `ENOENT`; the UNC path as the spec, and `npm pack`, give
  `ERR_INVALID_URL`. `cp -R` to a local folder first works, which is what the installer's copy does.
- **Inside WSL the Windows PATH comes along** (#74, #110). In a plain login shell `rsct-mcp`,
  `claude` and `npm` resolved to the Windows shims under `/mnt/c/…` with nothing installed on the
  Linux side, and `node` was not found.
- **On Windows the npm shim picks its own version from the global prefix** (#74). With
  `npm_config_prefix` pointing at an empty folder, `npm --version` printed the 10.9.2 bundled with
  Node; without it, the 11.1.0 installed in the real prefix. A run that pins the prefix is a run on
  the bundled npm, whatever `npm --version` says outside it.
- **Inside a vitest worker on Windows, npm's own variables arrive in UPPER case** (#74). Started by
  `npm test` or `npx`, the worker's `process.env` holds `NPM_CONFIG_PREFIX`. An override spelled
  `npm_config_prefix` is then a second key, and the child process received the inherited one: the
  installer tests' sandbox pin had never constrained a real npm. A pre-flight `npm root -g` caught
  it before anything was installed; `overlayEnv` now drops every spelling of a key before setting it.
- **Of the exit codes of a `PreToolUse` hook, only 2 refuses the tool call** (#114, Claude Code
  2.1.173 on Windows, headless `-p`). Exit 1 — what node returns when the command line was split
  at a space — lets the write happen. The same client honours exit 2 for the matcher `Bash` as
  well. A hook can also answer with a JSON decision; that route is not used here and was not
  measured.
- **What the client hands the hook as `file_path`** (#114, same client). An absolute path in the
  letter case the model typed. A relative name, a `~/…` path and a Git-Bash-style `/c/Users/…`
  all arrive already expanded to `C:\Users\…`; a `\\localhost\C$\…` path arrives as typed, and
  the client then holds that write for manual approval on its own ("suspicious Windows path
  pattern"), `--allowedTools Write` notwithstanding. Interactive and bypass-permission modes, and
  other client versions, were not measured — the guard still resolves a relative path itself.
- **Inside WSL, `realpath` does not fold letter case on the Windows disk** (#114, WSL2, Node
  22.14). `realpathSync.native('/mnt/c/USERS/…')` returns the path as typed, while `statSync`
  reports the same `dev:ino` for `/mnt/c/USERS/…` and `/mnt/c/Users/…` and a different one for the
  parent folder. On Windows itself `realpath` folds the case.
- **On Windows `dev` from a path `stat` is not a volume identity** (#114, Node 22.14, NTFS). A
  plain local folder reads `dev=0`; a junction pointing straight at it reads the volume serial
  with the same `ino`; so does a loopback share path. The drive root reads `ino` 0x5000000000005
  — the root record of every NTFS volume — so a project at `D:\` and the folder `C:\` cannot be
  told apart by number.
- **Windows path resolution, as Node reports it** (#114, Node 22). `realpathSync.native` resolves a
  `subst` drive to its target and folds `\\?\C:\…` to `C:\…`, but keeps `\\localhost\C$\…` as it
  is. On a share that does not exist (`\\localhost\<name>\a\b`) the walk up to an existing ancestor
  took 4.9 s; on a host that does not resolve, 0.13 s. `statSync` through the loopback share
  returns the same `ino` and a different `dev`.
- **`path.relative` answers `..env.ts` for a file of that name directly under the root** (#114). A
  test for "outside the root" must be `=== '..'` or a `..` followed by the separator, never a bare
  `startsWith('..')`.
- **The field never saw the edit guard work** (#114, 19 real projects, read with the developer's
  OK). 13 of 13 installed guard copies were the inert build; 421 code phases were recorded, none
  with an empty `scope_globs`, and 316 of them left `progress_<slug>.md` out of the list. The
  sanitizer riding on every edit wrote 9,938 `settings.baseline` lines out of 30,644 audit lines,
  up to 430 in one day. Of 663 commits, none used the dialog-free lane.
- **How Claude Code runs a PreToolUse hook** (ADR-028, 2026-10-17, Claude Code 2.1.173, Windows,
  hooks in Git Bash, `claude -p` with haiku in throwaway projects). Exit 2 refuses the call and the
  model reads the stderr, under `--permission-mode bypassPermissions` and
  `--dangerously-skip-permissions` too (control without the hook: the commit landed). Exit 1, a
  missing script and a crashing script let the call run, with or without `onFailure: "block"`;
  `node "<script>" || exit 2` refused all three. `Bash`, `PowerShell` and `Monitor` each run
  commands and each carries `tool_input.command`; a matcher on `Bash` alone let the other two
  commit with the hook never called. The command text arrives verbatim, multi-line. A hook entry
  written to `.claude/settings.json` mid-session runs from the next call on. The same command under
  WSL Ubuntu's `/bin/sh` (dash, node 22.14), WSL combination 1 (project in `/tmp` on the Linux
  disk): `git commit` 2, `git status` 0, a missing script 2.
  WSL combination 3 (the registered commands run by Git Bash with `CLAUDE_PROJECT_DIR` under
  `//wsl.localhost/Ubuntu/…`, in both the `//` and the `\\` spelling; not through the client):
  `git commit` 2, `git status` 0, an edit outside the list 2 and inside it 0. Windows git treats
  that repository as unsafe until the share is a `safe.directory`: before, an alias in its local
  config is unknown to git and to the guard alike; after, the guard resolves it (`alias=commit` 2).
- **Which `powershell.exe` Node runs on Windows** (ADR-027, 2026-10-16, Node 22.14). A copy of
  another program named `powershell.exe` in the working directory was not run by
  `execFileSync('powershell.exe', …)`; the same copy in a folder placed first in `PATH` was (exit 1,
  the copy's own; counter-test: the copy run by its path exits 1 too). This machine's `PATH` had no
  user-writable folder before `WindowsPowerShell\v1.0`.
- **An environment variable carries dialog text verbatim to PowerShell `$env:`** (ADR-027,
  2026-10-16, Windows PowerShell 5.1): 21 of 21 texts — every quote character, `%PATH%`,
  `$env:PATH`, LF and CRLF, accents, CJK, emoji, the empty string, a leading `-`, 30,000 ASCII and
  30,000 CJK characters. Node refuses an environment value that holds a NUL
  (`ERR_INVALID_ARG_VALUE`). zenity 4.0.1 (Ubuntu 24.04) lists `--no-markup` for `--question`.

---

## Module notes (migrated from source comments, #62)

Constraints and measurements that lived beside the code until the 2.11.0 REVIEW swept
those files. Keyed by module and symbol; restatements of what the code says were dropped.

### `lib/git.ts`

- **A failed git read keeps what git said, for the call that made it** (#104, 2.12.1). The store is
  an `AsyncLocalStorage` opened by `computeWorkingSweep` and by the dead-code `analyse`, so two
  tool calls in one process never read each other's failures and nothing survives the call —
  MEASURED (Rv #104 lens 1): with one module-global store, a concurrent check wiped the message and
  a refusal named another repository's path. What reaches the refusal is filtered: a read that
  failed without writing anything is not recorded (`rev-parse -q --verify <sha>:<new file>` fails by
  design for every added file and would otherwise spend the five slots), the newest five are kept,
  git's first line is cut at 200 characters and quoted, and the command is shown with at most four
  arguments — a `git config` value an agent controls is echoed by git verbatim, and unquoted it
  reads as framework voice (MEASURED, Rv #104 lens 2).
- Piping stderr instead of ignoring it makes it count against `maxBuffer` (64 MB): a read whose
  stderr passes that budget now fails where it used to succeed. Direction: stricter, a refusal, and
  it needs tens of megabytes of stderr.
- **`isSafeRevisionToken`** is an injection guard, not a validity check. Rules: no leading
  `-`, no control characters (a NUL makes `execFileSync` throw; a newline would split the
  JSONL audit record that echoes the rejected revision). Measured: an option-shaped token
  in the range reader is an unapproved arbitrary-path write —
  `git diff --name-only -z --diff-filter=d "--output=SIDEEFFECT...HEAD"` exits 0 and
  creates that file — and it runs before `gateRequest`, so no dialog would show. A 30-token
  battery found only the option shape doing anything but resolve-or-fail (`feat:main`,
  `main..feat`, `+feat`, `a b`, `feat.lock`, `feat/` all fail cleanly with 128/129).
  An earlier draft that also rejected `~ ^ : ? * [ .. @{` and bare `@` was refuted:
  `HEAD~1`, `HEAD^`, `HEAD@{0}` and `@` resolve, and since merge/rebase fail closed a false
  reject is a hard stop with no override. Rejected alternatives, both measured:
  `--end-of-options` needs git ≥ 2.24 (no minimum is declared, so older git would fail every
  read); `--` reclassifies the token as a pathspec and returns rc 0 with empty output — an
  attack turned into a silent pass.
- **`unsafeOperand`** is the second, process-side barrier, independent of the `--` sentinel
  each mutating helper also passes; `--` behaves differently per subcommand and no minimum
  git version is declared. Measured on git 2.45.1: `git push --exec=<program> -- <branch>`
  runs the program, so in `gitPush` the `--` goes before the remote (with it first,
  `git push -- --exec=X main` is refused as a strange hostname); `git rebase "--exec=<p>" main`
  executes the program while `git rebase -- "--exec=..."` is refused; `merge -m x -- --no-verify`
  is refused while `merge --no-ff -m x -- feat` merges.
- **`RangePathsResult`** is three-way on purpose: `unsafe_revision` (an input-validation
  event) and `unavailable` (git could not answer) must stay distinguishable in the audit log.
- **`getRangePaths`** uses `--diff-filter=d`, which drops deletions and also the old side of
  a rename git did not detect (`diff.renames=false`, or the silent `diff.renameLimit`
  fallback whose warning is discarded). An explicit `-M` was tried and removed: it produced
  byte-identical output. There is no MCP-substitutable override (the A2/INV-6 lesson: a public
  diff override is an enforcement bypass); tools carry a test-only reader seam.
- **`splitNulPaths`** rewrites `\` to `/`. Git emits `/` for `-z` on every OS, so it only fires
  on a Linux/macOS filename containing a backslash, where it is lossy; kept identical across
  the staged and range readers because divergence would be worse.
- **`getStagedStats` / `parseNumstatZ`**: numstat renders `-\t-\t<path>` for binary files.
  Parsed as integers that is `NaN`, which poisons cumulative counters
  (`JSON.stringify(NaN) === "null"`) and makes `lines > cap` always false. A `-` counts 0
  lines but the file still counts; every numeric is `Number.isFinite`-guarded.
- **`GIT_READ_TIMEOUT_MS` (30 s)** bounds the local reads because `execFileSync` blocks the
  event loop and a test timeout cannot interrupt a synchronous body. Not applied to
  `defaultGitExecutor`, which carries pushes to slow remotes.
- **`getHeadSha` vs `getHeadShaFull`**: short sha is the reporting format shared with
  `readGitState`'s `sha_before` on reject paths (one field must not carry two widths); full
  sha is the identifier for anything stored or compared (an abbreviation's width tracks object
  count and `core.abbrev`). `getHeadShaFull` is one spawn (~64 ms warm on Windows) against
  `readGitState`'s four.
- **`readWorktreeInfo`** detects a linked worktree by the `/worktrees/<name>` tail of
  `--git-dir`. Comparing absolute `--git-dir` with relative `--git-common-dir` as strings
  false-positived a subdirectory of the main worktree (git resolves symlinks and 8.3 names,
  `resolve()` does not).
- **`gitIsTracked`** treats any ambiguous git error as tracked, so a git failure can never
  green-light deleting a plan artifact. **`gitBranchMerged`** is blind to squash and rebase
  merges; the `gh pr list` signal covers those.

### `lib/free-commit.ts`

- `deriveAuditCeiling` makes one pass over the audit log and reconstructs the tier ratchet
  (`auditTierMax` = MAX over `classify.verdict` tiers) plus the review decision sets
  (unverified decisions, dead-code keeps, public-API approvals). It is the shared,
  wipe-resistant source the ceremony evidence gate and the REVIEW/dead-code gate read.
- The tier ratchet is a MAX over the whole log, never "since the last `classify.verdict`" —
  classify is ungated, so a counting boundary there would be a reset primitive. A wiped
  phase-state cannot lower the audit-recorded tier (`higherTier(state, audit)`).
- MEASURED for ADR-025 (2.14.0): since #80 removed the free-commit lane, no gate decision reads
  that MAX. It reaches `tier_max_recorded` in the evidence gate's output and nothing else; the
  downgrade guard in `tools/phase-code-start.ts` reads `last_classify.tier_max` from phase-state.
  The presence of a `classify.verdict` entry is what the evidence gate uses.
- `isFreeTier`/`higherTier` are the tier helpers the evidence gate uses to decide which tiers
  skip ceremony (`trivial`/`small`) and which do not.

### `lib/phase-machine.ts`, `lib/phase-scope.ts`

- **`StartPhaseInternal.patch`** merges extra state into the transition's single write: a
  second `writePhaseState` would race a background `rsct_status` (the lock serialises writes,
  not read-modify-write cycles). A mutator, because callers must also remove keys, which a
  spread cannot express under `exactOptionalPropertyTypes`.
- **`isStaleVerificationLabel`** is exactly `phase === 'verification' && completed_at != null`
  (#15) and must not be widened; exported so `rsct_phase_verification_start` asks it instead
  of retyping it (#27). Overwriting a completed label emits its own audit record after the
  write, carrying the previous spec context.
- **`CompletePhaseInternal.dialogDetail` / `forceDialog`** live on the internal struct so
  `CompletePhaseInput` and `DialogOptions` stay unchanged (a third dialog field would be a
  cross-OS change to `os-dialog.ts`).
- Closing the terminal phase (`nextPhase === null`, now `review`) arms `context_stale`.
- **`PHASE_STATE_PRESERVED_ON_ABANDON`** is an allowlist (#53): a new `PhaseState` key is
  dropped by an abandon unless listed. `context_stale` is listed because wiping it let an
  agent the edit guard had blocked unblock itself by abandoning an unrelated phase.
  `review_sweep` and `review_drift` are listed because they describe bytes, not the work.
- **Phase-state lock**: exclusive create (`wx`); a lock older than 30 s is stale and
  overwritten; a busy lock returns `locked` with its age; released in `finally`.
- **`matchesAnyGlob`** relativises by prefix strip on normalised forms, not `path.relative`
  (platform-bound, silently no-ops on mixed styles). Case-sensitive except the drive letter;
  not symlink-resolved.
- **`readThenStampBootstrap`** evaluates the marker before stamping (a post-stamp read is
  always "fresh") and skips the stamp on an unparseable file, whose write would otherwise
  replace every other key with `bootstrap_at` alone. **`truncateForHint`** takes `unknown`
  because `bootstrap_at` comes from unvalidated JSON (`{"length": 999}` would throw).
- `rsct_status` stamps `bootstrap_at` but only `rsct_load_context` clears `context_stale`.
- `headStaleness` marks, never rejects; `null` means "cannot tell".
- `readPlanDisposition` enforces the slug match on read, so a `delete` recorded for plan A is
  never applied to plan B.
- `PhaseVerificationBlock.head_sha` is nested in the block, not top-level, so it goes with the
  work on abandon.

### `lib/pre-merge-ack.ts`

- The four booleans are self-attestations; `plan_complete` is not cross-checked against the
  plan file's status (that produced a systematic false positive on every non-final merge of a
  multi-phase plan). Teeth: presence, reject-on-false, the `progressHasOpenItems` contradiction
  and the `files_swept` coverage check, which verifies the carried paths were claimed, not that
  a sweep happened.
- Every field is optional in the Zod schema so a partial ack is a clean `rejected`, never a
  throw; the schema is shared verbatim by the integration tools (lesson V-P1·PH-1).
- `PRE_MERGE_ACK_ITEMS` excludes `files_swept` because it is emitted as the
  `pre_merge_ack_self_attested` audit label, which must keep meaning "the booleans attested".
- `MAX_FILES_SWEPT` caps the first unbounded agent-supplied array echoed into the audit log;
  enforced in the evaluator, not as Zod `.max()`, to stay a clean rejection.
- Path comparison normalises NFC (macOS lists NFD, git stores NFC), separators, `./` and a
  trailing `/`; case is not folded (folding would pass on Windows/macOS and fail on Linux).
- The coverage check runs independently of the booleans and is skipped on an unreadable or
  empty range; merge and rebase fail closed on an unreadable range (measured: unrelated
  histories, rebase onto an orphan ref), push fails open.

### `tools/request-merge.ts`, `tools/request-rebase.ts` (migrated in the #91 REVIEW)

- The pre-merge ack is checked before the approval dialog: a missing ack is refused in chat
  without a dialog, and the approval is neither validated nor consumed on that path. A merge, a
  rebase and a squash are always integration events, so the ack is always required.
- The carried paths are read from git, never supplied by the caller. Merge reads
  `HEAD...<source>` — `HEAD`, not the branch name, because this runs before the detached-HEAD
  refusal, where `rev-parse --abbrev-ref HEAD` returns the literal `HEAD`. Rebase replays this
  branch onto `ref`, so `ref...HEAD`; squash stages `ref`'s changes here, so `HEAD...ref`. In the
  rebase range `ref` is agent-controlled and leads the token, the only one of the four ranges
  where that holds, so `getRangePaths` checks both endpoints with `isSafeRevisionToken` before it
  composes the range; composing it in the tool would skip that check.
- Both fail closed on an unreadable range, MEASURED: `git diff HEAD...<orphan>` exits 128 while
  `git merge --no-ff --allow-unrelated-histories <orphan>` exits 0 and lands. The range is read
  after the ack is evaluated, so a call with no ack is told that first.
- One exemption, on merge: `allow_unrelated_histories` with an `unavailable` range. Unrelated
  histories have no merge base, so for exactly the input that flag serves the read can never
  succeed. It is not a hole the agent can drive: the flag is refused without
  `dev_approval.override_protected_branch`; a merge of related histories reads fine and never
  reaches the exemption; an `unsafe_revision` result still fails closed. A merge that lands under
  the exemption says that the coverage check did not run.
- The coverage result is audited on the integration that landed, not only on refusals.
- The install-drift line goes into the OS dialog, the channel the agent cannot rewrite, as well as
  `hints[]`, and is drained on every return path. The #92 relocation notice rides every return
  too; a caller's own hints cannot drop it, and a headless run has no dialog to carry it.
- The carried-path reader is a test seam that takes a reader, not a path list, so a test can
  assert the base and head that were passed; it is not an MCP input.
- After a completed plan the cleanup is suggested, never performed (`rsct_plan_dispose`).

### `lib/install-advisory.ts` (migrated in the #91 REVIEW)

- One helper for every §C-gated mutating tool (#25): the severity check, the audit payload and the
  message live in one place, because copies drift and this is a security claim. Before it the
  warning reached only `hints[]`, which the agent relays at its discretion, and push and merge —
  the outward-facing, hard-to-reverse calls — carried none.
- The dialog line is one short line on purpose: the dialog is a decision surface, and a wall of
  text there trains the developer to dismiss it unread.
- The audit entry is written at evaluation time: it records that a mutation was attempted under
  degraded enforcement, whether or not the attempt then succeeded.
- It never blocks and never throws: a drift check that could fail a push would be a worse bug than
  the drift it reports.

### `lib/reverse-dep-walk.ts`

- An empty importer set means either "nothing depends on this" or "the walk could not look" (#54).
  `WalkCoverage` says which, keyed on the declared seeds (file type, inside the root), never on a
  path shape, so the verdict cannot differ between operating systems. Every early return is
  `not-run`, the zero-seed case first, so `uncovered` is never vacuously true.
- `seedIsCoverable` needs both halves: on POSIX an out-of-tree seed relativizes to `../…`, on
  Windows a different-drive seed to an absolute `D:/…`. A seed inside an excluded directory stays
  coverable on purpose (importers of `dist/x.js` are discoverable). It is exported so a test reaches
  the `isAbsolute` half, which no POSIX `relative()` produces.
- Only a relative `.js`/`.mjs`/`.cjs` specifier that resolves to nothing counts in
  `unresolved_js_specifiers`: `isAbsolute` is platform-bound (`'C:/vendor/x.js'` is absolute on
  win32 and bare on POSIX), so counting it would make the number, and the hint it selects, differ
  by OS. The hint fires on any non-zero count — "nearly empty reads as complete" is the same defect
  as "empty reads as clean".
- A `project_root` that is a FILE passes `existsSync`, then `readdirSync` throws ENOTDIR into the
  walk's swallow and yields `files_scanned: 0`, identical to an empty project — hence the explicit
  "is not a directory" refusal (a directory that exists but cannot be read is not addressed).
- Directory exclusion probes a virtual child (`<dir>/probe`) so `**/node_modules/**` matches the
  directory itself.
- Facts about the walk go to `hints` and reach every caller; V-phase advice comes from
  `coverageHints`, which the caller gates, because a tier-skipped V phase still runs the walk. Each
  advisory line states an observation and lists candidate causes without picking one; the
  uncovered-seeds line drops its closing sentence when the zero-scan line fires, so two long
  paragraphs never repeat each other.

### `tools/request-commit.ts`

- The message-length check (#20) and the REVIEW gate run before authorization, so a commit
  they refuse never costs a dialog or a token action; the REVIEW gate runs again right before
  the token reserve. Branch protection, secrets and the contract gate run after authorization.
- `internal.*Override` seams (staged diff, paths, stats, git state, audit writer, approval
  recorder) are test-only; the MCP dispatch passes no `internal`, closing the fabricated-diff
  hole (A2).
- #17: `.claude/settings.json` drift is reported, never staged or discarded; the audit keeps a
  redacted excerpt only.
- Token path: the action is debited before the commit and refunded on failure; if the refund
  write fails the action stays spent (tightens, never loosens). Since 2.17.0 (ADR-030) the reserve
  and the refund re-read the state and write only while the stored token is the one they read, and
  nothing re-arms the token.
- INV-7 contract gate diverges only on a confirmed multi-repo topology, and a confirmed
  multi-repo commit where it could not enforce says so at commit time (RV3).
- CAP-33 bootstrap and CAP-53 plan-tracking notices are advisory, never rejections.

### `tools/phase-review-start.ts`, `tools/phase-status.ts`

- Declared finding ids must be distinct at the door: coverage counts distinct ids, so a repeat
  would let one action close several findings.
- Restarting with no findings clears the stale set and audits `review.findings_replaced` —
  without it the log cannot tell "found nothing" from "erased five", the one move that makes the
  gate fail open.
- A run id or evidence mix is advertised only for a baseline that was actually persisted; `null`
  (not `[]`) where nothing landed, so the mix reads unmeasurable rather than a clean zero.
- `rsct_phase_status` lists open finding ids (a resumed session needs them to answer) and feeds
  the baseline itself, not a `?? []` fallback, for the same reason.

### `tools/classify-task.ts`

- Lexicons mix English and pt-BR; translation at runtime was rejected (external dependency,
  non-determinism). CAP-29 upgrades to complex at 3+ distinct concern categories, and at 4+
  numbered steps; step matching requires a line start or whitespace so `node 1.2.3` does not
  count. A real 2026-06-09 task (DTO + service + listener + template + test) returned standard
  before CAP-29 and skipped V.
- The verdict is persisted with a `tier_max` ratchet and emitted as `classify.verdict` to the
  audit log, the positive evidence the ceremony evidence gate and the tier ratchet require;
  both writes are best-effort.
- The PH-3 worktree nudge stays conditional because classify runs before the plan exists.

### `tools/plan-authorize.ts` (migrated in the #101 REVIEW)

- Since 2.17.0 (ADR-030) the pre-conditions (no branch, protected branch, an unsafe `plan_slug`, no
  `plan_` file, fewer than two phases) are checked BEFORE the gate, so the dialog can name the
  plan, its phases, the count and the expiry; a refusal there shows no dialog and consumes
  nothing. Up to 2.16.0 they ran after the gate.
- FV4: the emitting approval is consumed only once the token is persisted. A failed persist leaves
  it unconsumed. Since 2.17.0 the `plan_authorize.authorized` audit line is written before the
  token, and a failed audit write mints nothing.
- The sliding window of plan-lifecycle-v2 (block 1.4) — a re-arm of `expires_at` on each
  successful commit, under an absolute cap of 24 h by default and 7 days at most — is removed in
  2.17.0 (ADR-030): the lifetime is fixed from the approval, 8 hours at most, and
  `tokenExpiryMs` caps a token an older server wrote.

### `tools/phase-abandon.ts` (migrated in the #101 REVIEW)

- `preserved_keys` on the `phase_abandon.complete` audit line is what actually survived on disk, so
  a reader can tell a preserved session marker from a key the allowlist stopped carrying. It is
  empty on a failed write: nothing was replaced, so nothing was preserved BY that call.
- A set `context_stale` survives the abandon on purpose, and the hint says so at the call site
  instead of leaving the developer to find out at the next blocked edit. It reads the flag through
  `readContextStale`; the edit guard tests `state?.context_stale` for truthiness, and the two agree
  for a set, an absent and a `null` flag.

### `tools/audit.ts` (migrated in the #101 REVIEW)

- **`rsct_audit` deliberately bypasses `evaluateInstallAdvisory`** (#55) and must stay that way.
  That helper APPENDS an `install.drift_detected` entry when the severity is `security`, to record
  that a mutation was ATTEMPTED under degraded enforcement. `rsct_audit` attempts no mutation;
  routing it through the advisory would write false attempt records into the log the
  anti-rollback ceiling is re-derived from (append-only until ADR-025; `install.drift_detected` is
  one of the events whose newest entry a cut keeps). `getInstallDriftNotice` itself only reads.
- Honest scope of that guarantee, MEASURED by running the real handler (#55): it keeps the tool from
  writing a FALSE `install.drift_detected` entry; it does not make the handler write-free.
  `resolveProjectRoot` appends a config-violation entry when `.rsct.json` is present but rejected —
  normally once per hour for the same violation (ADR-024) — creating the log if absent.
  `rsct_status` and `rsct_load_context` do the same on the same input —
  the behaviour is the shared resolver's (#80). The tool description and the returned coverage
  boundary say so rather than claiming "no writes".
- The coverage boundary ships in the OUTPUT, not only in the docs: "is this project's process
  healthy?" is a completeness claim the tool cannot make, and a clean report is not a clean project.
- `explainHealth` answers a corrupt or torn signal FIRST, so a real fault is never described in
  the same breath as a fresh install; `audit_history_absent` alone is not a fault. `rsct_audit`
  surfaces this as `mechanical_health` {ok, faults, explanation}; `evaluateMcpHealth` (`lib/health.ts`)
  is its only consumer now that the dialog-free lane is gone (ADR-023). `audit.enabled: false` is
  unreachable (the schema is `z.literal(true)`), so a project cannot be stuck reporting "no history"
  forever.
- Install drift is reported ONLY in the structured field, never pushed into `hints[]` (decision of
  2026-08-21, shared by #53/#54/#55): one advisory surface, one dedup rule per overlapping pair.
  `rsct_status` owns the install-drift hint; repeating it would show the same line twice.
- Open-phase age: the V phase keeps its `started_at` inside the verification block, every other
  phase at the top level. Reading only the top-level field would leave V — the phase most likely to
  sit open for days — as the one phase whose age cannot be reported. Both fields are optional and
  the absent case is reachable (a stranded `verification` label), so a missing timestamp reports
  `null`, never a fabricated age.
- `rsct_installed: false` collapses three states: no `.rsct.json`, an unreadable one, and one
  present but REJECTED as malformed or out of bounds. The report tells them apart with a plain
  `existsSync`, because the rejected case is the one the bounds check exists to catch — a config
  edited to disable enforcement.
- Report only: no line may recommend a state-mutating remedy; an open-phase age does not point at
  `rsct_phase_abandon`. The reason written at the time — an abandon replaced the whole state with
  `{}` — stopped being true with the #53 allowlist; the rule stays, because a report must not route
  the reader into a mutation.

### `lib/edit-guard.ts`, `lib/edit-scope-hook.ts`, `tools/check-edit-scope.ts` (#114)

- **`judgeEditScope` tests `context_stale` before the empty-list short-circuit.** Closing a plan
  wipes `scope_globs` in the same write that arms the flag, so the other order would answer
  `unknown` for exactly the state the flag exists to refuse.
- **The network-style check runs twice.** Once on the path as typed, so a foreign share is refused
  without a disk or network round trip (4.9 s measured on a missing share); once on the resolved
  path, for a link or a mapped drive that lands on one.
- **`ScopePathDeps`** exists so the Windows rules run on the Linux and macOS cells as well
  (`path.win32`, a recording `canonical`, a scripted `identity`); production passes nothing.
- **`matchesAnyGlob` is called without a project root** on purpose: given one, it also tries the
  absolute path as a candidate, which is what let a folder above the project satisfy `**/x/**`.
- The identity walk runs only for a path that already reads as outside, so an edit inside the
  project costs no extra `stat`. It stops at once when the path and the project root do not share
  a top folder (another drive, another share): without that, a project at a drive root matched the
  root of every other NTFS drive. Where the separator is a backslash `dev` is not compared.
- `nativeScopePaths` is exported for one test, which keeps the real `stat` reader and swaps only
  the path resolver: no ordinary disk on the CI cells offers a second spelling `realpath` leaves
  alone, so without it nothing would run the production reader.
- A refusal for a file the list does not cover carries `judged_as`, the path below the root in
  the spelling that was matched — the only clue when the list and the disk differ in letter case.
- **What exits 2.** The hook exits 2 for `out_of_scope`, `stale_context`, `claude_settings` and
  `guard_failed` (the last two since 2.15.0, ADR-028). Empty or malformed stdin, a payload with no
  `file_path` / `notebook_path`, an unmanaged project (no `.rsct.json`) and an unreadable
  phase-state (`infra_error`) exit 0.
- `phase_state_override` of `rsct_check_edit_scope` carries `context_stale` so a what-if call can
  ask about a stale context.

### `lib/sanitize-permissions.ts` (migrated in the #114 REVIEW)

- **What it is for (INV-2.3).** The §C tools need an out-of-band approval; a standing
  `Bash(git commit:*)` in a settings file lets the agent run git directly. The sanitizer strips
  such entries from `permissions.allow[]` of `.claude/settings.json` and
  `.claude/settings.local.json`. The verb set is the ops that bypass a §C-gated outcome: commit,
  push, merge, and — since #91 — rebase, cherry-pick, revert (git verbs, in the git-globals /
  path-prefixed / shell-wrapped shapes) and `gh pr merge` (its own pattern, direct or
  path-prefixed), plus the wildcards that cover them; every other entry is preserved. Recovery
  forms (`git rebase --abort`) are stripped too, consistent with the existing `git merge --abort`
  strip (MEASURED: the sanitizer stripped `git merge --abort`/`--continue` before #91). Left on
  purpose (named limits; the terminal guard, ADR-028, refuses the merge itself): a broad `Bash(gh pr:*)` / `Bash(gh:*)` grant
  is NOT stripped — mirroring git's `git:*` catch-all would over-strip read-only `gh pr view` /
  `gh issue` / `gh api`; and the Hole-1 user-scope settings file and Hole-3 wrapper forms
  (`env git`, `git.exe`, shell-wrapped `gh`) are untouched.
- **It never blocks a session.** It never throws and exits 0 on a malformed file, reporting to
  stderr and, best effort, to the audit log.
- **Node builtins only, transitively** — it runs before the server exists. MEASURED after #92
  folded the shared audit-path resolver in: 19 KB, zero `zod` occurrences in the bundle (17 KB
  since #114, when the comments esbuild carried inside its literals went)
  (`audit-log.ts` reaches only `io-utils` and `repo-anchor` → `git.ts` at runtime; its
  `project-root` import is type-only). `audit.path` is read with a bare `JSON.parse`, which is what
  keeps zod out. There is ONE resolver because `settings.baseline` is written here and read by
  `rsct_request_commit`: a second copy of the path logic is a baseline written where nobody reads.
- **Git global options (#32).** Every pattern assumed the subcommand came right after `git`, but
  `git -C <path> commit` is valid and commits in ANOTHER repository; five forms walked past.
  Value-taking options accept a quoted argument (`git -C "C:\Program Files\repo" commit`). The
  option class excludes `:` and `*`, so a wildcard standing where the subcommand belongs
  (`Bash(git -C:*)`) is not swallowed as an option. `(?![\w-])` after the verb keeps
  `commit-graph`, `merge-base` and `merge-tree`: a hyphen is not a word character, so `commit\b`
  matched them before.
- **Path-prefixed git.** A lazy `[^)]*?` lets the path hold spaces without sliding past the last
  separator, and `git\s+` pins the basename: `git-credential-store` is another binary.
- **`isAbsoluteEntry`** also tests a drive-letter pattern, so `C:/x` is flagged on a POSIX Node,
  where `isAbsolute('C:/x')` is false.
- **Machine paths inside `allow[]` (#12).** Those entries are command strings that may EMBED a
  path, so a start-anchored test is useless: MEASURED 0 of 21 real entries, every real leak
  included. "An absolute path anywhere" is worse, because a false positive DELETES a working
  permission from the file the team shares — measured on `WebFetch(domain:https://github.com)` and
  `Bash(curl -s https://registry.npmjs.org/)` (`//host` reads as POSIX absolute) and on
  `Bash(sed "s:/opt:/srv:")` (the `:` reads as a drive letter). So the match is on HOME shapes:
  `C:\Users\` (case folded by an explicit class, because the POSIX branches must stay
  case-sensitive); `/home/<u>/` and `/Users/<u>/` only at the start of a token — unanchored they
  matched `Read(src/pages/home/**)` and `Bash(gh api /users/octocat)`, found in REVIEW because the
  first corpus had no path-style entry; capital `U` is load-bearing (macOS against an API path);
  `/mnt/<d>/Users/`; and `//wsl.localhost/` in both slash spellings (CAP-41 field report).
  `Read(/etc/hosts)` carries no user name and is the same on every machine — moving it would only
  make teammates approve it again.
- **Migration.** Verbatim: the command text is never rewritten and the path never made generic.
  Local-write-first: entries reach `settings.local.json` before they leave `settings.json`, and the
  run stops with the source untouched when the local file is malformed or unwritable; a re-run
  retries the strip and the dedup prevents duplicates. One engine for both keys and one result per
  file — `migration_skipped` dominates, since nothing moved.
- **Order.** Migration first, then the poison-pill loop over both files. An entry can be both
  (`Bash(git -C "C:\Users\me\repo" commit)`): the loop's second iteration strips it from the local
  file in the same run. Reversed, a live §C bypass would sit in the file nobody reviews until the
  next session.
- **`settings.baseline` is written last (#17).** It records the file as the framework leaves it;
  taken before the strip it would freeze the entries this run removed, and the next commit would
  report the framework's own cleanup as drift.
- **BOM (#12).** A UTF-8 BOM used to make the file `malformed`: the strip never ran and a
  `Bash(git commit:*)` entry survived while every surface reported healthy. Tolerated on read,
  never written back.

### `lib/version-drift.ts` (migrated in the #114 REVIEW)

- **Two axes.** Version (`normal`): the project's `rsct_version` is older than the running
  binary. Component: is enforcement running — the script is there AND its hook is registered
  (#24: a byte-perfect script with no hook entry enforces nothing and used to read as healthy).
- **What escalates to `security`.** `absent`; `unregistered`, only for a script that could be
  seen (`current` or `stale`); and since #114 `inert`. `unreadable` never does: a script that
  could not be read, or settings that could not be parsed, is absence of evidence.
- **`stale` does not escalate.** The scripts are bundles — `edit-scope-guard.js` embeds the whole
  config layer, so one unrelated `.rsct.json` key changes its bytes. Ranked as security it would
  fire in every project on almost every release, and a signal that is always on is one nobody
  reads. Comparing content answers "is it the same build", never "is a fix missing". The wording
  is "differs from", never "outdated": `.rsct/scripts/` is committed, a teammate on an older
  binary can hold a NEWER script, and the comparison has no direction.
- **The body is compared, not the stamp.** Line 2 carries the release version, the same axis as
  `rsct_version`, so "project behind" would always imply "stamp behind". `STAMP_RE` is anchored at
  the line start (a bundler line containing `v=1` is not a stamp), requires a leading digit
  (setup's `v=unknown` yields no version) and is exported so the bash test asserts the writer
  against the pattern itself. Whether line 2 IS a stamp is a separate question: `v=unknown` is
  still a stamp and still left out of the body, while a pre-stamp install carries source there.
- **Normalisation.** CRLF is folded: the directory is not gitignored, so `autocrlf` checks out
  CRLF while the shipped copy is LF. Trailing newlines are dropped: setup builds the file inside
  `$( … )`, which strips them, and writes it back with `printf '%s\n'`, while the shipped bundle
  ends at its sourceMappingURL with none. An empty body on either side is never `current` — two
  empty bodies would compare equal, a fail-open in the very case the check exists for.
- **Registration.** `registered` on a marker match under the canonical event in any project
  settings file — for the two PreToolUse guards only in the canonical form, matcher and command
  (ADR-028), and `altered` when the marker is there in any other form; `unregistered` only when
  every candidate was parsed or is provably absent (an absent file holds no hook — the fresh-clone
  case of #24); `unknown` otherwise, and when there is no candidate at all. Four states, because
  `null` would have to mean both "could not read" and "no canonical event". The event is required: a sanitizer wired under `PreToolUse` does not run
  at session start. Backslashes are folded on the parsed command — setup writes forward slashes,
  so this matters only for a hand-edited Windows path, where a miss would be a false security
  claim; the bash side does not fold and must not be "fixed" to. The marker is stored literally,
  not derived from the name: the setup and uninstall prompts hardcode the same string. A hook
  declared at user or enterprise level is invisible here, so the sentence names the files that
  were searched, taken from the reader's own list.
- **Enumeration.** Data-driven over `.rsct/scripts/*.js`. `ENFORCEMENT_SCRIPTS` is the only
  hand-kept list, and a `Map`, because names come from `readdirSync` and `'constructor' in {}` is
  true. Its names are reported even when the directory lacks them. A directory that does not exist
  is positive evidence (`absent`); any other failure (ENOTDIR, EACCES, a stalled share) is
  `unreadable`. Registration is reported whatever the file state, so the audit log can tell an
  entry left behind after the scripts were deleted from one never written. Settings are read once
  per sweep. With no shipped directory to compare against (running from source) there is no
  verdict.
- **Reporting.** `absent` wins over `unregistered` in the sentence — an absent script is always
  unregistered too. Every component that is not running is named. `affected_components` (renamed
  from `stale_components` in #24, since it also carries `current` entries) is stored verbatim in
  the `install.drift_detected` audit payload. A hand-typed leading `v` in `rsct_version` is
  stripped for display. The check is local — no network, no cache, no switch — and separate from
  `update-check.ts`, which has one.
- **Suggest-only.** An unreadable script, an unresolvable shipped reference, a missing or
  unparseable `rsct_version`, an equal version, or a project newer than the binary all degrade
  quietly; `isNewer` is false for anything it cannot parse.

### `prompts/01-setup.md`

- **Hook registration (#114, #91).** The quote character is built with `String.fromCharCode(34)`
  inside `node -e`, for the reason the backslash is (MSYS rewrites escapes). For the SessionStart
  sanitizer (4.V.c) the rewrite is keyed on the exact legacy command, not on the marker: the marker
  also matches a command the developer edited. For the two PreToolUse guards (4.V.d, 4.V.e) any
  entry carrying the marker that is not the canonical one is replaced (ADR-028): a guard entry in
  another form is reported as enforcement not running.
- The `.rsct/reports/` backfill (#62) follows the #73 clause: whole-file exact-line guard,
  block-scoped splice right after `.rsct/phase-state.lock` (the CAP-25 clause just before it
  guarantees that line exists), LF out, and a sanity check inside the markers.
- `sql_dialect` is validated three times on purpose — Phase 3, the CREATE render (the shell
  does not persist between phases, so the value is re-declared) and the UPDATE splice — and
  an existing invalid value is repaired in place, because it rejects the whole config.
- **4.V.a (migrated in the 2.19.0 REVIEW).** On Windows `npm root -g` answers a native path
  (`C:\Users\…\node_modules`); `[ -f ]`, `dirname` and `tail` worked on it only through Git Bash's
  tolerance of mixed separators, so it goes through `cygpath -u`. Linux and macOS have no `cygpath`,
  so the value is kept as it is. The hook scripts are taken only when `<root>/rsct-mcp` answers
  `[ -L ]` (ADR-032): MEASURED 2026-10-21 in Git Bash, npm's Windows junction answers true and a
  package folder from the registry answers false; on Linux and macOS npm links with a symlink.

### `scripts/install.sh` (migrated in the #74 REVIEW)

- **WSL guard.** `/proc/sys/kernel/osrelease` matching `microsoft|wsl` covers WSL1 and WSL2 (the
  test pins one string of each). A WSL shell would install into `/home/<user>/.rsct/`, which a
  Claude Code running on Windows never reads. Since 2.19.0, `--wsl` installs for a Claude Code that
  runs inside WSL (ADR-032); the check stays inline, ahead of sourcing `scripts/rsct-lib.sh`.
- **`read_or_default`.** `read -r` returns non-zero at EOF and `set -e` turns that into an abort, on
  purpose. An unconditional EOF fallback was measured in the #73 REVIEW: `bash scripts/install.sh
  </dev/null` without `RSCT_ASSUME_YES` ran a FULL install, because `Proceed? [y/N]` displays N and
  passes a coded default of `y`. The fallback is opt-in through a fourth argument, and only the
  removal-consent prompt passes it (default `n`). `read` assigns a partial last line, so only an
  EMPTY reply falls back. The stderr line exists because the abort used to be silent.
- **Host config path (`HOST_CFG`, #73).** `claude mcp add/remove` is a Node program: it honours
  `CLAUDE_CONFIG_DIR`, else `os.homedir()` — `USERPROFILE` on Windows, not bash's `$HOME`. The script
  resolves the same file through node (`rsct_host_config` in `scripts/rsct-lib.sh` since 2.19.0) and
  falls back to `${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json` only when node is absent or prints
  nothing. While it read `$HOME` and the CLI wrote elsewhere, detection missed a live user-scope
  entry and recorded `project` over it.
- **Every `node -e` body is single-quoted.** In a double-quoted body bash collapses `\\` (`\\b`
  becomes a backspace) and `$`/backticks go live; that is POSIX double-quote semantics, the same on
  Linux and macOS, and `bash -n` does not flag it. A backslash is built with
  `String.fromCharCode(92)`.
- **Scope marker (#71).** The menu default is derived from `~/.rsct/mcp-scope`; while it was the
  literal `1`, Enter or any unattended run rewrote a recorded `project` to `user`. The read is an
  `if`, not `[ -f … ] && VAR=…`: under `set -e` an `&&` chain as the LAST statement of a function or
  script body aborts (measured; as the last statement of an `if` block it does not). `tr -d '\r'`
  covers a hand-edited CRLF file, `head -1` bounds a corrupt one.
- **`MCP_SCOPE_KNOWN`, not `MCP_SCOPE_RECORDED`, gates "press Enter to keep it".** KNOWN is set only
  on an exact match; a marker with a stray space, another case or a BOM is non-empty but unmapped.
  `skip` is legacy: readable, displayed as resolving to `[1]`, never acted on by an unattended run —
  the README once told every teammate of a project-scope team to pick `[3]`, and a silent user-scope
  registration there masks the `.mcp.json` they share.
- **Empty reply at the menu** is resolved at the call site: inside `read_or_default` it would flip
  `Proceed? [y/N]` to proceed-on-Enter.
- **A `3` keypress** is normalised to `[1]` with a notice that is NOT gated on a recorded scope: on a
  fresh machine the gated one prints nothing.
- **Version markers (#44).** `~/.rsct/VERSION` (protocol, from `/VERSION`) and `~/.rsct/VERSION-CODE`
  (from `version.ts`). The code read is anchored on `^export const RSCT_MCP_VERSION` AND uses
  `sed -n …p`; either alone still yields the version, reverting both reproduces #44 (a docstring line
  went into the marker and the drift report read "same" forever). `sed` is last in the pipeline so a
  no-match exits 0 under `set -e`. A marker holding non-version text reads back as `unreadable` —
  distinct from the incoming axis's `unknown` and from the empty "no marker", which must keep reading
  as a fresh install. Markers are read through `tr -d '\r'`: `~/.rsct` can be copied between machines,
  and on Linux/macOS `2.6.1\r` differs from `2.6.1` on every run; Git Bash strips a trailing CR in
  command substitution, so a Windows run cannot see it.
- **`RUNTIME_DIRS`** is the list of what ships to `~/.rsct`; the WARN for a source-root directory in
  neither list keeps a new directory from being skipped in silence. The two retired command stubs
  (`rsct-init-universe`, `rsct-canonical-source`) are deleted on every install.
- **Project scope takes effect or is not recorded (#73).** A user-scope entry wins a name collision:
  the project entry's process is never spawned, approved or not. `SCOPE_EFFECTIVE` starts empty,
  every arm assigns it, the marker is written last from it; `unattended` has its own arm (the one
  legitimate no-write) and an empty value prints an INTERNAL error. An unattended run never removes a
  user-scope entry and never rewrites the marker.
- **The CLI's exit code is diagnostic only.** After `claude mcp add` / `remove` the host config is
  re-read unconditionally: exit codes differ across the Windows wrappers (the PowerShell `.ps1`
  returns 1 on "not found", the Git Bash stub returned 0), and a CLI that acted and then exited
  non-zero must be believed by the probe. Detection parses the top-level `mcpServers.rsct`:
  `claude mcp list` in a pipe includes project-scope entries, `claude mcp get` is exit-code-unreliable.
- **`claude … </dev/null`** keeps the CLI from eating the answer to a later prompt. No prompt follows
  the removal today, so no test can pin it; it turns load-bearing when a third question is added.
- **Pending-projects report.** A project resolves rsct at project scope only when its `.mcp.json`
  registers it AND `.claude/settings.local.json` approves it; both kinds are listed, because the
  removal breaks the registered-but-unapproved ones.
- The epilogue's effective-scope line reads `HOST_CFG`, so it cannot disagree with the CLI.
- **Companion step (#74).** On a global npm folder that needs elevated rights (measured on Linux,
  npm 10.9.2, a read-only prefix): the first `npm install -g .` fails with `EACCES`, which is the one
  place a `sudo` command is printed; once the link exists, a later run exits 0 without it, so updates
  need no `sudo`; `npm uninstall -g` of a package that is not installed exits 0 there too. The
  identity check can prove "this is the copy" and nothing else — behind a version manager's shim it
  says "could not be confirmed", never "is not".

### `scripts/rsct-lib.sh` (2.19.0, #110)

- MEASURED 2026-10-21 in WSL2 (Ubuntu, kernel `5.15.167.4-microsoft-standard-WSL2`, bash 5.2.21):
  `wslpath -w` answered `\\wsl.localhost\Ubuntu\home\<user>` for the home, `\\wsl.localhost\Ubuntu\tmp`
  for `/tmp`, `C:\Users` for `/mnt/c/Users` and for a link inside `/tmp` that points there. PATH
  held 47 entries, 38 of them under `/mnt/`; `node` had no Linux copy while `npm`, `claude` and
  `rsct-mcp` answered the Windows programs.
- `rsct_wslpath_side` reads only the prefix: a share named `\\wsl.localhost.example\…`, a `\\?\`
  path, an upper-case `\\WSL.LOCALHOST\` and an empty answer are the Windows side, so a doubtful
  answer stops a `--wsl` run instead of letting it write.
- `rsct_path_side` refuses a `.` or `..` segment before asking: the walk up to the deepest existing
  folder is lexical, the kernel's `..` is not, so `HOME=/home/u/missing/../../../mnt/c/x` was judged
  by `/home/u` while `mkdir -p` wrote under `/mnt/c/x` (found in the 2.19.0 REVIEW). The walk uses
  `${path%/*}`, not `dirname`: with every PATH entry dropped, `dirname` is not found, the path stays
  empty and the loop never ended (reproduced in the same REVIEW). In Git Bash `[ -e ]` resolves `..`
  by the text alone, so the reproduction needs a Linux kernel. A path that is not absolute is
  refused instead of being joined to `$PWD` (second REVIEW: `C:\Users\…` was judged by the current
  folder and passed), and so is a link whose target is gone, which `wslpath` would judge by the
  link's own place. The `MZ` test reads two characters with `read -n 2`, a builtin, so it does not
  depend on a `head` being on the rebuilt PATH.
- `rsct_linux_path` keeps no entry that is not absolute (`.`, `bin`, `node_modules/.bin`), because
  `rsct_path_side` answers `unknown` for it: after the installer's `cd` into a clone on `/mnt/c`,
  such an entry would resolve there (reproduced). It splits on `:` with `IFS` local to the
  function and `set -f`, so an entry with a space stays whole and an entry with `*` is not
  expanded; `set +f` afterwards. The callers do not run with `noglob` on purpose (the uninstaller
  turns it off before its wipe loop anyway).
- Contract under `set -e`: `rsct_tool_is_windows` is a yes/no function, called only in `if`;
  every other function prints its answer and returns 0, so `X=$(…)` never stops a script.
- `rsct_host_config` builds the backslash with `String.fromCharCode(92)` inside a single-quoted
  `node -e` (CLAUDE.md, cross-OS rule 4, MED-16/CAP-20) and turns it into `/` on Windows only: on
  Linux and macOS a backslash is part of a file name, and Claude Code there keeps it. Without node
  it falls back to `${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json`.

### `scripts/uninstall-framework.sh` (migrated in the #74 REVIEW)

- The companion is asked about separately because a developer may keep the server for projects wired
  through `.mcp.json` after removing the framework files; `--skip-mcp` asks nothing and touches
  neither the global install, its files, nor a user-scope registration — and the plan line says
  "left untouched" rather than "will ask separately".
- User-scope detection parses the host config's top-level `mcpServers.rsct`: `claude mcp list` in a
  pipe includes the project-scope entries of any `.mcp.json` in the cwd ancestry, and would offer a
  removal the user-scope command cannot perform. Since 2.19.0 (#82) the file is resolved like the
  installer's `HOST_CFG` (`rsct_host_config` in `scripts/rsct-lib.sh`), detection needs node but not
  `claude`, and the entry is re-read after `claude mcp remove`, whose exit code is not used. The
  re-read exits 0 (still there), 1 (gone) or 2 (unreadable), so a file the CLI damaged or deleted
  is reported as not confirmed instead of removed.
- Both scripts compute `SCRIPT_DIR` with `CDPATH= cd --`: with an exported `CDPATH` holding `.`,
  `cd` prints the folder and the command substitution captured it twice, so sourcing
  `rsct-lib.sh` failed (found in the 2.19.0 REVIEW; the uninstaller had no `SCRIPT_DIR` before).
- The removed-command list keeps the two retired names so old stubs are cleaned.
- `set +f` precedes the wipe loop: with `noglob` inherited from the environment the loop ran over the
  literal patterns, removed nothing and still printed "Removed" (measured).
- No line prints an `rm -rf` to paste. Every "later" path says to run the uninstaller again, which
  finds the folder with no command on PATH and finishes the job; an unquoted `rm -rf $HOME/…` hint,
  pasted with a space in the user name, was measured deleting another folder.
- `claude mcp remove … </dev/null`, as in the installer: without it a run with stdin left open hung
  on the test stub, which drains stdin.

### `lib/verification-checklist.ts` (migrated in the #79 REVIEW)

- **Every checklist finding gets its evidence class at ONE door** (`evidenceForSource`), not at the
  nine emission sites: the `RawFinding` a site builds has no `evidence` field, so a site cannot
  forget to classify (#75). The table is TOTAL — the `default` arm returns the WEAKEST class and
  names the offending `source` literal, so a literal added later degrades safely and loudly.
  `source` stays typed `string` on purpose (narrowing to a union ripples through every consumer and
  is not riding this feature), which is why the `default` arm and `coerceEvidence`'s own fallback
  both stay; `tests/unit/verification-evidence.test.ts` asserts no emittable source reaches
  `default`.
- **The V phase has no agent-declared findings** — `phaseVerificationStartInputSchema` is
  `.strict()` with no `findings` field, so every finding is machine-produced; the framework must
  classify its own, and `also_explained_by` is person-authored and reviewer-checked, not producible
  by an agent under queue pressure (#75).
- **`DiscoveredImporter` is aliased from `lib/reverse-dep-walk.ts`** (the producer and owner), not
  redeclared — the two had stayed in sync by luck (#10).
- **The org contract graph is injected by the caller** (#75 Part B), so this module still takes only
  a project root and a test can hand it a graph with no universe on disk. No dependency on #54:
  `contractsTouchingPaths` already returns the shape in-process; #54 would add persistence and a
  query tool, neither needed here.
- **Four of the five `contract_graph` states are no-ops, each reported, never collapsed** into one
  silent "raised nothing". `no_manifest` is the DEFAULT state of every universe — `contracts.json`
  is hand-written and no installer creates it — so an empty graph is the common case, not an edge. A
  contract with no consumers gates nothing: reporting it would charge a mandatory action for a
  dependency nobody declared.
- **Finding ids carry a `v-` prefix** so V-phase ids stay distinguishable from REVIEW-phase ids in
  the shared audit trail, where `findings_actions[]` reference them by hand.
- **The `knowledge-category:*` source set is exported** so the exhaustiveness test derives it from
  the keys rather than a hand list that would go stale silently; the match is by prefix because the
  source is interpolated per category.
- **"No findings against the corpus" is claimed only when every corpus file was actually read**
  (#49/#58): a clean pass over a present-but-unreadable file is the same silent zero those issues
  removed, and this checklist closes the V phase, so the miss is worse one phase later. The
  empty-findings path returns an empty literal, never the unclassified `RawFinding[]`, so the
  central-classification door stays the only exit.
- `affected_paths[1]` is the doc; `[0]` is the declared path that matched it.
- **The premise-check findings show `score N, shared: …` (#79)** — the match carries them and the
  developer needs them to triage by strength; display-only, the gate baseline never reads `detail`.

### `lib/plan-authorization.ts`, `lib/plan.ts` (migrated in the 2.17.0 REVIEW)

- The token functions are pure: they never throw and never touch the file system; the tools own
  the reads and writes through the locked `writePhaseState`. The token carries no overrides, so it
  never passes INV-5 or INV-6.
- `validateToken` returns the first failing reason in a fixed order — absent, not covered,
  expired, unrecorded, branch, plan gone, plan complete, exhausted — so the caller can name the
  cause. A hand-edited token without `covers` reads as not covered instead of throwing. The caller
  hands it the token's own plan, found by its `plan_slug`, never the newest plan by mtime (FV1):
  touching an unrelated plan file mid-session must not change what the token is checked against.
- TTL and `max_actions` resolve as tool input, then the config default, then the built-in default.
  Both inputs are bounds-checked upstream (zod, `RsctApprovalModesSchema`); the token clamps again
  so no later caller can mint an out-of-range window, and a non-finite value takes the default.
- `findPlanBySlug` takes `plan_<slug>.md` first and `spec_<slug>.md` as the fallback;
  `findPlanFileBySlug` (2.17.0) takes `plan_` only, and only a name the directory listing returns.
  `phaseSpecExists` checks the `spec_` form only — one spec per phase in a multi-phase plan (PH-1).
  The active-plan lookup accepts `spec_` as an alias of `plan_`, as rules/B does (CAP-53).
- `findPlanByBranch` keys the integration gate's plan-complete check on the plan whose `Branch` row
  is the branch being integrated, so touching an unrelated completed plan to win the mtime race
  cannot pass the check (plan-lifecycle-v2, HOLE A). Since 2.18.0 (ADR-031) both sides go through
  `branchKey` (no `refs/heads/` or `heads/`, NFC, lower case), and the tools ask
  `branchPlansHaveOpenItems` for the branches they integrate.
- `isPlanComplete` reads the plan's `Status` row with English and pt-BR completion words, starting
  on a word boundary so "incomplete" is not "complete"; a plan it reads as finished ends that
  plan's batch token (`plan_complete`). Its only caller is `validateToken`.
- Progress checkboxes inside fenced code are ignored; CRLF is normalised; indented items and `*`/`+`
  markers count. `progressHasOpenItems` is lenient — an absent file has no open items; it only
  refuses a `plan_complete: true` that visible open items contradict. The destructive cleanup uses
  `progressCompletionState`, where only `all_closed` (at least one closed item, none open) counts:
  the absence of open items never clears an unfinished plan for deletion.
- `listPlans` (#55) orders by the plan file's mtime, and since 2.18.0 (ADR-031) a tie by the NFC
  file name in code-unit order. The table's `Last update` row is reported
  and never sorts: two recency sources disagree as soon as someone forgets to edit the row. `slug`
  comes from the file name and is the resolution identity; the `Slug` row is reported as
  `declared_slug` and never resolves a plan (#57). `slug` is not unique in the list — `plan_x.md`
  and `spec_x.md` can coexist and share `progress_x.md`. Since 2.18.0 `findActivePlan`,
  `findPlanByBranch` and `findNewestPlanFile` filter the same enumerator, pinned by
  `plan-lookup-spellings.test.ts` with ten mixed-case names of one mtime.
- Metadata rows are read from a markdown table within the first 60 lines.

### `lib/update-check.ts` (migrated in the 2.17.0 REVIEW)

- Consult by default (#38). "May I ask GitHub" (opt-out) and "do you want this release" (per tag,
  `declined_tags`) are separate decisions; a decline silences that release only.
- Cached in `~/.rsct/update-check.json` for 24 h, fail-silent and suggest-only: it never downloads
  or updates anything. `rsct_status` reads only the cache; a stale cache fires a background refresh
  whose result lands for the next call, so the status adds no network latency.
- Off switches, in precedence order: `RSCT_UPDATE_CHECK=off` (the only one reachable before a
  session exists — CI, headless, a machine that must never send the request), `rsct_status` with
  `update_check: "off"`, and the cache's `consent` field. Any present `consent` other than `"yes"`
  is off: testing for the literal `"no"` would fail open on every hand-edit variant (`"No"`,
  `false`, `0`, `null`), and hand-editing was the only opt-out older versions had. The refresh
  never writes `consent` — recording a "yes" nobody gave erases what the opt-out notice depends on.
  The variable outranks the file, so a caller reports `isUpdateCheckKilled` instead of promising an
  effect. Turning the check off spends the opt-out notice; turning it on restores it.
- A one-shot notice is a count, not a flag: a hint may never be relayed, and a flag burned when the
  hint is generated is spent unread. A notice is emitted only when its increment persisted — on a
  read-only home a counter that never lands would nag on every call.
- The cache is shared by every project and every installed version, so every field is optional and
  unknown fields are kept: writes spread the fresh read instead of listing fields, and the write
  after the network await reads again first, so a decline or an opt-out recorded during the request
  is not erased.
- Unreadable is not absent. An unreadable file fails closed and is never overwritten: a transient
  OneDrive or antivirus lock, or a root-owned `~/.rsct`, would otherwise send a request the
  developer opted out of and overwrite the recorded choice. Only `ENOENT` means absent. A BOM is
  tolerated, or a file saved by a Windows editor would silence the check for good. Writes go
  through a pid-suffixed temp file (two processes share one global binary) and report whether they
  landed.
- Staleness is measured from the last attempt, not the last success: a failing network never
  advances `last_checked`, and measuring success would send a request on every call. An in-process
  memo keyed by home bounds the attempts when the disk write never lands, and is stamped before the
  request so the calls inside one request window do not each start their own. A stamp in the future
  (wrong clock, VM restore) is stale, never fresh for ever; an unparseable `last_attempt` falls
  through to `last_checked`.
- Tags are normalised (`v`/`V`, whitespace) on the offer and the decline path alike — one capital
  letter in a hand-made tag would otherwise silence that release. An unparseable version is never
  a false "update available".
- A decline must name the release being offered (cached, newer than the running version, not
  declined), which refuses a mistyped tag, a release never offered and a release that does not
  exist yet. Accepting a tag that is not newer than the running version lets a decline swallow a
  real future release: decline v2.6.0 on a 3.0.0 branch, go back to 2.5.1, and v2.6.0 is silenced.

### `tools/request-push.ts` (migrated in the 2.17.0 REVIEW)

- The install-drift advisory is evaluated before every pre-gate check and prepended on every return
  path (#25): a push is outward-facing and hard to reverse, so degraded enforcement matters more
  here than at commit.
- The remote must be a configured remote of the repository (#62 B5). MEASURED: `git push
  <bare-path> main` lands the repository in a foreign one, `git push -- <path> main` is still rc 0,
  and `git push --mirror -- origin` is rc 0 and deletes remote branches, so the `--` sentinel is
  not enough on its own. Strict by decision: only an unreadable list (outside a repository) skips
  the check; an empty list refuses, because a repository with no remotes is the shape a path remote
  exploits. Pushing to a URL or a path stopped working on purpose; the schema always documented
  the field as a remote name.
- The destination is resolved before the protection check (#62 B5). `isProtectedBranch` is an exact
  compare, and `+main`, `HEAD:main`, `refs/heads/main`, `heads/main` and `@` all landed on the
  remote's `main` with no ack and no override (measured, git 2.45.1). Option-shaped, glob and empty
  destinations are refused; a glob force-updated a protected `main` while the plain push of the
  same state was refused (measured).
- The ref store's answer is added to the string candidates, never put in their place: it answers
  for the local ref store while the push writes the remote, and a clone with no local `main` still
  moves the remote's `main` with `HEAD:refs/heads/main`. It is trusted only when the output starts
  with `refs/`, never on the exit code. MEASURED: `rev-parse --symbolic-full-name` is rc 0 with
  empty output for `HEAD@{0}`, echoes `HEAD` on a detached HEAD, and on failure still echoes its
  argument; taking that into the set can make a branch protected that is not, a hard stop with no
  override.
- That `rev-parse` call has no `--`, and that is load-bearing (Rv-A). With `--` it echoes the
  operands (`--`, then `main`), the arm was dead, and `git push origin HEAD` from a protected branch
  skipped the ack, the coverage check and the override while the audit recorded `protected: false`.
  The refspec parse makes this safe: it refuses a destination starting with `-` before the call. A
  "refuse multi-line output" guard is not a second barrier — `rev-parse --symbolic-full-name --all`
  returns one line in a repository with one ref.
- The coverage range is `<remote>/<destination>...<source>`: what is on the remote, and what is
  sent. Using the raw branch for both composed `origin/feat/x:main`, git's `<rev>:<path>` tree
  syntax. Two shapes name no range and degrade: a delete refspec (`:main` carries no files, and
  `origin/main...` would be another range) and a destination still spelled `HEAD` (`<remote>/HEAD`
  is the remote's default-branch symref — confidently wrong). They get different advice: a named
  range that does not read is a fetch problem, an unnameable one is not; the audit tells them apart
  by `range_base: null`.
- Push fails open on an unreadable range, the only one of the three. MEASURED: `git push origin
  main` succeeds with `origin/main` never fetched, so the range is rc 128 on an ordinary first push
  of a `--single-branch` clone. The push is protected by the remote allow-list, the refspec parse,
  INV-5 on the resolved destination and `override_protected_branch`; a readable range is still
  checked.
- The pre-integration ack is required only for a protected destination (MCP-P1-D): a feature push
  to trigger CI must not force a dishonest attestation. It is checked before the dialog, so a
  missing ack refuses in chat and spends no approval. On a push that is not protected,
  `path_crosscheck` is left out rather than labelled — the check did not apply.
- The cleanup advisory after a completed plan appears only on a protected push, the only push that
  carries the plan-complete ack; the plan is found by branch, then the active plan. It is
  suggested, never performed.

### Tests and build

- The dialog tests of 2.20.1 (ADR-034) never open a window: the unit tests hand `runWindowsDialog`,
  `runMacDialog` and `runLinuxDialog` a recording executor, and the Windows integration test runs the
  real PowerShell with the dialog call replaced by an echo (the no-desktop case also replaces the
  check with `$true` on top of the echo, so a script that went past the check would still open no window). Each case exists for one mutation, all
  killed: a Windows failure, an unexpected Linux ending or unexpected macOS output counted as no
  channel; the no-desktop word matched loosely or with a failing exit; the desktop check inverted;
  the script written through a cmdlet or with module autoloading left on; a missing program read
  from the message instead of the error code; the error code not copied by `normalizeExecError`; any
  macOS failure, or a stopped osascript, read as a decline; the Linux display check dropped or
  reading the message; the zenity exit codes not passed; the gate trusting an unknown answer, a
  forced failure reported as a missing channel, the reason losing its trust note; run-alone's start
  not recording `dialog_failed` as declined; the REVIEW reason for a failure saying "could not be
  shown". The gate's non-forced cases pin `fabrication_signals` as empty: with an `action_scope`
  that does not match the tool, a scope signal forces the dialog, and the first version of those
  cases tested the forced path by mistake (the gate mutation survived until the scope was fixed).
  After the REVIEW, also killed: the no-desktop word accepted as a prefix (a case appends `Yes` to
  it); the forced path refusing only `failed` (an unknown answer also runs forced); the script's last
  statement written another way (the whole script is pinned, so Linux and macOS cells catch it too);
  the zenity error code not passed; the no-desktop branch not ending the script — the real
  no-desktop case runs on top of the echo, so that mutant fails the test instead of opening a window
  (the first version replaced only the check, and only `exit 0` stood between it and a real dialog).
  MEASURED on the release CI (PR #141, Node 20 cells red on all three systems, Node 22 green): on
  Node 20 `execFileSync` hands `stdout` and `stderr` as `null` for a program that does not exist, and
  the old `bufferOrStringToString` called `toString` on it, so a missing dialog program threw instead
  of returning "no channel" (an older defect: the code was the same before 2.20.1). It now reads
  `null` as empty. That makes Node 20 follow the documented rule — no dialog program means no
  channel, where `trust_allowed_for` applies — which is more permissive than the crash for that one
  case; the maintainer decided it (2026-10-22, "Ok para A"). The test that calls `defaultExecutor`
  on a missing path is what catches it, on the Node 20 cells only.

- The #82 tests of 2.20.0 (ADR-033) run the real prompt blocks. `tests/bash/lib/chain-harness.ts`
  runs several blocks in one folder, each in its own shell as the agent does, with node steps
  between them standing in for the agent's edits. `HOME` is the project folder by default; the
  CREATE steps point it at a separate folder so the template never lands in the project's `.rsct/`.
  The git helpers set `commit.gpgsign=false` and `core.hooksPath`, as `tests/sweep-repo.ts` does, so a
  signing or hook setup in the developer's global git config cannot fail them. The symlink cases
  create the link through bash with `MSYS=winsymlinks:sys`, so they run on Windows without symlink
  rights too (a native link on Linux and macOS). Each case exists for one mutation, all killed in
  the T phase: setup — the 4.3 refusal off; a folder or a blank file without node counted as
  empty; Step E without the fence check, with `RSCT_APP:` anywhere, without the byte-order mark,
  without the first-heading fallback; Phase 1.5 searching keywords inside RSCT blocks, counting the
  placeholder lines, taking a mid-line marker; Phase 1.0 back to `rev-parse HEAD` (the anchor of
  that test is the `echo` line, because the first anchor sat inside the mutated text and the test
  failed for not finding its block). Uninstall — every body as framework text; an unclosed BEGIN
  accepted; a mid-line BEGIN; the byte-order mark dropped; the scope ignored; the placeholder search
  inside the filled section; 4.3b with sections left, removing an edited pointer, keeping the blank
  line before the pointer or after the header; 4.3c without `--full-tree`, reading the blob from the
  root, template lines as framework text in UPDATE, an old file counted as framework text without a
  header, the dry run honouring markers, the real run ignoring them, the restore skipped, any hash
  taken as a commit; 4.6 splicing every match; 4.V.c replacing an existing ignore file; 4.7
  removing an edited one or one next to a kept log, and keeping an empty `.claude/`; 1.6 without
  the linked-worktree check or comparing paths as text; 1.3 reporting uncommitted as committed.
  Server — the helper acting at `same`, replacing a file, throwing, writing `*`, and each of the
  six call sites removed. The two calls of a consumed approval cover each other, so each case makes
  the other write fail: a folder where the log should be, or where the store should be. After the
  REVIEW fixes, each in turn: every symlink guard off (4.2 sections, placeholder, canonical, 4.3b,
  4.3c — the 4.3b case links to a file with no section left, since with sections 4.3b writes
  nothing anyway, and the chain case adds a canonical section to the target so the canonical guard
  is reached); the slot and canonical markers matched mid-line again (both lines of a pair, which is
  what the old code did; one line alone leaves the pair unclosed and refused); an unreadable file
  at the commit counted as absent; 4.3c applying by default; the worktree count dropped; the store
  removed in a shared main worktree, and kept everywhere; Phase 1.6 ending on a false test; the
  retention call with no log, and removed. MEASURED on the first CI run of the release (PR #140),
  green on Windows only: the uninstall 4.4b left a blank line where the block had been in a CRLF
  `.gitignore` on Linux and macOS, where awk sees the `\r` (anti-pattern #4); it now pipes through
  `tr -d '\r'`, and the test expects LF exactly on every system — on Windows that case cannot fail,
  since awk there never sees the `\r`. And `mktemp` with no argument does not fail on macOS when
  `TMPDIR` names a missing folder, so the unreadable-file case deletes the blob's loose object
  instead (made writable first: git stores objects read-only).

- `tests/bash/lint.test.ts` (migrated in the 2.19.0 REVIEW) is the static bash lint (T0.a): `bash -n`
  over every prompt block and script (the V2 regression gate), the AP1–AP7 detectors over the real
  corpus with no ERROR finding allowed, one self-test per detector (it must flag a known-bad and
  pass a known-good: a detector with no proof it fires is a silent pass), and the CI guard that
  fails when `RSCT_REQUIRE_BASH=1` and bash is missing. The block counts guard against an extractor
  that lints nothing. No `scripts/*.sh` may be skipped by the illustrative-sentinel heuristic: it
  exists for prompt blocks that show a "❌ NÃO usar" example, but `loadScriptBlocks` runs the same
  `skipState` over whole scripts, so one comment with ❌, PROIBIDO or "NÃO usar" would switch off
  every detector and the `bash -n` gate for that file, and the skip is only logged (#73: the
  install.sh comments of the time cited anti-pattern #5 by name). The skipped-block report is
  informational, not an assertion. The `bash -n` gate spawns about 70 synchronous bash processes,
  slow under Git Bash on Windows CI, hence its 120 s timeout. The AP5 self-test's known-bad parses
  and re-stringifies a whole file; its known-goods are the documented `.mcp.json` exception and a
  per-value text splice. AP6 is off by default.
- `verification-checklist.test.ts`: the clean-pass suppression is scoped to the corpus MISS, not to
  a small corpus — the cases use only `decisions.md` with no `knowledge/` directory, because a
  present knowledge category emits `forgotten` prompts that would lift the count above zero and skip
  the branch for an unrelated reason; a directory AT a category path is "present but unreadable".
  The #58 case pins that a clean pass over an unread file is the V-closing silent zero; the #79 case
  pins the `score N, shared: …` detail (mutation: drop the append).
- `tsup.config.ts`: runtime deps are bundled (`noExternal`) so `dist/index.js` runs with no
  `node_modules` (the 2026-06-22 "no mcp__rsct__* tools" incident); pino's dynamic
  `require('node:os')` needs the `createRequire` banner, with the shebang kept on line 1.
  `dist-standalone.test.ts` copies the bundle outside the repo so Node cannot resolve the
  repo's `node_modules`; `spawnSync`, because the stdio server exits 0 on EOF and
  `execFileSync` would drop stderr.
- `block-smoke.test.ts`: blocks are extracted from the real prompts by anchor. Marker-range
  assertions exist because `toContain` passes on the alias comment that contains `plan_*.md`.
  The `.gitignore` clauses use a whole-file guard and a block-scoped splice — a block-scoped
  guard duplicated a line a dev already had, an unscoped splice landed in the dev's section
  where uninstall cannot remove it. In the MCP-approval block, `exec 2>&1` is the test: without
  it, deleting the type guard survived mutation because stdout, exit code and file bytes are
  identical and only the stderr refusal differs. Version-stamp and hook-registration tests run
  the real block against the real reader (`STAMP_RE`, `readScriptRegistration`) so the bash
  writer and the TS reader cannot drift with a green suite; the hook idempotency key is the
  marker, which only a second run catches.
- `findings-gate.test.ts`: every negative assertion is seeded so the guard under test is the
  only thing producing the result (the #38 review found three that passed against a broken
  build). The run-id producer is exercised through the real `_start` (M16 survived when tests
  seeded the id by hand). `how_to_falsify` is matched on a fragment, not `expect.any(String)`,
  which accepts `''`.
- `review-evidence.test.ts`: the dialog-detail spread-order test must inject a competing
  `dialogDetail`; injecting only `promptFn` passed under both orders (measured, 8/8 green under
  the mutation). Evidence stays optional in the declared-finding schema; making it required would
  break recovery of findings stored before #75.
- `phase-machine.test.ts`: the #15 exception is tested mostly through negatives — a stale
  `code` label carries no completion evidence and has no claim on it.
- `phase-abandon.test.ts` (#53): the abandon writes an allowlist copy
  (`PHASE_STATE_PRESERVED_ON_ABANDON`) instead of `{}`; the tests pin it in both directions, since a
  list that only gains keys is how a live batch token would survive. Every test asserts
  `status === 'abandoned'` and a cleared control key first — a rejected §C gate returns without
  writing, so a failing fixture would pass every "this key survived" assertion. The `context_stale`
  fixture must carry `phase`: `completePhaseGeneric` deletes `phase` in the same write that arms the
  flag, and the abandon early-returns without writing when `phase` is absent. State is read from
  disk, never through `phase_state_override`.
- `audit-anchor.test.ts` (#92): each case exists for one mutation — the default path based on
  `projectRoot` again; always relocating to the parent; a missing identity treated as a
  relocation; a configured path honoured unconditionally (MEASURED: it moves the audit-log anchors
  away from the CORRECT root); every configured path refused; `isInside` as a bare `startsWith`
  (a sibling whose name extends the base reads as inside); a second copy of the path logic in the
  hook; the legacy-log migration skipped (the audit-log ceiling resets to 0);
  `renameSync` in place of `copyFileSync`; the legacy file appended to an existing target; the
  `sameDirectory` guard dropped (a plain repository would rewrite its own log on every process).
- `check-edit-scope.test.ts`: the root-relative cases pin PH-1 — an absolute `file_path` never
  matched a root-relative glob. The matcher itself stays case-sensitive (a lower-case glob does not
  match a differently-cased body); the absolute path is built from the root the handler resolves,
  because macOS turns `/var` into `/private/var`.
- `sanitize-permissions.test.ts`: the machine-path corpus IS the spec — real entries from the #17
  field report plus common permission shapes — and its negatives matter as much as its positives,
  since a false positive deletes a teammate's permission. The `git -C` relocation case was pinned
  as a documented gap in 2.5.0 and inverted by #32.
- `compiled-hooks.test.ts` (#114) launches the files in `dist/scripts/` the way a project holds
  them: shebang, stamp line, body, a `package.json` with `"type": "module"`, an explicit
  `CLAUDE_PROJECT_DIR`. Unit tests that import the functions cannot see what the bundle does when
  it is run — that is how 25 releases shipped the inert guard. `RSCT_TEST_HOOK_DIST` points the
  same rows at another build; against the released 2.12.3 files 10 of the 11 launch rows fail
  (the plain sanitizer row is the one that passes). Every allow row has a block row on the same
  state. The link case asserts that the link and the real path differ before it trusts its
  result, and does not skip. A row that needs a literal `..` builds the string by hand:
  `path.join` folds it away, and two rows once tested `README.md` under that name.
- `hook-registration.test.ts` (#114) runs the registered command LITERALLY through `bash -c` in a
  project whose path has a space; asserting the string alone would pass with the quotes in the
  wrong place.
- `request-merge.test.ts`, `request-push.test.ts`, `request-rebase.test.ts` (migrated in the 2.17.0
  REVIEW): `tmpRoot` is not a repository, so the default range reader returns an empty but
  readable range (`ok`, never `unavailable`); the fail-closed path has its own test. The reader is
  a spy, so a test can assert which range was asked for — a swapped base and head is a real defect
  class, and rebase and squash move in opposite directions. The ack schema parity tests derive the
  keys from the Zod shape: a hard-coded key list stayed green while a field missing from the JSON
  mirror (`additionalProperties: false`) would block every merge, protected push and rebase. Each
  refusal case has a control that an always-refuse version cannot pass (an ordinary ref, a
  configured non-default remote, an overridden protected push). The drift-advisory tests count the
  advisory's own lines, not the whole message, which #92 grew by naming the repository.
- `request-push.test.ts`: where the argv is under test, the git fake throws on an argv it does not
  model — the permissive one let 21 of 22 argv sites go stale. A block runs a real repository and
  the real executor, with only `push` intercepted, because a stub had fed the `rev-parse` arm output
  real git cannot produce for that argv, and the arm's mutant died against a wrong fixture.
- `request-rebase.test.ts`: the unsafe-revision test asserts that the token appears in the reject
  text. The earlier "git was never invoked" assertion was vacuous, measured by deleting
  `isSafeRevisionToken` with the test still green: the real reader runs through another seam. The
  exec-side barrier is pinned against a real repository in `git.test.ts`.

### `tests/bash/script-install.test.ts` (migrated in the #74 REVIEW)

- **The sandbox is structural.** `runScript` pins HOME, USERPROFILE, CLAUDE_CONFIG_DIR and npm's
  prefix by default and refuses to reach the companion branch without a stub dir and pins that hold
  the sandbox prefix `rsct-install-`. Under #71 the worst reachable call was an additive
  `claude mcp add`; under #73 it is `claude mcp remove rsct --scope user`, which de-registers rsct in
  every project on the machine. The guard tests `!env.RSCT_SKIP_MCP`, not `=== undefined`: `''` is how
  a contributor writes "clear it", and bash's `[ -n ]` reads it as cleared too. The pin check accepts
  ANY sandbox, because the `CLAUDE_CONFIG_DIR` case points at a second one on purpose.
- `USERPROFILE` is pinned because `os.homedir()` reads it on Windows, not HOME (measured).
  `RSCT_SKIP_MCP: undefined` clears the variable — Node drops undefined values; omitting the key
  would inherit a contributor's exported one. `tsc` does not cover this file (`tsconfig` excludes
  `tests/`).
- `read -r` on a closed stdin returns non-zero and `set -e` kills the script at the first prompt, so
  an interactive case needs a real pipe (`input`).
- **The kill timeout is the only bound.** `execFileSync` blocks the vitest worker, so vitest's own
  per-test timeout can never fire. 45 s against runs that take 1–3 s; the real-npm case passes 240 s,
  because on a machine at 100% CPU one real-npm installer run was measured at 78 s. A kill reaches
  only the top bash: its subshell and a real npm carry on, inside the sandbox.
- **Stubs.** `npm` identifies itself and its cwd so a case can prove the stub won `command -v` and
  where it ran. `claude` performs the real edit on `$CLAUDE_CONFIG_DIR/.claude.json`, because the
  installer re-reads the host config after every add/remove — an inert stub sends every case down
  the "did not land" arm. Its knobs: `STUB_CLAUDE_FAIL` (non-zero, no action), `STUB_CLAUDE_LIE`
  (exit 0, no action — kills "drop the re-verify"), `STUB_CLAUDE_ACT_THEN_FAIL` (acts, then exits
  non-zero — a probe gated on the exit code falsifies success but never failure). Every call is
  appended to `stub-claude.log`, since the installer redirects the CLI's stdout. It drains stdin so a
  missing `</dev/null` at a call site eats the next answer, and takes `rc=$?` first: a POSIX `if`
  whose condition is false and has no else completes with status 0. `rsct-mcp` is stubbed too (#74):
  without it a case resolved, and one mutation away would have started, the machine's own install.
  That stub logs how many bytes it read from stdin, which is what pins `</dev/null` on the start.
- `node` is NOT stubbed: an `exit 0` stub prints no version, so `MCP_INSTALLABLE=no` and the menu
  never runs. The `claude` stub must stay even though CI has no Claude CLI — without it the CI cells
  take "claude CLI not on PATH" while a dev machine takes the registering arm.
- **Pre-flight.** bash resolves PATH with `access(X_OK)` and skips an entry that fails it; on a
  `noexec` TMPDIR the stub is skipped and bash walks on to the real binary. Resolution is checked
  before the dir is handed to `runScript`.
- **`expectMenuRan` is a positive proof.** The marker is written only inside the menu, so any
  short-circuit before it leaves a seeded value untouched and a marker assertion passes with the fix
  reverted. `Choice [1/2] (default: N)` proves reachability and the recorded→default mapping at once.
  The AC 1 case does not call it, so restoring `[3]` reddens there on its own.
- **Honest coverage.** A trailing CR is stripped by MSYS in command substitution, so on Git Bash the
  CRLF-marker case passes with or without `tr -d '\r'` (measured); it bites only on the Linux and
  macOS cells. An interior CR survives `$( )` everywhere, which is why the scope fixture is
  `pro\rject`. The unattended-arm case asserts WHICH ARM RAN: a seed that already reads `project`
  let `SCOPE_EFFECTIVE="project"` and a deleted assignment both survive.
- **Identity fixture (#74).** A stub dir holding `rsct-mcp` plus `node_modules/rsct-mcp` → a link to
  the sandbox's `~/.rsct/mcp-server`, made with `symlinkSync(…, 'junction')` before the copy exists;
  it satisfies the Windows form of the identity check on all three OSes. The POSIX form needs a
  symlinked command and is skipped on win32. `FOREIGN_COMMAND` is the machine's own `rsct-mcp`: two
  cases run only where there is none, and the real-npm case expects "still on PATH" where there is.
- **Real-npm case (#74).** One case drives a real npm: prefix, cache, user and global config in the
  sandbox, offline, and `install-links=true` so that only the explicit flag produces the link. It
  asks `npm root -g` first and refuses to run unless the answer is inside the sandbox — the check
  that found the upper-case variables (see "Measured facts").
- **Architectural boundary case.** The scan is parameterised on the directory and run against a
  seeded tree as well: a scanner only ever pointed at the tree it must find nothing in cannot be
  shown to find anything. The extension filter is applied to `rel`, which is backslash-joined on
  Windows.

### `lib/os-dialog.ts`

- The dialog is drawn by the desktop, not by Claude Code's tool-result channel; that is what makes
  an approval out of band (INV-2.1) and what the §C contract leans on against a fabricated
  `dev_approval`. Tests cannot open real dialogs, so every platform helper takes an injectable
  `executor` and `gateRequest` takes `promptFn` (ADR-027).
- **`promptYesNo`** is synchronous underneath (`execFileSync`) but returns a Promise, so an
  asynchronous backend (DBus, a native module) can replace it without changing its callers.

### `lib/audit-log.ts`, `lib/gate-dialog.ts`, `lib/repo-anchor.ts` (migrated in the 2.18.0 REVIEW)

- `auditFields` sits beside `AuditAppendResult` because 15 tools had each declared an identical
  private copy (#10). A disabled audit maps to `{null, null}`; only a write failure sets
  `audit_error`.
- `appendAuditEntry` stamps `ts` over any caller value, appends one line, creates the parent
  folder, and never throws: a mutating tool must go on when the log cannot be written, and reports
  `write_failed` instead.
- `decideAuditPath`'s base is the repository the action lands in, not the caller's `project_root`
  (#92): a crafted subdirectory resolves back to that repository, so it cannot present a fresh
  ceiling, lock or history. A configured path outside the base is ignored and reported (`escaped`)
  because, MEASURED, an absolute `audit.path` moved the anchors away from the right root.
  `isInside` compares through the anchor's own normalisation — a raw `startsWith` disagrees with
  `sameDirectory` on a trailing separator, on `/` against `\` and on drive-letter case — and the
  `sameDirectory` call covers a path equal to the base, which has no trailing separator to match.
- `migrateLegacyLog` (AUDIT-2) carries an existing log to a relocated base: without it the first
  run after the upgrade in a monorepo package or a nested project finds no log, and a spent approval
  would become replayable. It copies, never moves (the old file stays as evidence and a half-done
  copy cannot destroy the only one), skips when both exist (two histories merged blind would count
  twice), runs once per root per process, and never throws — a failed copy leaves the new place
  empty, which fails closed at the history signal.
- `gateDialogFooter` (#92 defects A and F): MEASURED, before it no gated dialog named the
  repository — every message named a branch, a commit message or refs, so in the crafted-root probe
  the developer read "Authorize batch commits for this plan on 'main'?", true and useless, while
  every anchor sat in the crafted folder. Tools pass `config` only where they gate on branch
  protection; the narrowing notice is noise elsewhere. `anchorHints` carries the same facts in
  `hints[]`, because with no dialog channel the footer is never rendered. A relocation is reported,
  never refused (D1): refusing breaks the monorepo-package and nested-project setups measured
  legitimate.
- `repo-anchor.ts` (#92): MEASURED, an `rsct_request_commit` with `project_root` at a crafted
  subdirectory committed into the parent repository while the parent's log recorded nothing. The
  field is not rejected — the sanctioned registration passes no root, installs default to user
  scope, and the fallbacks are unreliable under WSL-from-Windows, so the per-call field is the last
  resort where they fail; the shared anchors resolve at the repository the mutation lands in
  instead. The derivation is global (one log per repository); only the reporting is scoped to the
  gated tools. `LOCAL_ANCHORS` stay per checkout.
- `canonicalPath` resolves the nearest existing ancestor and re-attaches the rest, since a
  containment candidate often does not exist yet; when nothing resolves (a `//wsl.localhost/` path
  that throws) it returns the plain absolute form, so a comparison degrades instead of failing.
  Normalising for comparison: `resolve()` already absorbs a trailing separator, forward slashes and
  `./` (MEASURED by mutation: removing the explicit strip reddened nothing; it remains for a drive
  root). Case is folded on Windows only — a candidate that does not exist keeps the caller's
  spelling, which on Windows names the same file, and folding on Linux would call two different
  folders equal.
- The anchor cache lives for the process: the answer for a root goes stale only if the
  repository's identity changes under it (`git init` inside it, or `.git` removed). A new worktree
  is a new key; `git init` in a crafted subdirectory makes the commits land there, so that escape
  closes itself.
- `resolveRepositoryAnchor`: a linked worktree resolves to its main worktree (`--show-toplevel`
  names the worktree), a submodule to its own toplevel (`dirname(common-dir)` points inside
  `.git/modules`), everything else to its toplevel; a bare main repository to its common dir's
  parent. `--path-format=absolute` is not used (AD-003). `repositoryDialogLine` names the target in
  the one channel the agent cannot forge but could aim.
- `protectRelocatedState` (2.20.0, ADR-033): every writer of a shared file calls it with its own
  write — after it; the retention cut before it writes its working files, and only when a log or a
  pending cut exists (MEASURED in the REVIEW: called unconditionally, it created the folder with no
  log, because `candidatesFor` always names one or two logs). A read reaches it only through the
  migration copy, which writes. It acts only for `relocated`: at `same` the project's `.gitignore` block
  already covers the files, and at `not-applicable` or `unavailable` there is no repository to keep
  them out of. `wx` keeps a developer's file, and the empty `catch` keeps the result of the write it
  follows. A consumed approval calls it after the audit line and again after the store: when one
  of the two writes fails, the other still protects the folder. It lives in
  `repo-anchor.ts` because the SessionStart sanitizer bundle must stay free of zod. The content is
  built from `SHARED_ANCHORS`; that list is pinned to the real writers by tests that check `git
  status` stays clean after an append, a consumed approval and a migration copy.

### `lib/dev-approval.ts` (migrated in the 2.20.0 REVIEW)

- The consumed-approval audit event records `action_scope` and `timestamp`, never `reason`: the
  store omits it too, it is free developer text, and the log must not carry free-form payload
  that may hold a secret.
- The `dev_approval` schema is strict: unknown keys are rejected, so a fabricated payload cannot
  carry extra "trust" markers. Each override block carries a `reason` that lands in the audit log,
  so every waiver is attributable. The contract-surface waiver (T2/INV-7) has no token path: under
  a plan token a commit touching a surface stays blocked until a per-action approval.
- `approvals_store_absent` (#92): MEASURED, `loadStore` reports `corrupt: false` for a missing file,
  so `rm .rsct/approvals-seen.json` looked like a fresh project. It is raised only when the audit
  log shows this project consumed approvals before — raising it on absence alone fired on the first
  approval of every new project and, because any signal forces the dialog, broke the headless
  `trust` fallback in CI. It stays a signal, not a rejection: a fresh project has no store either,
  and the audit half of the union is what catches the replay.
- `auditConfig` is forwarded by every gated call site so the audit half reads the file the
  consumption was written to; without it a configured `audit.path` would split the two halves from
  the rest of the log.
- `EXPECTED_SCOPE_TOKEN` is the per-tool prefix `action_scope` must start with (the token before
  the first `:`); a tool not in the map skips `scope_mismatch`.
- The timestamp skew default is 180 s, raised from 60 s in the M2 gate run: MEASURED, 78–155 s passed
  between the timestamp capture (through the Bash tool) and the tool call when each step raised a
  Claude Code permission prompt. `approval_modes.timestamp_skew_seconds` overrides it.
- The store follows the repository, not the declared root (#92): MEASURED before the change, the
  same payload was rejected as reused at the real root and accepted at a crafted subdirectory of
  the same repository, and on a host with no dialog channel then approved through `trust` with no
  fabrication signal.
- "Consumed" is the union of the store and the append-only, repository-bound audit log: the store
  alone is defeated by `rm`, the log only by an edit its shape makes visible, so one witness is
  enough and a partial write failure degrades to safe. REFUTED before it was written: deriving the
  union from the log as it was — no event carried `action_scope` or `timestamp`, so recording them
  is what makes it possible. The scan pre-filters lines that are not approval records (it runs on
  every gated validation); an unreadable log leaves the store as the only witness and never invents
  a reuse.
- `validateDevApproval` is a pure read; `recordConsumedApproval` runs after the mutation lands, so a
  failed mutation does not burn the approval, writes the audit witness first and independently of
  the store (a store failure cannot leave the approval unrecorded on both sides), writes the store
  through a temporary file and a rename, and never throws.

### `tools/capture-issue.ts` (migrated in the 2.18.0 REVIEW)

- Labels: a preference list per severity, matched without case against what the host repository
  offers; the first match wins; with none the issue is created unlabeled, which always succeeds.
  The framework never creates a label or a type in someone else's repository. An explicit label is
  used as written (the developer may know one discovery cannot see) and an unknown one is warned
  about, never dropped — dropping would hide a typo, and gh reports the real error; after a
  `failed` call the hint names it as the likely cause.
- Host-repository discovery waits until the call is in create mode and carries a `dev_approval`: it
  runs gh, two authenticated API reads included, and no gated tool may cause an external effect
  before its gate. Draft mode never discovers ("no external mutation"). Paths before authorization
  describe only what the caller asked.
- A label gh is about to refuse is named in the dialog, not only in the hints: approving a call
  already known to fail spends the approval on nothing. The chosen mapping is stated in the hints.

### `tools/load-context.ts`, `tools/status.ts` (migrated in the 2.18.0 REVIEW)

- `rsct_load_context` is the §0 entry point. It reports how the open findings are known (#75)
  because it is the first thing a resumed session reads; `measurable: false` means no baseline
  could be read, not that nothing was raised. The bootstrap marker is evaluated before it is
  stamped (#53 — a read after the stamp describes the stamp) and the write is reported. Only this
  tool clears `context_stale` (plan-lifecycle-v2 D4), in the same write as the marker, so a failed
  write says the re-bootstrap obligation is still there; the check is truthiness, the predicate the
  edit guard uses.
- Plan reconciliation (plan-lifecycle-v2 2.4) is local only (no gh round trip on every bootstrap)
  and runs only once the session has left the plan's branch, since a branch still checked out
  cannot be integrated; a squash or rebase merge is invisible to `git branch --merged` and is
  caught when the developer runs `rsct_plan_dispose` (a residual).
- An escalated sanitizer state is recorded at every bootstrap, not only at the commit gate: it
  means a `Bash(git commit)` allow survived, commits can bypass `rsct_request_commit`, and the
  window would leave no trail. `adrs_count: 0` comes with a warning (#49) because a parse or read
  miss would otherwise read as "no decisions" for the whole session; a resumed REVIEW gets its own
  steer (#40).
- Both report the protected list the gates enforce (`effectiveProtectedList`, #50), not the raw
  key, and only when the project is managed.
- `rsct_status` accepts loose values while its advertised schema is strict: it is the bootstrap
  tool documented to always succeed, and its parse is unguarded, so a `z.enum` would turn a
  paraphrased `update_check: "On"` into a failure that also loses git state, topology and the
  install-drift hint; `coerce` turns a `true` into `"true"`, ignored with a hint. Unknown keys
  still reject. Its `deps` argument is a test seam, not MCP surface — without it the suite would
  call api.github.com and rewrite the contributor's `~/.rsct`.
- The update-check mutations run before the read, so turning the check off is not followed by a
  notice on how to undo it and a decline silences the hint being answered; the environment switch
  outranks the file, so a confirmation never contradicts it on a CI image. Caller input echoed
  into hints is bounded. In a linked worktree the phase state (`phase-state.json`, a batch token)
  is that worktree's own, while the approval store and the audit log are the repository's, kept
  in the main worktree (#92) — an approval spent in one worktree is spent in all; the status says
  so (corrected in 2.20.0, ADR-033: the text claimed the store was per worktree too).
- The bootstrap verdict strings are per tool, not shared: `evaluateBootstrapMarker`'s own hints
  tell the reader to run both tools, which is self-referential from inside either. Every
  "recorded" claim depends on `recorded`.

### `tools/phase-verification-complete.ts` (migrated in the 2.18.0 REVIEW)

- `evidence_mix` (#75) is counted from the stored baseline, never from `findings_actions` (an
  action records a decision, not what it rested on), and is a required field so every return path
  carries it; `null` reads as `measurable: false`, not as zeros. A block of another spec is not
  weighed. The mix rides the dialog line, the hints and the audit entry — the dialog is absent on a
  run with no dialog channel. `head_stale` (#75 C) is reported, never acted on.
- A findings-gate rejection lists every finding still awaiting an action (#40); otherwise the only
  way back is re-running `_start`, which rewrites the baseline. The unknown-id check runs after the
  spec match and before the block check, and every rejection is audited. Gating recorded decisions
  on a non-empty baseline was considered and rejected: the log is agent-written anyway, and dropping
  a decision the developer made deletes information.
- The completed verification block is kept (CAP-28), so `rsct_phase_code_start` can see that V ran
  for this spec; the prune is an allowlist — spec, tier, start and completion times and `head_sha`
  stay, findings and importers go (they are in the audit log). The phase label is always cleared
  once `completed_at` is stamped: the old `clear_phase: false` stranded a label no tool could clear
  without destroying the record. A `clear_phase` passed anyway is reported in the hints as
  deprecated, so the caller learns it did nothing instead of finding out from the state; the other
  top-level fields of the state survive the completion, and a rejected completion leaves the state
  as it was (the test file's comments, migrated in the 2.20.1 REVIEW). `PhaseVerificationCompleteInput`
  stays exported where importers expect it (#19).

---

## How to contribute new decisions

- Firm premise: append under "Firm premises", sequential numbering.
- ADR: append at the end of the ADR section, sequential `ADR-NNN`. Never rewrite an
  existing ADR — record a revision as a new one and set the old one's **Status**.
- Anti-decision: append under "Anti-decisions", with the measurement that killed it.
- Chronological history lives in `git log`, not here. This file is current state.
