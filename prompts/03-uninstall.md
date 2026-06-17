# RSCT Uninstall — 03-uninstall.md
# Version: 1.0.0

You are operating inside a software project repository that was previously
configured by `/rsct-setup` (and optionally `/rsct-canonical-source`).

Your task: reverse the changes made by RSCT setup, with full safety guarantees:
- Never delete a file that the developer modified after creation
- Never leave the project in an inconsistent state
- Always offer granularity (full uninstall or selective)
- Always require explicit OK before mutation

Read this entire file before executing any action.

---

## Absolute rules during this entire session

- No `git commit`, `git push`, or file deletion without explicit OK from the user
  for that specific action.
- If a generated file's SHA256 does not match its marker: never delete without
  asking the user case-by-case.
- If the `.rsct.json` `install` block is missing: abort with clear message —
  this project was set up by a pre-1.0.0 RSCT version (no markers) and cannot
  be auto-uninstalled.
- When in doubt about anything: stop and ask.

---

## Phase 1 — Silent discovery (no output yet, no mutations)

Run all steps silently. Collect all findings before presenting anything.

### 1.1 — Read .rsct.json (mandatory anchor)
```bash
cat .rsct.json 2>/dev/null || echo "FILE_NOT_FOUND"
```

If `.rsct.json` not found OR `install` block missing OR
`install.setup_commit_sha_before` missing:
→ **Abort uninstall**. Report to user:
```
RSCT uninstall requires .rsct.json with an `install` block
containing `setup_commit_sha_before`. This project appears to:
  - Not have been set up by RSCT v1.0.0+, OR
  - Have had .rsct.json manually edited / deleted

Manual cleanup required. See README.md "Manual uninstall" section.
```

Otherwise, extract:
- `RSCT_VERSION` = `rsct_version`
- `MODE_AT_INSTALL` = `install.mode` ("UPDATE" or "CREATE")
- `SETUP_COMMIT_SHA_BEFORE` = `install.setup_commit_sha_before`
- `CANONICAL_SOURCE_ADDED` = `install.canonical_source_added`
- `PROJECT_NAME` = `app.name`

### 1.2 — Compute current project_encoded for memory entries

Use the same encoding rule as `01-setup.md` Phase 1.7 (Windows: native path,
lowercased drive letter, `[\\/:.[:space:]]` → `-`; Linux/macOS: POSIX path,
`[/:.[:space:]]` → `-`):

```bash
PROJECT_PATH=$(pwd)
OS_NAME=$(uname -s 2>/dev/null || echo "")

if echo "$OS_NAME" | grep -qiE "MINGW|MSYS|CYGWIN"; then
  NATIVE_PATH=$(pwd -W 2>/dev/null \
    || cygpath -w "$PROJECT_PATH" 2>/dev/null \
    || echo "$PROJECT_PATH")
  FIRST=$(printf '%s' "$NATIVE_PATH" | cut -c1 | tr 'A-Z' 'a-z')
  REST=$(printf '%s' "$NATIVE_PATH" | cut -c2-)
  PROJECT_ENCODED=$(printf '%s%s' "$FIRST" "$REST" \
    | sed -E 's#[\\/:.[:space:]]#-#g')
else
  PROJECT_ENCODED=$(printf '%s' "$PROJECT_PATH" \
    | sed -E 's#[/:.[:space:]]#-#g')
fi

echo "PROJECT_ENCODED=$PROJECT_ENCODED"
MEMORY_DIR="$HOME/.claude/projects/$PROJECT_ENCODED/memory"
echo "MEMORY_DIR=$MEMORY_DIR"
ls "$MEMORY_DIR" 2>/dev/null || echo "MEMORY_DIR_NOT_FOUND"
```

Note: if the project folder was moved since setup, `PROJECT_ENCODED` will be
different from when memory entries were written. In that case `MEMORY_DIR` will
not exist — report as "memory entries already orphaned (project moved?)".

### 1.3 — Scan CLAUDE.md for RSCT markers
```bash
grep -n "<!-- RSCT-" CLAUDE.md 2>/dev/null || echo "NO_MARKERS"
```

Identify, by marker:
- §A–§H sections present (each has `<!-- RSCT-§X-BEGIN ... -->` and `<!-- RSCT-§X-END -->`)
- For each: extract `source=inserted` vs `source=migrated-from-ptbr` from BEGIN marker
- Canonical source section (`<!-- RSCT-CANONICAL-SOURCE-BEGIN -->` / `<!-- RSCT-CANONICAL-SOURCE-END -->`)

