# RSCT Init Universe — 04-init-universe.md
# Version: 2.0.0

You are operating to **bootstrap a new universe repository** for an organization.

A universe is a single-source-of-truth folder for: architecture diagrams,
governance documents (LGPD, DNS, naming, retention), and inventory of
applications and hosts. Once created, the universe is referenced by every
project of the organization via `/rsct-canonical-source`.

This prompt creates the skeleton — empty folders + template files with TODOs.
The developer fills the content over time as the organization grows. No diagrams
are auto-generated (they are binary `.drawio` files); placeholders document
which diagrams are expected.

Read this entire file before executing any action.

---

## Absolute rules during this entire session

- No `git commit`, `git push`, or other git mutation without explicit OK
  from the user for that specific action.
- Idempotent: if the target universe already exists, **never overwrite**
  existing files. Only add what is missing.
- When in doubt about anything: stop and ask.

---

## ⛔ Execution mandate — read before every code block

Same contract as `prompts/01-setup.md`'s execution mandate:

1. **Execute every fenced code block literally.** Do NOT translate to
   Node / Python / PowerShell / TS, do NOT consolidate multiple blocks
   into a single helper script. The `sed` pipelines below are the
   canonical writers of universe files; a re-implementation will diverge
   on EOL handling, regex escaping, or trailing-newline semantics.
2. **Do NOT reformat managed files.** When this prompt mutates a file
   that already exists, it uses `sed` or targeted substitution — never
   `JSON.parse → modify → JSON.stringify`.
3. **CHECKPOINT lines surface obedience.** Each mutating block opens
   with `echo "  CHECKPOINT: Phase X.Y executing canonical bash"`.
   Do NOT remove or alter these — the dev relies on them to know the
   canonical path ran instead of an ad-hoc re-implementation.
4. **If a block looks buggy, STOP and report it as a framework bug.**
   Do NOT patch it per-run by writing your own variant.

---

## Phase 1 — Silent discovery (no output yet, no mutations)

### 1.1 — Detect organization and target path

Try to infer the org from context (in order):

```bash
# (a) If invoked from inside a project with .rsct.json, read app.org
cat ./.rsct.json 2>/dev/null | grep -E '"org"' | sed -E 's/.*"org"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'

# (b) If inside a git repo, parse remote URL for the org slug
git config --get remote.origin.url 2>/dev/null \
  | sed -E 's|.*github.com[:/]([^/]+)/.*|\1|'

# (c) Otherwise: must ask the developer in Phase 2
```

Store as `ORG_SLUG`.

### 1.2 — Candidate target paths

The universe is conventionally located in one of:
```
~/projetos/<ORG_SLUG>-universe/
~/projects/<ORG_SLUG>-universe/
~/dev/<ORG_SLUG>-universe/
~/workspace/<ORG_SLUG>-universe/
```

For each candidate, check if it already exists:
```bash
for path in \
  "$HOME/projetos/${ORG_SLUG}-universe" \
  "$HOME/projects/${ORG_SLUG}-universe" \
  "$HOME/dev/${ORG_SLUG}-universe" \
  "$HOME/workspace/${ORG_SLUG}-universe"; do
  [ -d "$path" ] && echo "EXISTS: $path"
done
```

If any exists: this is **re-run / update mode** — we will add only what is missing.
If none exists: this is **fresh init mode** — we will create everything.

### 1.3 — Capture timestamp
```bash
CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "CREATED_AT=$CREATED_AT"
```

### 1.4 — Detect GitHub remote (optional)

```bash
# If invoked from inside a project, infer org's GitHub org from the project's remote
git config --get remote.origin.url 2>/dev/null \
  | sed -E 's|^git@github.com:([^/]+)/.*|https://github.com/\1/'"${ORG_SLUG}"'-universe|' \
  | sed -E 's|^https://github.com/([^/]+)/.*|https://github.com/\1/'"${ORG_SLUG}"'-universe|'
```

