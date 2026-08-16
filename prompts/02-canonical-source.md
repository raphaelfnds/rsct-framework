# RSCT Canonical Source — 02-canonical-source.md

You are operating inside a software project repository belonging to an organization
that maintains a central **universe repository** with canonical architectural artifacts.

Your task: create or update the `## 0. Canonical architectural source` section
in `CLAUDE.md` at the root of this repository.

Read this entire file before executing any action.

---

## Absolute rules

- No `git commit`, `git push` without explicit OK from the user.
- Do not modify any section of CLAUDE.md other than `## 0. Canonical architectural source`.
- If the repo already has `AGENTS.md`, ask the user which file to update.
- Never copy content from the universe repository — only reference via canonical URL.

---

## ⛔ Execution mandate — read before every code block

Same contract as `prompts/01-setup.md`'s execution mandate:

1. **Execute every fenced `bash` block literally.** Do NOT translate
   to Node / Python / PowerShell / TS, do NOT consolidate Phase
   blocks into a single helper script.
2. **The Phase 4 `markdown` block is the canonical content** of the
   `## 0. Canonical architectural source` section. Insert it into
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
# Four-way resolution. Every match is byte-literal (-F) and unanchored, so it is
# CRLF-safe (anti-pattern #4) and immune to the `.` in "## 0." (anti-pattern #2).
# Never -i with -F (anti-pattern #7 — SIGABRT on Git Bash grep 3.0).
#
# CLAUDE_MD is assigned HERE: each fenced block runs in its own shell, so a value
# set in another Phase does not exist in this one (anti-pattern #6).
CLAUDE_MD="$(pwd)/CLAUDE.md"
CS_MODE="create-append"
if   grep -qF "<!-- RSCT-CANONICAL-SOURCE-BEGIN"      "$CLAUDE_MD" 2>/dev/null; then CS_MODE="update"
elif grep -qF "<!-- RSCT-CANONICAL-SOURCE-SLOT-BEGIN" "$CLAUDE_MD" 2>/dev/null; then CS_MODE="create-slot"
elif grep -qF "<TODO: run 02-canonical-source.md"     "$CLAUDE_MD" 2>/dev/null; then CS_MODE="create-legacy"
fi
echo "CS_MODE=$CS_MODE"

# Context for the report, best-effort. `awk index()==1` is byte-literal and
# column-anchored — the repo idiom for matching a heading without a regex.
awk 'index($0,"## 0. Canonical architectural source")==1 || index($0,"## Canonical architectural source")==1 { print NR": "$0 }' \
  "$CLAUDE_MD" 2>/dev/null || true
```

`CS_MODE` resolves to one of four states. **It is not carried to Phase 4** — that
block runs in its own shell *and* the Phase 4 preamble mutates the file in
between, so Phase 4 re-derives it.

| `CS_MODE` | State of `CLAUDE.md` | What Phase 4 does |
|---|---|---|
| `update` | a real `RSCT-CANONICAL-SOURCE` pair is present | the preamble excises it; the section is re-inserted at the canonical anchor |
| `create-slot` | the template's `RSCT-CANONICAL-SOURCE-SLOT` pair is present | **replace** that block, BEGIN..END inclusive |
| `create-legacy` | an unmarked placeholder from an install predating the SLOT marker | **replace** the legacy block: the `## 0.` heading line through the `<TODO ...>` line |
| `create-append` | none of the above | insert at the canonical anchor |

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
  CLAUDE.md section: [exists — will update | placeholder slot — will fill
                      | legacy placeholder — will migrate | not found — will create]
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
>    I will execute `prompts/04-init-universe.md` to bootstrap a skeleton
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

- If **option 1**: execute `prompts/04-init-universe.md` and continue this
  prompt once the universe is created. After creation, the universe is local
  and Phase 3+ proceeds normally with `UNIVERSE_LOCAL_PATH` set to the new path.
- If **option 2**: ask for the path and re-validate.
- If **option 3**: present URLs + reason and wait for explicit OK before any
  remote fetch.

---

## Phase 3 — Identify app-specific elements

**Note for freshly-bootstrapped universes:** if the developer chose Option 1
in Phase 2 (creating the universe via `prompts/04-init-universe.md`), most artifacts
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

Insert into CLAUDE.md **only** the `## 0. Canonical architectural source`
section, **wrapped in RSCT markers** so `/rsct-uninstall` can identify and
remove it cleanly later.

Where it goes is decided by `CS_MODE`, re-derived at the top of the block
below. In `update` mode the preamble excises the old section first; in
`create-slot` and `create-legacy` the existing placeholder is **replaced in
place**; in `create-append` the section is inserted at the canonical anchor.

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
# Assigned HERE — each fenced block runs in its own shell (anti-pattern #6).
CLAUDE_MD="$(pwd)/CLAUDE.md"