### 1.4 — Scan documentation/ for RSCT-GENERATED files
```bash
# CAP-24: process substitution (`done < <(find ...)`) instead of
# `find ... | while`. The loop body is no-side-effect today (echo only)
# but pipeline-while runs in a subshell — if a future edit adds a
# counter or external-variable mutation, the subshell would discard it
# silently. Anti-pattern #1 in CLAUDE.md root.
while read -r f; do
  head -n 1 "$f" | grep -q "<!-- RSCT-GENERATED" && echo "RSCT: $f" || echo "OTHER: $f"
done < <(find documentation/ -name "*.md" 2>/dev/null)
```

For each `RSCT: <file>`:
- Extract `sha256-body` from the marker (first line, value after `sha256-body=`)
- Compute current SHA256 of the body using the portable helper below
- Compare:
  - **UNMODIFIED** → marker SHA matches current → safe to delete
  - **MODIFIED** → marker SHA differs → developer edited it → needs decision
  - **MISSING** → file was already deleted (no-op for uninstall)

**Portable SHA256 helper** — same as `01-setup.md`. Define once near the top of
the execution context and reuse for every file comparison.

```bash
sha256_compute() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    openssl dgst -sha256 | awk '{print $NF}'
  fi
}

# Example comparison for one file:
# tr -d '\r' normalizes CRLF→LF before SHA so Windows `git autocrlf`
# checkouts don't produce false MODIFIED classifications (the file was
# created with LF endings in the marker SHA but git may have converted
# the working tree to CRLF after install). Mirror of the same fix in
# 01-setup.md Phase 4.5 / 4.6.
CURRENT_SHA=$(tail -n +2 "$f" | tr -d '\r' | sha256_compute)
MARKER_SHA=$(head -n 1 "$f" | sed -n 's/.*sha256-body=\([a-f0-9]\{64\}\).*/\1/p')
if [ "$CURRENT_SHA" = "$MARKER_SHA" ]; then echo "UNMODIFIED"; else echo "MODIFIED"; fi
```

### 1.5 — Scan memory entries
```bash
# CAP-24: process substitution mirror of Phase 1.4.
if [ -d "$MEMORY_DIR" ]; then
  while read -r f; do
    head -n 1 "$f" | grep -q "<!-- RSCT-GENERATED" && echo "RSCT: $f" || echo "OTHER: $f"
  done < <(ls "$MEMORY_DIR"/feedback_*.md "$MEMORY_DIR"/MEMORY.md 2>/dev/null)
fi
```

Same UNMODIFIED / MODIFIED / MISSING classification as Phase 1.4.

### 1.6 — Inventory .rsct/ artifacts (M2 enforcement state)

```bash
ls -la .rsct/ 2>/dev/null || echo "NOT_FOUND"
ls -la .rsct/scripts/ 2>/dev/null || echo "SCRIPTS_NOT_FOUND"
```

Catalogue the framework-installed artifacts and any other files present
(scripts/ + audit.log + approvals-seen.json from M2 install; phase-state.json
written on the fly by the M3 phase machine). Each is classified
independently in Phase 2:

| Path | Created by | Default action | Why |
|---|---|---|---|
| `.rsct/scripts/sanitize-permissions.js` | `/rsct-setup` Phase 4.V (F2.5.6) | **remove always** | Pure framework code; no dev value once rsct-mcp is uninstalled. |
| `.rsct/audit.log` | first §C-gated tool call or sanitizer hook | **keep by default** | Forensic / compliance record (rule overrides, sanitize events). Dev can opt-in to delete. |
| `.rsct/approvals-seen.json` | first successful `rsct_request_*` mutation (INV-2 anti-reuse store) | **remove** | Internal state with no post-uninstall value. |
| `.rsct/phase-state.json` | M3 phase machine on every `rsct_phase_*_start/_complete` call | **remove** | Internal phase-machine state with no post-uninstall value (analogous to approvals-seen). |

Anything else in `.rsct/` (developer-added files, schema references):
**always preserve** — never delete files the framework did not create.

Store as `RSCT_INVENTORY` (e.g., `scripts:present, audit:present(127 lines),
approvals:present(3 entries), phase-state:present, other:none`).

### 1.7 — Verify pre-setup SHA is still reachable
```bash
git cat-file -e "$SETUP_COMMIT_SHA_BEFORE" 2>/dev/null && echo "REACHABLE" || echo "UNREACHABLE"
```

If UNREACHABLE: the commit was garbage-collected (shouldn't happen normally
unless `git gc --prune=now` was run aggressively). Restoring pre-setup PT-BR
content via `git checkout` won't work. Inform user; offer marker-only removal.

