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
`plan_token_ttl_minutes` 5–480, `plan_token_max_actions` 1–100,
`plan_token_ttl_slide_minutes` 5–1440, `plan_token_ttl_abs_minutes` 5–10080. `sql_dialect`
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
**Status**: active
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
**Status**: active
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
**Status**: active; the dialog-free-lane-suspension consequence is superseded by ADR-023 (#80, 2.13.4)
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

---

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
  87.5 ms at 50k. Bounding it is issue #93. Any new reader of the log should ride an
  existing pass rather than add one.
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
  write fails the action stays spent (tightens, never loosens). The sliding window re-arms on
  success only.
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

- The pre-conditions (no branch, protected branch, no active plan) are checked AFTER the gate, so
  the approval gates everything; a pre-condition failure does not consume the approval, and the
  developer fixes and retries with the same payload.
- FV4: the emitting approval is consumed only once the token is persisted. A failed persist leaves
  it unconsumed.
- Sliding window (plan-lifecycle-v2, block 1.4): the token re-arms `expires_at` on each successful
  commit, so an actively worked plan never expires mid-flight, and never lives past the absolute
  cap. An explicit `ttl_minutes` IS the sliding width; the configured slide and the built-in default
  apply only when it is absent.

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
  routing it through the advisory would write false attempt records into the append-only log the
  anti-rollback ceiling is re-derived from. `getInstallDriftNotice` itself only reads.
- Honest scope of that guarantee, MEASURED by running the real handler (#55): it keeps the tool from
  writing a FALSE `install.drift_detected` entry; it does not make the handler write-free.
  `resolveProjectRoot` appends a config-violation entry when `.rsct.json` is present but rejected,
  creating the log if absent. `rsct_status` and `rsct_load_context` do the same on the same input —
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
- **Fail-open on machinery, fail-closed on policy.** The hook exits 2 only for `out_of_scope` and
  `stale_context`. Empty or malformed stdin, a payload with no `file_path` / `notebook_path`, an
  unmanaged project (no `.rsct.json`), an unreadable phase-state (`infra_error`) and any thrown
  fault exit 0 — a broken guard must never stop all editing.
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
  purpose (named limits, the real Bash guard is #84): a broad `Bash(gh pr:*)` / `Bash(gh:*)` grant
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
  settings file; `unregistered` only when every candidate was parsed or is provably absent (an
  absent file holds no hook — the fresh-clone case of #24); `unknown` otherwise, and when there is
  no candidate at all. Three states, because `null` would have to mean both "could not read" and
  "no canonical event". The event is required: a sanitizer wired under `PreToolUse` does not run
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

- **Hook registration (#114).** The quote character is built with `String.fromCharCode(34)`
  inside `node -e`, for the reason the backslash is (MSYS rewrites escapes). The rewrite is keyed on
  the exact legacy command, not on the marker: the marker also matches a command the developer
  edited, and that one is not ours to change.
- The `.rsct/reports/` backfill (#62) follows the #73 clause: whole-file exact-line guard,
  block-scoped splice right after `.rsct/phase-state.lock` (the CAP-25 clause just before it
  guarantees that line exists), LF out, and a sanity check inside the markers.
- `sql_dialect` is validated three times on purpose — Phase 3, the CREATE render (the shell
  does not persist between phases, so the value is re-declared) and the UPDATE splice — and
  an existing invalid value is repaired in place, because it rejects the whole config.

### `scripts/install.sh` (migrated in the #74 REVIEW)

- **WSL guard.** `/proc/sys/kernel/osrelease` matching `microsoft|wsl` covers WSL1 and WSL2 (the
  test pins one string of each). A WSL shell would install into `/home/<user>/.rsct/`, which a
  Claude Code running on Windows never reads. The Claude-Code-inside-WSL case is #110.
- **`read_or_default`.** `read -r` returns non-zero at EOF and `set -e` turns that into an abort, on
  purpose. An unconditional EOF fallback was measured in the #73 REVIEW: `bash scripts/install.sh
  </dev/null` without `RSCT_ASSUME_YES` ran a FULL install, because `Proceed? [y/N]` displays N and
  passes a coded default of `y`. The fallback is opt-in through a fourth argument, and only the
  removal-consent prompt passes it (default `n`). `read` assigns a partial last line, so only an
  EMPTY reply falls back. The stderr line exists because the abort used to be silent.
- **Host config path (`HOST_CFG`, #73).** `claude mcp add/remove` is a Node program: it honours
  `CLAUDE_CONFIG_DIR`, else `os.homedir()` — `USERPROFILE` on Windows, not bash's `$HOME`. The script
  resolves the same file through node and falls back to `$HOME/.claude.json` only when node is
  absent. While it read `$HOME` and the CLI wrote elsewhere, detection missed a live user-scope entry
  and recorded `project` over it.
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

### `scripts/uninstall-framework.sh` (migrated in the #74 REVIEW)

- The companion is asked about separately because a developer may keep the server for projects wired
  through `.mcp.json` after removing the framework files; `--skip-mcp` asks nothing and touches
  neither the global install, its files, nor a user-scope registration — and the plan line says
  "left untouched" rather than "will ask separately".
- User-scope detection parses `~/.claude.json`: `claude mcp list` in a pipe includes the project-scope
  entries of any `.mcp.json` in the cwd ancestry, and would offer a removal the user-scope command
  cannot perform. It reads `$HOME`, not `CLAUDE_CONFIG_DIR` — the gap recorded on #82.
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

### Tests and build

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

---

## How to contribute new decisions

- Firm premise: append under "Firm premises", sequential numbering.
- ADR: append at the end of the ADR section, sequential `ADR-NNN`. Never rewrite an
  existing ADR — record a revision as a new one and set the old one's **Status**.
- Anti-decision: append under "Anti-decisions", with the measurement that killed it.
- Chronological history lives in `git log`, not here. This file is current state.