# Re-derive CS_MODE: Phase 1.3 ran in another shell, and this block is about to
# mutate the file. Byte-literal (-F), never -i with -F (anti-pattern #7).
CS_MODE="create-append"
if   grep -qF "<!-- RSCT-CANONICAL-SOURCE-BEGIN"      "$CLAUDE_MD" 2>/dev/null; then CS_MODE="update"
elif grep -qF "<!-- RSCT-CANONICAL-SOURCE-SLOT-BEGIN" "$CLAUDE_MD" 2>/dev/null; then CS_MODE="create-slot"
elif grep -qF "<TODO: run 02-canonical-source.md"     "$CLAUDE_MD" 2>/dev/null; then CS_MODE="create-legacy"
fi
echo "CS_MODE=$CS_MODE"

# Excise every well-formed BEGIN..END block in ONE portable awk pass, and refuse
# to touch the file when the markers are not properly paired.
#
# Why not `sed '/B/,/E/d'` with a count guard: counting is not enough. A file
# whose END precedes its BEGIN counts 1 BEGIN / 1 END, passes any count check,
# and the range delete then runs from BEGIN to END OF FILE — destroying the
# developer's content, after which "are the markers gone?" is trivially true.
# Counting also wrongly rejects a file with two well-formed pairs, which the
# old unguarded sed handled correctly.
#
# awk is POSIX and needs no `sed -i` suffix branch (no Darwin/* split), and one
# pass can express pairing, which a sed range address cannot.
#
# Line endings: on a CRLF checkout the rewritten file comes back LF, because awk
# on MSYS strips `\r` from input records. Measured, not assumed. That matches
# what `sed -i` already did on this platform, so it is not a regression — but do
# NOT claim this path preserves CRLF. It does not.
cs_excise() { # $1 BEGIN literal, $2 END literal, $3 file → stdout: "OK <n>" | "MALFORMED <why>"
  awk -v b="$1" -v e="$2" -v out="$3.rsct.tmp" '
    index($0, b) > 0 { if (inb) { bad = "nested-BEGIN-line-" NR; exit } inb = 1; next }
    index($0, e) > 0 { if (!inb) { bad = "stray-END-line-" NR; exit } inb = 0; n++; next }
    { if (!inb) print > out }
    END {
      if (bad == "" && inb) bad = "unterminated-BEGIN"
      if (bad != "") print "MALFORMED " bad; else print "OK " n + 0
    }
  ' "$3" 2>/dev/null
}

if [ "$CS_MODE" = "update" ]; then
  CS_RESULT=$(cs_excise "<!-- RSCT-CANONICAL-SOURCE-BEGIN" "<!-- RSCT-CANONICAL-SOURCE-END" "$CLAUDE_MD")
  case "$CS_RESULT" in
    "OK "*)
      mv "${CLAUDE_MD}.rsct.tmp" "$CLAUDE_MD"
      echo "  existing canonical-source block removed (UPDATE mode)"
      ;;
    *)
      rm -f "${CLAUDE_MD}.rsct.tmp"
      echo "  ⚠ ${CS_RESULT} canonical-source markers in $CLAUDE_MD" >&2
      echo "    NOT excising — the markers are not properly paired. Fix them by hand." >&2
      exit 1
      ;;
  esac
else
  echo "  no existing canonical-source block (${CS_MODE})"
fi

# An orphan placeholder can coexist with a real section (an old install that was
# linked, then upgraded). Remove it here, or the sanity check below rejects the
# run for a duplicate heading the agent never saw.
CS_SLOT=$(cs_excise "<!-- RSCT-CANONICAL-SOURCE-SLOT-BEGIN" "<!-- RSCT-CANONICAL-SOURCE-SLOT-END" "$CLAUDE_MD")
case "$CS_SLOT" in
  "OK 0") rm -f "${CLAUDE_MD}.rsct.tmp" ;;
  "OK "*) mv "${CLAUDE_MD}.rsct.tmp" "$CLAUDE_MD"; echo "  removed orphan canonical-source slot" ;;
  *)      rm -f "${CLAUDE_MD}.rsct.tmp"; echo "  ⚠ ${CS_SLOT} in the canonical-source slot markers — left as-is" >&2 ;;
esac
```

After the preamble, write the markdown block below into `CLAUDE.md`
according to `CS_MODE`. The block's placeholders are filled from Phase 1
discovery (`UNIVERSE_NAME`, `UNIVERSE_LOCAL_PATH`, `UNIVERSE_GITHUB_BASE`,
`APP_NAME`) and Phase 3 dev answers (hosts, roles).

**The canonical anchor** — where the section goes when it is not replacing
something in place: immediately after the `<!-- /RSCT-CONVENTIONS-REF -->`
line if that line exists, else immediately after the `# CLAUDE.md` H1.
Never above the H1.

| `CS_MODE` | Where the block goes |
|---|---|
| `update` | at the canonical anchor (the preamble already removed the old section) |
| `create-slot` | **replaces** `<!-- RSCT-CANONICAL-SOURCE-SLOT-BEGIN ... -->` through `<!-- RSCT-CANONICAL-SOURCE-SLOT-END -->`, both markers included |
| `create-legacy` | **replaces** the unmarked placeholder: from the `## 0. Canonical architectural source` heading line through the `<TODO ...>` line, inclusive |
| `create-append` | at the canonical anchor |