### 1.8 — Current branch
```bash
git rev-parse --abbrev-ref HEAD
```
Store as `CURRENT_BRANCH`. If it is `main`, `test`, or any protected branch,
the execution phase must create a derived branch.

### 1.9 — Scan .claude/settings.json for the SessionStart sanitizer hook

The install Phase 4.V (F2.5.6) registered a `hooks.SessionStart[]` entry
whose command contains the marker substring
`.rsct/scripts/sanitize-permissions.js`. Detect it without modifying
the file:

```bash
SETTINGS_PATH="$(pwd)/.claude/settings.json"
if [ -f "$SETTINGS_PATH" ]; then
  node -e '
    const fs = require("fs");
    const target = process.argv[1];
    const MARKER = ".rsct/scripts/sanitize-permissions.js";
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (e) {
      console.log("SETTINGS_MALFORMED");
      process.exit(0);
    }
    const groups = (settings.hooks && Array.isArray(settings.hooks.SessionStart))
      ? settings.hooks.SessionStart : [];
    let matches = 0;
    for (const g of groups) {
      if (g && Array.isArray(g.hooks)) {
        for (const h of g.hooks) {
          if (h && typeof h.command === "string" && h.command.indexOf(MARKER) !== -1) {
            matches++;
          }
        }
      }
    }
    console.log("HOOK_MATCHES=" + matches);
  ' "$SETTINGS_PATH"
else
  echo "SETTINGS_NOT_FOUND"
fi
```

Store as `SESSIONSTART_HOOK_MATCHES` (integer ≥0) or one of
`SETTINGS_MALFORMED` / `SETTINGS_NOT_FOUND`. The malformed case is
non-fatal — Phase 4.V scrub will log a warning and skip, preserving
the file untouched so the dev can fix it manually.

---

## Phase 2 — Compute classification per item

Build the uninstall plan internally. Items fall into categories:

**Category A — Safe to remove (no dev edits detected):**
- `.rsct.json` (always safe — it is our own metadata)
- Files in `documentation/` with marker SHA matching current body
- Memory entries with marker SHA matching current body
- CLAUDE.md sections wrapped in markers (excised by markers, source code preserved around)
- Canonical source section (excised by markers)

**Category B — Needs developer decision (file modified after install):**
- Files in `documentation/` with marker SHA NOT matching
- Memory entries with marker SHA NOT matching

For each Category B item, the dev will choose:
- **delete** — remove anyway
- **keep** — leave the file alone entirely
- **strip-marker** — remove only the `<!-- RSCT-GENERATED -->` line on top,
  leaving the rest of the file (effectively orphaning the file from RSCT)

**Category C — Restorable from git (pre-setup state available):**
- Sections in CLAUDE.md migrated from PT-BR (`source=migrated-from-ptbr`)
- The pre-setup state lives at commit `$SETUP_COMMIT_SHA_BEFORE`
- Offer: "remove (delete EN section)" vs "restore (git checkout pre-setup CLAUDE.md)"
- If `$SETUP_COMMIT_SHA_BEFORE` is UNREACHABLE (1.7): only "remove" is available

**Category D — Already gone:**
- Files listed by markers but no longer present on disk (dev deleted manually)
- Just clean up references; nothing to actually remove

**Category E — M2 enforcement state (added by Phase 4.V install):**

| Item | Default | Always-on-uninstall | Dev opt-in to override default |
|---|---|---|---|
| `hooks.SessionStart[]` entries in `.claude/settings.json` matching the sanitizer marker | **remove** | yes (closes the §C-gated ceiling cleanly) | dev may choose to keep for staged uninstall |
| `.rsct/scripts/sanitize-permissions.js` | **remove** | yes | none — pure framework code |
| `.rsct/audit.log` | **keep** | no | dev may choose to delete for full clean removal |
| `.rsct/approvals-seen.json` | **remove** | yes (silent — no question raised) | none — internal state with no post-uninstall value |
| `.rsct/phase-state.json` | **remove** | yes (silent — no question raised) | none — M3 phase-machine state with no post-uninstall value |
| Any other file under `.rsct/` not listed above | **keep** | no | preserved unconditionally — never delete unknowns |

