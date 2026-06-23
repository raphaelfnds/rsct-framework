# rsct-mcp

MCP server for the [RSCT framework](../) — institutional consciousness layer
for Claude Code.

Implements the **Recall MVP (M1)**, the **Enforcement MVP (M2)**, and the
**M3 phase machine** (V phase + R/S/C/T pairs + classify_task):
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
  + 4-category checklist, the four R/S/C/T phase pairs
  (`rsct_phase_{research,spec,code,test}_{start,complete}`) backed by
  the shared `lib/phase-machine.ts`, `rsct_phase_abandon` (§C-gated
  phase discard), `rsct_capture_issue` (draft + create modes via gh
  CLI), 5 personas (Architect, Senior Dev, QA, DevOps, Security) +
  `rsct_persona_review` + `rsct_auto_persona`, and Tutor as the 6th
  persona (opt-in only) with `rsct_tutor_step`. Bilingual EN+pt-BR
  vocabulary across the heuristic keyword sets.

**Entry point for non-trivial tasks:** call `rsct_classify_task` with the
task description. It returns a tier (trivial / small / standard / complex)
and the recommended phase sequence. Tier is advisory — the phase tools
accept any phase regardless of classify_task output. For trivial / docs-only
fixes, skip the phase machine entirely.

## Status

| Milestone | State |
|---|---|
| M1 — Recall MVP (F0 + F1 + F2) | ✅ gate passed 2026-06-03; merged to `main` (tag `v0.2.0-m2`) |
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

**34 tools · 5 resources · tsc strict · ESM ~250 KB
(server) + 5.7 KB (sanitize-permissions CLI) · cross-platform (Windows /
macOS / Linux)**

---

## Install (local, from source)

Requirements: Node 20+, npm 10+.

```bash
cd mcp-server
npm install
npm run build
npm install -g .   # registers `rsct-mcp` binary on PATH
```

Verify the binary boots cleanly:

```bash
# Git Bash / macOS / Linux:
node dist/index.js < /dev/null
# Windows PowerShell (PowerShell does not accept `<` as stdin redirect):
#   cmd /c "node dist\index.js < NUL"
# OR via the global binary (after npm install -g .):
#   rsct-mcp  # then Ctrl+C after the ready log appears
```

Expect on stderr (single JSON line, then clean exit 0):

```json
{"level":30,"time":"...","name":"rsct-mcp","version":"0.6.3",
 "tools":["rsct_status","rsct_load_context","rsct_get_decisions",
          "rsct_get_knowledge","rsct_get_environments",
          "rsct_get_architecture","rsct_check_premise",
          "rsct_check_branch","rsct_check_secrets",
          "rsct_check_edit_scope","rsct_request_commit",
          "rsct_request_push","rsct_request_merge",
          "rsct_classify_task","rsct_phase_status",
          "rsct_phase_research_start","rsct_phase_research_complete",
          "rsct_phase_spec_start","rsct_phase_spec_complete",
          "rsct_phase_verification_start","rsct_phase_verification_complete",
          "rsct_phase_code_start","rsct_phase_code_complete",
          "rsct_phase_test_start","rsct_phase_test_complete",
          "rsct_phase_abandon","rsct_capture_issue",
          "rsct_persona_review","rsct_auto_persona","rsct_tutor_step"],
 "resources":["rsct://decisions","rsct://architecture",
              "rsct://plan","rsct://progress"],
 "resource_templates":["rsct://knowledge/{category}"],
 "msg":"rsct-mcp ready"}
```

The immediate exit is correct: the server reads MCP protocol from stdin;
piping `/dev/null` (or `NUL` on Windows) gives it nothing, so it closes
after the ready log.

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
- [ ] Dev signs off in [progress_rsct-mcp-v1.md](../progress_rsct-mcp-v1.md) to start M2.

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

- Input: `project_root?`
- Output: identity, git, `universe`, hints

### `rsct_load_context`

Full session bootstrap — `rsct_status` plus active plan, decisions snapshot, knowledge index, next-action hints.

