# RSCT Canonical Source — 02-canonical-source.md

You are operating inside a software project repository belonging to an organization
that maintains a central **universe repository** with canonical architectural artifacts.

Your task: create or update the `## Canonical architectural source` section in
`CLAUDE.md` at the root of this repository.

Read this entire file before executing any action.

---

## Absolute rules

- No `git commit`, `git push` without explicit OK from the user.
- Do not modify any section of CLAUDE.md other than `## Canonical architectural source`.
- If the repo already has `AGENTS.md`, ask the user which file to update.
- Never copy content from the universe repository — only reference via canonical URL.

---

## ⛔ Execution mandate — read before every code block

Same contract as `prompts/01-setup.md`'s execution mandate:

1. **Execute every fenced `bash` block literally.** Do NOT translate
   to Node / Python / PowerShell / TS, do NOT consolidate Phase
   blocks into a single helper script.
2. **The Phase 4 `markdown` block is the canonical content** of the
   `## Canonical architectural source` section. Insert it into
   `CLAUDE.md` **byte-for-byte** with only the explicit
   `[PLACEHOLDER]` substitutions named in Phase 4 (`[APP_NAME]`,
   `[UNIVERSE_NAME]`, `[UNIVERSE_LOCAL_PATH]`, `[UNIVERSE_GITHUB_BASE]`,
   `[YYYY-MM-DD]`). Do NOT re-word, re-order columns, drop tables,
   or "improve" the prose. The block is wrapped in
   `<!-- RSCT-CANONICAL-SOURCE-BEGIN -->` / `END` markers that
   `/rsct-uninstall` depends on to detect and remove the section
   cleanly; any rewording risks breaking that detection.
3. **Do NOT reformat the existing `.rsct.json` file** when wiring
   the `universe` block and `canonical_source_added: true` flag in
   Phase 5. Use `sed`-based edits the same way Phase 4.4 of
   `01-setup.md` does (see the canonical `sed -i -E` pattern there).
   A full `JSON.parse → JSON.stringify` round-trip would reformat
   every other field and produce spurious diffs.
4. **CHECKPOINT lines surface obedience.** Each mutating Phase 1
   bash block opens with `echo "  CHECKPOINT: Phase X.Y executing
   canonical discovery probe"`. Do NOT remove or alter these.
5. **If a block looks buggy, STOP and report it as a framework bug.**
   Do NOT patch it per-run by writing your own variant.

---

## Phase 1 — Silent discovery

### 1.1 — App and organization identity
```bash
echo "  CHECKPOINT: Phase 1.1 executing canonical discovery probe (remote/org/app/universe identity)"
REMOTE_URL=$(git config --get remote.origin.url)
echo "REMOTE_URL=$REMOTE_URL"

# Extract org and app from remote URL
# Handles both https://github.com/org/app and git@github.com:org/app formats
ORG_SLUG=$(echo "$REMOTE_URL" | sed 's|.*github.com[:/]\([^/]*\)/.*|\1|')
APP_NAME=$(echo "$REMOTE_URL" | sed 's|.*github.com[:/][^/]*/\([^.]*\).*|\1|')
echo "ORG_SLUG=$ORG_SLUG"
echo "APP_NAME=$APP_NAME"

# Infer universe name from org slug (e.g., "acme-23" → "acme")
UNIVERSE_NAME=$(echo "$ORG_SLUG" | sed 's/-[0-9]*$//')
echo "UNIVERSE_NAME=$UNIVERSE_NAME"
```

Also check: `pom.xml` → `<artifactId>`, `package.json` → `name`, `README.md` → first H1.

**Store `ORG_SLUG`, `APP_NAME`, `UNIVERSE_NAME` — reuse in all subsequent steps.**

### 1.2 — Universe local path
Use `ORG_SLUG` and `UNIVERSE_NAME` from step 1.1:

```bash
echo "  CHECKPOINT: Phase 1.2 executing canonical universe local-path probe"
# Values from step 1.1 — substitute before running
ORG_SLUG="[from 1.1]"
UNIVERSE_NAME="[from 1.1]"

for candidate in \
  "../${UNIVERSE_NAME}-universe" \
  "../${ORG_SLUG}-universe" \
  "../universe" \
  "$HOME/projetos/${UNIVERSE_NAME}-universe" \
  "$HOME/projects/${UNIVERSE_NAME}-universe" \
  "$HOME/dev/${UNIVERSE_NAME}-universe" \
  "$HOME/workspace/${UNIVERSE_NAME}-universe"; do
  [ -d "$candidate" ] && echo "FOUND: $candidate" && break
done
```