> **`CONVENTIONS.md`** (project root, CAP-54) is **dev-owned** — it carries no
> RSCT marker and is in no canonical set, so uninstall **never** touches it (it
> is the team's standard, like any dev-authored file). At most, mention it as
> "preserved" in the report.

Category E is independent of Categories A–D. Even a "memory-only"
uninstall does NOT touch Category E unless the dev explicitly
includes it via the Phase 3 scope question.

---

## Phase 3 — Uninstall report + single question block

Present to the developer:

```
═══════════════════════════════════════════════════════
RSCT UNINSTALL — Report                     v1.0.0
Project: [PROJECT_NAME]
Installed at: [install.applied_at] (mode: [MODE_AT_INSTALL])
Pre-setup SHA: [SETUP_COMMIT_SHA_BEFORE] [REACHABLE|UNREACHABLE]
Current branch: [CURRENT_BRANCH]
═══════════════════════════════════════════════════════

✅ Safe to remove (unmodified, marker SHA matches):
  CLAUDE.md sections (via markers):
    §A, §B, §C, §D, §E, §F, §G, §H (8 sections, all source=inserted)
    [or: §F, §G, §H (inserted); §A, §B (migrated from PT-BR)]
  Canonical source section: [present | not present]
  .rsct.json
  documentation/README.md
  documentation/architecture.md (unmodified)
  documentation/decisions.md (unmodified)
  documentation/setupdeveloper.md (unmodified)
  documentation/impact/README.md (unmodified)
  documentation/tests/README.md (unmodified)
  Memory entries: 8 files at [MEMORY_DIR]

⚠ Modified after install — your decision:
  documentation/architecture.md           [delete | keep | strip-marker]
  documentation/setupdeveloper.md         [delete | keep | strip-marker]
  memory/feedback_testing-qa-mode.md      [delete | keep | strip-marker]

📌 Recoverable (only matters if you want to restore PT-BR):
  CLAUDE.md §A, §B were migrated from PT-BR. Pre-setup state is at
  commit [SETUP_COMMIT_SHA_BEFORE]. Options:
    - remove (default): excise sections, do not restore PT-BR
    - restore: git checkout [SHA] -- CLAUDE.md (rewrites whole file)

🗑 Already gone (will skip):
  documentation/modules/auth.md (file not present — dev deleted manually)

🛡 M2 enforcement state (Category E):
  SessionStart sanitizer hook in .claude/settings.json: [HOOK_MATCHES entries | SETTINGS_NOT_FOUND | SETTINGS_MALFORMED]
  .rsct/scripts/sanitize-permissions.js                : [present | absent]
  .rsct/audit.log                                       : [present (N lines) | absent]
  .rsct/approvals-seen.json                             : [present (M entries) | absent]
  .rsct/phase-state.json                                : [present | absent]

──────────────────────────────────────────────────────
❓ Scope of uninstall:

  [ ] Full uninstall (all of the above, including M2 enforcement state)
  [ ] Custom — select below:
      [ ] CLAUDE.md sections: __all__ | §___,___ only
      [ ] Canonical source section
      [ ] .rsct.json
      [ ] documentation/
      [ ] memory entries
      [ ] M2 enforcement state (Category E — see questions below)
  [ ] Memory-only (clear ~/.claude/.../memory only — does NOT touch Category E)

❓ For each modified file listed above, choice: delete | keep | strip-marker

❓ For migrated-from-ptbr sections, restore policy: remove | restore

❓ M2 enforcement state (only asked if Category E is in scope):
  - SessionStart sanitizer hook entry: remove (recommended) | keep
  - .rsct/audit.log forensic record  : keep (recommended) | delete
  (.rsct/scripts/, .rsct/approvals-seen.json, and .rsct/phase-state.json are removed silently — no value preserved.)

❓ Final branch for uninstall commits:
  - chore/rsct-uninstall (recommended — new branch from [CURRENT_BRANCH])
  - work directly on [CURRENT_BRANCH] (only if not protected)
══════════════════════════════════════════════════════

OK to proceed?
```

Wait for explicit OK and answers to all five questions before any mutation.

---

## Phase 4 — Execute (in order, each step idempotent)

### 4.1 — Create branch
```bash
git checkout -b chore/rsct-uninstall
```
Exception: if user chose to work directly on current branch and current branch
is not protected.

### 4.2 — Excise sections from CLAUDE.md

For each section in scope:

If "restore" chosen for a migrated-from-ptbr section:
```bash
git checkout "$SETUP_COMMIT_SHA_BEFORE" -- CLAUDE.md
```
Note: this rewrites the WHOLE CLAUDE.md from the pre-setup state.
Cannot do this if §A from PT-BR is "restore" but §B is "remove" — git checkout
is all-or-nothing on the file. If granularity is mixed, default to "remove" for
all PT-BR sections and warn the user.

Otherwise ("remove"): loop over the section IDs the dev marked for
removal in Phase 3 and excise each `<!-- RSCT-§X-BEGIN ... -->` /
`<!-- RSCT-§X-END -->` block by marker pair. Sed range-delete
(`/BEGIN/,/END/d`) handles the full multi-line block atomically; the
loop runs one sed per section so partial-scope choices (e.g., remove
§F + §G but keep the rest) are honored without rewriting the prompt
per case.

**Canonical bash — per-section excision (CAP-18 hardening):**

The loop below excises one section per iteration. The dev's Phase 3
answer (`CLAUDE.md sections: __all__` vs `§F, §G only`) determines
which IDs go into `SECTIONS_TO_REMOVE`. **The fallback default is
full uninstall** (`0 A B C D E F G H`) — if the variable is left
unset (e.g., the dev did not narrow the scope), every RSCT-managed
section is excised. Set the variable explicitly above this block
based on Phase 3 answer; the example below shows the two canonical
shapes.

```bash
echo "  CHECKPOINT: Phase 4.2 executing canonical RSCT-§X block excision"
CLAUDE_MD="$(pwd)/CLAUDE.md"

# SECTIONS_TO_REMOVE — set this BEFORE the loop, based on Phase 3 answer:
#   Full uninstall (default):      SECTIONS_TO_REMOVE="0 A B C D E F G H"
#   Custom narrow (e.g., F+G):     SECTIONS_TO_REMOVE="F G"
# The :- fallback below makes the block safe to run as written when the
# dev confirmed "full uninstall" in Phase 3 (the most common case) and
# is also the safe default if the variable was left unset by accident.
SECTIONS_TO_REMOVE="${SECTIONS_TO_REMOVE:-0 A B C D E F G H}"
echo "  sections to excise: ${SECTIONS_TO_REMOVE}"

# §0 and §A-§H are the only legitimate IDs — all are ASCII-safe under
# the literal `/` sed delimiter, and the `${SECTION}` interpolation
# expands inside double quotes so the literal `§` (multi-byte UTF-8)
# is passed through to the shell unchanged.
for SECTION in $SECTIONS_TO_REMOVE; do
  if grep -q "<!-- RSCT-§${SECTION}-BEGIN" "$CLAUDE_MD"; then
    # CAP-22: BSD sed (macOS) requires an empty suffix after -i; GNU sed
    # (Git Bash / Linux) does not. Branch on uname -s to stay cross-OS.
    case "$(uname -s)" in
      Darwin)
        sed -i '' "/<!-- RSCT-§${SECTION}-BEGIN/,/<!-- RSCT-§${SECTION}-END/d" "$CLAUDE_MD"
        ;;
      *)
        sed -i "/<!-- RSCT-§${SECTION}-BEGIN/,/<!-- RSCT-§${SECTION}-END/d" "$CLAUDE_MD"
        ;;
    esac
    if grep -q "<!-- RSCT-§${SECTION}-BEGIN" "$CLAUDE_MD"; then
      echo "  ⚠ ERROR: §${SECTION} excision did not land — inspect $CLAUDE_MD manually" >&2
      exit 1
    fi
    echo "  excised §${SECTION}"
  else
    echo "  §${SECTION} not present — no-op"
  fi
done
```

After excising: if `CLAUDE.md` now contains only the header
(`<!-- RSCT_VERSION: 1.0.0 -->` and `# CLAUDE.md` line) and was
created by this setup (`MODE_AT_INSTALL == "CREATE"`): delete the
entire file. Otherwise leave the file with whatever content remains
(dev-written or pre-existing).

### 4.3 — Excise canonical source section (if in scope)
```bash
# CAP-22: BSD sed (macOS) requires an empty suffix after -i; GNU sed
# (Git Bash / Linux) does not. Branch on uname -s to stay cross-OS.
case "$(uname -s)" in
  Darwin)
    sed -i '' '/<!-- RSCT-CANONICAL-SOURCE-BEGIN/,/<!-- RSCT-CANONICAL-SOURCE-END/d' CLAUDE.md
    ;;
  *)
    sed -i '/<!-- RSCT-CANONICAL-SOURCE-BEGIN/,/<!-- RSCT-CANONICAL-SOURCE-END/d' CLAUDE.md
    ;;
esac
```

### 4.4 — Remove documentation/ files

For each file with classification:
- **Category A (UNMODIFIED) + in scope** → delete file
- **Category B with choice "delete"** → delete file
- **Category B with choice "keep"** → no-op
- **Category B with choice "strip-marker"** → remove first line of file

After deleting files: prune empty directories (`documentation/modules/` if empty, etc.).
If `documentation/` itself becomes empty AND mode was CREATE: delete it.
Otherwise leave it (dev may have other docs there).

### 4.4b — Excise the `.gitignore` plan-tracking block (mirrors install 4.4b)

The install side wraps the plan-tracking patterns in
`# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b` ... `# RSCT-END` so
uninstall can find and remove them cleanly without disturbing the rest
of the file. Skip this step if `.gitignore` is absent or holds no RSCT
markers.

```bash
GITIGNORE="$(pwd)/.gitignore"
BEGIN_PATTERN="^# RSCT-BEGIN .*source=01-setup\.md/4\.4b"
END_PATTERN="^# RSCT-END"

if [ -f "$GITIGNORE" ] && grep -qE "$BEGIN_PATTERN" "$GITIGNORE" 2>/dev/null; then
  TMPFILE=$(mktemp)
  # Strip the marker block AND a single empty line immediately preceding
  # it (the install side inserts a leading blank for readability).
  awk -v begin="$BEGIN_PATTERN" -v end="$END_PATTERN" '
    BEGIN { in_block = 0; held = "" }
    {
      if (in_block) {
        if ($0 ~ end) { in_block = 0; held = ""; next }
        next
      }
      if ($0 ~ begin) {
        in_block = 1
        held = ""
        next
      }
      # Hold a single blank line so we can drop it if the next line opens
      # the RSCT block; otherwise flush it.
      if ($0 ~ /^$/) {
        if (held != "") { print held }
        held = $0
        next
      }
      if (held != "") { print held; held = "" }
      print
    }
    END { if (held != "") { print held } }
  ' "$GITIGNORE" > "$TMPFILE"
  mv "$TMPFILE" "$GITIGNORE"
  echo "  excised RSCT plan-tracking block from $GITIGNORE"

  # If the file is now empty (or whitespace-only), delete it — it was
  # solely an artifact of the install.
  if ! grep -q '[^[:space:]]' "$GITIGNORE" 2>/dev/null; then
    rm -f "$GITIGNORE"
    echo "  removed empty $GITIGNORE"
  fi
elif [ -f "$GITIGNORE" ] && grep -q "^plan_\*\.md" "$GITIGNORE" 2>/dev/null; then
  echo "  ⚠ legacy (pre-marker) RSCT plan-tracking block detected in $GITIGNORE."
  echo "    Cannot auto-remove without RSCT-BEGIN/END markers."
  echo "    Delete manually: lines from the '# RSCT plan tracking' comment"
  echo "    through 'progress_*.md' (and 'spec_*.md' if present — the alias"
  echo "    line shipped in v0.7.0; older legacy blocks won't contain it)."
fi
```

### 4.5 — Remove memory entries

```bash
MEMORY_DIR="$HOME/.claude/projects/$PROJECT_ENCODED/memory"
```

For each memory file with classification (same rules as 4.4):
- UNMODIFIED + in scope → delete
- MODIFIED with choice → delete | keep | strip-marker

After deleting files: if `MEMORY_DIR` is empty: delete the directory.
Also delete the parent `$HOME/.claude/projects/$PROJECT_ENCODED/` if it
is now empty.

### 4.6 — Delete .rsct.json

If `.rsct.json` is in scope and full uninstall: delete it last.

If only partial uninstall (e.g., user kept canonical source): instead of
deleting, update the `install` block to reflect what's still present
(e.g., `canonical_source_added` remains `true` if canonical was kept).

### 4.V — Scrub M2 enforcement state (mirrors install Phase 4.V)

Skip this entire phase if Category E is NOT in scope (per Phase 3
scope question).

**4.V.a — Scrub SessionStart sanitizer hook entries from `.claude/settings.json`**

Idempotent — removes ONLY entries whose `command` field contains the
marker substring `.rsct/scripts/sanitize-permissions.js`. Preserves every
other hook entry. If `hooks.SessionStart[]` becomes empty after the scrub,
the array is removed; if `hooks` itself becomes empty, the key is removed.
Malformed `settings.json` logs a warning and skips — the file is left
untouched.

```bash
echo "  CHECKPOINT: Phase 4.V.a executing canonical structured-merge SessionStart hook scrub"
# EXCEPTION: structured merge required. This block parses + re-serializes
# .claude/settings.json because the hook entry is nested
# (hooks.SessionStart[].hooks[]) and a text-based regex removal cannot
# guarantee correct array boundary handling across dev-customized shapes.
# The reformat of dev whitespace is the accepted cost; symmetric with the
# install-side justification in 01-setup.md Phase 4.V.c.
SETTINGS_PATH="$(pwd)/.claude/settings.json"
if [ -f "$SETTINGS_PATH" ]; then
  node -e '
    const fs = require("fs");
    const target = process.argv[1];
    const MARKER = ".rsct/scripts/sanitize-permissions.js";
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (e) {
      console.error("WARN: " + target + " is malformed JSON — SessionStart hook scrub skipped. Fix manually.");
      process.exit(0);
    }
    if (!settings.hooks || !Array.isArray(settings.hooks.SessionStart)) {
      console.log("No SessionStart hooks present — nothing to scrub.");
      process.exit(0);
    }
    let removed = 0;
    const remainingGroups = [];
    for (const group of settings.hooks.SessionStart) {
      if (!group || !Array.isArray(group.hooks)) {
        remainingGroups.push(group);
        continue;
      }
      const keptHooks = group.hooks.filter(h => {
        if (h && typeof h.command === "string" && h.command.indexOf(MARKER) !== -1) {
          removed++;
          return false;
        }
        return true;
      });
      if (keptHooks.length > 0) {
        remainingGroups.push({ ...group, hooks: keptHooks });
      }
      // If keptHooks is empty, drop the entire group.
    }
    if (remainingGroups.length === 0) {
      delete settings.hooks.SessionStart;
    } else {
      settings.hooks.SessionStart = remainingGroups;
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
    // CAP-50 (audit F2): if scrubbing the RSCT hook empties the file entirely,
    // delete it instead of leaving an orphaned "{}" — mirrors the .mcp.json
    // scrub in 4.V.a2. This only fires when install created settings.json
    // solely for the hook; a dev with any other settings keeps the file.
    if (Object.keys(settings).length === 0) {
      fs.unlinkSync(target);
      console.log("Removed " + target + " (it held only the RSCT SessionStart hook).");
    } else {
      fs.writeFileSync(target, JSON.stringify(settings, null, 2) + "\n", "utf8");
      console.log("Scrubbed " + removed + " RSCT SessionStart hook entr" + (removed === 1 ? "y" : "ies") + " from " + target);
    }
  ' "$SETTINGS_PATH"
fi
```

The script exits 0 unconditionally (mirrors the install side's never-block
principle). Re-running scrub on an already-scrubbed file is a no-op.

**4.V.a2 — Scrub project-scope MCP registration from `.mcp.json` (CAP-48)**

If `/rsct-setup` registered rsct at project scope (Phase 4.V.c2 wrote the
`rsct` key into `.mcp.json`), remove it here. Scrub **by the `rsct` key** under
`mcpServers` (the entry name is the marker — JSON has no comments), preserving
any other MCP servers the dev added. If `.mcp.json` would be left holding
nothing but that entry, the file is removed entirely. Absent / malformed /
already-clean `.mcp.json` → no-op.

```bash
echo "  CHECKPOINT: Phase 4.V.a2 scrubbing project-scope rsct from .mcp.json"
# EXCEPTION: structured merge required — symmetric with 4.V.a and the install
# side (01-setup.md Phase 4.V.c2). The rsct entry is nested under
# mcpServers.<name>; scrub by the "rsct" key, never by name pattern.
MCP_JSON="$(pwd)/.mcp.json"
if [ -f "$MCP_JSON" ]; then
  node -e '
    const fs = require("fs");
    const target = process.argv[1];
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(target, "utf8")); }
    catch (e) { console.error("WARN: " + target + " is malformed JSON — .mcp.json scrub skipped. Fix manually."); process.exit(0); }
    if (!cfg.mcpServers || !cfg.mcpServers.rsct) {
      console.log("No rsct entry in .mcp.json — nothing to scrub.");
      process.exit(0);
    }
    delete cfg.mcpServers.rsct;
    const remaining = Object.keys(cfg.mcpServers).length;
    const otherTop = Object.keys(cfg).filter(k => k !== "mcpServers").length;
    if (remaining === 0 && otherTop === 0) {
      fs.unlinkSync(target);
      console.log("Removed .mcp.json (it held only the rsct entry).");
    } else {
      if (remaining === 0) delete cfg.mcpServers;
      fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      console.log("Removed rsct from .mcp.json; preserved the dev's other entries.");
    }
  ' "$MCP_JSON"
fi
```

**4.V.b — Remove .rsct/scripts/ (always when Category E in scope)**

```bash
[ -d .rsct/scripts ] && rm -rf .rsct/scripts
```

**4.V.c — Conditionally remove audit / approvals state**

`.rsct/audit.log` removal is OPTIONAL per Phase 3 answer. Default is keep
(forensic value). Only delete if dev explicitly chose "delete".

```bash
[ "$AUDIT_LOG_CHOICE" = "delete" ] && [ -f .rsct/audit.log ] && rm -f .rsct/audit.log
```

`.rsct/approvals-seen.json` is always removed when Category E is in scope —
no dev question (internal state, no post-uninstall value).

```bash
[ -f .rsct/approvals-seen.json ] && rm -f .rsct/approvals-seen.json
```

`.rsct/phase-state.json` is always removed when Category E is in scope —
no dev question (M3 phase-machine internal state, no post-uninstall value).
Mirror of approvals-seen.json removal above (CAP-26). The advisory lock
file `.rsct/phase-state.lock` is also removed defensively in case a
prior phase-machine write crashed mid-flight and left a stale lock.

```bash
[ -f .rsct/phase-state.json ] && rm -f .rsct/phase-state.json
[ -f .rsct/phase-state.lock ] && rm -f .rsct/phase-state.lock
```

### 4.7 — Granular .rsct/ cleanup

Replaces the previous blunt `rm -rf .rsct`. After Phase 4.V has handled
the M2 artifacts, prune `.rsct/` only if there is nothing left worth
preserving:

```bash
if [ -d .rsct ]; then
  # Remove only when empty after the granular Phase 4.V passes above.
  # If the dev opted to keep audit.log, .rsct/ stays.
  # If any unknown (dev-added) files exist under .rsct/, .rsct/ stays.
  rmdir .rsct 2>/dev/null && echo "Removed empty .rsct/" \
    || echo ".rsct/ preserved (contains files the framework did not create or that dev chose to keep)"
fi
```

`rmdir` only succeeds when the directory is empty — this is the explicit
safety net against accidentally clobbering preserved state.

---

## Phase 5 — Review and commit

1. Show diff of all changes:
   ```bash
   git diff --stat
   git diff
   ```
2. List all files deleted, modified, with classifications applied.
3. Run leak review (same as 01-setup.md Phase 5.3) — uninstall removes content
   but the diff is still visible in git history; ensure nothing sensitive
   appears that the dev wouldn't want in a public commit.
4. Suggest commit message:
   ```
   chore: uninstall RSCT v1.0.0 [scope: full | custom — list items]
   ```
5. **Wait for updated OK** before `git add` / `commit` / `push`.

---

## Phase 6 — Final report

```
═══════════════════════════════════════════════════════
RSCT UNINSTALL — Done
═══════════════════════════════════════════════════════

Removed:
  - [count] CLAUDE.md sections
  - [count] documentation/ files
  - [count] memory entries
  - .rsct.json
  - .rsct/scripts/ (M2 sanitizer hook script)
  - .rsct/approvals-seen.json (M2 anti-reuse store)
  - .rsct/phase-state.json (M3 phase-machine state)
  - [.rsct/audit.log — only if dev chose "delete"]
  - .rsct/ (only if directory ended empty)
  - [N] SessionStart sanitizer hook entries from .claude/settings.json

Preserved (developer edits or explicit dev choice):
  - documentation/architecture.md (kept, marker stripped)
  - .rsct/audit.log (kept by default for forensic record)
  - .rsct/ (preserved — still contains non-framework files)
  - [list any others]

Not restored (no PT-BR backup chosen):
  - CLAUDE.md §A, §B (originally PT-BR, removed without restore)
    → To restore manually: git checkout [SETUP_COMMIT_SHA_BEFORE] -- CLAUDE.md

Skipped (Category E):
  - .claude/settings.json: SETTINGS_MALFORMED — manual fix required before re-uninstall.

Branch: chore/rsct-uninstall ready for review / merge.
═══════════════════════════════════════════════════════
```

---

## Idempotency note

Re-running this uninstall after a partial failure (e.g., script interrupted
between Phase 4.4 and 4.5):

1. Re-runs Phase 1 discovery — finds the remaining items
2. Items already removed in the previous attempt are classified as MISSING
3. Phase 2 builds a smaller plan from what's left
4. Phase 3 presents what's still pending
5. Continues from there

The marker-based approach means there is no shared state file to corrupt;
the project's own files are the source of truth.

---

## Manual uninstall fallback

If `.rsct.json` `install` block is missing (pre-1.0.0 install), point user to
this manual procedure:

1. Identify sections in CLAUDE.md by content matching with `rules/` files
2. Delete `documentation/` if it was created from RSCT templates (dev decision)
3. Delete `~/.claude/projects/<PROJECT_ENCODED>/memory/` if dev wants
4. Delete `.rsct.json` if present
5. Use `git log` to find any setup commit and revert if convenient

This is dev-driven; the framework cannot auto-restore without markers.
