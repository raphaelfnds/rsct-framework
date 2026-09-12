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

Anything that removes the V phase, the REVIEW phase or plan tracking must reach the
developer through the OS dialog on the call that does it. `trust_allowed_for` is ignored
on those paths. Recording a bypass in the audit log is not a substitute: the developer
learns only afterwards, and only if they think to look.

### #3 — A tier that skips phases needs evidence, not a declaration

`trivial` and `small` skip V, REVIEW and plan tracking by design. Because `spec_tier` is
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
**Status**: active
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
**Status**: active
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
- **Only 18 packages reach `dist/index.js`.** Measured from the sourcemap: `ajv`,
  `zod-to-json-schema`, `zod`, `pino`, `@modelcontextprotocol/sdk`, `pino-std-serializers`,
  `thread-stream`, `fast-uri`, `ajv-formats`, `tsup`, `fast-deep-equal`,
  `json-schema-traverse`, `@pinojs/redact`, `quick-format-unescaped`, `atomic-sleep`,
  `sonic-boom`, `on-exit-leak-free`, `safe-stable-stringify`. A dependency advisory matters
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