If found locally, read these files directly (no remote authorization needed):
- `CLAUDE.md` → operational protocol §0
- `docs/governance/canonical-sources-map.md`
- `docs/governance/systems-inventory.md`
- `docs/governance/document-control.md`
- `docs/INDEX.md`

### 1.3 — Current CLAUDE.md canonical source section
```bash
echo "  CHECKPOINT: Phase 1.3 executing canonical CLAUDE.md section detection"
grep -n "## Canonical architectural source" CLAUDE.md 2>/dev/null \
  && awk '/## Canonical architectural source/,/^## [^#]/' CLAUDE.md 2>/dev/null \
  || echo "SECTION_NOT_FOUND"
```

### 1.4 — Remote base URL (normalized)
```bash
echo "  CHECKPOINT: Phase 1.4 executing canonical remote-URL normalization"
git config --get remote.origin.url \
  | sed 's/\.git$//' \
  | sed 's|git@github\.com:|https://github.com/|'
```
Store as `REMOTE_BASE_URL`.

### 1.5 — Existing .rsct.json
```bash
echo "  CHECKPOINT: Phase 1.5 executing canonical .rsct.json read-only inspection"
cat .rsct.json 2>/dev/null || echo "NOT_FOUND"
```

---

## Phase 2 — Discovery report + single question block

Present to the developer:

```
═══════════════════════════════════════════════════════
RSCT CANONICAL SOURCE — Discovery Report
═══════════════════════════════════════════════════════

✅ Discovered automatically:
  App name         : [APP_NAME]
  Organization     : [ORG_SLUG]
  Universe name    : [UNIVERSE_NAME]
  Remote base URL  : [REMOTE_BASE_URL]
  Universe locally : [found at PATH | not found]
  CLAUDE.md section: [exists — will update | not found — will create]
  .rsct.json       : [exists | not found]

❓ Could not discover — please answer:
  [numbered list — only what was NOT found above, e.g.:]
  1. Universe not found locally. Path on your machine?
     (or confirm: access via GitHub only)
  2. App name ambiguous between [X] and [Y]. Which is this?
═══════════════════════════════════════════════════════

OK to proceed?
```

Wait for explicit OK.

**If universe not found locally**, offer 3 options to the developer:

> "Universe `[UNIVERSE_NAME]-universe` not found locally. A universe is the shared
> source of governance + cross-repo contracts for your org — do you want one wired
> to this project? Choose how:
>
> **1. Create it now (recommended for a new organization).**
>    I will invoke `/rsct-init-universe` to bootstrap a skeleton
>    universe at `~/projects/[UNIVERSE_NAME]-universe/`. It creates governance
>    document templates with TODOs, placeholder folders for applications
>    and hosts, and a CLAUDE.md operational protocol. You fill the content
>    over time.
>
> **2. Provide the path** — if the universe exists on this machine somewhere
>    I didn't search (custom location).
>
> **3. Remote-only access.** I will read the universe from GitHub instead.
>    Requires explicit OK for each network fetch. URLs I would read:
>      - `CLAUDE.md` — operational protocol
>      - `docs/governance/canonical-sources-map.md`
>      - `docs/governance/document-control.md`
>      - `docs/INDEX.md`
>
> Which option?"

Wait for the developer's choice.

- If **option 1**: invoke `/rsct-init-universe` and continue this
  prompt once the universe is created. After creation, the universe is local
  and Phase 3+ proceeds normally with `UNIVERSE_LOCAL_PATH` set to the new path.
- If **option 2**: ask for the path and re-validate.
- If **option 3**: present URLs + reason and wait for explicit OK before any
  remote fetch.

---

## Phase 3 — Identify app-specific elements

**Note for freshly-bootstrapped universes:** if the developer chose Option 1
in Phase 2 (creating the universe via `/rsct-init-universe`), most artifacts
listed below will not exist yet — the universe was just bootstrapped with
placeholders. Report each as "pending curation" rather than "missing", and
proceed to Phase 4 generating the section with the canonical paths.

From universe content (local or remote), identify:

- **Production host(s)**: runtime canonical + proxy/edge if any
- **C4 Containers diagram**: `docs/diagrams/c4-containers-[APP_NAME].drawio` (verify existence)
- **Technical retention annex**: `docs/governance/retention-technical-annexes/[APP_NAME].md`
- **Canonical subdomains**: `docs/governance/dns-governance-survey.md`
- **LGPD legal basis**: `docs/governance/lgpd-system-matrix.md`