The `---` separators around the slot stay **outside** the replaced range, and
the replacement ends with exactly one newline — so no doubled separator and no
orphan blank run is left behind. Compare `examples/java-spring/CLAUDE.md`.

```markdown
<!-- RSCT-CANONICAL-SOURCE-BEGIN v=1.0.0 -->
## 0. Canonical architectural source

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

### 4.b — Post-mutation sanity check (canonical bash)

Run this immediately after writing the block. It is the only mechanical proof
that the splice landed: the write itself is an agent edit, so nothing else
verifies it.

```bash
echo "  CHECKPOINT: Phase 4.b executing canonical canonical-source post-mutation sanity check"
# `${VAR:-default}` per anti-pattern #6 — a safe fallback rather than a bare
# assignment, so the check is also runnable against a fixture path in tests.
CLAUDE_MD="${CLAUDE_MD:-$(pwd)/CLAUDE.md}"
CS_FAIL=0

# `grep -c` exits 1 on zero matches → `|| true`. Compare as STRINGS: a missing
# file yields an empty value, and `-eq` would abort with a non-obvious error.
cs_count() { grep -cF "$1" "$CLAUDE_MD" 2>/dev/null || true; }
# `awk index($0,s)==1` is byte-literal AND anchored at column 1, so a heading
# quoted mid-sentence in the dev's prose is not counted as the real one. It
# never anchors on `$`, so it is CRLF-safe. (The two heading forms do NOT
# contain one another once the `## ` prefix is included — that is why both are
# asserted separately below rather than relying on a single count.)
cs_atcol1() { awk -v s="$1" 'index($0,s)==1 { n++ } END { print n+0 }' "$CLAUDE_MD" 2>/dev/null || echo 0; }
cs_line()   { awk -v s="$1" 'index($0,s)==1 { print NR; exit }' "$CLAUDE_MD" 2>/dev/null; }
# First heading of any level — the H1 is `# CLAUDE.md` only in files RSCT
# created. An ADOPT-mode install keeps the project's own title (`# Acme API`),
# and asserting the literal would reject a correctly placed section.
cs_first_h() { awk 'index($0,"# ")==1 { print NR; exit }' "$CLAUDE_MD" 2>/dev/null; }
cs_expect() {
  if [ "${3:-}" != "$2" ]; then
    echo "  ⚠ ERROR: sanity '$1' = ${3:-<none>}, expected $2 — inspect $CLAUDE_MD" >&2
    CS_FAIL=$((CS_FAIL + 1))
  fi
}

cs_expect "numbered heading"  1 "$(cs_atcol1 '## 0. Canonical architectural source')"
cs_expect "no bare heading"   0 "$(cs_atcol1 '## Canonical architectural source')"
cs_expect "one real BEGIN"    1 "$(cs_count '<!-- RSCT-CANONICAL-SOURCE-BEGIN')"
cs_expect "one real END"      1 "$(cs_count '<!-- RSCT-CANONICAL-SOURCE-END')"
cs_expect "no SLOT residue"   0 "$(cs_count 'RSCT-CANONICAL-SOURCE-SLOT')"
# Only OUR placeholders, never a bare `<TODO`. `01-setup.md` actively teaches the
# dev to write `<TODO: describe X>` in their own sections; asserting on the generic
# token would reject a perfectly good CLAUDE.md — after the file was already written.
cs_expect "no slot TODO"      0 "$(cs_count '<TODO: run /rsct-universe')"
cs_expect "no legacy TODO"    0 "$(cs_count '<TODO: run 02-canonical-source.md')"

H1_LINE="$(cs_first_h)"
HD_LINE="$(cs_line '## 0. Canonical architectural source')"
# The section must sit below the document's first heading, whatever that heading
# is. A file with no heading at all cannot be ordered, so the check is skipped
# rather than failed — the placement rule has the same fallback.
if [ -n "$H1_LINE" ] && [ -n "$HD_LINE" ] && [ "$HD_LINE" -le "$H1_LINE" ]; then
  echo "  ⚠ ERROR: the section (line ${HD_LINE}) must come after the first heading (line ${H1_LINE})" >&2
  CS_FAIL=$((CS_FAIL + 1))
elif [ -z "$HD_LINE" ]; then
  echo "  ⚠ ERROR: no '## 0. Canonical architectural source' heading at column 1 — the block did not land" >&2
  CS_FAIL=$((CS_FAIL + 1))
fi

if [ "$CS_FAIL" -ne 0 ]; then
  echo "  ⚠ ERROR: canonical-source sanity check failed (${CS_FAIL} assertion(s)) — do NOT commit" >&2
  exit 1
fi
echo "  canonical-source sanity check OK (H1=${H1_LINE} heading=${HD_LINE})"
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