- Input: `project_root?`, `decisions_excerpt_count?` (default 3, max 20)
- Output: structured snapshot for session priming (identity, git, active plan,
  decisions, knowledge, `universe`, `next_action_hints`)

### The `universe` block

Both `rsct_status` and `rsct_load_context` surface the org-level **universe**
(the layer linked by `/rsct-canonical-source` and bootstrapped by
`/rsct-init-universe`). They compute it from a single shared source, so the two
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
sibling `dir.ext` file. Fail-graceful: no universe / no `contracts.json` → empty graph + a
hint (never an error).

### `rsct_check_premise`

Heuristic check: tokenises a claim, scores against decisions AND anti-decisions by shared-token overlap (`MIN_SCORE=2`), scans matched decision entries for negation patterns, returns a recommendation.

- Input: `project_root?`, `claim` (≥5 chars), `against?: 'premises'|'adrs'|'both'` (default `both`)
- Output: `recommendation: 'proceed' | 'conflict' | 'requires_revision'`, ranked decision matches (score, shared_tokens, negation_signal), anti-decision matches (score, shared_tokens), human-readable `reason`

`conflict` is returned when:
- a matched decision contains rollback / rejection language (`rolled back`, `superseded`, `deprecated`, `do not`, `rejected`, `anti-pattern`, `never`, `revogado`, `não usar`, etc.), OR
- the claim matches an anti-decision entry (`### AD-NNN —` in `documentation/knowledge/anti-decisions.md`) — the team explicitly abandoned that path. Anti-decision hits ALWAYS dominate the recommendation, even when an active premise also matches.

---

## M2 features — Enforcement layer

M2 adds **6 new tools** (3 pure queries + 3 §C-gated mutating ops) plus a
SessionStart sanitizer hook. Together they materialize §C/§D/§E from
[CLAUDE.md governance rules](../rules/) as enforceable contracts: an "always
allow" entry in `permissions.allow[]` no longer bypasses commit/push/merge
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
- Output: `status: 'in_scope' | 'out_of_scope' | 'unknown'`, `active_phase`, `matched_glob?`

`status='unknown'` when `.rsct/phase-state.json` is missing or empty
(M3 owns the canonical schema). Glob support v1: `*`, `**`, `?` plus
regex metachar escape; `{a,b}` and `[abc]` are deferred to v2.

### §C-gated mutating ops

These three tools require a valid `dev_approval` payload on every call
(INV-2 anti-reuse) AND pop an OS dialog for explicit dev confirmation
(INV-2.1 out-of-band channel) unless the tool's own name is listed in
`approval_modes.trust_allowed_for[]` (e.g. `["rsct_request_commit"]`).
Fabrication signals (INV-2.2) auto-elevate to forced-dialog mode
regardless of trust.

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
- Output: `status: 'committed' | 'rejected' | 'mutation_failed'`, `authorized_via: 'dev_approval' | 'plan_token' | null`, `channel` (gate channel or `'plan_token'`), `sha_before`, `sha_after?`, `reject_kind?` (incl. `'plan_token_invalid'`), `plan_token?` (budget summary on token commits), `audit_path: string | null`, `audit_error: string | null`, `anti_replay_persisted: boolean | null`, `anti_replay_error: string | null`, `hints: string[]`

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

- Input: `project_root?`, `remote?` (default `origin`), `branch?` (default HEAD), `dev_approval`
- Output: `status: 'pushed' | 'rejected' | 'mutation_failed'`, `branch`, `remote`, `reject_kind?`, `audit_path`, `audit_error`, `anti_replay_persisted`, `anti_replay_error`, `hints` — same post-mutation failure surface as `rsct_request_commit`.

#### `rsct_request_merge`

Merges `source_branch` into `target_branch` (extra-strict — refuses
force-pushy patterns by default).