If detected: propose this as `GITHUB_REMOTE` (dev confirms in Phase 2).
If not detected: leave empty; dev can fill later.

### 1.5 — Verify universe-templates location

The framework templates live at one of:
- `~/.rsct/universe-templates/` — when the framework was installed via
  `scripts/install.sh` (the common case after `/rsct-init-universe` invokes
  this prompt)
- `<framework-source>/universe-templates/` — when running this prompt from
  a fresh clone before install

```bash
RSCT_HOME="$HOME/.rsct"
if [ -d "$RSCT_HOME/universe-templates" ]; then
  echo "Templates at: $RSCT_HOME/universe-templates/"
else
  echo "ERROR: $RSCT_HOME/universe-templates/ not found."
  echo "Either run scripts/install.sh from the framework source first,"
  echo "or ask the developer for the framework source path so this prompt"
  echo "can read templates from there."
fi
```

If the templates dir is not found at either location, abort and instruct the
developer to install the framework (`scripts/install.sh`) or provide the
source path manually.

---

## Phase 2 — Discovery report + single question block

Present to the developer:

```
═══════════════════════════════════════════════════════
RSCT INIT UNIVERSE — Discovery Report
Mode: [FRESH | UPDATE]
═══════════════════════════════════════════════════════

✅ Discovered automatically:
  Organization slug : [ORG_SLUG | NOT DETECTED]
  Target path       : [first candidate path that doesn't exist yet,
                       or path that exists for UPDATE]
  GitHub remote     : [URL inferred | NOT DETECTED]
  Created at        : [CREATED_AT]
  RSCT templates    : [found at $RSCT_HOME/universe-templates/]

❓ Could not discover — please answer:
  1. Organization slug? [if not detected]
  2. Target local path? [if multiple candidates or you prefer different location]
  3. GitHub remote URL for the universe? [optional, can skip]

──────────────────────────────────────────────────────
Plan:
  Target           → [PATH]
  Will create:
    CLAUDE.md, README.md, .universe.json, contracts.json
    docs/INDEX.md
    docs/governance/ (5 templates + retention-technical-annexes/)
    docs/diagrams/README.md (placeholders for .drawio files)
    applications/README.md
    hosts/README.md
  Will skip (already present): [list, if UPDATE mode]
  Git init        → [yes — initial commit | no — skip]
═══════════════════════════════════════════════════════

OK to proceed?
```

Wait for explicit OK and all answers before any mutation.

---

## Phase 3 — Execute (idempotent)

### 3.1 — Create directory structure

```bash
echo "  CHECKPOINT: Phase 3.1 executing canonical universe directory creation"
TARGET="$HOME/projetos/${ORG_SLUG}-universe"   # from Phase 2 confirmed value
mkdir -p "$TARGET"
mkdir -p "$TARGET/docs/governance/retention-technical-annexes"
mkdir -p "$TARGET/docs/diagrams"
mkdir -p "$TARGET/applications"
mkdir -p "$TARGET/hosts"
```

### 3.2 — Copy templates with placeholder substitution

For each file in `$RSCT_HOME/universe-templates/`, copy to its target path
**only if the target does not already exist** (idempotent).

Substitutions to apply (in order, in every file):
- `[ORG_SLUG]` → confirmed org slug
- `[CREATED_AT]` → ISO timestamp from Phase 1.3
- `[GITHUB_REMOTE]` → confirmed URL, or empty string if not provided

Mapping (template source → target path):

