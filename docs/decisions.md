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
`plan_token_ttl_minutes` 5–480, `plan_token_max_actions` 1–100, `free_commit_max` 1–50,
`free_commit_max_files` 1–500, `free_commit_max_lines` 1–100000,
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
**Status**: active for V and plan tracking; the REVIEW part is superseded by ADR-011 (2.11.0)
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
**Status**: active
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
**Status**: active
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
**Status**: active
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

---

## Module notes (migrated from source comments, #62)

Constraints and measurements that lived beside the code until the 2.11.0 REVIEW swept
those files. Keyed by module and symbol; restatements of what the code says were dropped.

### `lib/git.ts`

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

- The audit log is the anti-rollback anchor for the free lane; phase-state is the primary
  counter. Residual: a truncate-and-rewrite forge of the gitignored log (Fork 1/A — no
  privilege boundary with a same-user agent). #92 measured that pointing `project_root` at a
  crafted subdirectory committed in the parent repo while debiting the subdirectory's budget;
  the log now resolves at the repository the commit lands in.
- `free_commit.committed` is counted cumulatively over the whole log, never "since the last
  `classify.verdict`" — classify is ungated, so a counting boundary there would be a counter
  reset primitive.
- `reserveFreeBudget` is debit-first: persisted before `gitCommit` ("can't record the spend"
  means "can't spend"), refunded on commit failure. A cap-tripping commit lands and locks;
  the next one is refused.
- `evaluateFreeEligibility` only ever withholds; `tier_max` and the count are
  `max(state, audit)`, and absence of classify evidence is ineligible. Security install drift
  withholds the lane (#25) — that buys reach, not enforcement: it moves the warning from
  `hints[]` into the per-action dialog. When the state ratchet already says non-free the audit
  scan is skipped, safely, because the audit max is a superset a wipe cannot lower.

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
  they refuse never costs a dialog, a token action or free budget; the REVIEW gate runs again
  right before the token or free-lane reserve. Branch protection, secrets and the contract
  gate run after authorization.
- `internal.*Override` seams (staged diff, paths, stats, git state, audit writer, approval
  recorder) are test-only; the MCP dispatch passes no `internal`, closing the fabricated-diff
  hole (A2).
- #17: `.claude/settings.json` drift is reported, never staged or discarded; the audit keeps a
  redacted excerpt only.
- A lane withheld for security drift must not surface as `plan_token_invalid` (#25) — that
  would send the dev to mint a token instead of repairing enforcement.
- Token path: the action is debited before the commit and refunded on failure; if the refund
  write fails the action stays spent (tightens, never loosens). The sliding window re-arms on
  success only. Free lane: same debit-first discipline; the durable `free_commit.committed`
  event is the backstop a phase-state wipe cannot erase.
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
  audit log, the positive evidence the free lane requires; both writes are best-effort.
- The PH-3 worktree nudge stays conditional because classify runs before the plan exists.

### `prompts/01-setup.md`

- The `.rsct/reports/` backfill (#62) follows the #73 clause: whole-file exact-line guard,
  block-scoped splice right after `.rsct/phase-state.lock` (the CAP-25 clause just before it
  guarantees that line exists), LF out, and a sanity check inside the markers.
- `sql_dialect` is validated three times on purpose — Phase 3, the CREATE render (the shell
  does not persist between phases, so the value is re-declared) and the UPDATE splice — and
  an existing invalid value is repaired in place, because it rejects the whole config.

### Tests and build

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

---

## How to contribute new decisions

- Firm premise: append under "Firm premises", sequential numbering.
- ADR: append at the end of the ADR section, sequential `ADR-NNN`. Never rewrite an
  existing ADR — record a revision as a new one and set the old one's **Status**.
- Anti-decision: append under "Anti-decisions", with the measurement that killed it.
- Chronological history lives in `git log`, not here. This file is current state.