- Input: `project_root?`, `source_branch`, `target_branch?` (default current HEAD), `dev_approval`, `allow_unrelated_histories?` (default false)
- Output: `status: 'merged' | 'rejected' | 'mutation_failed'`, `sha_before`, `sha_after?`, `reject_kind?`, `audit_path`, `audit_error`, `anti_replay_persisted`, `anti_replay_error`, `hints` — same post-mutation failure surface as `rsct_request_commit`.

`override_protected_branch` is dual-purpose here: it ALSO acks the
force-like risk of `allow_unrelated_histories=true`. Documented so devs
don't accidentally pass the flag without the override.

#### `rsct_plan_authorize` (T3 — plan execution mode: batch)

Mints a **plan-scoped batch token**: one strong `dev_approval` (full §C gate +
OS dialog) authorizes up to `max_actions` **commits** within the active plan +
current branch + a time window, so `rsct_request_commit` no longer needs a fresh
approval per commit. **Commit only** — push/merge keep per-action §C. Requires an
active `plan_`/`spec_` at the project root and a **non-protected** branch. The
token never bypasses INV-5/INV-6 (no overrides on the token path). The emitting
approval is consumed (cannot re-mint). Auto-revokes on branch switch, plan
completion/deletion, expiry, or exhaustion.

- Input: `project_root?`, `dev_approval`, `ttl_minutes?` (5–480, default 120), `max_actions?` (1–100, default 20). Defaults also configurable via `.rsct.json` `approval_modes.plan_token_ttl_minutes` / `plan_token_max_actions`.
- Output: `status: 'authorized' | 'rejected' | 'state_write_failed'`, `plan_slug`, `branch`, `expires_at`, `max_actions`, `covers`, `reject_kind?` (incl. `no_active_plan` / `protected_branch` / `no_branch`), `audit_path`, `audit_error`, `anti_replay_persisted`, `anti_replay_error`, `hints`.

#### `rsct_plan_revoke` (T3)

Revokes the active plan token. **NOT §C-gated** — revoking only tightens
security. After revoke, `rsct_request_commit` again requires a per-action
`dev_approval`. No-op (`status: 'no_token'`) when none is active.

- Input: `project_root?`, `reason?`
- Output: `status: 'revoked' | 'no_token' | 'state_write_failed'`, `revoked_plan_slug`, `audit_path`, `audit_error`, `hints`.

The active token + git-worktree context are also surfaced by `rsct_phase_status`
(`plan_authorization`, `worktree`) and `rsct_status` (`worktree`). Because the
runtime state is gitignored and per-working-tree, each `git worktree` gets its
own isolated token and anti-reuse store.

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
- `Bash(git*)` / `Bash(git:*)`
- Path-prefixed forms (MED-12): `Bash(/usr/bin/git commit)`, `Bash(./bin/git push)`, `Bash(C:/Program Files/Git/bin/git merge)`. Allows spaces in the path; pins basename to `git` so a different binary like `Bash(/usr/bin/git-credential-store)` is NOT stripped.
- Shell-wrapped forms (MED-12): `Bash(sh -c "git commit ...")`, `Bash(bash -c 'git push origin')` and the other POSIX shell variants (`zsh`, `dash`, `fish`, `ksh`, `csh`).
- Wildcard-around-git (MED-12): `Bash(*git*)` and similar — the bash matcher would catch commit/push/merge inside any wildcard envelope.
- `Bash(*)` / `Bash(:*)`

Benign entries (`Bash(npm test)`, `Edit`, `Read`, `WebFetch(domain:*)`,
`mcp__rsct__*`, read-only git like `Bash(git status)`) are preserved.
Zero external deps; the script can be invoked directly via
`node dist/scripts/sanitize-permissions.js --project-root <path>`.

Audit events: appends `sanitize.stripped` / `sanitize.malformed` JSONL
lines to `.rsct/audit.log` when something is changed. Never blocks
session start — malformed JSON logs to stderr and exits 0.

### Audit log

All §C-gated tools and the SessionStart hook write structured JSONL
entries to `.rsct/audit.log` (configurable via `.rsct.json` `audit.path`;
disabled when `audit.enabled: false`).

