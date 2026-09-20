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
under-report, so the honest-coverage rule of #54 stands.

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

---

## How to contribute new decisions

- Firm premise: append under "Firm premises", sequential numbering.
- ADR: append at the end of the ADR section, sequential `ADR-NNN`. Never rewrite an
  existing ADR — record a revision as a new one and set the old one's **Status**.
- Anti-decision: append under "Anti-decisions", with the measurement that killed it.
- Chronological history lives in `git log`, not here. This file is current state.
