# RSCT Framework

Operational implementation of the [RSCT Workflow Framework](https://medium.com/@raphael.fnds/rsct-workflow-framework-turning-ai-into-a-real-engineering-copilot-2f4a44bd7117) as governance protocols for AI-assisted engineering.

> **TL;DR** — RSCT turns an AI coding agent into a disciplined engineer. It reads
> your project's memory at the start of every session and is *mechanically*
> prevented — via a companion MCP server — from skipping the plan, committing
> without your OK, or drifting from your conventions. The cycle is
> **Research → Specification → Verification → Code → Review → Test**, with
> guardrails at every phase.

**Why it exists.** LLM coding agents are capable but undisciplined: they skip
plans, lose context between sessions, reuse stale authorizations, and quietly
drift from a project's standards. RSCT addresses this at two layers:

- a **passive** layer — project memory + the §A–§H rules in `CLAUDE.md` that the
  agent reads at session start;
- a **mechanical** layer — `rsct-mcp`, an MCP server that *enforces* the rules
  (authorization gates, phase machine, branch protection) instead of trusting
  the model to follow them.

## What this is

A file structure that turns RSCT theory into concrete AI behavior rules for real projects.

**Built for Claude Code.** The framework relies on Claude Code's native
behavior of reading `CLAUDE.md` and per-project memory entries at session
start. Other AI tools (Cursor, Copilot, Codex) do not currently load
`CLAUDE.md` automatically — supporting them with auto-generated
`.cursorrules` and `.github/copilot-instructions.md` is planned for a future release.

```
Research → Specification → Verification → Code → Review → Test
```

Each phase has guardrails that prevent common AI failure modes:
scope creep, missing reversibility, skipped tests, accidental commits.
The **Verification** phase (V) shipped in M3 (`v0.3.0`) — it runs
between spec-approval and code-edit, walking reverse dependencies +
running a four-category checklist (gap / breakage / redundancy /
forgotten) against the project's institutional context. Tier table:
trivial+small skip V; standard+complex run V. The **Review** phase
(a code review of the diff, between Code and Test) is opt-in and asked
once at spec-approval; when included, the test phase will not start until
the review has run (standard+complex; trivial+small skip it).

## Documentation

The end-user guides live in [`docs/`](docs/):

- **[Getting started](docs/getting-started.md)** — prerequisites, install,
  restart, `/rsct-setup`, and a 5-minute first-project walkthrough (the
  single-repo happy path).
- **[Command reference](docs/commands.md)** — a per-command manual for all four
  slash commands.
- **[Multi-repo & contracts](docs/multi-repo.md)** — the T2 layer: topology
  modes, the org universe, contracts & surfaces, producer-vs-consumer, and a
  step-by-step multi-repo walkthrough.
- **[Troubleshooting](docs/troubleshooting.md)** — common failures and fixes.

The companion server's tool-by-tool reference is in
[`mcp-server/README.md`](mcp-server/README.md).

## Installation

One-time, per machine. Installs runtime files to `~/.rsct/` and registers
Claude Code slash commands at `~/.claude/commands/rsct-*.md`.

> ⚠️ **On Windows: open Git Bash, not PowerShell, and not WSL.**
>
> The install/uninstall scripts are POSIX shell. PowerShell can invoke
> `bash`, but Windows ships with several different `bash` binaries
> (Git Bash, WSL bash, Cygwin) and they mount Windows drives at
> different paths (`/c/...` vs `/mnt/c/...`). The scripts refuse to run
> under WSL because that would install to `/home/<user>/.rsct/`, which
> Claude Code on the Windows side does not read.
>
> Open **Git Bash** from the Start menu (or right-click a folder →
> "Git Bash Here") and run the commands below from there. The prompt
> will look like `MINGW64` followed by your path.

```bash
git clone https://github.com/raphaelfnds/rsct-framework ~/dev/rsct-framework
cd ~/dev/rsct-framework
bash scripts/install.sh
```

> ⚠️ **Restart your IDE / Claude Code after install.**
> Slash commands are loaded at IDE startup. New `rsct-*` commands installed
> while the IDE is running will not appear in the chat autocomplete until
> you fully close and reopen the VSCode/Claude Code window. If you type
> `/rsct-setup` and see *"No matching commands"*, that's the symptom —
> restart fixes it.

After install (and restart), four slash commands are available in **any**
project on this machine — no path needed.

### Unattended / non-interactive install (CI, provisioning)

Both `install.sh` and `uninstall-framework.sh` accept a non-interactive mode:

```bash
# Framework files only — no prompts, no rsct-mcp companion, no global side effects:
RSCT_ASSUME_YES=1 RSCT_SKIP_MCP=1 bash scripts/install.sh
# equivalently: bash scripts/install.sh --yes --skip-mcp
```

- `RSCT_ASSUME_YES=1` (or `--yes` / `-y`) — answer every prompt with its default.
- `RSCT_SKIP_MCP=1` (or `--skip-mcp`) — skip the rsct-mcp companion entirely
  (no global `npm install -g`, no `claude mcp add`). Omit it to install and
  register the companion non-interactively too (user scope by default).

The same flags work for `uninstall-framework.sh` (`--skip-mcp` there leaves the
global companion and any user-scope registration untouched).

### Registering rsct-mcp with Claude Code

The install script (`scripts/install.sh`) asks where to register the
MCP server during the install run. Three choices:

| Choice | Command run for you | Where to use |
|---|---|---|
| **1. User scope** *(recommended for solo dev)* | `claude mcp add rsct rsct-mcp --scope user` | One-time per machine. `rsct__*` tools become available in every project after IDE restart. |
| **2. Project scope** *(for teams committing `.mcp.json`)* | nothing — you run it manually per project | `cd <each-project> && claude mcp add rsct rsct-mcp --scope project`. The `.mcp.json` commits to git so teammates pick it up. |
| **3. Skip** | nothing | Run either of the above commands manually whenever you want. |

### Manual steps the install can never automate

| Step | When |
|---|---|
| **Restart IDE / Claude Code** | After install, **and** after any `claude mcp add/remove`. Slash commands + MCP registrations load at IDE startup. |
| **`/rsct-setup` inside each project** | Once per project, to write `CLAUDE.md`, `documentation/`, memory entries, and the SessionStart sanitizer hook. |

For the typical solo-dev path: `bash scripts/install.sh` → choose User
scope → restart Claude Code → run `/rsct-setup` in each project.
Three steps, one restart.

### Project scope detail (when to use option 2)

When you pick **Project scope** during install, the installer records the
choice in `~/.rsct/mcp-scope`. The next time you run **`/rsct-setup` in a
project**, it AUTOMATICALLY creates / updates a committable `.mcp.json` in that
project root (CAP-48) — no manual step needed. You can still register manually
with `claude mcp add rsct rsct-mcp --scope project`. Either path writes:

1. **`.mcp.json` in the project root**:
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
   No hardcoded path and no `${workspaceFolder}` placeholder — the server
   auto-detects the project root (its cwd, or `CLAUDE_PROJECT_DIR` which Claude
   Code sets). That keeps the committed file portable across every teammate's
   checkout (nothing machine-specific). Each teammate still needs `rsct-mcp`
   installed (the binary on PATH) for it to connect — see **Team onboarding**
   below.

   > **CAP-49:** an earlier version wrote `args: ["--project-root",
   > "${workspaceFolder}"]`. Claude Code does **not** expand that placeholder,
   > so the server received it literally and reported `rsct_installed: false`.
   > Re-running `/rsct-setup` auto-migrates a committed file that still carries
   > it back to `args: []`.

2. **Should you commit `.mcp.json`?** YES if you want your team to
   share the config — add it to git:
   ```bash
   git add .mcp.json && git commit -m "chore: register rsct-mcp project scope"
   ```
   Teammates who pull will pick up the registration automatically on
   their next Claude Code session (after restart). If you keep it
   uncommitted (or `.gitignore` it), the registration is local to
   your clone only.

3. **Verify the registration:**
   ```bash
   claude mcp list
   # Expect a line like:
   #   rsct: rsct-mcp - ✓ Connected
   ```
   Run this from inside the project directory (so the project scope
   is picked up). If `rsct` does not appear, the `.mcp.json` is
   missing, malformed, or the `rsct-mcp` binary is not on PATH.

4. **Coexists with User scope without conflict.** If you have both
   `~/.claude.json` `mcpServers.rsct` (user scope) AND
   `<project>/.mcp.json` `mcpServers.rsct` (project scope), Claude
   Code uses the project-scope entry **for that project only** —
   user scope still applies to other projects. Only one `rsct-mcp`
   instance runs per Claude Code session.

5. **Remove project scope later:** `/rsct-uninstall` scrubs the `rsct`
   entry from `.mcp.json` automatically (by key, preserving any other
   servers; removes the file if it held only rsct). Or do it manually:
   ```bash
   claude mcp remove rsct --scope project
   # then commit the removed .mcp.json change if it was tracked
   ```

6. **Troubleshooting** — if `rsct_*` tools do not appear after IDE
   restart:
   - Check `~/.claude.json` and `<project>/.mcp.json` for the `rsct`
     entry (both are JSON, editable by hand if needed).
   - Confirm the binary: `where rsct-mcp` (Windows) or `which rsct-mcp`
     (macOS/Linux) should print a path.
   - Confirm the boot smoke: `cmd /c "rsct-mcp < NUL"` (PowerShell)
     or `rsct-mcp < /dev/null` (Git Bash / macOS / Linux) should
     print the ready log on stderr.
   - Fully close all Claude Code windows + reopen. Slash commands +
     MCP registrations load at IDE startup only.

**Team onboarding — the `.mcp.json` shares the *registration*, not the
*binary*.** The committed `.mcp.json` only points Claude Code at the `rsct-mcp`
command; the binary itself must exist on each machine's PATH. So:

- **First dev (owner):** install with **[2] Project scope**, run `/rsct-setup`,
  commit `.mcp.json` (plus `CLAUDE.md`, `documentation/`).
- **Every other teammate:** clone (they get `.mcp.json` from git), then run the
  installer **just to get the `rsct-mcp` binary** — they can pick **[3] Skip**
  at the scope prompt, since the registration already arrived via git (the
  binary is installed *before* the scope menu, regardless of the choice).
  Restart Claude Code → connected.

So: the binary is per-machine (everyone installs it); choosing scope [2] and
running `/rsct-setup` is a one-time job for the owner.

To uninstall the framework from the machine (different from removing RSCT
from a project):
```bash
bash scripts/uninstall-framework.sh
```
(That script also offers to remove the global `rsct-mcp` install and
walks you through the per-project `claude mcp remove rsct` step.)

### Windows line endings (the `LF will be replaced by CRLF` warning)

On Windows with `core.autocrlf=true` (Git for Windows' default), `git`
prints `warning: LF will be replaced by CRLF` for every artifact
`/rsct-setup` generates (`CLAUDE.md`, `.rsct.json`, `documentation/`,
memory entries). **This is harmless** — RSCT idempotency never depends on
the on-disk line ending: every SHA the framework computes strips `\r`
first (`tr -d '\r'`), so a CRLF round-trip never flips a file from SKIP
to a spurious UPDATE.

If you'd rather silence the warning, add a `.gitattributes` in the
project root pinning the RSCT artifacts to LF:

```gitattributes
# RSCT-generated artifacts — keep LF so the framework's SHA markers stay stable
CLAUDE.md            text eol=lf
.rsct.json           text eol=lf
documentation/**     text eol=lf
```

This is optional and `/rsct-setup` never writes it for you (it won't
touch a file the dev owns) — add it yourself if the warnings bother you.

## How to use

After installation, from inside any project on the machine. The stubs below are
quickstarts — the full per-command manual (preconditions, outputs, consent
gates, recovery) is in **[`docs/commands.md`](docs/commands.md)**.

### New project (no existing CLAUDE.md)
```
/rsct-setup
```
Creates CLAUDE.md, documentation/ structure and memory entries from scratch.

### Existing project (update)
```
/rsct-setup
```
Same command — detects what exists and only adds what is missing.

### Bootstrap a new universe (if your organization doesn't have one yet)
```
/rsct-init-universe
```
Creates a skeleton universe repository at `~/projects/<org>-universe/` with:
- `CLAUDE.md` (operational protocol §0)
- `docs/governance/` (LGPD matrix, DNS survey, naming standards, retention)
- `docs/diagrams/` (placeholders for C4, deployment, DFD .drawio files)
- `applications/` (one folder per app, registered over time)
- `hosts/` (one folder per production host)

Templates have TODO placeholders. You fill the content as the organization
grows — no upfront commitment to fill everything.

### Add canonical universe source to a project
```
/rsct-canonical-source
```
Adds the `## Canonical architectural source` section to CLAUDE.md,
pointing to the universe repository of your organization. If no universe
is found locally or remotely, this command offers to invoke
`/rsct-init-universe` first.

### Universe app registration

Once a project is linked to a universe (via `/rsct-canonical-source`), re-running
`/rsct-setup` offers to **register this app in the universe** (consent-gated): it
renders an app README into `applications/<app>/` and appends the app to the
universe's `registered_apps[]` index. It writes only to the universe repo and never
commits or pushes there — you review and commit those changes yourself.

From then on, `rsct_status` and `rsct_load_context` surface a `universe` block
describing the universe and whether this app is registered, and emit a one-line hint
to register it when it is not yet linked. See
[the `universe` block](mcp-server/README.md#the-universe-block) for the field/state
reference.

> **Multi-repo org?** Topology modes, contracts & surfaces, the producer-vs-consumer
> gate, and which session edits which repo are covered in
> **[`docs/multi-repo.md`](docs/multi-repo.md)**.

### Uninstall RSCT from a project
```
/rsct-uninstall
```
Reverses everything `/rsct-setup` and `/rsct-canonical-source` created or
modified. Detects developer edits via SHA256 and protects them from accidental
deletion. Supports full uninstall and selective scopes (memory-only, specific
rules, docs-only, etc.).

### Invoking the prompts directly (without install)

If you prefer not to install — useful for one-off use or testing — you can
invoke each prompt by its path in the cloned framework:
```
@/path/to/rsct-framework/prompts/01-setup.md
@/path/to/rsct-framework/prompts/04-init-universe.md
@/path/to/rsct-framework/prompts/02-canonical-source.md
@/path/to/rsct-framework/prompts/03-uninstall.md
```

## First project walkthrough (5 minutes)

After install, try the framework on a sandbox project before pointing it
at production code. The walkthrough below is the smell test — if any
step doesn't behave as described, that's a bug worth filing.

1. **Make a sandbox repo:**
   ```bash
   mkdir -p ~/tmp/rsct-trial && cd ~/tmp/rsct-trial
   git init -b main && echo "# trial" > README.md && git add . && git commit -m "init"
   ```
2. **Open it in Claude Code** (or VSCode with Claude Code). If you
   just installed in this session, fully restart — slash commands load
   at IDE startup.
3. **Run `/rsct-setup`** in the Claude chat. Expect:
   - 5–10 discovery questions about your stack (Phase 1).
   - A structured plan you must approve (Phase 3) before any file is
     written.
   - Created: `CLAUDE.md`, `documentation/`, memory entries under
     `.claude/projects/.../memory/`, `.rsct.json`, and
     `.claude/settings.local.json` with the SessionStart sanitizer hook
     wired up (if you opted in to `rsct-mcp` during setup — recommended).
4. **Ask Claude to commit** something. Expected behavior:
   - Plain `Bash(git commit ...)` will be refused or surface a §C
     reauthorization request (per the rules in `CLAUDE.md`).
   - With `rsct-mcp` installed: Claude proposes
     `mcp__rsct__rsct_request_commit` instead, which pops a native OS
     dialog asking you to confirm out-of-band before the commit lands.
     Audit trail goes to `.rsct/audit.log`.
5. **Reverse it.** `/rsct-uninstall` cleanly removes everything the
   framework added to *this project* (markers + SHA256 detect any
   developer edits and protect them). Then
   `bash ~/dev/rsct-framework/scripts/uninstall-framework.sh` removes
   the framework from your machine (slash commands + `~/.rsct/`).

You can also invoke the prompts directly without installing — see
[Invoking the prompts directly](#invoking-the-prompts-directly-without-install)
above. That mode is useful for kicking the tires before committing
to a machine-wide install.

## How reversibility works

Every artifact created or modified by RSCT is marked, so it can be removed cleanly:

| Artifact | Marker | What `03-uninstall.md` does |
|---|---|---|
| Sections in `CLAUDE.md` | `<!-- RSCT-§X-BEGIN v=1.0.0 source=... -->` ... `<!-- RSCT-§X-END -->` | Excises by marker pair, preserves surrounding content |
| Canonical source section | `<!-- RSCT-CANONICAL-SOURCE-BEGIN ... -->` ... `<!-- RSCT-CANONICAL-SOURCE-END -->` | Same — clean excision |
| Files in `documentation/` | First line: `<!-- RSCT-GENERATED v=1.0.0 created=<date> sha256-body=<hex> -->` | Computes SHA of current body; if matches → safe delete; if differs → asks dev |
| Memory entries | Same marker format | Same SHA256-based protection |
| `.rsct.json` | The `install` block itself is the marker | Always safe to delete |
| Pre-setup PT-BR content in `CLAUDE.md` | `install.setup_commit_sha_before` in `.rsct.json` | Offers `git checkout <SHA> -- CLAUDE.md` to restore |

The setup commit captured in `setup_commit_sha_before` IS the backup —
no separate backup files needed.

## Repository structure

```
rsct-framework/                    # dev/source — version controlled in git
├── README.md
├── scripts/
│   ├── install.sh                 # copy framework to ~/.rsct/ + register slash commands
│   └── uninstall-framework.sh     # remove ~/.rsct/ + slash commands (machine-level)
├── prompts/
│   ├── 01-setup.md                # main: setup or update project
│   ├── 02-canonical-source.md     # universe canonical source section
│   ├── 03-uninstall.md            # reverse setup in a project (full or selective)
│   └── 04-init-universe.md        # bootstrap a new universe repository
├── rules/                         # individual rule files (inserted into CLAUDE.md)
│   ├── A-bug-mode.md
│   ├── B-architect-plan.md
│   ├── C-reauthorize.md
│   ├── D-branch-protection.md
│   ├── E-secrets-leak.md
│   ├── F-state-reversibility.md
│   ├── G-testing.md
│   └── H-adr-learning.md
├── memory-templates/              # memory entries for each rule (with marker)
├── doc-templates/                 # per-project documentation/ templates
│   ├── CLAUDE.md.template
│   ├── architecture.md.template
│   ├── decisions.md.template
│   ├── CONVENTIONS.md.template      # optional project-root CONVENTIONS.md (prescriptive coding standards; dev-owned)
│   ├── documentation-index.md.template
│   ├── setupdeveloper.md.template
│   ├── rsct.json.template
│   ├── tests-readme.md.template
│   ├── modules/_module.md.template
│   └── impact/
│       ├── README.md.template
│       └── _impact.md.template
├── universe-templates/            # per-organization universe templates
│   ├── CLAUDE.md.template
│   ├── README.md.template
│   ├── universe.json.template
│   ├── docs/
│   │   ├── INDEX.md.template
│   │   ├── governance/ (5 templates + retention README)
│   │   └── diagrams/README.md.template
│   ├── applications/ (README + _app.md.template)
│   └── hosts/ (README + _host.md.template)
└── examples/
    ├── java-spring/               # filled example for Java/Spring stack
    └── react-ts/                  # planned example, not filled yet
```

After running `scripts/install.sh`, the runtime layout on the machine is:

```
~/.rsct/                           # active installation — read by Claude Code
├── VERSION
├── prompts/                       # copy of prompts/ from source
├── rules/                         # copy of rules/ from source
├── doc-templates/                 # copy of doc-templates/ from source
├── memory-templates/              # copy of memory-templates/ from source
└── universe-templates/            # copy of universe-templates/ from source

~/.claude/commands/                # Claude Code slash command pointers
├── rsct-setup.md                  # @~/.rsct/prompts/01-setup.md
├── rsct-init-universe.md          # @~/.rsct/prompts/04-init-universe.md
├── rsct-canonical-source.md       # @~/.rsct/prompts/02-canonical-source.md
└── rsct-uninstall.md              # @~/.rsct/prompts/03-uninstall.md
```

The source and the installed copy are decoupled — you edit the source, run
`install.sh` to push the changes to the active install.

## RSCT → Development phases mapping

The full cycle is **R → S → V → C → REVIEW → T**:

| RSCT Phase | Real development | Guardrails |
|---|---|---|
| Research | Requirements + reuse analysis + impact | §A (bug mode), §H (ADR) |
| Specification | Plan with 2+ options + approval | §B (plan), §F (IDA/VOLTA), §G (tests in plan) |
| Verification | Audit the approved spec — reverse-dep walk + gap scan, before any code | §B (plan); enforced at code-start |
| Code | Execution | §C (reauthorize), §D (branches) |
| REVIEW | Code review of the diff — correctness / security / regression, before tests | §G (testing); asked once at spec-closure, enforced at test-start |
| Test | Automated or manual + approval | §G (testing) |
| — | Commit + Push | §C, §D, §E (leak review) |

## Versioning

RSCT carries **two distinct version axes** — keep them separate:

- **Display / release version** — the framework release a project was last set up
  with (e.g. `1.1.0`). It is stamped, on both CREATE and UPDATE, into the `CLAUDE.md`
  header (`<!-- RSCT_VERSION: -->` and the `Generated by RSCT Framework v…` line) and
  the `rsct_version` field of `.rsct.json`, sourced from the installed
  `~/.rsct/VERSION`. This is the version you see; it tracks the release.
- **Marker schema id** (`v=1.0.0`) — a STABLE identifier carried by every RSCT marker
  (`RSCT-…-BEGIN`, `RSCT-GENERATED`, the `.gitignore` block, `RSCT_TEMPLATE_VERSION`).
  It keys idempotency (re-running `/rsct-setup` recognizes prior markers by this id),
  so it changes only when the marker *format* changes — NOT on every release. It is a
  schema id, not the product version.

The framework's first stable release is **`v1.0.0`** (tagged `v1.0.0`,
published on `main`). It consolidates the full stack — **M1 Recall + M2
Enforcement + the M3 R→S→V→C→T phase machine** plus L3 personas, the Tutor,
issue capture, the bilingual EN+pt-BR vocabulary, the content-SHA memory
classifier, the prebuilt-`dist/` toolchain-free install, and the cross-OS
correctness sweep (Windows / WSL / Linux / macOS). See
[CHANGELOG.md](CHANGELOG.md) for the complete CAP-by-CAP history.

The `v=` marker schema id is intentionally held at `1.0.0` across releases:
bumping it would make existing installs re-emit duplicate marker blocks on the next
`/rsct-setup` (a field-report-proven idempotency property). The user-facing version
(the `CLAUDE.md` header + `.rsct.json rsct_version`) is separate and is re-stamped to
the current release on every `/rsct-setup` run — so a project no longer appears stuck
at `1.0.0` while the framework moves ahead.

The `install` block in `.rsct.json` also records when the framework was applied
and the git SHA of the pre-setup state — both required for `03-uninstall.md` to
work safely.

## Roadmap

### Future

- **Memory write protocol** — currently the AI may write to `MEMORY.md` and
  add memory entries without explicit dev OK. A future release will require dev
  authorization, with proposal at end of planning, and surface space/eviction
  list when storage gets crowded
- **Two-pass audit before proposing plans** — strengthen §B item 2 to enforce
  re-read of relevant context before submitting options
- **Cursor support** — auto-generate `.cursorrules` pointing to `CLAUDE.md`
  so Cursor reads the same governance protocol
- **GitHub Copilot support** — auto-generate `.github/copilot-instructions.md`
  with the same content
- **OpenAI Codex / other tools** — as their native config conventions stabilize

### Done (shipped in v1.1.0)

- **Universe-aware `rsct-mcp`** — `rsct_status` and `rsct_load_context` now resolve,
  read, and surface the org-level universe as a `universe` block (with a registration
  hint when the app is not yet linked). See
  [the `universe` block](mcp-server/README.md#the-universe-block).
- **Auto-registration of applications in the universe** — `/rsct-setup` detects a
  linked universe and offers (consent-gated) to register the current project in
  `applications/<app>/`. See [Universe app registration](#universe-app-registration).

### Done (shipped in v1.0.0)

- Content-SHA update detection for memory entries (4 states: CREATE /
  UPDATE / SKIP / PRESERVE_WITH_WARNING) — implemented in `01-setup.md`
  Phase 4.6. Compares the user file's body SHA against the
  resolved-template SHA, so every body change in source templates
  propagates on next `/rsct-setup` run without requiring a protocol
  version bump (case observed in v0.6.4: feedback_*.md body edits were
  being skipped by re-runs because `v=1.0.0` matched on both sides)
- Recommended option mandatory in plans (§B item 1)
- Active branch verification at task boundaries (§D)
- Plan tracking files `plan_<slug>.md` + `progress_<slug>.md` generated
  at project root after every approved plan (§B item 6); branch-local via
  `.gitignore` patterns added by `/rsct-setup`. `spec_<slug>.md` is an
  accepted alias of `plan_<slug>.md` (same gitignore rule, same template)
  when the dev prefers the M3 "spec" wording
- **`rsct-mcp` companion MCP server** (in [`mcp-server/`](mcp-server/README.md)) —
  the mechanical recall + enforcement layer: **37 tools + 5 resources** spanning
  Recall (M1), Enforcement (M2: §C-gated commit/push/merge + the SessionStart
  sanitizer hook + the append-only `.rsct/audit.log`), the
  **R→S→V→C→REVIEW→T** phase machine + 6 personas + Tutor (M3 + DX-4), multi-repo
  topology & the contract-surface gate (T2), guided onboarding (DX-1), and
  plan-authorization batch tokens (T3). The per-tool catalog, the boot-log tool
  list, and the full milestone history live in
  [`mcp-server/README.md`](mcp-server/README.md) — the single source for the
  field-level reference (this README does not restate it).

## Trying rsct-mcp locally

```bash
cd mcp-server
npm install && npm run build && npm install -g .
# Choose ONE registration scope:
#   user (recommended, works in every project on the machine):
claude mcp add rsct rsct-mcp --scope user
#   OR per-project (commits .mcp.json for the team):
#   cd <each-project> && claude mcp add rsct rsct-mcp --scope project
# Then restart Claude Code.
```

If you went through `bash scripts/install.sh` the script already
prompted you for the scope choice. See **[Project scope detail](#project-scope-detail-when-to-use-option-2)** above for what `--scope project` writes,
whether to commit `.mcp.json`, how to verify, and how to undo.

Quick smoke (once registered): in any project, ask Claude to call
`rsct_status` — you should see `rsct_installed`, the active branch,
the effective protected list, and whether the SessionStart hook is
wired in `.claude/settings.local.json`. From there `rsct_load_context`
gives Claude the curated read of the project at session start
(including `active_phase` when a phase is in flight). For
**non-trivial tasks** the canonical entry point is
`rsct_classify_task` — pass the task description, get back a tier
(trivial / small / standard / complex) + the recommended RSCT phase
sequence.

The validation guides in [`mcp-server/README.md`](mcp-server/README.md)
walk the surface end-to-end:
- **M1 — Recall:** 7 read-only tools + 5 resources.
- **M2 — Enforcement:** 6 tools — 3 pure-query checks + 3 §C-gated mutating ops
  + SessionStart sanitizer + cross-platform OS dialog + audit log.
- **M3 — Phase machine + V phase + personas + Tutor + issue capture:**
  17 tools across the RSCT cycle.
- **Post-M3 — multi-repo, onboarding & REVIEW (T1c/T2/T3 + DX):** 7 more —
  `rsct_get_universe`, `rsct_get_topology`, `rsct_detect_onboarding`,
  `rsct_plan_authorize`/`_revoke`, and `rsct_phase_review_start`/`_complete`.

That's **7 + 6 + 17 + 7 = 37 tools**. Smoke: ask Claude to call
`rsct_classify_task` with any task description and confirm the returned tier +
`recommended_phases[]` is sensible.

## Manual uninstall (pre-1.0.0 projects)

If a project was set up by a pre-1.0.0 RSCT version (no markers, no `install`
block in `.rsct.json`), `03-uninstall.md` will abort and direct you to manual
cleanup. The framework cannot auto-restore without the markers it now writes —
this is an explicit limitation of legacy installs.