Event naming convention: `<tool>.<outcome>` where outcome ∈
{`rejected`, `override_invoked`, `committed`, `pushed`, `merged`,
`mutation_failed`, `stripped`, `malformed`}.

Single-source writer in `mcp-server/src/lib/audit-log.ts`. Append-only,
never throws — failures surface via `{ ok: false, reason }` so the
caller can report I/O issues without aborting tool execution.

### OS dialog (INV-2.1 out-of-band channel)

Cross-platform Yes/No dialog implemented in
`mcp-server/src/lib/os-dialog.ts`:
- **Windows:** PowerShell `[System.Windows.Forms.MessageBox]`
- **macOS:** `osascript -e 'display dialog'`
- **Linux:** `zenity --question`

When no channel is available (CI, headless), the tool consults
`.rsct.json` `approval_modes.trust_allowed_for[]`: if the invoking
tool's name (`rsct_request_commit`, `rsct_request_push`, or
`rsct_request_merge`) is on the list, accept silently; otherwise
reject. The match is by tool name — not by `dev_approval.action_scope`
— so an entry like `["rsct_request_commit"]` trusts every commit
request in headless mode, independent of the specific scope value.

Test override: `RSCT_TEST_DIALOG_RESPONSE=yes|no` environment variable
short-circuits the dialog. **Documented as a test/CI escape valve
only** — in production it's a Claude bypass vector only if Claude has
shell access to set the dev's env, which it does not from inside the
MCP server.

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
**force-written** to `<root>/.rsct/audit.log` even if the rejected
config tried to disable audit. A warning also goes to stderr.

Bounds:

| Field | Bound | Why |
|---|---|---|
| `audit.enabled` | must be `true` or absent (literal in schema) | `false` defeats INV-3 forensic trail |
| `approval_modes.timestamp_skew_seconds` | `60 ≤ n ≤ 600` | M2 gate observed 78–155s AI roundtrip; 600s = 4× headroom while still bounding INV-2 replay window |
| `approval_modes.trust_allowed_for[]` | enum of `rsct_request_commit`/`_push`/`_merge` | unknown entries can't smuggle a wildcard trust |
| `protected_branches[]` | min length 1 if present | empty disables §D wholesale; if you want zero protected branches, uninstall the framework |
| `audit` / `approval_modes` sub-objects | strict (unknown keys rejected) | blocks payloads like `audit: { enabled: true, force_disable: true }` that future versions could misinterpret |
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
| `RSCT_TEST_DIALOG_RESPONSE` | Short-circuits the OS dialog with `yes` or `no`. **Test/CI only** — production code paths should never set this. |

---

## Development

```bash
npm run dev         # tsup --watch
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:watch  # vitest watch mode
npm run build       # one-shot ESM build to dist/
```

Unit tests live in [`tests/unit/`](./tests/unit/). Fixtures used by tests
live in [`tests/fixtures/`](./tests/fixtures/) — `sample-rsct/` is a fully
populated rsct project; `no-rsct/` is the graceful-degradation control.

### Architecture

```
src/
├── index.ts                 # MCP server entry (stdio); tools + resources wiring
├── resources.ts             # rsct:// URI routing
├── lib/
│   ├── project-root.ts      # locate .rsct.json (Windows-safe) + RsctConfig type
│   ├── git.ts               # minimal git state + GitExecutor + commit/push/merge
│   ├── plan.ts              # find active plan_<slug>.md + progress_<slug>.md
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
│   ├── audit-log.ts         # single-source JSONL append writer for .rsct/audit.log
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
    └── sanitize-permissions.ts  # INV-2.3 SessionStart hook (standalone CLI)
```

Each tool: zod schema for input, structured output type, pure handler.
Adding a new tool — create `src/tools/<name>.ts` and register it in
`src/index.ts` (`TOOLS` array + `HANDLERS` map).