If additional access is needed to confirm paths:
- Local: read directly
- Remote: request authorization again with URL + reason

---

## Phase 4 — Generate section

Insert into CLAUDE.md **only** the `## Canonical architectural source` section,
**wrapped in RSCT markers** so `/rsct-uninstall` can identify and remove
it cleanly later.
If section already exists: replace it entirely (markers and content).

**Canonical bash — preamble (UPDATE-mode safety, CAP-18 hardening):**

The block below mechanically excises any existing canonical-source
section before the new markdown block is appended. This is the only
part of the Phase 4 flow that is reformat-sensitive — getting the
BEGIN/END marker pair wrong breaks `/rsct-uninstall`'s detection
contract. The markdown content itself stays as prose below (single
source of truth for the section's shape; agent fills the
Claude-decided placeholders — host names, roles, paths — from Phase 3
answers).

```bash
echo "  CHECKPOINT: Phase 4 executing canonical canonical-source UPDATE-mode excision preamble"
CLAUDE_MD="$(pwd)/CLAUDE.md"

if grep -q "<!-- RSCT-CANONICAL-SOURCE-BEGIN" "$CLAUDE_MD"; then
  # Range-delete by BEGIN/END marker pair. Single `/` delimiter, no `|`
  # alternation risk, mirror of `03-uninstall.md` Phase 4.3 excise pattern.
  # CAP-22: BSD sed (macOS) requires an empty suffix after -i; GNU sed
  # (Git Bash / Linux) does not. Branch on uname -s to stay cross-OS.
  case "$(uname -s)" in
    Darwin)
      sed -i '' "/<!-- RSCT-CANONICAL-SOURCE-BEGIN/,/<!-- RSCT-CANONICAL-SOURCE-END/d" "$CLAUDE_MD"
      ;;
    *)
      sed -i "/<!-- RSCT-CANONICAL-SOURCE-BEGIN/,/<!-- RSCT-CANONICAL-SOURCE-END/d" "$CLAUDE_MD"
      ;;
  esac
  # Sanity: both markers must be gone after excision.
  if grep -q "<!-- RSCT-CANONICAL-SOURCE-BEGIN" "$CLAUDE_MD" || \
     grep -q "<!-- RSCT-CANONICAL-SOURCE-END" "$CLAUDE_MD"; then
    echo "  ⚠ ERROR: existing canonical-source block did not excise cleanly — inspect $CLAUDE_MD manually" >&2
    exit 1
  fi
  echo "  existing canonical-source block removed (UPDATE mode)"
else
  echo "  no existing canonical-source block (CREATE mode)"
fi
```

After the preamble, insert the markdown block below into `CLAUDE.md`
right after the `<!-- RSCT_APP: ... -->` header line (Phase 4.3 of
`01-setup.md` is the canonical writer of that header). The block's
placeholders are filled from Phase 1 discovery (`UNIVERSE_NAME`,
`UNIVERSE_LOCAL_PATH`, `UNIVERSE_GITHUB_BASE`, `APP_NAME`) and
Phase 3 dev answers (hosts, roles):