| Template (in `universe-templates/`) | Target (in `$TARGET/`) |
|---|---|
| `CLAUDE.md.template` | `CLAUDE.md` |
| `README.md.template` | `README.md` |
| `universe.json.template` | `.universe.json` |
| `contracts.json.template` | `contracts.json` |
| `docs/INDEX.md.template` | `docs/INDEX.md` |
| `docs/governance/document-control.md.template` | `docs/governance/document-control.md` |
| `docs/governance/canonical-sources-map.md.template` | `docs/governance/canonical-sources-map.md` |
| `docs/governance/dns-governance-survey.md.template` | `docs/governance/dns-governance-survey.md` |
| `docs/governance/lgpd-system-matrix.md.template` | `docs/governance/lgpd-system-matrix.md` |
| `docs/governance/naming-standards.md.template` | `docs/governance/naming-standards.md` |
| `docs/governance/retention-README.md.template` | `docs/governance/retention-technical-annexes/README.md` |
| `docs/diagrams/README.md.template` | `docs/diagrams/README.md` |
| `applications/README.md.template` | `applications/README.md` |
| `applications/_app.md.template` | `applications/_app.md.template` (kept as `.template` so devs use it) |
| `hosts/README.md.template` | `hosts/README.md` |
| `hosts/_host.md.template` | `hosts/_host.md.template` (kept as `.template`) |

For each target file:
```bash
echo "  CHECKPOINT: Phase 3.2 executing canonical template render (sed with | delimiter + CRLF normalize)"
if [ -f "$TARGET_FILE" ]; then
  echo "SKIP (exists): $TARGET_FILE"
else
  # All three substitution patterns use `|` as the sed delimiter so values
  # containing `/` (URLs, paths) do not collide with the sed pattern syntax.
  # `tr -d '\r'` normalizes Windows CRLF → LF before substitution so the
  # rendered file is consistent regardless of whether autocrlf converted
  # the template at git checkout time. Same defensive idiom as 01-setup.md
  # Phase 4.5 (CAP-10).
  tr -d '\r' < "$SOURCE_TEMPLATE" \
    | sed -E \
        -e "s|\[ORG_SLUG\]|${ORG_SLUG}|g" \
        -e "s|\[CREATED_AT\]|${CREATED_AT}|g" \
        -e "s|\[GITHUB_REMOTE\]|${GITHUB_REMOTE}|g" \
    > "$TARGET_FILE"
  echo "CREATED: $TARGET_FILE"
fi
```

### 3.3 — Optional: git init

If the user opted for git init in Phase 2:
```bash
echo "  CHECKPOINT: Phase 3.3 executing canonical git init in universe"
cd "$TARGET"
git init
git add .
# Do not commit yet — see Phase 4
```

---

## Phase 4 — Review and (optional) initial commit

1. List all files created (Category A) and skipped (Category B — already existed).
2. If `.git/` was initialized, show `git status`.
3. **Wait for explicit OK** before:
   - `git commit -m "chore: bootstrap [ORG_SLUG]-universe"`
   - `git remote add origin [GITHUB_REMOTE]` (if URL was provided)
   - Any push

Suggested commit message:
```
chore: bootstrap [ORG_SLUG]-universe

- Skeleton governance docs (templates with TODOs)
- Empty applications/ and hosts/ folders for inventory
- docs/diagrams/README.md listing expected .drawio files
```

---

## Phase 5 — Final report

```
═══════════════════════════════════════════════════════
RSCT INIT UNIVERSE — Done
═══════════════════════════════════════════════════════

Universe created at: [TARGET]

Next steps for the developer:
  1. Fill the governance documents over time. The most useful first:
       - docs/governance/naming-standards.md
       - docs/governance/document-control.md
  2. Add diagrams as .drawio files in docs/diagrams/.
  3. From any project of [ORG_SLUG]:
       /rsct-canonical-source
     This wires the project's CLAUDE.md to this universe.
  4. To register an application:
       cp applications/_app.md.template applications/<app-name>.md
     and fill in the placeholders. (Or just re-run /rsct-setup in the app —
     it offers, consent-gated, to register the app into this universe.)
  5. Declare cross-repo contracts in contracts.json (created empty above).
     A contract is a SURFACE one app PUBLISHES that others consume — in
     multi-repo mode the gate then blocks a producer commit that breaks it.
     Edit it by hand (see its _help) or, once ≥2 apps are registered,
     re-run /rsct-setup from an app: it offers a guided flow to declare them.
═══════════════════════════════════════════════════════
```