`tsup` builds two ESM entry points:
- `dist/index.js` — the MCP server (registered via `bin: { "rsct-mcp": ... }`).
- `dist/scripts/sanitize-permissions.js` — the SessionStart hook CLI; copied to
  consuming projects' `.rsct/scripts/` by `/rsct-setup` Phase 4.V.

---

## Known issues / follow-ups

- **YAML profile support (F2.3.1 / F2.5.7b).** `application*.yml` files are
  detected by `rsct_get_environments` but not parsed; output surfaces them
  via `yaml_files_detected_but_not_parsed`. Closing this needs a dep decision
  (`yaml` npm package ~50 KB vs hand-rolled subset parser ~100 LOC).
  Deferred to M3 backlog.
- **Uninstall side for the SessionStart hook (deferred from F2.5.6).**
  `/rsct-uninstall` does NOT yet scan for `.rsct/scripts/sanitize-permissions.js`
  or scrub the `hooks.SessionStart[]` entry from `.claude/settings.json`.
  Tracked as F2.5.8b. Real-user removal is manual until then.
- **`**Status**:` / `**Tags**:` in `decisions.md.template`.** Parser accepts
  the syntax but the canonical template doesn't yet document it.
- **npm audit reports vitest dev-chain vulnerabilities** (esbuild dev-server,
  moderate). Dev-only — does not affect the production binary.

---

## M2 validation guide

Dev-owned checklist required to clear M2 and start M3. Runs after the
companion install (`npm run build && npm install -g .`) and after
`/rsct-setup` re-runs to install the SessionStart hook in the project.

> Use the rsct-framework repo itself OR a copy of the M1 validation test
> project. Either works — sample-rsct fixture is also a fast canary.

### Pre-flight

- [ ] M1 validation gate signed off (per progress_rsct-mcp-v1.md).
- [ ] `rsct-mcp` on PATH and `node dist/index.js < /dev/null` prints the
      ready log including all 13 tool names.
- [ ] `/rsct-setup` re-run in the test project; Phase 4.V reports either
      "Installed RSCT SessionStart sanitizer hook" (fresh) or "already
      present — no change" (idempotent).
- [ ] `.rsct/scripts/sanitize-permissions.js` exists in the test project.
- [ ] `.claude/settings.json` contains the `hooks.SessionStart[]` entry
      with command `node ${CLAUDE_PROJECT_DIR}/.rsct/scripts/sanitize-permissions.js`.
- [ ] Claude Code restarted after registration.

### Tool checks (6 new in M2)

Ask Claude each prompt in a fresh chat; verify the trace shows the
expected tool and the response matches the docs above.

| # | Prompt | Expected tool | Verify |
|---|---|---|---|
| 1 | "Is the current branch protected?" | `rsct_check_branch` | Returns `is_protected: boolean`, `source: 'default'/'config'/'config+extras'`. |
| 2 | "Scan the staged diff for secret leaks." | `rsct_check_secrets` | Returns `findings[]` with line-level classification; honors `secrets_extra_patterns[]`. |
| 3 | "Is `mcp-server/src/lib/foo.ts` in scope for the active phase?" | `rsct_check_edit_scope` | Returns `status: 'in_scope'/'out_of_scope'/'unknown'` based on `.rsct/phase-state.json`. |
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
| Windows | PowerShell MessageBox | Dialog appears with project name + action_scope. Yes → tool proceeds; No → tool rejects with `reject_kind: 'dialog_no'`. |
| macOS | `osascript display dialog` | Same. Requires Accessibility permission granted to the terminal app on first run. |
| Linux | `zenity --question` | Same. Requires `zenity` installed; if absent, `trust_allowed_for[]` is the documented fallback. |

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
- [ ] Dev signs off in [progress_rsct-mcp-v2.md](../progress_rsct-mcp-v2.md)
      to start M3 (or to merge v1 + v2 → main as the planned M2 close).

If any row fails, capture the failure (tool/hook, prompt or step, actual
vs expected) in `progress_rsct-mcp-v2.md` before opening a fix.
