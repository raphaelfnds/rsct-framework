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
`plan_token_ttl_slide_minutes` 5–1440, `plan_token_ttl_abs_minutes` 5–10080.

The vectors this closes: audit off, skew set to infinity, `protected_branches: []`,
`trust_allowed_for: *`.

### #2 — A phase bypass is a per-call decision, never a pre-authorised tool

Anything that removes the V phase or plan tracking must reach the developer through the
OS dialog on the call that does it. REVIEW cannot be removed at all (ADR-011). `trust_allowed_for` is ignored
on those paths. Recording a bypass in the audit log is not a substitute: the developer
learns only afterwards, and only if they think to look.

### #3 — A tier that skips phases needs evidence, not a declaration

`trivial` and `small` skip V and plan tracking by design (never REVIEW, ADR-011). Because `spec_tier` is
declared by the caller on every `_start` call, that declaration is refused unless an
`rsct_classify_task` verdict is on record for the project.

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
enforced by nothing. Two earlier placements failed in the field: a hygiene ack at the
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
  until a REVIEW covers those paths.
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
  rejected: committing the fixes a review found is the normal reason for it.

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
  `.rsct.json` `sql_dialect` and never inferred.
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
  would otherwise carry any prose. Python docstrings and JS/PHP bare string statements are
  runtime values (`__doc__`, directives), not comments, and are not swept — a residual.
- Git reads run from the top level with `:(top,literal)` pathspecs. MEASURED:
  `git ls-files -s -- 'app/[id]/page.tsx'` returns three entries (glob);
  `git rev-parse :0:<path>` returns one. With `project_root` below the top level,
  `hash-object --path` resolves the file relative to cwd and `ls-files -s` returns empty
  with rc 0. Blob ids from `hash-object --path`, `:0:<p>` and `HEAD:<p>` were identical
  across autocrlf true/false/input and `eol` attributes. A path with a `filter` attribute is
  `unverified` (LFS pointers, clean filters).
**Consequences**: About 5.5 MB of WASM ships in the package. The standalone-dist test runs
the packaged `dist/index.js` beside `grammars/` and sweeps one file per engine, which is what
makes CI exercise Linux and macOS.

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

## How to contribute new decisions

- Firm premise: append under "Firm premises", sequential numbering.
- ADR: append at the end of the ADR section, sequential `ADR-NNN`. Never rewrite an
  existing ADR — record a revision as a new one and set the old one's **Status**.
- Anti-decision: append under "Anti-decisions", with the measurement that killed it.
- Chronological history lives in `git log`, not here. This file is current state.