```markdown
<!-- RSCT-CANONICAL-SOURCE-BEGIN v=1.0.0 -->
## Canonical architectural source

<!-- RSCT_UNIVERSE: [UNIVERSE_NAME] | updated: [YYYY-MM-DD] -->

### 0. Permanent rule — universe access

Any access to [UNIVERSE_NAME]-universe artifacts listed below requires:
1. Try local path first: `[UNIVERSE_LOCAL_PATH]`
2. If not available locally: list URLs + reason and wait for explicit user OK.
3. This rule applies even in `Edit automatically` mode.

Source: `[UNIVERSE_NAME]-universe/CLAUDE.md` §0.1

---

### 1. Operational protocol (read first in any session)

| | Path |
|---|---|
| Local | `[UNIVERSE_LOCAL_PATH]/CLAUDE.md` |
| Remote | `[UNIVERSE_GITHUB_BASE]/blob/main/CLAUDE.md` |

Key rules: explicit OK for commit/push; analyze impact before changing;
external access requires OK; no secrets in output.

---

### 2. App identity and operational state — [APP_NAME]

**Production host(s):**
| Host | Role | Local | Remote |
|---|---|---|---|
| [host] | [runtime/proxy/edge] | `[LOCAL]/hosts/[host]/operational-state.md` | `[REMOTE]/blob/main/hosts/[host]/operational-state.md` |

Application:
- Local: `[UNIVERSE_LOCAL_PATH]/applications/[APP_NAME]/README.md`
- Remote: `[UNIVERSE_GITHUB_BASE]/blob/main/applications/[APP_NAME]/README.md`

---

### 3. Governance affecting this app

| Artifact | Local | Remote |
|---|---|---|
| Status matrix | `[LOCAL]/docs/governance/document-control.md` | `[REMOTE]/blob/main/docs/governance/document-control.md` |
| Subdomains | `[LOCAL]/docs/governance/dns-governance-survey.md` | `[REMOTE]/blob/main/docs/governance/dns-governance-survey.md` |
| LGPD | `[LOCAL]/docs/governance/lgpd-system-matrix.md` | `[REMOTE]/blob/main/docs/governance/lgpd-system-matrix.md` |
| Retention annex | `[LOCAL]/docs/governance/retention-technical-annexes/[APP_NAME].md` | `[REMOTE]/blob/main/docs/governance/retention-technical-annexes/[APP_NAME].md` |
| Canonical sources | `[LOCAL]/docs/governance/canonical-sources-map.md` | `[REMOTE]/blob/main/docs/governance/canonical-sources-map.md` |
| Naming standards | `[LOCAL]/docs/governance/naming-standards.md` | `[REMOTE]/blob/main/docs/governance/naming-standards.md` |

> Retention annex: include only if confirmed existing in Phase 3.

---

### 4. Architectural diagrams

| Diagram | Local | Remote |
|---|---|---|
| C4 Context (ecosystem) | `[LOCAL]/docs/diagrams/c4-context-ecosystem.drawio` | `[REMOTE]/blob/main/docs/diagrams/c4-context-ecosystem.drawio` |
| C4 Containers ([APP_NAME]) | `[LOCAL]/docs/diagrams/c4-containers-[APP_NAME].drawio` | `[REMOTE]/blob/main/docs/diagrams/c4-containers-[APP_NAME].drawio` |
| Deployment macro | `[LOCAL]/docs/diagrams/deployment-macro.drawio` | `[REMOTE]/blob/main/docs/diagrams/deployment-macro.drawio` |
| DFD macro | `[LOCAL]/docs/diagrams/dfd-macro.drawio` | `[REMOTE]/blob/main/docs/diagrams/dfd-macro.drawio` |
| Security map ISO/LGPD | `[LOCAL]/docs/diagrams/security-map-iso-lgpd.drawio` | `[REMOTE]/blob/main/docs/diagrams/security-map-iso-lgpd.drawio` |

> C4 Containers: include only if confirmed existing in Phase 3.

---

### When to consult each category

- **Cat. 1**: always, at the start of any session (local first).
- **Cat. 2**: before changing runtime config, infra, deploy, .env, DB, allowlist.
- **Cat. 3**: before changing domains, personal data, retention, LGPD, naming.
- **Cat. 4**: before proposing relevant architectural change. If the change
  affects a diagram, read `diagrams-refactoring-prompt.md` first.
<!-- RSCT-CANONICAL-SOURCE-END -->
```

---

## Phase 5 — Update .rsct.json and suggest commit

1. If `.rsct.json` exists, add/update two things:

   **(a)** The `universe` block with discovered values:
   ```json
   "universe": {
     "name": "[UNIVERSE_NAME]",
     "local": "[UNIVERSE_LOCAL_PATH or empty string]",
     "remote": "[UNIVERSE_GITHUB_URL]"
   }
   ```

   **(b)** In the `install` block: set `canonical_source_added` to `true`:
   ```json
   "install": {
     ...existing fields preserved (applied_at, mode, setup_commit_sha_before)...,
     "canonical_source_added": true
   }
   ```
   This flag tells `/rsct-uninstall` that the canonical source section
   is present and should be considered during uninstall.

   If `.rsct.json` does not exist: `01-setup.md` was not run first.
   Recommend running it before 02 — uninstall depends on the `install` block
   with `setup_commit_sha_before` being present. Create a minimal `.rsct.json`
   with just the `universe` block; setup will fill in the rest on next run.
2. Show diff of the generated CLAUDE.md section.
3. Run leak review:
   ```bash
   git diff | grep -iE "password|secret|token|\/home\/[a-zA-Z]|C:\\\\Users\\\\"
   ```
4. Suggest commit message:
   ```
   docs: add canonical architectural source [universe: UNIVERSE_NAME]
   ```
5. **Do not execute the commit.** Suggest only.
