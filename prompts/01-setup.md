# RSCT Setup — 01-setup.md

You are operating inside a software project repository.
Your task: apply or update the RSCT governance protocol.

Read this entire file before executing any action.
Also read all files in `rules/` from this repository before starting.

---

## Absolute rules during this entire session

- No `git commit`, `git push`, `git merge`, deploy or release without explicit OK
  from the user for that specific action.
- No code editing without a plan approved by the user (§B).
- When in doubt about anything: stop and ask.

---

## ⛔ Execution mandate — read before every code block

Every fenced code block in this prompt — whether labelled `bash` or
`node` — is the **canonical writer** of the file or state it touches.
The contract is strict and the framework's correctness depends on it:

1. **Execute literally.** Do **NOT** translate the block into another
   language (Node, Python, PowerShell, TypeScript, …) "for efficiency"
   or "because I'm faster at it". The framework's idempotency, marker
   hashes, EOL behavior, and re-run semantics depend on the **exact**
   pipeline shown. A re-implementation in another language **WILL**
   diverge on at least one of: trailing-newline handling, CRLF
   normalization, JSON whitespace, regex escaping, subshell variable
   scope. Every dogfood-cycle defect this framework has shipped a fix
   for (CAP-9 through CAP-14) was caused by exactly that kind of
   divergence — once at write time, then again at re-run.

2. **Do NOT consolidate.** Do **NOT** wrap multiple Phase blocks into
   a single helper script (a `setup.js`, an `rsct-apply.sh`, etc.).
   Each block is meant to run in its own context, with the variables
   captured by Phase 1, and to leave its own audit trail in the dev's
   terminal so the dev can see what happened step-by-step.

3. **Do NOT reformat managed files.** When a code block updates an
   existing JSON / YAML / Markdown file, the block uses `sed`,
   `grep`, or targeted text substitution — NOT
   `JSON.parse(...) → modify → JSON.stringify(..., null, 2)`. A full
   re-serialization destroys whitespace and ordering customizations the
   dev may have added between setup runs. The **only** exception in
   this prompt is the `.claude/settings.json` hook install / scrub
   (Phase 4.V.c and `03-uninstall.md` 4.V.a-uninstall), which **must**
   merge into a structured shape and where the reformat is unavoidable
   — those blocks are explicitly marked **`EXCEPTION: structured merge required`**.

4. **Reach for an external script and you bypass the prompt.** If
   while reading a Phase you find yourself thinking "I'll write a
   quick Node script to do this more cleanly" — that is the failure
   mode this prompt was designed to prevent. The bash here was chosen
   for cross-OS portability (Git Bash / Linux / macOS), audit
   reproducibility (every line surfaces in the user's terminal), and
   prompt-level enforceability (the framework can read the block
   itself in a future audit pass). An external script bypasses all
   three.

5. **CHECKPOINT lines are how the dev sees you obeyed.** Each Phase
   block starts with a `echo "  CHECKPOINT: Phase X.Y executing canonical bash"`
   line. Do NOT remove it, do NOT suppress its output, do NOT echo a
   different message. If the dev does not see the CHECKPOINT, the
   dev has to assume the prompt was bypassed and audit the diff
   manually.

If a code block in this prompt looks like it has a bug, **stop and
ask** — do not "fix it" by reimplementing. A real bug in a canonical
block is a framework bug and needs to be fixed at the prompt source,
not patched per-run.

---

## Phase 0 — universe≠app guard (must run FIRST, before any discovery)

`/rsct-setup` configures **applications**. If THIS repository is a **universe**
(a governance repo — it carries a `.universe.json` at its root), setup must **not**
run here. Run this block before anything else:

```bash
echo "  CHECKPOINT: Phase 0 executing canonical universe-vs-app guard"
# Anchor to the REPO ROOT, never $PWD: on WSL-from-Windows the shell cwd can be
# C:\Windows, so a bare relative `.universe.json` test could false-NEGATIVE (the
# dangerous direction — it would let setup run inside a universe). `git rev-parse`
# is the robust anchor; `pwd` is the fallback for a not-yet-git-init'd universe.
GUARD_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -f "$GUARD_ROOT/.universe.json" ]; then
  echo "RSCT-UNIVERSE-REPO-DETECTED"
  echo "This repository is a UNIVERSE (governance repo), not an application."
  echo "/rsct-setup configures APPS. Here you edit the universe files"
  echo "(.universe.json, contracts.json, docs/governance/) and commit them yourself."
  echo "To refresh just the universe markers/skeleton, use /rsct-init-universe (update mode)."
fi
```

**STOP rule (mechanical, read carefully).** If the block above printed
`RSCT-UNIVERSE-REPO-DETECTED`, **STOP the entire `/rsct-setup` run right now** —
do **not** read or execute any further Phase, and do **not** mutate anything.
Report the redirect message to the user and end. A bash `exit` would only end
*that one block* (every code block here runs in its own context — see the
Execution mandate), so the halt is **this instruction to you**, not a shell exit.
Belt-and-suspenders: Phase 1.9b independently re-checks via
`rsct_detect_onboarding` (`recommended_route: "guard-universe-repo"`) and applies
the same STOP, so the guard holds even if this file's `.universe.json` were edited.

---

## Phase 1 — Silent discovery (no output yet, no mutations)

Run all steps silently. Collect all findings before presenting anything.

### 1.0 — Capture pre-setup state (critical for uninstall)
```bash
SETUP_COMMIT_SHA_BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "INITIAL")
echo "SETUP_COMMIT_SHA_BEFORE=$SETUP_COMMIT_SHA_BEFORE"
```
**Store this value — used in Phase 4.4 to populate `.rsct.json` `install` block.**
This SHA is what `03-uninstall.md` uses to restore pre-setup state of any
file mutated by setup (notably CLAUDE.md PT-BR sections).

### 1.1 — Project identity
```bash
git config --get remote.origin.url
```
Extract: organization slug, app name. Store as `APP_NAME` and `ORG_SLUG`.

Check in order until found:
- `pom.xml` → `<artifactId>` and `<groupId>` (Java/Maven)
- `build.gradle` / `build.gradle.kts` → `rootProject.name` or `group` (Java/Kotlin/Gradle)
- `package.json` → `name` (Node/JS/TS)
- `Cargo.toml` → `[package].name` (Rust)
- `go.mod` → `module <path>` (Go)
- `pyproject.toml` → `[project].name` or `[tool.poetry].name` (Python modern)
- `setup.py` → `name=` argument (Python legacy)
- `Gemfile` → `app_name` from .gemspec, or working dir name (Ruby)
- `composer.json` → `name` (PHP)
- `*.csproj` / `*.sln` → file name (without extension) (.NET)
- `README.md` → first H1 (fallback for any stack)

### 1.2 — Technology stack

Detect by file presence (first match per stack family; multiple matches → fullstack/polyglot):

| Marker file | Stack | What to extract |
|---|---|---|
| `pom.xml` | Java + Maven | `<java.version>`, key Spring/Jakarta deps |
| `build.gradle` / `build.gradle.kts` | Java/Kotlin + Gradle | `sourceCompatibility`, plugins, deps |
| `package.json` | Node/JS/TS | `engines.node`, framework (React/Vue/Next/Express/NestJS) |
| `Cargo.toml` | Rust | `edition`, key deps (axum, tokio, actix, rocket) |
| `go.mod` | Go | Go version, key deps (gin, echo, chi, fiber) |
| `pyproject.toml` | Python (modern) | `requires-python`, framework (django, fastapi, flask) |
| `setup.py` / `requirements.txt` | Python (legacy) | same as above from requirements |
| `manage.py` | Django specifically | Django version |
| `Gemfile` | Ruby | Ruby version, framework (rails, sinatra, hanami) |
| `composer.json` | PHP | PHP version, framework (laravel, symfony, slim) |
| `*.csproj` / `*.sln` | .NET | `<TargetFramework>`, key NuGet packages |

**Multi-stack:** if two or more markers found (e.g., `pom.xml` + `package.json`),
record as fullstack with both stacks.

**Fallback:** if no marker matched, record what files exist in the root and
ask developer to confirm stack in Phase 3.

### 1.3 — Test framework

Run only the probes that match the stack detected in 1.2.

```bash
# JVM (Maven + Gradle)
grep -E "junit|testcontainers|mockito|assertj|spock|kotest" \
  pom.xml build.gradle build.gradle.kts 2>/dev/null | head -5
ls src/test 2>/dev/null | head -3

# Node / JS / TS
grep -E "jest|vitest|cypress|playwright|mocha|chai|jasmine|ava" \
  package.json 2>/dev/null | head -5
find . -maxdepth 4 \( -name "*.spec.ts" -o -name "*.test.ts" \
  -o -name "*.spec.js" -o -name "*.test.js" \) 2>/dev/null | head -3

# Rust
grep -E "rstest|proptest|mockito|insta|tokio-test|criterion" \
  Cargo.toml 2>/dev/null | head -5
find . -maxdepth 4 -path "*/tests/*.rs" 2>/dev/null | head -3

# Go
grep -E "testify|ginkgo|gomega|mockery|gomock" \
  go.mod go.sum 2>/dev/null | head -5
find . -maxdepth 4 -name "*_test.go" 2>/dev/null | head -3

# Python
grep -E "pytest|unittest|tox|nose|behave|hypothesis" \
  pyproject.toml requirements.txt setup.py 2>/dev/null | head -5
find . -maxdepth 4 \( -name "test_*.py" -o -name "*_test.py" \) 2>/dev/null | head -3

# Ruby
grep -E "rspec|minitest|cucumber|capybara|factory_bot" \
  Gemfile Gemfile.lock 2>/dev/null | head -5
find . -maxdepth 4 \( -name "*_spec.rb" -o -name "*_test.rb" \) 2>/dev/null | head -3

# PHP
grep -E "phpunit|pest|codeception|behat|mockery" \
  composer.json 2>/dev/null | head -5
find . -maxdepth 4 -name "*Test.php" 2>/dev/null | head -3

# .NET
grep -E "xunit|nunit|MSTest|FluentAssertions|Moq|NSubstitute" \
  *.csproj 2>/dev/null | head -5
find . -maxdepth 4 -name "*Tests.csproj" 2>/dev/null | head -3
```

Store as `TEST_FRAMEWORK` — concise human-readable label, e.g.:
- "JUnit 5 + Testcontainers" (Java)
- "Vitest + Playwright" (Node)
- "cargo test + rstest" (Rust)
- "go test + testify" (Go)
- "pytest" (Python)
- "RSpec + Capybara" (Ruby)
- "PHPUnit + Pest" (PHP)
- "xUnit + Moq" (.NET)
- OR "none detected" if no probes matched

### 1.4 — Protected branches

Detect canonical protected branches present on remote AND always include
the four safety defaults so future branches with those names are protected
on creation, not after the first accident.

```bash
# Step A — detect canonical names present on the remote
DETECTED=$(git branch -r 2>/dev/null \
  | grep -oE "(main|master|test|staging|prod|dev)" \
  | sort -u | tr '\n' ' ')
echo "DETECTED_PROTECTED=$DETECTED"

# Step B — always-on safety baseline. Closes M2 gate Finding #5:
# even if a project only has `main` today, protect `master`, `test`,
# and `dev` too — so a future `git checkout -b master` is gated by §D
# automatically, instead of being unprotected because `.rsct.json`
# replaced the lib's default with the detected subset.
DEFAULT_SAFETY="main master test dev"

# Step C — union, deduplicated, deterministic order (safety first)
PROTECTED_BRANCHES=$(printf '%s %s' "$DEFAULT_SAFETY" "$DETECTED" \
  | tr ' ' '\n' | awk 'NF' | awk '!seen[$0]++' | tr '\n' ' ' \
  | sed 's/ *$//')
echo "PROTECTED_BRANCHES=$PROTECTED_BRANCHES"

# Step D — HEAD branch (informational; written to .rsct.json if M3
# adds a head_branch field)
git remote show origin 2>/dev/null | grep "HEAD branch"
```

Store as `PROTECTED_BRANCHES` (e.g., `main master test dev` even for a
fresh repo that only has `main`). This list is what gets written to
`.rsct.json` `protected_branches[]` in Phase 4.4.

**Why the always-on baseline:** the previous version of this step wrote only
the detected subset. Result: a project with only `main` today got
`.rsct.json` `protected_branches: ["main"]` — and if a `master` branch was
later created (e.g., from a contributor's legacy fork or a rename), it
would be unprotected because `.rsct.json` REPLACES the lib's default. The
union closes that gap without taking away the dev's ability to override.

### 1.5 — Current CLAUDE.md state
```bash
cat CLAUDE.md 2>/dev/null || echo "FILE_NOT_FOUND"
```

If exists, search for each rule using BOTH English (current standard) AND
Portuguese (legacy — projects configured with previous prompt versions).
Mark each rule as: `present-en` | `present-ptbr` | `missing`

| Rule | English keywords | Portuguese keywords (legacy) |
|------|-----------------|------------------------------|
| §A | "bug mode" OR "sequential tutor" | "Modo Bug" OR "tutor sequencial" |
| §B | "mandatory plan" OR "2 options" | "Plano obrigatório" OR "2 opções" |
| §C | "does not reuse" OR "updated OK" | "não se reusa" OR "OK atualizado" |
| §D | "protected branches" | "Branches protegidas" |
| §E | "sensitive info" OR "secrets leak" | "info sensível" OR "paths locais" |
| §F | "state reversibility" OR "reverse flow" | "IDA/VOLTA" OR "fluxo de volta" |
| §G | "QA planner" OR "testing — integrated" | "orientado a testes" OR "modo QA" |
| §H | "ADR auto-learning" OR "decisions.md" | "auto-aprendizado" |

Also read `<!-- RSCT_VERSION: X.X.X -->` if present.
Also search for any existing RSCT markers (`<!-- RSCT-§X-BEGIN -->`) — their
presence indicates this project was already set up by RSCT v1.0.0+.

### 1.6 — Existing documentation structure
```bash
ls documentation/ 2>/dev/null || echo "NOT_FOUND"
ls documentation/modules/ 2>/dev/null || echo "NOT_FOUND"
ls documentation/impact/ 2>/dev/null || echo "NOT_FOUND"
```
Identify unpaired modules/impact (file in one folder without matching name in the other).
For any existing file in `documentation/`, also check for the
`<!-- RSCT-GENERATED -->` header marker.

### 1.7 — Existing memory entries and encoded path

Claude Code stores per-project memory in `~/.claude/projects/<PROJECT_ENCODED>/memory/`.
The encoding rule (verified on Windows and Linux): on Windows the **native**
path is used (e.g., `C:\Users\...`), the drive letter is lowercased, and any
of `\ / : . space` is replaced by `-`. On Linux/macOS the POSIX path is used
with the same dash substitution (no drive letter handling needed).

```bash
PROJECT_PATH=$(pwd)
OS_NAME=$(uname -s 2>/dev/null || echo "")

if echo "$OS_NAME" | grep -qiE "MINGW|MSYS|CYGWIN"; then
  # Windows via Git Bash / MSYS / Cygwin — convert POSIX path to native form
  NATIVE_PATH=$(pwd -W 2>/dev/null \
    || cygpath -w "$PROJECT_PATH" 2>/dev/null \
    || echo "$PROJECT_PATH")
  # Lowercase the leading char (drive letter), keep the rest as-is
  FIRST=$(printf '%s' "$NATIVE_PATH" | cut -c1 | tr 'A-Z' 'a-z')
  REST=$(printf '%s' "$NATIVE_PATH" | cut -c2-)
  # Replace path separators, colon, dot, space with single -
  PROJECT_ENCODED=$(printf '%s%s' "$FIRST" "$REST" \
    | sed -E 's#[\\/:.[:space:]]#-#g')
else
  # Linux / macOS
  PROJECT_ENCODED=$(printf '%s' "$PROJECT_PATH" \
    | sed -E 's#[/:.[:space:]]#-#g')
fi

echo "PROJECT_ENCODED (computed)=$PROJECT_ENCODED"

# Verify expected memory dir; if the computed encoding does not exist on disk,
# resolve it from an existing dir before falling back to a fresh CREATE.
MEMORY_DIR="$HOME/.claude/projects/$PROJECT_ENCODED/memory"
if [ -d "$MEMORY_DIR" ]; then
  echo "MEMORY_DIR=$MEMORY_DIR (FOUND)"
  ls "$MEMORY_DIR"
else
  echo "MEMORY_DIR=$MEMORY_DIR (NOT FOUND — checking for an existing encoded dir first)"
  BASENAME=$(basename "$PROJECT_PATH")
  # B2 (field-report): on WSL2-from-Windows the project root is a driveless UNC
  # path (//wsl.localhost/Ubuntu/...). The encoding above may not reproduce the
  # exact dir name Claude Code created (`pwd -W` / `cygpath -w` behavior on a UNC
  # root is not guaranteed across Git Bash versions), which would silently make
  # setup write memory to a brand-new dir while the real one sits beside it.
  # Resolve from disk when the match is UNAMBIGUOUS: exactly one projects/ entry
  # whose name contains the basename AND already has a memory/ subdir. Zero or
  # many matches → keep the computed value and defer the choice to Phase 3
  # (never write to two encoded dirs).
  #
  # Matching uses a case-folded `case` glob (tr + case), NOT `grep -iF`: the
  # GNU grep 3.0 bundled with Git Bash SIGABRTs ("Aborted — core dumped",
  # rc=134) on the `-i`+`-F` flag combination regardless of input (verified on
  # MINGW64 grep 3.0). The previous `ls | grep -iF` diagnostic crashed on every
  # Windows run — silently, since it was the tail of the block. tr/case is POSIX
  # and crash-free on all three OSes; the `for ... */` glob with a `[ -d ]` guard
  # is null-safe when projects/ is empty.
  BASENAME_LC=$(printf '%s' "$BASENAME" | tr 'A-Z' 'a-z')
  FUZZY_UNIQUE=""
  FUZZY_COUNT=0
  if [ -d "$HOME/.claude/projects" ]; then
    for CAND_DIR in "$HOME/.claude/projects/"*/; do
      [ -d "$CAND_DIR" ] || continue
      CAND=$(basename "$CAND_DIR")
      CAND_LC=$(printf '%s' "$CAND" | tr 'A-Z' 'a-z')
      case "$CAND_LC" in
        *"$BASENAME_LC"*)
          [ -d "$HOME/.claude/projects/$CAND/memory" ] || continue
          FUZZY_UNIQUE="$CAND"
          FUZZY_COUNT=$((FUZZY_COUNT + 1))
          ;;
      esac
    done
  fi

  if [ "$FUZZY_COUNT" -eq 1 ]; then
    PROJECT_ENCODED="$FUZZY_UNIQUE"
    MEMORY_DIR="$HOME/.claude/projects/$PROJECT_ENCODED/memory"
    echo "  Resolved PROJECT_ENCODED from existing on-disk dir (unique match): $PROJECT_ENCODED"
    ls "$MEMORY_DIR"
  elif [ "$FUZZY_COUNT" -gt 1 ]; then
    echo "  ⚠ AMBIGUOUS — more than one existing dir with a memory/ subdir contains basename '$BASENAME':"
    for CAND_DIR in "$HOME/.claude/projects/"*/; do
      [ -d "$CAND_DIR" ] || continue
      CAND=$(basename "$CAND_DIR")
      CAND_LC=$(printf '%s' "$CAND" | tr 'A-Z' 'a-z')
      case "$CAND_LC" in
        *"$BASENAME_LC"*) [ -d "$HOME/.claude/projects/$CAND/memory" ] && echo "      $CAND" ;;
      esac
    done
    echo "  Present these in Phase 3 and ask which is canonical for this machine;"
    echo "  keeping computed PROJECT_ENCODED=$PROJECT_ENCODED until confirmed."
  else
    echo "  No existing memory dir matches — PROJECT_ENCODED=$PROJECT_ENCODED will be created in Phase 4.6."
  fi
fi

echo "PROJECT_ENCODED=$PROJECT_ENCODED   # <- effective value; reuse this exact string in Phase 4.6"
```

**Store the final printed `PROJECT_ENCODED` value (the `effective value` line,
which reflects any fuzzy resolution above) — reuse it verbatim in Phase 4.6.**

If the fallback fuzzy match finds an entry with a different encoded form than
what was computed (e.g., older Claude Code version used a different rule),
present both to the developer in Phase 3 and ask which is canonical for this
machine — never write to two encoded dirs.

### 1.8 — Sensitive variables (for §E)

Run the universal probe first, then language-specific probes for the stack
detected in 1.2.

```bash
# Universal — .env.example exists in projects of any language
cat .env.example 2>/dev/null | grep -E "^[A-Z_]+=?" | head -30

# Java/Spring (application*.properties / application*.yml in resources)
# Uses ERE (-E) — POSIX-portable across GNU (Git Bash / Linux) and BSD (macOS).
# BSD grep silently fails to alternate on the GNU `\|` BRE extension —
# CAP-21 audit (sibling of CAP-17 AUDIT-C in Phase 4.2) caught this same
# pattern surviving in Phase 1.8.
grep -rhE "spring.datasource|jwt.secret|api.key|password|secret|token" \
  src/main/resources/ 2>/dev/null | grep -v "^#" | head -20

# .NET (appsettings*.json)
grep -hE "ConnectionStrings|Secret|Key|Password|Token" \
  appsettings*.json 2>/dev/null | head -20

# Node (common config locations)
grep -rhE "password|secret|token|api[_.]key" \
  config/*.json config/*.js src/config/ 2>/dev/null | grep -v "^#" | head -20

# Python (settings.py / config.py / .env / Django/Flask conventions)
grep -E "SECRET_KEY|DATABASE_URL|API_KEY|PASSWORD|TOKEN" \
  settings.py config.py .env app/config.py 2>/dev/null | head -20

# Ruby (Rails conventions)
grep -E "secret_key_base|password|api_key|token" \
  config/secrets.yml config/database.yml config/credentials.yml.enc \
  2>/dev/null | head -20

# PHP (Laravel/Symfony conventions)
grep -E "APP_KEY|DB_PASSWORD|JWT_SECRET|API_KEY" \
  .env config/*.php 2>/dev/null | head -20

# Rust / Go — typically only .env (already covered) and config files
grep -E "password|secret|token|api[_.]key" \
  config.toml config.yaml configs/*.yaml 2>/dev/null | grep -v "^#" | head -20
```

Aggregate findings into a deduplicated list of sensitive variable names
(e.g., `DB_PASSWORD`, `JWT_SECRET`). Save the list as `SENSITIVE_VARS`
(one var per line, deduplicated, uppercase canonical form when the
source uses snake_case) — it is consumed in TWO places:

**Selection criterion (field-report F3) — include ONLY actual secrets.** A
literal reading of the universal `^[A-Z_]+=` probe would dump dozens of
non-secret config keys into `secrets_extra_patterns[]` (and they would
re-derive inconsistently across runs — see the F1 convergence note). Keep a
name only if it denotes a credential: match (case-insensitive) any of
`secret | password | passwd | pwd | token | api[_-]?key | apikey |
access[_-]?key | private | credential | cert | dsn | auth | bearer | salt |
signing` in the name, **or** a name the dev explicitly flags. **Exclude**
obviously non-secret keys even though they are uppercase — `APP_NAME`,
`APP_ENV`, `APP_URL`, `APP_DEBUG`, `LOG_*`, `*_HOST`, `*_PORT`, `*_DRIVER`,
locale / pagination / feature flags, etc. When unsure about a name, ask the dev
rather than adding it.

1. **§E section of `CLAUDE.md`** (prose guidance to the AI: "never
   echo these var values").
2. **`.rsct.json` `secrets_extra_patterns[]`** (Phase 4.4, MED-16
   wiring). Each var name is converted to an assignment regex
   (`DB_PASSWORD\\s*=\\s*\\S+`, CAP-50) and unioned with whatever the
   dev already has in `.rsct.json` so `rsct_check_secrets` and
   `rsct_request_commit` catch the project-specific names that the
   universal regex in `lib/secrets.ts` would miss — without firing on a
   prose mention (`APP_KEY: a chave`) of the var name in docs.

### 1.9 — Universe local path
```bash
echo "  CHECKPOINT: Phase 1.9 executing canonical universe local-path probe"
: "${ORG_SLUG:=[value from step 1.1]}"   # AI substitutes from 1.1; tests pre-set it
# Strip a trailing -<digits> org suffix (e.g. "bluelt-23" → "bluelt"), mirroring
# 02-canonical-source.md Phase 1.1, so an org-suffixed slug still discovers the
# canonically-named universe (this is T1.d — Phase 1.9 previously probed only
# "${ORG_SLUG}-universe" and missed e.g. "bluelt-universe" for org "bluelt-23").
UNIVERSE_NAME=$(printf '%s' "$ORG_SLUG" | sed 's/-[0-9]*$//')
for candidate in \
  "../${UNIVERSE_NAME}-universe" \
  "../${ORG_SLUG}-universe" \
  "../universe" \
  "$HOME/projetos/${UNIVERSE_NAME}-universe" \
  "$HOME/projects/${UNIVERSE_NAME}-universe" \
  "$HOME/dev/${UNIVERSE_NAME}-universe" \
  "$HOME/workspace/${UNIVERSE_NAME}-universe" \
  "$HOME/projetos/${ORG_SLUG}-universe"; do
  # Require the `.universe.json` marker (not just a dir) — mirrors the MCP
  # `isUniverseDir`, so a same-named non-universe dir is not a false positive.
  [ -d "$candidate" ] && [ -f "$candidate/.universe.json" ] && echo "FOUND: $candidate" && break
done
```

The inferred `${UNIVERSE_NAME}-universe` is probed FIRST (the canonical name wins),
with `${ORG_SLUG}-universe` kept as a fallback for universes literally named with the
org suffix. If a universe is FOUND here but the project is not yet linked to it (see
Phase 1.10 / `canonical_source_added`), Phase 3 will OFFER to link it (T1.d).

### 1.9b — Onboarding situation (orchestrator brain, DX-1)

When `rsct-mcp` is installed, call `mcp__rsct__rsct_detect_onboarding` (pass
`project_root` **explicitly** — same Windows/WSL caveat as Phase 5 step 3). It is the
single deterministic classifier; store its `situation`, `recommended_route`,
`siblings`, and `hints`. It drives Phase 3 routing (the prompt narrates in plain
language; the tool's English `hints` are guidance for you, not user copy):

| `recommended_route` | Phase 3 action |
|---|---|
| `guard-universe-repo` | **STOP now** — same as Phase 0 (this is the MCP belt-and-suspenders). |
| `offer-create-universe` | Render the NEW 🌱 CREATE A UNIVERSE guided offer (siblings found, no universe). |
| `offer-link-existing` | Render the existing 🌌 UNIVERSE LINK offer. |
| `fix-universe-link` | Render the 🔧 UNIVERSE LINK BROKEN notice (do NOT register). |
| `none` (situation `offer-register`) | Nothing extra — Phase 4.8 self-guards registration. |
| `none` (situation `has-universe-linked` / `solo`) | Nothing extra (near-zero-config). |

When the detector ran, its `recommended_route` is the AUTHORITY for which universe
offer (if any) Phase 3 shows — it supersedes the Phase 1.9 bash probe for routing.

If `rsct-mcp` is **NOT** installed (typically the very first `/rsct-setup`, before the
IDE restart that loads the MCP), **SKIP this step**. The create-universe suggestion is
then honestly a **second-run** capability; Phase 5 step 8 prints an explicit pointer so
the dev knows to re-run after restarting. Do **NOT** hand-roll a bash sibling scan as a
fallback (it would reintroduce the cross-OS risk the detector exists to avoid). The
existing Phase 1.9 bash probe still feeds the 🌌 UNIVERSE LINK offer in this MCP-absent case.

### 1.10 — Existing `.rsct.json` + discrepancy detection

```bash
cat .rsct.json 2>/dev/null || echo "NOT_FOUND"
```

If `.rsct.json` exists, **extract every individual field** for
cross-reference against discovery values from Phases 1.1–1.9. Use
`grep`/`sed`/`jq` patterns suitable to your shell:

```bash
extract_json_string() {  # field path → value
  local field="$1"
  cat .rsct.json 2>/dev/null \
    | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | sed 's/.*: *"//; s/"$//'
}
extract_json_array() {   # field path → comma-list of contents
  local field="$1"
  cat .rsct.json 2>/dev/null \
    | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\[[^]]*\]" \
    | sed 's/.*\[//; s/\]//'
}

RSCT_JSON_APP_NAME=$(extract_json_string "name")
RSCT_JSON_APP_ORG=$(extract_json_string "org")
RSCT_JSON_TEST_FRAMEWORK=$(extract_json_string "test_framework")
RSCT_JSON_UNIVERSE_NAME=$(extract_json_string "name")  # universe.name
RSCT_JSON_UNIVERSE_LOCAL=$(extract_json_string "local")
RSCT_JSON_UNIVERSE_REMOTE=$(extract_json_string "remote")
RSCT_JSON_PROTECTED_BRANCHES=$(extract_json_array "protected_branches")
RSCT_JSON_INSTALL_SHA_BEFORE=$(extract_json_string "setup_commit_sha_before")
RSCT_JSON_CANONICAL_SOURCE_ADDED=$(extract_json_string "canonical_source_added")
# DX-1b ask-once: PRESENCE (not value) of install.create_universe_declined_at —
# robust to nesting + CRLF (literal-key match). Set => suppress the 🌱 create offer.
RSCT_CREATE_DECLINED=$(grep -q '"create_universe_declined_at"' .rsct.json 2>/dev/null && echo 1 || echo "")
```

**Build a DISCREPANCIES list** by comparing each extracted value to the
discovery result from previous phases:

| `.rsct.json` field | Compared against | Source | If differs |
|---|---|---|---|
| `protected_branches` | Phase 1.4 | `git branch -r` | RAISE Phase 3 question |
| `test_framework` | Phase 1.3 | dependency grep | RAISE Phase 3 question |
| `universe.local` | Phase 1.9 | filesystem scan | RAISE Phase 3 question |
| `universe.remote` | Phase 1.1 | git remote URL | RAISE Phase 3 question (rare) |
| `app.name` | Phase 1.1 | pom.xml / package.json | RAISE Phase 3 question |
| `app.org` | Phase 1.1 | git remote URL | RAISE Phase 3 question |

For each discrepancy, register:

```
DISCREPANCY: <field-name>
  in .rsct.json: <value or ABSENT>
  from discovery: <value or NOT_DETECTED>
  action_options:
    - update_to_discovery (use the freshly-detected value)
    - keep_rsct_json_value (preserve existing — explain in 1 line)
    - other (user-provided value)
```

**Do NOT silently preserve the existing value.** Phase 3 will surface
each discrepancy as a mandatory question before the OK-to-proceed
gate. Phase 4.4 applies the user's choice.

If `.rsct.json` contains an `install` block, the project was already
set up; **integrity fields** (see Phase 4.4) remain protected from
overwrite regardless of any discovered discrepancy. Only **config
fields** are subject to discrepancy resolution.

---

## Phase 2 — Determine mode

**UPDATE mode**: CLAUDE.md exists AND has at least one rule (`present-en` or `present-ptbr`).
→ Migrate `present-ptbr` rules to English (wrap result in RSCT markers).
→ Add `missing` rules (wrap in RSCT markers).
→ Never overwrite `present-en` content.

**CREATE mode**: CLAUDE.md does not exist OR has no RSCT rules.
→ Create everything from scratch (all sections wrapped in RSCT markers).

---

## Phase 3 — Discovery report + single question block

Present to the developer. Render the header version (`vX.Y.Z`) from the **release**
version in `$HOME/.rsct/VERSION` (CRLF-safe: `tr -d '\r' < "$HOME/.rsct/VERSION" | head -1`).
If that file is absent (prompt invoked directly without an install), fall back to the
discovered CLAUDE.md `RSCT_VERSION`, else omit the version:

```
═══════════════════════════════════════════════════════
RSCT SETUP — Discovery Report               v[RELEASE_VERSION]
Mode: [UPDATE | CREATE]
═══════════════════════════════════════════════════════

✅ Discovered automatically:
  App name             : [APP_NAME]
  Organization         : [ORG_SLUG]
  Stack                : [value]
  Test framework       : [TEST_FRAMEWORK | none detected]
  Protected branches   : [PROTECTED_BRANCHES]
  CLAUDE.md            : [exists v[VERSION] | not found]
  .rsct.json           : [exists | not found — will create]
    .app.name          : [value]      (discovery: [discovery-value])
    .app.org           : [value]      (discovery: [discovery-value])
    .protected_branches: [value]      (discovery: [discovery-value])  [⚠ if diverges]
    .test_framework    : [value]      (discovery: [discovery-value])  [⚠ if diverges]
    .universe.name     : [value]
    .universe.local    : [value]      (discovery: [discovery-value])  [⚠ if diverges]
    .universe.remote   : [value]
    .install block:
      .setup_commit_sha_before : [SHA]
      .applied_at              : [timestamp]
      .mode                    : [UPDATE | CREATE]
      .canonical_source_added  : [true/false]
  Universe locally     : [found at PATH | not found]
  Pre-setup SHA        : [SETUP_COMMIT_SHA_BEFORE]

  Rules status:
    §A Bug mode            : [✅ EN | 🔄 PT-BR→will migrate | ❌ missing]
    §B Mandatory plan      : [✅ EN | 🔄 PT-BR→will migrate | ❌ missing]
    §C Reauthorize         : [✅ EN | 🔄 PT-BR→will migrate | ❌ missing]
    §D Protected branches  : [✅ EN | 🔄 PT-BR→will migrate | ❌ missing]
    §E Secrets leak        : [✅ EN | 🔄 PT-BR→will migrate | ❌ missing]
    §F State reversibility : [✅ EN | 🔄 PT-BR→will migrate | ❌ missing]
    §G Testing             : [✅ EN | 🔄 PT-BR→will migrate | ❌ missing]
    §H ADR auto-learning   : [✅ EN | 🔄 PT-BR→will migrate | ❌ missing]

  Documentation:
    documentation/         : [exists | not found]
    documentation/modules/ : [N files | not found]
    documentation/impact/  : [N files | not found]
    Unpaired               : [list | none]

  Memory entries    : [list | none]
  Sensitive variables: [list | none]

❓ DISCREPANCIES DETECTED — answer required before OK-to-proceed:
  [for each DISCREPANCY built in Phase 1.10, present as numbered question
   with the 3 action_options (update_to_discovery, keep_rsct_json_value,
   other). Mark Recommended option per §B item 1 — usually
   update_to_discovery when discovery is more recent than .rsct.json,
   keep_rsct_json_value only when the discovery is from a transient
   state that should NOT propagate.]

  Example format:
  D1. protected_branches
      .rsct.json: ["main"]
      Discovery:  ["main", "test"]  (git origin)
      ✅ Recommended: update_to_discovery — reflects current git reality
                       and matches §D content "main and test"
      Alternatives:    keep_rsct_json_value — only if you want test
                       to be non-protected at config level

❓ Could not discover — please answer:
  [numbered list — only what was NOT found above and is not already
   in DISCREPANCIES]

🌌 UNIVERSE LINK (T1.d) — present ONLY when Phase 1.9 FOUND a universe AND this
  project is NOT yet linked to it (`.rsct.json` has no `universe.local`, i.e.
  `canonical_source_added` is false / the `universe` block is absent). Omit entirely
  when already linked or no universe was found.
  [Present as a Recommended (§B item 1) consent question:]
  "Universe `[UNIVERSE_NAME]-universe` found at `[PATH]`, but this project is not linked
   to it. Link it now? `[Y/n]`
   ✅ Recommended: yes — runs `/rsct-canonical-source` (adds the canonical-source
      section to CLAUDE.md + sets `universe.local` in `.rsct.json`), after which this
      app can be registered in the universe (Phase 4.8).
   Note: the universe is a SEPARATE repository. Here in the app I only edit `CLAUDE.md`
   and `.rsct.json`; any change to the universe stays in the universe repo and YOU review
   and commit it there yourself — RSCT never commits the universe."
  - On YES → after this setup applies its own mutations, invoke `/rsct-canonical-source`
    (it OWNS `universe.local` + `canonical_source_added` + the CLAUDE.md section — setup
    never writes them directly). Once `universe.local` is set, run Phase 4.8 to register
    the app (it reads `universe.local` fresh from `.rsct.json` at execution time).
  - On NO → proceed unlinked (no change); the dev can run `/rsct-canonical-source` later.

🌱 CREATE A UNIVERSE (DX-1) — present ONLY when Phase 1.9b returned
  `recommended_route: "offer-create-universe"` (≥1 same-org sibling app found at `../`
  and NO universe) AND `RSCT_CREATE_DECLINED` is empty. Omit when the MCP isn't installed,
  no confirmed sibling was found, or the dev already declined (DX-1b ask-once — Phase 1.10
  reads `install.create_universe_declined_at`; once declined, this offer stays quiet).
  [Present as ONE plain-language ORIENTATION prompt, Recommended (§B item 1):]
  "🌌 You have other apps from the same org (`[list the siblings.dir from the detector]`)
   with no central *universe*. A universe holds the governance and the *contracts* between
   those apps — it's what lets RSCT block a commit that breaks a contract another repo
   depends on. Set this up now? `[y/N]`
   ✅ Recommended: yes. With your OK at EACH step, I will:
     1) create the universe (`/rsct-init-universe`),
     2) link THIS app (`/rsct-canonical-source`),
     3) register this app in the universe (Phase 4.8).
   You edit the contract content and commit the universe repository yourself — RSCT never
   touches the universe's git. The contract gate only activates once a SECOND app is
   registered in this universe."
  - On NO → proceed unlinked (mono path), and RECORD the decline so the offer stays quiet on
    future runs (ask-once) — text-splice `install.create_universe_declined_at` into `.rsct.json`
    via the block below. **To set up a universe LATER**, delete that field from `.rsct.json`, or
    run `/rsct-init-universe` directly. (The offer never fires without same-org siblings AND no
    universe, so it stays quiet for solo/mono projects regardless.)

```bash
echo "  CHECKPOINT: Phase 3 recording create-universe decline (ask-once, text-splice)"
RSCT_JSON=".rsct.json"
DECLINED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ)
# Record the decline in install.create_universe_declined_at by TEXT-SPLICE — never
# JSON.parse->stringify the managed .rsct.json (CLAUDE.md #5). Path via argv; double-quoted
# JS only (no apostrophe can appear inside a single-quoted node -e); CRLF-tolerant char
# classes. The install block always exists in a managed .rsct.json; inject the key right
# after its "{", empty-object-guarded so we never emit a trailing comma before "}".
if [ -f "$RSCT_JSON" ] && ! grep -q '"create_universe_declined_at"' "$RSCT_JSON" 2>/dev/null; then
  node -e '
    var fs = require("fs");
    var f = process.argv[1], at = process.argv[2];
    var s;
    try { s = fs.readFileSync(f, "utf8"); } catch (e) { console.error("  WARN: .rsct.json unreadable — decline not recorded."); process.exit(0); }
    if (/"create_universe_declined_at"/.test(s)) { process.exit(0); }
    var m = s.match(/("install"[ \t\r\n]*:[ \t\r\n]*\{)([ \t\r\n]*)/);
    if (!m) { console.error("  WARN: install block not found — decline not recorded."); process.exit(0); }
    var at_pos = m.index + m[0].length;
    var sep = (s.charAt(at_pos) === "}") ? "" : ", ";
    var inject = "\"create_universe_declined_at\": \"" + at + "\"" + sep;
    s = s.slice(0, at_pos) + inject + s.slice(at_pos);
    fs.writeFileSync(f, s, "utf8");
    console.log("  recorded create-universe decline at " + at);
  ' "$RSCT_JSON" "$DECLINED_AT"
  if grep -q '"create_universe_declined_at"' "$RSCT_JSON" 2>/dev/null; then echo "  OK: decline recorded (ask-once)"; else echo "  ERROR: decline persistence failed" >&2; exit 1; fi
fi
```

  - On YES → run the GUIDED, STATEFUL chain. Each step is consent-gated AND re-probed
    before the next; a failure or a decline STOPS the chain cleanly (no half-built promise):
    a) Invoke `/rsct-init-universe`. Then VERIFY the universe exists, using the path
       `/rsct-init-universe` reports as `Universe created at:` (its final report) as
       `<universe-path>`: `[ -f "<universe-path>/.universe.json" ]`. If absent (init-universe aborted — e.g.
       missing templates — or its own OK was declined): **STOP here** and tell the dev
       "universe creation was cancelled or failed — run `/rsct-setup` whenever you want; nothing was linked."
    b) Invoke `/rsct-canonical-source` (it OWNS `universe.local` + `canonical_source_added`
       + the CLAUDE.md section — setup never writes them directly). Then VERIFY linking:
       `.rsct.json` now has a non-empty `universe.local`. If not: **STOP** and report the app
       is not linked (the state is re-runnable; nothing else was promised).
    c) Run Phase 4.8 to register this app (it reads `universe.local` fresh from `.rsct.json`).
    Report FILESYSTEM-verified results ("created `applications/<app>/` and set `universe.local`;
    the MCP only reflects this after you restart the IDE") — do NOT claim what the MCP can't
    confirm this session (the restart is inevitable).

🔧 UNIVERSE LINK BROKEN (DX-1) — present ONLY when Phase 1.9b returned
  `recommended_route: "fix-universe-link"` (`.rsct.json` `universe.local` is set but the
  universe does not resolve there).
  "⚠️ Your `.rsct.json` points to a universe at `[universe.local_path]`, but it isn't there.
   Fix the path (`universe.local`) or run `/rsct-canonical-source` again. I will NOT register
   this app into a universe that doesn't exist."
  - Skip Phase 4.8 registration for this state (registering into a missing universe is a no-op
    that misleads the dev). No mutation; the dev fixes the path or re-links.

──────────────────────────────────────────────────────
Plan:
  CLAUDE.md      → migrate PT-BR: [list] | add missing: [list] | create from scratch
                   ALL inserted/migrated sections wrapped in RSCT markers
  .rsct.json     → [create | already exists — update install.applied_at]
  documentation/ → create: [list — each with RSCT-GENERATED header] | up to date
  memory/        → create: [list — each with RSCT-GENERATED header] | up to date
  Branch         → chore/sync-rsct-rules (from [current branch])
  Uninstall      → /rsct-uninstall can later reverse all of the above
═══════════════════════════════════════════════════════

OK to proceed?
```

Wait for explicit OK before any mutation.

---

## Phase 4 — Execution

**Template locations:** all templates referenced in this phase live at:
- `~/.rsct/doc-templates/` (after install via `scripts/install.sh`)
  or `<framework-source>/doc-templates/` (when running from a source clone)
- `~/.rsct/memory-templates/` (same fallback rule)
- `~/.rsct/rules/` (same fallback rule — for §A–§H content)

When this prompt references `doc-templates/...`, `memory-templates/...`, or
`rules/...`, resolve those paths from the RSCT install root, **not from the
project's working directory**.

### 4.1 — Create branch
```bash
echo "  CHECKPOINT: Phase 4.1 executing canonical branch creation"
git checkout -b chore/sync-rsct-rules
```
Exception: if user explicitly authorized working directly on protected branch.

Note: `SETUP_COMMIT_SHA_BEFORE` was already captured in Phase 1.0; do not
re-capture here (HEAD may have moved if the user committed something between
discovery and execution; we want the pre-discovery state).

### 4.2 — CLAUDE.md — UPDATE mode

**Step A — Migrate PT-BR sections to English (wrapped in RSCT markers)**

> **D1 (field-report) — confirm before discarding project-specific content.**
> A `present-ptbr` section is the dev's ORIGINAL CLAUDE.md prose, not a
> framework-generated block: it has no RSCT marker and no SHA, so unlike the
> `documentation/` and memory classifiers (Phases 4.5 / 4.6, which PRESERVE
> dev-edited files by SHA) there is **no automatic protection here**. Replacing
> such a section wholesale silently discards any project-specific rule the dev
> wrote into it. The migration must therefore be **consented, not silent** — the
> dev should opt into a destructive replacement deliberately.

For each rule marked `present-ptbr`:
1. Locate the entire section in CLAUDE.md (from its header to the next `##` or `---`).
2. **Compare** the existing section against the canonical `rules/X-*.md`
   content, and classify:
   - **Equivalent** — the PT-BR section is just a translation / restatement of
     the canonical rule, with no extra project-specific clauses. Migration is
     non-destructive → proceed to step 3 (replace).
   - **Diverges** — the section carries project-specific rules, exceptions,
     examples, or thresholds NOT present in the canonical `rules/` file.
     **STOP and ask the dev.** Show a focused diff (what would be dropped vs
     what replaces it) and offer: **(a)** replace with the canonical rule (the
     project-specific text stays recoverable via git — see below); **(b)** keep
     the dev's section body as-is, only wrapping it in markers with
     `source=migrated-from-ptbr-preserved`; or **(c)** hand-merge the canonical
     rule into the dev's section. **Default to NOT replacing** until the dev
     chooses.
3. Replace (or, per 2b, wrap-only) the section, **wrapped in markers**:
   ```
   <!-- RSCT-§X-BEGIN v=1.0.0 source=migrated-from-ptbr -->
   <content from rules/X-*.md>
   <!-- RSCT-§X-END -->
   ```
4. Log which sections were migrated, preserved (2b), or hand-merged (2c).

The pre-migration PT-BR content is recoverable via
`git checkout $SETUP_COMMIT_SHA_BEFORE -- CLAUDE.md` — that is the only
backup mechanism. Do not create separate backup files.

Migration map:
| PT-BR header | Replace with |
|---|---|
| `Bootstrap de sessão` OR `Inicialização de sessão` OR `Entry point` | `rules/0-session-bootstrap.md` |
| `Modo Bug` OR `tutor sequencial` | `rules/A-bug-mode.md` |
| `Plano obrigatório` | `rules/B-architect-plan.md` |
| `Autorização explícita` OR `não se reusa` | `rules/C-reauthorize.md` |
| `Branches protegidas` | `rules/D-branch-protection.md` |
| `Revisão obrigatória` OR `info sensível` | `rules/E-secrets-leak.md` |
| `IDA/VOLTA` OR `Fluxos de operação` | `rules/F-state-reversibility.md` |
| `Orientação a testes` OR `orientado a testes` | `rules/G-testing.md` |
| `Auto-aprendizado` | `rules/H-adr-learning.md` |

**Step B — Add missing rules (wrapped in RSCT markers)**

For each rule marked `missing`, append the content of the corresponding `rules/`
file, **wrapped in markers**:
```
<!-- RSCT-§X-BEGIN v=1.0.0 source=inserted -->
<content from rules/X-*.md>
<!-- RSCT-§X-END -->
```

Insertion order when creating new sections:
```
§0 → section 1   (Session bootstrap — rsct-mcp entry point; MUST be the first
                  rule-marker section, BEFORE §B; placed AFTER section 0
                  "Canonical architectural source" if present)
§B → section 2   (Plan before editing code)
§A → section 2.1 (Bug mode — directly under §B)
§C → section 3.1 (Explicit authorization)
§D → section 3.2 (Protected branches)
§E → section 3.3 (Secrets and sensitive info)
§F → section 3.4 (State reversibility)
§G → section 4   (Testing)
§H → section 5   (ADR auto-learning)
```

§0 is **required** when `rsct-mcp` is installed (the typical case for
new projects starting from v0.6.4+). When `rsct-mcp` is NOT installed,
§0 still ships in CLAUDE.md but Claude falls back to the §A–§H prose
because none of the `mcp__rsct__*` calls referenced in §0 are
available. The §0 rule explicitly documents this fallback at its end.

**Step C — Inject discovered values into inserted/migrated sections**

> **Removed as of v0.7.3 (no-op for years).** Earlier versions of this
> prompt asked Claude to substitute three placeholders here
> (`[TEST_FRAMEWORK_PLACEHOLDER]` in §G, `[PROTECTED_BRANCHES_PLACEHOLDER]`
> in §D, "Project-specific variables" subsection in §E). All three
> were removed from the canonical `rules/` files in earlier sweeps —
> the prose instruction had no concrete placeholder to substitute and
> was dead code. If a legacy install is observed to still carry one
> of these placeholders in `CLAUDE.md`, treat it as a known
> pre-v0.7.0 artefact and leave the cleanup to a future targeted
> migration prompt rather than substituting in setup.

**Step D — Update version header (canonical bash, UPDATE mode)**

The two-line version header at the top of `CLAUDE.md` is the canonical
identification block for the framework install. v0.7.3 turns this
step from prose into an executable bash block — the prior prose
("Add or update at the very top of CLAUDE.md ...") let the reading
agent invent its own `sed` and got it wrong at least once (`\|` inside
an ERE pattern was interpreted as alternation, matching adjacent
`RSCT_UNIVERSE` lines that share the ` | updated: ` shape — CAP-17
incident, 2026-06-08).

```bash
echo "  CHECKPOINT: Phase 4.2 Step D executing canonical RSCT_APP header date update"
APPLIED_AT_DATE="$(date -u '+%Y-%m-%d')"
CLAUDE_MD="$(pwd)/CLAUDE.md"

# UPDATE mode (header already present): rotate ONLY the date on the
# existing `RSCT_APP: ${APP_NAME}` line.
#
# Sed delimiter is `#` so the literal `|` inside the marker shape
# (`RSCT_APP: foo | updated: ...`) needs no escape and cannot be
# misread as ERE alternation. The literal `|` in the pattern is
# expressed as `[|]` (character class) — POSIX-pure, no need for
# `\|` (which is a GNU/BSD extension with conflicting semantics).
# Whitespace is `[[:space:]]+` so dev whitespace edits do not break
# the match.
#
# The pattern anchors on `RSCT_APP:[[:space:]]+${APP_NAME}` — it
# will NEVER match `RSCT_UNIVERSE` (managed by 02-canonical-source.md)
# or `RSCT_VERSION` (literal "1.0.0", no date).
#
# CAP-50: the grep GUARDS use BRE `[[:space:]][[:space:]]*` (POSIX one-or-more),
# NOT `[[:space:]]\+`. BRE `\+` is a GNU extension; BSD grep (macOS) treats it
# as a literal `+`, so the guard silently failed to match and the sed rotation
# was skipped on macOS (anti-pattern #2). The literal `|` in the marker must
# stay BRE-literal, so `-E` is not an option here — hence the explicit
# `[[:space:]][[:space:]]*` instead of `[[:space:]]+`.
if grep -q "<!-- RSCT_APP:[[:space:]][[:space:]]*${APP_NAME}[[:space:]][[:space:]]*|[[:space:]][[:space:]]*updated:" "$CLAUDE_MD"; then
  # F2 (field-report): skip the rewrite when the date is ALREADY today. An
  # unconditional `sed -i` rewrites the file even on a no-op match, and on a
  # Windows checkout with core.autocrlf=true that flips CRLF->LF on disk —
  # surfacing a phantom 'modified' file with an empty content diff that pollutes
  # review and risks an accidental EOL-flip commit via `git add -A`.
  if grep -q "RSCT_APP:[[:space:]][[:space:]]*${APP_NAME}[[:space:]][[:space:]]*|[[:space:]][[:space:]]*updated:[[:space:]][[:space:]]*${APPLIED_AT_DATE}" "$CLAUDE_MD"; then
    echo "  RSCT_APP header date already ${APPLIED_AT_DATE} — no rewrite needed"
  else
    case "$(uname -s)" in
      Darwin)
        sed -i '' -E "s#(<!-- RSCT_APP:[[:space:]]+${APP_NAME}[[:space:]]+[|][[:space:]]+updated:[[:space:]]+)[0-9]{4}-[0-9]{2}-[0-9]{2}([[:space:]]+-->)#\\1${APPLIED_AT_DATE}\\2#" "$CLAUDE_MD"
        ;;
      *)
        sed -i -E "s#(<!-- RSCT_APP:[[:space:]]+${APP_NAME}[[:space:]]+[|][[:space:]]+updated:[[:space:]]+)[0-9]{4}-[0-9]{2}-[0-9]{2}([[:space:]]+-->)#\\1${APPLIED_AT_DATE}\\2#" "$CLAUDE_MD"
        ;;
    esac
    # Sanity: confirm the rotation landed on the RSCT_APP line ONLY.
    # Surface a vocal error if the line was not updated, OR if a sibling
    # marker (RSCT_UNIVERSE / RSCT_VERSION) was collaterally touched.
    if grep -q "RSCT_APP:[[:space:]][[:space:]]*${APP_NAME}[[:space:]][[:space:]]*|[[:space:]][[:space:]]*updated:[[:space:]][[:space:]]*${APPLIED_AT_DATE}" "$CLAUDE_MD"; then
      echo "  RSCT_APP header date rotated to ${APPLIED_AT_DATE}"
    else
      echo "  ⚠ ERROR: RSCT_APP header rotation did not land — inspect $CLAUDE_MD manually" >&2
      exit 1
    fi
  fi
else
  # CREATE-mode safety net: if RSCT_APP header is missing entirely,
  # the Phase 4.3 CREATE writer should have inserted it; surface
  # vocally instead of falling back to silent no-op.
  echo "  ⚠ RSCT_APP header missing — expected to be inserted by Phase 4.3 CREATE writer first; not adding here to avoid format ambiguity" >&2
fi
```

The two-line header shape itself is:

```
<!-- RSCT_VERSION: 1.0.0 -->
<!-- RSCT_APP: [APP_NAME] | updated: [YYYY-MM-DD] -->
```

In CREATE mode (no `CLAUDE.md` yet), Phase 4.3 writes this header
verbatim from `doc-templates/CLAUDE.md.template` (which carries
RSCT_VERSION as a literal and substitutes `[APP_NAME]` and `[YYYY-MM-DD]`).
In UPDATE mode, Phase 4.2 Step D rotates only the RSCT_APP **date**.
In BOTH modes, the `RSCT_VERSION` value is then (re)stamped to the
**release** version by the Phase 4.4 display-version stamp (the template's
literal `1.0.0` is the display default, not a fixed value) — distinct from
the `v=` marker schema id, which stays `1.0.0`.

**Step E — CONVENTIONS-REF pointer backfill (canonical bash, UPDATE mode)**

The `doc-templates/CLAUDE.md.template` ships a top-level
`<!-- RSCT-CONVENTIONS-REF -->` block pointing the agent at the project
`CONVENTIONS.md` (the prescriptive *how*, see Phase 4.7). A `CLAUDE.md`
installed before CAP-56 has no such pointer, and Phase 4.2's per-section
classifier never re-touches `present-en` content — so the reference would
stay orphaned on every UPDATE re-run (CAP-56 incident, 2026-06-13). This
step backfills the pointer once, idempotently, anchored on the RSCT_APP
header line (managed by Step D, reliably present in UPDATE mode).

The splice runs in **Node** (not sed/awk) so the multi-line block inserts
cleanly across GNU/BSD and the EOL of the existing file is detected and
preserved (CRLF tolerance — anti-pattern #4). The marker check makes it a
true no-op on a CLAUDE.md that already carries the pointer (CREATE installs
get it from the template, so this never double-inserts).

```bash
echo "  CHECKPOINT: Phase 4.2 Step E executing canonical CONVENTIONS-REF pointer backfill"
CLAUDE_MD="$(pwd)/CLAUDE.md"
node -e '
  var fs = require("fs");
  var p = process.argv[1];
  var txt = fs.readFileSync(p, "utf8");
  if (txt.indexOf("RSCT-CONVENTIONS-REF") !== -1) {
    console.log("  CONVENTIONS-REF pointer already present — no change");
    process.exit(0);
  }
  var nl = txt.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
  var block = [
    "",
    "<!-- RSCT-CONVENTIONS-REF v=1.0.0 -->",
    "> **Project conventions (`CONVENTIONS.md`).** If a `CONVENTIONS.md` file exists at",
    "> the project root, **consult it before writing new code** — it is this project",
    "> prescriptive *how* (naming, schema/migration patterns, identifier language, the",
    "> mold for a new module), distinct from `documentation/decisions.md` (the *why/when*).",
    "> See §B (plan) and §H (ADR/learning). If recurring conventions emerge and no file",
    "> exists yet, propose creating one (`/rsct-setup` can scaffold a skeleton).",
    "<!-- /RSCT-CONVENTIONS-REF -->",
  ].join(nl);
  var lines = txt.split(nl);
  var idx = -1;
  var i;
  for (i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("RSCT_APP:") !== -1) { idx = i; break; }
  }
  if (idx === -1) {
    for (i = 0; i < lines.length; i++) {
      if (/^#\s+CLAUDE\.md/.test(lines[i])) { idx = i; break; }
    }
  }
  if (idx === -1) {
    console.error("  ⚠ CONVENTIONS-REF backfill: no anchor (RSCT_APP / # CLAUDE.md heading) found — skipping");
    process.exit(0);
  }
  lines.splice(idx + 1, 0, block);
  fs.writeFileSync(p, lines.join(nl), "utf8");
  console.log("  CONVENTIONS-REF pointer backfilled after the header anchor");
' "$CLAUDE_MD"

# Post-mutation sanity (regra-mãe #3). Fixed-string grep (no -i/-F combo,
# anti-pattern #7) — the marker is present whether backfilled now or already
# there from the template.
if grep -q 'RSCT-CONVENTIONS-REF' "$CLAUDE_MD"; then
  echo "  CONVENTIONS-REF pointer present in CLAUDE.md ✓"
else
  echo "  ⚠ ERROR: CONVENTIONS-REF pointer missing after backfill — inspect $CLAUDE_MD manually" >&2
  exit 1
fi
```

### 4.3 — CLAUDE.md — CREATE mode

**Canonical bash — render template + insert RSCT_APP header line:**

```bash
echo "  CHECKPOINT: Phase 4.3 executing canonical CLAUDE.md CREATE writer"
TEMPLATE="$HOME/.rsct/doc-templates/CLAUDE.md.template"
CLAUDE_MD="$(pwd)/CLAUDE.md"
APPLIED_AT_DATE="$(date -u '+%Y-%m-%d')"

# Render template with placeholders substituted.
# `tr -d '\r'` normalizes CRLF → LF (mirror of CAP-10 SHA-pipeline fix).
# `#` delimiter avoids conflict with literal `|` in the RSCT_APP marker shape.
# CAP-23: substitute [APP_NAME] AND [CREATED_AT] uniformly (mirror of
# Phase 4.5/4.5b). Today only [APP_NAME] appears in CLAUDE.md.template
# body, but if the template ever ships a [CREATED_AT] placeholder the
# fix is already in place. Anti-regression grep below catches any new
# placeholder added to the template without wiring its substitution.
tr -d '\r' < "$TEMPLATE" \
  | sed -E -e "s#\[APP_NAME\]#${APP_NAME}#g" \
           -e "s#\[CREATED_AT\]#${APPLIED_AT_DATE}#g" \
  > "$CLAUDE_MD"
if grep -qE '\[(APP_NAME|CREATED_AT|ORG_SLUG|APPLIED_AT|MODE|SETUP_COMMIT_SHA_BEFORE|PROTECTED_BRANCHES_JSON_ARRAY|TEST_FRAMEWORK)\]' "$CLAUDE_MD"; then
  echo "  ⚠ ERROR: $CLAUDE_MD contains unsubstituted placeholder after CREATE — framework bug, inspect doc-templates/CLAUDE.md.template" >&2
  exit 1
fi

# Insert the per-install `RSCT_APP` header line right after the
# template's `RSCT_VERSION` line. The template intentionally does
# NOT carry this line because the date rotates per-run and Phase 4.2
# Step D rotates it in-place via canonical sed — keeping the template
# date-free keeps marker-SHA stability easy.
#
# POSIX awk: portable across GNU (Git Bash / Linux) and BSD (macOS).
# Tempfile + atomic mv survives mid-stream awk failure.
awk -v line="<!-- RSCT_APP: ${APP_NAME} | updated: ${APPLIED_AT_DATE} -->" \
  '{print} /^<!-- RSCT_VERSION:/{print line}' \
  "$CLAUDE_MD" > "${CLAUDE_MD}.tmp" && mv "${CLAUDE_MD}.tmp" "$CLAUDE_MD"

# Sanity: confirm the RSCT_APP line landed.
if grep -q "RSCT_APP: ${APP_NAME} | updated: ${APPLIED_AT_DATE}" "$CLAUDE_MD"; then
  echo "  CLAUDE.md created with RSCT_APP header date ${APPLIED_AT_DATE}"
else
  echo "  ⚠ ERROR: RSCT_APP header insertion failed — inspect $CLAUDE_MD manually" >&2
  exit 1
fi
```

After the header is in place, insert the rule sections into the
`[§X — content inserted here]` placeholders left by the template:

1. Insert all 9 rule sections (§0 + §A–§H) in order from `rules/` files
   (§0 first, then §A–§H). **Each inserted section wrapped in markers**:
   ```
   <!-- RSCT-§X-BEGIN v=1.0.0 source=inserted -->
   <content from rules/X-*.md>
   <!-- RSCT-§X-END -->
   ```
   For §0, the marker is `<!-- RSCT-§0-BEGIN ... -->` / `<!-- RSCT-§0-END -->`.
2. The CLAUDE.md `## 0. Canonical architectural source` placeholder block
   (lines 11–16 of the template) is left untouched — it is filled later
   by `/rsct-canonical-source` (`prompts/02-canonical-source.md`).

Phase 4.2 Step D will rotate the `updated:` date on every future
re-run; the header line itself is preserved as-is.

### 4.4 — Create or update `.rsct.json` (integrity vs config fields)

If `.rsct.json` not found: create from `doc-templates/rsct.json.template`,
substituting all `[APP_NAME]`, `[ORG_SLUG]`, etc. placeholders
with values from Phase 1 discovery and Phase 3 user answers.

If `.rsct.json` exists, fields are handled in **two categories**:

**Integrity fields — preserve always, even with user OK:**

| Field | Why preserved |
|---|---|
| `install.setup_commit_sha_before` | Overwriting destroys uninstall's ability to restore pre-setup state via `git checkout` |
| `install.canonical_source_added` | Managed only by `/rsct-canonical-source` (02-canonical-source.md) |
| `install.mode` | Reflects the original install type (CREATE vs UPDATE); never changes across re-runs |

The `install.applied_at` field is **rotated** to current UTC time on
every re-run (not preserved, not requiring user OK — it is intentionally
a timestamp of the most recent run).

**Config fields — updatable with explicit Phase 3 user OK:**

| Field | Discovery source | Resolved how |
|---|---|---|
| `app.name`, `app.org` | Phase 1.1 | DISCREPANCY question if diverges |
| `protected_branches` | Phase 1.4 | DISCREPANCY question if diverges |
| `test_framework` | Phase 1.3 | DISCREPANCY question if diverges |
| `universe.name`, `universe.local`, `universe.remote` | Phase 1.9 + 1.1 | DISCREPANCY question if diverges |

For each config field whose discrepancy was raised in Phase 3, **apply
the user's resolved answer here**. Do NOT fall back to "preserve
existing" silently — if no user answer was captured for a discrepancy,
that is a bug in Phase 3, not a license to skip.

**Universe block — OMIT when not configured.** If the dev's Phase 3
answer for universe was "no universe / leave placeholders" (or any
shape where `universe.name` is absent / empty), the rendered
`.rsct.json` MUST NOT contain a `universe` block at all. Writing
`"universe": { "name": "", "local": "", "remote": "" }` produces a
`bounds_violation` audit event on every subsequent MCP load because
the strict schema in `lib/project-root.ts` requires `min(1)` on those
fields. The block is `optional()` in the schema — omitting it is the
correct null state. `02-canonical-source.md` (the `/rsct-canonical-source`
command) is the path that adds the universe block later when the dev
adopts a universe.

**Anti-pattern (forbidden):** applying the rule "If exists: only add
missing keys — never overwrite existing values" blanket-style to
config fields. That conflates integrity protection with config
preservation and produces the bug class where an explicit dev OK gets
silently ignored.

**Populate the `install` block:**

| Field | Value source |
|---|---|
| `applied_at` | Current UTC time in ISO-8601, e.g., `2026-05-15T14:30:00Z` |
| `mode` | "UPDATE" or "CREATE" (from Phase 2) |
| `setup_commit_sha_before` | `SETUP_COMMIT_SHA_BEFORE` captured in Phase 1.0 |
| `canonical_source_added` | `false` — 02-canonical-source.md sets to `true` when run |

**Re-run protection:** if the `install` block already exists in `.rsct.json`
(meaning setup ran before), update `applied_at` only; preserve
`setup_commit_sha_before` and `canonical_source_added` from the prior run.
Overwriting `setup_commit_sha_before` would destroy the uninstall's ability
to restore pre-setup state.

Save the value of `applied_at` — it is reused as `[CREATED_AT]` in every
file marker created in Phases 4.5 and 4.6 (a single timestamp for the whole
setup run keeps things traceable).

> **Capture `APPLIED_AT` ONCE and thread it explicitly (field-report F4).**
> Compute it a single time here (e.g. `APPLIED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"`
> and `APPLIED_AT_DATE="$(date -u '+%Y-%m-%d')"`) and reuse the **literal** value
> in Phases 4.4 / 4.5 / 4.5b / 4.6 — do NOT call `date` again in a later phase.
> The host shell does **not** persist between separate tool calls (Claude Code's
> Bash tool starts a fresh shell each invocation), so a second `date` would
> diverge and a fresh CREATE spread across phases would stamp markers with
> different `created=` timestamps. (Re-runs are unaffected — SKIP/PRESERVE do not
> rewrite markers — but a first install can split across shells.) The same
> applies to every discovery var (`SENSITIVE_VARS`, `PROTECTED_BRANCHES`,
> `PROJECT_ENCODED`, …): re-declare or pass them forward; never assume the
> previous phase's shell variables are still set.

**Canonical bash — CREATE mode (render from template with sed substitutions):**

When `.rsct.json` does NOT exist (fresh project), render from
`doc-templates/rsct.json.template` via `sed` substitutions on every
placeholder. The template lives at `$HOME/.rsct/doc-templates/rsct.json.template`
when the framework was installed via `scripts/install.sh`. The
`PROTECTED_BRANCHES_JSON_ARRAY` placeholder is built from the
space-separated `PROTECTED_BRANCHES` captured in Phase 1.4.

```bash
echo "  CHECKPOINT: Phase 4.4 executing canonical .rsct.json CREATE render"
RSCT_JSON_TEMPLATE="$HOME/.rsct/doc-templates/rsct.json.template"
RSCT_JSON="$(pwd)/.rsct.json"

# Convert the space-separated PROTECTED_BRANCHES into a JSON array literal:
#   input  : "main master test dev"
#   output : ["main", "master", "test", "dev"]
#   empty  : []
# CAP-36 (field-report A1): the template placeholder is `[PROTECTED_BRANCHES_JSON_ARRAY]`
# with LITERAL brackets, and the sed below matches `\[PROTECTED_BRANCHES_JSON_ARRAY\]`
# — consuming those brackets. So the replacement must carry its own `[...]`,
# otherwise the render emits `"protected_branches": "main", "master",` (invalid
# JSON). We build the inner CSV first, then wrap once.
PROTECTED_JSON_INNER=$(printf '%s' "$PROTECTED_BRANCHES" \
  | tr ' ' '\n' | awk 'NF' \
  | sed 's/^.*$/"&"/' \
  | paste -sd, - \
  | sed 's/,/, /g')
PROTECTED_JSON="[${PROTECTED_JSON_INNER}]"

# Render with one sed per placeholder. Pipe delimiter (|) avoids collisions
# with URLs / paths that contain `/`. Quote every replacement to keep shells
# from re-tokenizing values that contain spaces.
sed -E \
  -e "s|\[APP_NAME\]|${APP_NAME}|g" \
  -e "s|\[ORG_SLUG\]|${ORG_SLUG}|g" \
  -e "s|\[TEST_FRAMEWORK\]|${TEST_FRAMEWORK}|g" \
  -e "s|\[APPLIED_AT\]|${APPLIED_AT}|g" \
  -e "s|\[MODE\]|${MODE}|g" \
  -e "s|\[SETUP_COMMIT_SHA_BEFORE\]|${SETUP_COMMIT_SHA_BEFORE}|g" \
  -e "s|\[PROTECTED_BRANCHES_JSON_ARRAY\]|${PROTECTED_JSON}|g" \
  "$RSCT_JSON_TEMPLATE" > "$RSCT_JSON"

# Sanity: confirm no placeholders left unsubstituted.
# Uses ERE (-E) — POSIX-portable across GNU (Git Bash / Linux) and BSD
# (macOS). The earlier BRE form (`grep -q '\[\(...\|...\)\]'`) relied on
# GNU's `\|` extension for alternation, which BSD grep in BRE mode does
# not support — caught by the v0.7.3 CAP-17 audit sweep (AUDIT-C).
if grep -qE '\[(APP_NAME|ORG_SLUG|TEST_FRAMEWORK|APPLIED_AT|MODE|SETUP_COMMIT_SHA_BEFORE|PROTECTED_BRANCHES_JSON_ARRAY)\]' "$RSCT_JSON"; then
  echo "  ERROR: one or more placeholders left unsubstituted in $RSCT_JSON — inspect manually" >&2
  exit 1
fi
# CAP-36 (field-report A1): the placeholder sweep above only proves no
# `[PLACEHOLDER]` token survived — it does NOT prove the render is valid JSON.
# A malformed `protected_branches` value (the exact A1 regression) passes the
# sweep but breaks every downstream JSON.parse. Validate structurally when a
# node runtime is available (rsct-mcp already requires one); skip silently on
# the rare host without node rather than block the install.
if command -v node >/dev/null 2>&1; then
  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$RSCT_JSON" 2>/dev/null; then
    echo "  ERROR: rendered $RSCT_JSON is not valid JSON — inspect manually" >&2
    exit 1
  fi
fi
echo "  .rsct.json created from template (protected_branches=${PROTECTED_BRANCHES})"
```

**Canonical bash — UPDATE mode `applied_at` rotation (in-place, preserves file formatting):**

This is the CANONICAL writer of `applied_at` on UPDATE re-runs. It uses
`sed` to swap **only** the value between the existing quotes, leaving
every other byte of `.rsct.json` (whitespace, key order, array shape,
optional fields) byte-stable. Do NOT use `JSON.parse → modify →
JSON.stringify` here — that would reformat the file and produce
spurious diffs.

```bash
echo "  CHECKPOINT: Phase 4.4 executing canonical in-place applied_at rotation"
RSCT_JSON="$(pwd)/.rsct.json"
APPLIED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# In-place edit; portable across GNU sed (Linux + Git Bash) and BSD sed (macOS).
# Pattern keys on the literal "applied_at" field and replaces only the value
# between quotes; touches no other character in the file.
case "$(uname -s)" in
  Darwin)
    sed -i '' -E "s|(\"applied_at\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"|\1\"${APPLIED_AT}\"|" "$RSCT_JSON"
    ;;
  *)
    sed -i -E "s|(\"applied_at\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"|\1\"${APPLIED_AT}\"|" "$RSCT_JSON"
    ;;
esac

# Sanity: confirm the field was found and updated.
if ! grep -q "\"applied_at\"[[:space:]]*:[[:space:]]*\"${APPLIED_AT}\"" "$RSCT_JSON"; then
  echo "  ERROR: applied_at rotation did not land in $RSCT_JSON — inspect manually" >&2
  exit 1
fi
echo "  applied_at rotated to ${APPLIED_AT}"
```

CREATE mode (.rsct.json absent) still renders from `doc-templates/rsct.json.template`
via straightforward placeholder substitution (`[APP_NAME]`, `[ORG_SLUG]`,
…) — that is a fresh write, no preservation concerns.

**Canonical bash — stamp the user-facing (release) version (runs in BOTH modes):**

The framework carries TWO version axes. The **display / release version** (this
step) is what the user sees — it should reflect the release the project was last
set up with (e.g. the current release), NOT the template's literal `1.0.0`. The **marker schema
id** (`v=1.0.0` on every `RSCT-…-BEGIN` / `RSCT-GENERATED` / gitignore marker, plus
`RSCT_TEMPLATE_VERSION`) is a STABLE idempotency key and is **never touched here**.

This step stamps the three display surfaces — `.rsct.json rsct_version`, the
CLAUDE.md `<!-- RSCT_VERSION: -->` marker, and the CLAUDE.md
`<!-- Generated by RSCT Framework v… -->` provenance line. By this point both files
exist regardless of mode (CLAUDE.md from Phase 4.2/4.3, `.rsct.json` just above), so
one unified step covers CREATE (overwrites the template literal) and UPDATE
(overwrites the prior value). Idempotent: re-running at the same release re-writes the
same value (no diff). Source = `$HOME/.rsct/VERSION` (written by `scripts/install.sh`);
CRLF-safe read + semver guard; if it is unreadable or non-numeric (e.g. the prompt was
invoked directly without an install) the stamp is **skipped** — never destructive.

```bash
echo "  CHECKPOINT: Phase 4.4 executing canonical display-version stamp"
RELEASE_VERSION=""
[ -f "$HOME/.rsct/VERSION" ] && RELEASE_VERSION="$(tr -d '\r' < "$HOME/.rsct/VERSION" | head -1)"
# Semver guard: accept only digits-and-dots; anything else (empty / garbage) → skip.
case "$RELEASE_VERSION" in ''|*[!0-9.]*) RELEASE_VERSION="" ;; esac

if [ -z "$RELEASE_VERSION" ]; then
  echo "  display-version stamp: no readable numeric \$HOME/.rsct/VERSION — leaving version fields as-is"
else
  RSCT_JSON="$(pwd)/.rsct.json"
  CLAUDE_MD="$(pwd)/CLAUDE.md"
  # In-place value swaps — mirror the applied_at idiom (portable GNU/BSD). Each sed
  # keys on a DISTINCT anchor, so it can never touch RSCT_APP / RSCT_UNIVERSE or any
  # `v=` marker (the markers use `v=`, an equals sign; these anchors do not).
  stamp_version() { # $1=sed-pattern  $2=file
    case "$(uname -s)" in
      Darwin) sed -i '' -E "$1" "$2" ;;
      *)      sed -i    -E "$1" "$2" ;;
    esac
  }

  # (a) .rsct.json — "rsct_version": "X" (quoted value swap, like applied_at)
  if [ -f "$RSCT_JSON" ]; then
    stamp_version "s|(\"rsct_version\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"|\1\"${RELEASE_VERSION}\"|" "$RSCT_JSON"
    if grep -q "\"rsct_version\"[[:space:]]*:[[:space:]]*\"${RELEASE_VERSION}\"" "$RSCT_JSON"; then
      echo "  .rsct.json rsct_version stamped → ${RELEASE_VERSION}"
    else
      echo "  ⚠ rsct_version stamp did not land in $RSCT_JSON — inspect manually" >&2
    fi
  fi

  # (b)+(c) CLAUDE.md — RSCT_VERSION marker + "Generated by RSCT Framework v…" line.
  # Each swaps only the numeric version token, leaving the rest of the line intact.
  if [ -f "$CLAUDE_MD" ]; then
    stamp_version "s|(<!-- RSCT_VERSION:[[:space:]]*)[0-9][0-9.]*|\1${RELEASE_VERSION}|" "$CLAUDE_MD"
    stamp_version "s|(Generated by RSCT Framework v)[0-9][0-9.]*|\1${RELEASE_VERSION}|" "$CLAUDE_MD"
    if grep -q "<!-- RSCT_VERSION:[[:space:]]*${RELEASE_VERSION}" "$CLAUDE_MD"; then
      echo "  CLAUDE.md RSCT_VERSION + Generated-by stamped → ${RELEASE_VERSION}"
    else
      echo "  ⚠ CLAUDE.md version stamp did not land — inspect $CLAUDE_MD manually" >&2
    fi
  fi
fi
```

**Populate `secrets_extra_patterns[]` from `SENSITIVE_VARS` (MED-16):**

For each entry in `SENSITIVE_VARS` (Phase 1.8), generate an assignment regex
`<VAR_NAME>\\s*=\\s*\\S+` (CAP-42 → CAP-50, field-report C1 + audit F5: the bare
word-boundary `\\b<VAR_NAME>\\b` matched the name in prose, and the CAP-42 `[=:]`
form still matched doc prose like `APP_KEY: a chave`; the `=`-only form is
unambiguous and matches the `.env`/`*.properties` files vars are discovered
from) and **union** with the current `secrets_extra_patterns[]` in `.rsct.json`
— never replacing dev-written regexes. Any legacy `\\b<VAR_NAME>\\b` or CAP-42
`<VAR_NAME>\\s*[=:]\\s*\\S+` this run would regenerate is migrated to the `=`
form so re-runs converge instead of accumulating.

**Canonical bash — text-based merge into `secrets_extra_patterns[]`
(does NOT round-trip through `JSON.parse → JSON.stringify`, so the
rest of `.rsct.json` keeps its formatting byte-for-byte):**

```bash
echo "  CHECKPOINT: Phase 4.4 executing canonical text-based secrets_extra_patterns merge"
node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const vars = process.argv.slice(2);
  // Build the backslash literally via char code — keeps the source
  // robust against the surrounding shells eating "\\b" → "\b". The
  // file ends up containing the JSON-escaped form "\\b" which
  // JSON.parse decodes to "\b" (word boundary) at consumer time.
  const BS = String.fromCharCode(92);
  const wb = BS + "b";

  let txt;
  try { txt = fs.readFileSync(path, "utf8"); }
  catch (e) { console.error("WARN: .rsct.json unreadable, skipping secrets_extra_patterns wiring."); process.exit(0); }

  // Locate the secrets_extra_patterns array as TEXT — never JSON.parse the
  // whole file (that would force a JSON.stringify round-trip on write,
  // reformatting every other field).
  //
  // Two-step match: (1) regex finds the "secrets_extra_patterns": [ opener,
  // (2) a bracket-balanced walk locates the matching closing ]. Step 2 is
  // necessary because a naive `[\s\S]*?\]` would stop at the first `]`
  // inside a string literal (e.g., a custom pattern like "[a-z]+" contains
  // a literal `]`).
  const openerRe = /("secrets_extra_patterns"[ \t]*:[ \t]*)\[/;
  const m = txt.match(openerRe);
  if (!m) {
    console.error("WARN: secrets_extra_patterns array not found in .rsct.json — leaving file untouched.");
    process.exit(0);
  }
  const prefix = m[1];
  const openIdx = m.index + m[0].length - 1; // index of the [

  // Bracket-balanced walk: skip over any [ ] inside string literals.
  let i = openIdx + 1;
  let depth = 1;
  let inString = false;
  let escape = false;
  while (i < txt.length && depth > 0) {
    const c = txt[i];
    if (escape) { escape = false; }
    else if (c === BS) { escape = true; }
    else if (c === "\"") { inString = !inString; }
    else if (!inString) {
      if (c === "[") depth++;
      else if (c === "]") depth--;
    }
    i++;
  }
  if (depth !== 0) {
    console.error("WARN: secrets_extra_patterns array unbalanced — leaving file untouched.");
    process.exit(0);
  }
  const closeIdx = i - 1;          // index of matching ]
  const inner = txt.slice(openIdx + 1, closeIdx);
  const matchEnd = closeIdx + 1;   // end index of the full "key":[...] match

  // Parse existing entries from the inner array text (string literals only).
  // Build the regex via new RegExp + string concat so the BS construction is
  // applied at runtime (a regex literal would be parsed at load time, before
  // the BS var exists).
  //
  // CAP-20 escape-level fix: the capture group returns the RAW bytes between
  // the quotes (e.g. for "\\bJWT\\b" in the file, sm[1] = "\\bJWT\\b" — 4-byte
  // escape: \, \, b, J, W, T, \, \, b). The comparator below works in
  // decoded-byte space (wb + v + wb = "\bJWT\b" — 2-byte escape: \, b, ...).
  // Pre-v0.7.5 the array stored sm[1] raw, so every known VAR mis-compared as
  // "new" on every UPDATE re-run; the subsequent JSON.stringify(p) then
  // re-escaped each entry, doubling backslashes on disk into the corrupted
  // form "\\\\bJWT\\\\b" (which decodes to "\\bJWT\\b" — literal backslash +
  // "b", NOT a word boundary). Result: array grew 8 → 16 → 24 entries with
  // half corrupted, and the secret classifier silently stopped matching.
  // Cure: JSON-decode each string body on read so existing[] always holds raw
  // decoded bytes; write path then re-escapes uniformly via JSON.stringify().
  const strRe = new RegExp(
    "\"((?:[^\"" + BS + BS + "]|" + BS + BS + ".)*)\"",
    "g"
  );
  function decodeJsonStringBody(s) {
    try { return JSON.parse("\"" + s + "\""); }
    catch (e) { return s; }  // malformed body — leave raw; cure detector below will not match it
  }
  const decoded = [];
  let sm;
  while ((sm = strRe.exec(inner)) !== null) decoded.push(decodeJsonStringBody(sm[1]));

  // Cure entries left corrupted by the pre-v0.7.5 bug. In decoded-byte form a
  // corrupted entry is exactly "\\b<WORD>\\b" (3 bytes \,\,b at each end);
  // a correct one is "\b<WORD>\b" (2 bytes \,b at each end). The detector
  // only drops entries matching the EXACT corrupted shape with word-name
  // body — any custom dev-written pattern (e.g. "^[a-z]+$", "\.json",
  // "\bCUSTOM\b" word-boundary) is preserved verbatim.
  const CORRUPT_PREFIX = BS + BS + "b";  // 3 bytes: \, \, b
  let curedCount = 0;
  const existing = decoded.filter(p => {
    const isCorrupt = p.length >= 7 &&
      p.substring(0, 3) === CORRUPT_PREFIX &&
      p.substring(p.length - 3) === CORRUPT_PREFIX &&
      /^[A-Za-z0-9_]+$/.test(p.substring(3, p.length - 3));
    if (isCorrupt) curedCount++;
    return !isCorrupt;
  });

  // CAP-42 → CAP-50 → CAP-51 (field-report C1 + audit F5 + field-report F1):
  // generate an ASSIGNMENT regex `<VAR>\s*=\s*\S+`. History — the original bare
  // `\b<VAR>\b` matched the variable NAME anywhere (even prose), tripping INV-6
  // on the §E security note that merely LISTS the vars; the CAP-42 `[=:]` still
  // matched doc prose like "APP_KEY: a chave" (`:` is ambiguous — YAML
  // assignment vs a doc label); CAP-50 narrowed to `=` only (unambiguous, and
  // `.env`/`*.properties`/shell — the files SENSITIVE_VARS is discovered from —
  // use `=`). Real secret VALUES in `:`/YAML are still caught by lib/secrets.ts
  // value-shape (sk-, AKIA, PEM) + generic key-name patterns. Backslashes via
  // BS (String.fromCharCode(92)) so the shells do not eat `\s`/`\S` (#4 / CAP-20).
  //
  // CAP-51 (field-report F1): migrate legacy entries to the `=` form BY SHAPE,
  // independent of the SENSITIVE_VARS for this run. The pre-CAP-51 code migrated only
  // the vars rediscovered THIS run, so an entry whose var was not re-derived
  // (lives in .rsct.json but not re-scanned this run) stayed in its old
  // `[=:]`/bare shape forever and the array never converged. `legacyVarOf`
  // detects the two framework-GENERATED shapes — `\b<WORD>\b` (pre-CAP-42) and
  // `<WORD>\s*[=:]\s*\S+` (CAP-42), WORD = [A-Za-z0-9_]+ — and returns the var
  // name to rewrite to the canonical `=` form. Dev-written regexes (`^custom.*$`,
  // `\.env`, …) match neither shape and are preserved verbatim. A future
  // canonical change is just one more clause in `legacyVarOf` (scalability).
  const ATTR = BS + "s*=" + BS + "s*" + BS + "S+";           // \s*=\s*\S+ (canonical)
  const CAP42_SUFFIX = BS + "s*[=:]" + BS + "s*" + BS + "S+"; // \s*[=:]\s*\S+ (legacy shape)
  const isWord = (s) => s.length > 0 && /^[A-Za-z0-9_]+$/.test(s);
  const legacyVarOf = (p) => {
    if (p.startsWith(wb) && p.endsWith(wb)) {                 // \bWORD\b
      const w = p.slice(wb.length, p.length - wb.length);
      if (isWord(w)) return w;
    }
    if (p.endsWith(CAP42_SUFFIX)) {                           // WORD\s*[=:]\s*\S+
      const w = p.slice(0, p.length - CAP42_SUFFIX.length);
      if (isWord(w)) return w;
    }
    return null;
  };

  const result = [];
  const seen = new Set();
  let migrated = 0;
  for (const p of existing) {              // migrate every legacy SHAPE, then dedup
    const w = legacyVarOf(p);
    const neu = w !== null ? w + ATTR : p;
    if (neu !== p) migrated++;
    if (!seen.has(neu)) { seen.add(neu); result.push(neu); }
  }
  const added = [];
  for (const v of vars) {                  // union the SENSITIVE_VARS for this run
    if (!v || /[^A-Za-z0-9_]/.test(v)) continue;  // skip names with regex-unsafe chars
    const re = v + ATTR;
    if (!seen.has(re)) { seen.add(re); result.push(re); added.push(re); }
  }
  if (added.length === 0 && curedCount === 0 && migrated === 0) {
    console.log("  secrets_extra_patterns already converged — no-op");
    process.exit(0);
  }

  // Re-render the array preserving the format style observed in `inner`.
  const isEmpty     = inner.trim() === "";
  const isMultiline = inner.includes("\n");
  let rendered;
  if (isMultiline || isEmpty) {
    // Multi-line layout (preferred when adding entries): two-space indent.
    rendered = "[\n    " +
      result.map(p => JSON.stringify(p)).join(",\n    ") +
      "\n  ]";
  } else {
    // Keep the single-line layout the dev had.
    rendered = "[" + result.map(p => JSON.stringify(p)).join(", ") + "]";
  }

  // Splice only the matched region; every byte outside the array is preserved.
  const before = txt.slice(0, m.index);
  const after  = txt.slice(matchEnd);
  fs.writeFileSync(path, before + prefix + rendered + after, "utf8");
  const parts = [];
  if (curedCount > 0) parts.push("cured " + curedCount + " corrupted entries (CAP-20)");
  if (migrated > 0) parts.push("migrated " + migrated + " legacy entries to the `=` assignment form by shape (CAP-51)");
  if (added.length > 0) parts.push("added " + added.length + " secrets_extra_patterns entries: " + added.join(", "));
  console.log("  " + parts.join("; "));
' "$(pwd)/.rsct.json" $SENSITIVE_VARS
```

Idempotency: re-running on a project where `secrets_extra_patterns[]`
already contains every generated regex prints `no-op` and does not
rewrite `.rsct.json`. Vars with regex-unsafe characters (anything
outside `A-Za-z0-9_`) are skipped — those should be added by the dev
manually with the escape they want.

CAP-20 backward compat: projects that ran pre-v0.7.5 setup on a
`.rsct.json` with populated `secrets_extra_patterns[]` accumulated
corrupted entries of shape `"\\\\b<WORD>\\\\b"` (literal backslash +
`b`, not a word boundary). v0.7.5+ auto-detects and drops those on
next setup run, logging `cured N corrupted entries (CAP-20)`. The
detector only matches the exact corrupted shape with a `[A-Za-z0-9_]+`
body — any dev-authored custom pattern is preserved verbatim.

**Why this block uses Node instead of pure `sed`:** the array element
boundaries inside a JSON `[...]` block aren't reliably matched by
POSIX BRE (you would need to count quoted strings across whitespace).
Node here is **read+regex+text-splice only** — it never calls
`JSON.parse` on the whole file or `JSON.stringify` on the whole object.
The rest of `.rsct.json` keeps its formatting byte-for-byte.

**Why `String.fromCharCode(92)` instead of `"\\b"`:** when this snippet
is invoked via `bash -c '...'` or even single-quoted `node -e '...'`,
some shells (Git Bash on Windows, certain cygwin-on-msys configurations)
collapse `\\` to `\`. A bare `\b` inside a JS double-quoted string then
parses as a backspace control character (0x08), and the resulting JSON
file stores a real backspace instead of `\b`. Consumers reading the
file get `VAR` and never match anything. Building the
backslash from char code 92 keeps the source byte stream identical
across every shell.

### 4.4b — `.gitignore` patterns for plan tracking

Plan tracking files (`plan_<slug>.md` and `progress_<slug>.md`) are
**branch-local** by §B item 6 — they must never reach `main`/`test`.
`spec_<slug>.md` is treated as an **accepted alias of `plan_<slug>.md`**
(a dev may name the artefact "spec" instead of "plan"; same gitignore
rule, same NEVER-on-protected guarantee). The block also ignores the
RSCT runtime-state files and, root-anchored, the framework source clone
(`/rsct-framework/`) in case it is cloned INTO the project — a
team-safety rule so the clone never travels with the project repo.
Setup adds a marker-wrapped block to the project's `.gitignore` so
`/rsct-uninstall` can excise it cleanly later:

```bash
echo "  CHECKPOINT: Phase 4.4b executing canonical .gitignore RSCT block install"
GITIGNORE="$(pwd)/.gitignore"
BEGIN_MARKER="# RSCT-BEGIN v=1.0.0 source=01-setup.md/4.4b"
END_MARKER="# RSCT-END"
PATTERN_BLOCK=$(cat <<EOF

$BEGIN_MARKER
# RSCT plan tracking — branch-local files, NEVER track on main/test
# spec_*.md is an accepted alias of plan_*.md (same rule, same intent).
# Use \`git add --force plan_<slug>.md progress_<slug>.md\` (or spec_*) to
# commit on feature branches. Verify they are absent before any merge to
# main/test.
plan_*.md
progress_*.md
spec_*.md

# RSCT runtime state — local per-machine forensic + anti-replay store.
# These files are mutated by every \`mcp__rsct__rsct_request_commit/_push/_merge\`
# call. Tracking them means every commit produces a new diff on the very
# files that record the commit, an infinite loop. Each developer's clone
# keeps its own audit/anti-replay state.
.rsct/audit.log
.rsct/approvals-seen.json
.rsct/phase-state.json
.rsct/phase-state.lock

# RSCT framework source clone — if the framework repo is cloned INTO the
# project (a top-level "rsct-framework" dir) to invoke its prompts, ignore it
# so it never travels with the project repo. Root-anchored: a clone living
# elsewhere (e.g. under your home dir) is untouched.
/rsct-framework/
$END_MARKER
EOF
)

HAS_NEW_BLOCK="no"
HAS_LEGACY_BLOCK="no"
if [ -f "$GITIGNORE" ]; then
  grep -qF "$BEGIN_MARKER" "$GITIGNORE" 2>/dev/null && HAS_NEW_BLOCK="yes"
  # Legacy detection: pre-marker installs wrote the patterns without a
  # BEGIN/END pair. The plan_*.md line is the only stable marker we can
  # match safely.
  if [ "$HAS_NEW_BLOCK" = "no" ] && \
     grep -q "^plan_\*\.md" "$GITIGNORE" 2>/dev/null; then
    HAS_LEGACY_BLOCK="yes"
  fi
fi

if [ "$HAS_NEW_BLOCK" = "yes" ]; then
  # CAP-16 backfill: a pre-v0.7.0 RSCT block was idempotent ONLY on
  # BEGIN-marker presence — meaning new pattern lines added to the
  # canonical block (like spec_*.md in v0.7.0) never reached projects
  # set up before the new line shipped. The backfill below scans
  # individual pattern lines and inserts the ones missing, keeping
  # marker idempotency intact (BEGIN/END are not rewritten).
  if ! grep -qF "spec_*.md" "$GITIGNORE"; then
    # POSIX awk: append spec_*.md right after the first progress_*.md line.
    # Tempfile + mv keeps the operation atomic in case awk fails mid-stream.
    #
    # `tr -d '\r'` normalizes CRLF → LF before awk so the `/^progress_\*\.md$/`
    # match works on Windows projects with `core.autocrlf=true` (where
    # `.gitignore` lives as `progress_*.md\r\n` on disk and the awk `$`
    # anchor would otherwise refuse to match, silently leaving the
    # backfill as a no-op while still printing the "added" log line
    # — CAP-16 follow-up after v0.7.1 shipped without this).
    # The output is written in LF; `git autocrlf` re-applies CRLF on
    # the next checkout if the dev configured it that way.
    tr -d '\r' < "$GITIGNORE" \
      | awk '/^progress_\*\.md$/{print; print "spec_*.md"; next} 1' \
      > "${GITIGNORE}.tmp" && mv "${GITIGNORE}.tmp" "$GITIGNORE"

    # Sanity check: confirm the line landed; surface a vocal error if not
    # so a future CRLF-like edge case never falls back to silent no-op.
    if grep -qF "spec_*.md" "$GITIGNORE"; then
      echo "  CAP-16 backfill: added spec_*.md alias to existing RSCT .gitignore block"
    else
      echo "  ⚠ CAP-16 backfill: spec_*.md insertion did not land — inspect $GITIGNORE manually" >&2
    fi
  fi
  # CAP-25 backfill: pre-v0.7.7 RSCT blocks did not list .rsct/phase-state.json,
  # so the M3 phase machine (rsct_phase_*_start/_complete) was writing an
  # untracked file that appeared in `git status` on every run. Same backfill
  # idiom as CAP-16 / spec_*.md: append after .rsct/approvals-seen.json
  # (the last existing .rsct/ line in the canonical block) when missing.
  if ! grep -qF ".rsct/phase-state.json" "$GITIGNORE"; then
    tr -d '\r' < "$GITIGNORE" \
      | awk '/^\.rsct\/approvals-seen\.json$/{print; print ".rsct/phase-state.json"; next} 1' \
      > "${GITIGNORE}.tmp" && mv "${GITIGNORE}.tmp" "$GITIGNORE"

    if grep -qF ".rsct/phase-state.json" "$GITIGNORE"; then
      echo "  CAP-25 backfill: added .rsct/phase-state.json to existing RSCT .gitignore block"
    else
      echo "  ⚠ CAP-25 backfill: .rsct/phase-state.json insertion did not land — inspect $GITIGNORE manually" >&2
    fi
  fi
  # CAP-25 (extension): .rsct/phase-state.lock is the advisory lock the M3
  # writer uses to serialize writes to phase-state.json. Normally released
  # at the end of each write; if a process crashes mid-write, the stale
  # lock can persist briefly. Ignoring keeps `git status` clean even in
  # that crash-recovery window.
  if ! grep -qF ".rsct/phase-state.lock" "$GITIGNORE"; then
    tr -d '\r' < "$GITIGNORE" \
      | awk '/^\.rsct\/phase-state\.json$/{print; print ".rsct/phase-state.lock"; next} 1' \
      > "${GITIGNORE}.tmp" && mv "${GITIGNORE}.tmp" "$GITIGNORE"

    if grep -qF ".rsct/phase-state.lock" "$GITIGNORE"; then
      echo "  CAP-25 backfill: added .rsct/phase-state.lock to existing RSCT .gitignore block"
    else
      echo "  ⚠ CAP-25 backfill: .rsct/phase-state.lock insertion did not land — inspect $GITIGNORE manually" >&2
    fi
  fi
  # framework-clone backfill: pre-1.1.x RSCT blocks did not list /rsct-framework/
  # (the framework source clone, root-anchored). Deterministic team-safety rule —
  # a clone committed into the project repo would travel to the whole team. Same
  # backfill idiom as CAP-16/CAP-25: append after .rsct/phase-state.lock (the last
  # runtime-state line — guaranteed present because the CAP-25 lock clause just
  # ran) when missing, so existing installs ignore a top-level clone on re-run.
  if ! grep -qF "/rsct-framework/" "$GITIGNORE"; then
    tr -d '\r' < "$GITIGNORE" \
      | awk '/^\.rsct\/phase-state\.lock$/{print; print "/rsct-framework/"; next} 1' \
      > "${GITIGNORE}.tmp" && mv "${GITIGNORE}.tmp" "$GITIGNORE"

    if grep -qF "/rsct-framework/" "$GITIGNORE"; then
      echo "  backfill: added /rsct-framework/ (framework clone) to existing RSCT .gitignore block"
    else
      echo "  ⚠ backfill: /rsct-framework/ insertion did not land — inspect $GITIGNORE manually" >&2
    fi
  fi
elif [ "$HAS_LEGACY_BLOCK" = "yes" ]; then
  echo "  ⚠ .gitignore has a pre-marker plan-tracking block."
  echo "    /rsct-uninstall will NOT auto-remove it (no markers to scan)."
  echo "    Either delete those lines manually OR replace them with the"
  echo "    new marker-wrapped block (see 4.4b in prompts/01-setup.md)."
elif [ ! -f "$GITIGNORE" ]; then
  echo "$PATTERN_BLOCK" > "$GITIGNORE"
else
  echo "$PATTERN_BLOCK" >> "$GITIGNORE"
fi
```

Idempotency: re-running setup does NOT duplicate the block. The grep
checks for the `RSCT-BEGIN` line as marker. A pre-marker (legacy) block
is detected separately so the dev is warned but the new block is NOT
added on top — that would produce a duplicate patterns list.

**`.mcp.json` marker convention.** As of CAP-48, setup **does** edit
`.mcp.json` — but ONLY when the dev chose project scope at install time
(`$HOME/.rsct/mcp-scope` = `project`); see Phase 4.V.c2. The convention:
identify the rsct entry by its server name (`"rsct"` key under
`"mcpServers"`) — JSON does not accept inline comment markers, so the
entry name IS the marker. `/rsct-uninstall` scrubs by that key, never by
name pattern, preserving any other servers the dev added.

### 4.5 — Documentation structure

The framework owns a **closed set** of files under `documentation/`.
Everything outside that set is dev-custom and **NEVER touched** by
`/rsct-setup`: not CREATEd, not UPDATEd, not marker-backfilled, not
moved, not renamed, not reformatted. This is a hard architectural
contract — Phase 4.5 below is the only writer for canonical docs;
dev-custom paths flow through the OUT_OF_SCOPE branch and exit the
loop untouched.

The canonical list is enumerated explicitly in `CANONICAL_DOCS`
below. Adding or removing canonical files requires editing this
prompt (and the corresponding `doc-templates/` source). The dev-custom
detection branch scans `documentation/` for anything outside the
canonical set and reports them as `OUT_OF_SCOPE` with a vocal log
line; any attempt to include an OUT_OF_SCOPE path in the canonical
loop is a framework bug and exits the run.

**Portable SHA256 helper** (defined here, reused in Phase 4.5b and
Phase 4.6 and `03-uninstall.md`):

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
```

**Canonical bash — enumerate, classify, mutate canonical docs ONLY:**

```bash
echo "  CHECKPOINT: Phase 4.5 executing canonical documentation/* writer"
APPLIED_AT="${APPLIED_AT}"   # from Phase 4.4 (single timestamp for whole run)

# CANONICAL_DOCS: the closed list of files the framework owns under
# documentation/. Format: "target_relpath|template_relpath" pairs,
# one per line. Anything NOT in this list is dev-custom and protected
# from any mutation by the OUT_OF_SCOPE branch below.
CANONICAL_DOCS="\
documentation/README.md|documentation-index.md.template
documentation/architecture.md|architecture.md.template
documentation/decisions.md|decisions.md.template
documentation/setupdeveloper.md|setupdeveloper.md.template
documentation/impact/README.md|impact/README.md.template
documentation/tests/README.md|tests-readme.md.template
documentation/infrastructure.md|infrastructure.md.template"

CREATE_COUNT=0; UPDATE_COUNT=0; SKIP_COUNT=0; PRESERVE_COUNT=0

# IMPORTANT: process substitution (`done < <(...)`) instead of `| while`
# so the counter variables survive the loop body. A pipeline-`while`
# would run the body in a subshell and discard every `CREATE_COUNT++`,
# producing a misleading "all-zero" summary at the end (CAP-13 curou
# isso para Phase 4.6 additive-merge; CAP-19 herda o mesmo idiom).
while IFS='|' read -r TARGET_REL TEMPLATE_REL; do
  [ -z "$TARGET_REL" ] && continue
  TARGET="$(pwd)/${TARGET_REL}"
  TEMPLATE="$HOME/.rsct/doc-templates/${TEMPLATE_REL}"

  if [ ! -f "$TEMPLATE" ]; then
    echo "  ⚠ ${TARGET_REL}: TEMPLATE_MISSING (${TEMPLATE_REL}) — framework bug, inspect ~/.rsct/" >&2
    continue
  fi

  # Resolve template body: tail | tr -d \r | substitute placeholders.
  # CAP-23: substitute every framework-owned placeholder. Pre-v0.7.6 only
  # [APP_NAME] was resolved; [CREATED_AT] leaked verbatim into the body
  # of infrastructure.md and every knowledge file ("last_capture:
  # [CREATED_AT]"). Bug existed since template inception — affected
  # CREATE and UPDATE paths in every install ever. Now both placeholders
  # are substituted with the same -e chain (single sed invocation).
  #
  # CAP-35: preserve existing `last_capture: YYYY-MM-DD` from the TARGET
  # body across re-runs. Without preservation, every /rsct-setup
  # re-run produced a spurious UPDATE on files whose only "change" was
  # the date stamp being re-resolved to today (10 files / re-run in the
  # acme-api 2026-06-10 dogfood). The reader: if the TARGET
  # exists and contains a parseable `last_capture: YYYY-MM-DD` line,
  # use that as EFFECTIVE_CREATED_AT; otherwise fall back to
  # ${APPLIED_AT_DATE} (covers CREATE + the case where dev removed the
  # line or it's a non-date sentinel like `<TODO>`). Idempotency
  # restored — SHA only changes when real template content changes.
  EFFECTIVE_CREATED_AT="${APPLIED_AT_DATE}"
  if [ -f "$TARGET" ]; then
    EXISTING_LAST_CAPTURE=$(tr -d '\r' < "$TARGET" 2>/dev/null \
      | grep -E '^last_capture:[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]]*$' \
      | head -1 \
      | sed -E 's/^last_capture:[[:space:]]+([0-9]{4}-[0-9]{2}-[0-9]{2}).*$/\1/')
    if [ -n "$EXISTING_LAST_CAPTURE" ]; then
      EFFECTIVE_CREATED_AT="$EXISTING_LAST_CAPTURE"
    fi
  fi
  TEMPLATE_BODY=$(tail -n +2 "$TEMPLATE" | tr -d '\r' \
    | sed -e "s/\[APP_NAME\]/${APP_NAME}/g" \
          -e "s/\[CREATED_AT\]/${EFFECTIVE_CREATED_AT}/g")
  TEMPLATE_BODY_SHA=$(printf '%s\n' "$TEMPLATE_BODY" | sha256_compute)
  MARKER="<!-- RSCT-GENERATED v=1.0.0 created=${APPLIED_AT} sha256-body=${TEMPLATE_BODY_SHA} -->"

  if [ ! -f "$TARGET" ]; then
    # B1 (field-report): mkdir uses the RELATIVE dirname (TARGET_REL), not the
    # absolute $(pwd)-based TARGET. Under a UNC root (//wsl.localhost/... on
    # WSL2-from-Windows) an absolute `mkdir -p` walks from the read-only network
    # mount root and aborts with EROFS, silently skipping the create. The cwd is
    # the project root (every path here assumes that), so the relative form
    # creates only project-local dirs; the absolute write that follows still
    # works (MSYS maps it to the Windows backend — only mkdir is UNC-hostile).
    mkdir -p "$(dirname "$TARGET_REL")" || { echo "  ⚠ ERROR: cannot create directory for ${TARGET_REL}" >&2; exit 1; }
    { printf '%s\n' "$MARKER"; printf '%s\n' "$TEMPLATE_BODY"; } > "$TARGET" || { echo "  ⚠ ERROR: write failed for ${TARGET_REL}" >&2; exit 1; }
    # A2 (field-report): refuse to log/count CREATE for a file that never landed.
    # The placeholder grep below returns non-zero on a missing file, so without
    # this guard a failed write (e.g. the B1 mkdir EROFS) still printed CREATE
    # and bumped the counter — the summary reported CREATE for absent files.
    if [ ! -f "$TARGET" ]; then
      echo "  ⚠ ERROR: ${TARGET_REL} not created (write succeeded but file is absent) — aborting" >&2
      exit 1
    fi
    # CAP-23 anti-regression: fail loud if any framework placeholder
    # survived into the file body. New templates that add a placeholder
    # without wiring its substitution above will trip this check on
    # first CREATE instead of silently shipping leaked placeholders.
    if grep -qE '\[(APP_NAME|CREATED_AT|ORG_SLUG|APPLIED_AT|MODE|SETUP_COMMIT_SHA_BEFORE|PROTECTED_BRANCHES_JSON_ARRAY|TEST_FRAMEWORK)\]' "$TARGET"; then
      echo "  ⚠ ERROR: ${TARGET_REL} contains unsubstituted placeholder after CREATE — framework bug, inspect template" >&2
      exit 1
    fi
    echo "  CREATE  ${TARGET_REL}"
    CREATE_COUNT=$((CREATE_COUNT + 1))
    continue
  fi

  USER_MARKER_SHA=$(head -n 1 "$TARGET" \
    | sed -n 's/.*sha256-body=\([a-f0-9]\{64\}\).*/\1/p')
  USER_BODY_SHA=$(tail -n +2 "$TARGET" | tr -d '\r' | sha256_compute)

  if [ "$USER_BODY_SHA" = "$USER_MARKER_SHA" ]; then
    # Dev did NOT edit.
    if [ "$USER_BODY_SHA" = "$TEMPLATE_BODY_SHA" ]; then
      echo "  SKIP    ${TARGET_REL}"
      SKIP_COUNT=$((SKIP_COUNT + 1))
    else
      { printf '%s\n' "$MARKER"; printf '%s\n' "$TEMPLATE_BODY"; } > "$TARGET" || { echo "  ⚠ ERROR: write failed for ${TARGET_REL}" >&2; exit 1; }
      if grep -qE '\[(APP_NAME|CREATED_AT|ORG_SLUG|APPLIED_AT|MODE|SETUP_COMMIT_SHA_BEFORE|PROTECTED_BRANCHES_JSON_ARRAY|TEST_FRAMEWORK)\]' "$TARGET"; then
        echo "  ⚠ ERROR: ${TARGET_REL} contains unsubstituted placeholder after UPDATE — framework bug, inspect template" >&2
        exit 1
      fi
      echo "  UPDATE  ${TARGET_REL}: template body changed since install"
      UPDATE_COUNT=$((UPDATE_COUNT + 1))
    fi
  else
    # Dev edited (body sha mismatch with marker).
    echo "  PRESERVE ${TARGET_REL}: dev-edited (body sha mismatch with marker; preserved as-is)"
    PRESERVE_COUNT=$((PRESERVE_COUNT + 1))
  fi
done < <(printf '%s\n' "$CANONICAL_DOCS")

# OUT_OF_SCOPE detection + report — scan documentation/ for any file
# NOT in CANONICAL_DOCS. These are dev-custom and PROTECTED from any
# mutation by this phase. Read-only by construction.
echo "  CHECKPOINT: Phase 4.5 scanning documentation/ for OUT_OF_SCOPE (dev-custom) paths"
CANONICAL_SET=$(printf '%s\n' "$CANONICAL_DOCS" | awk -F'|' '{print $1}' | sort -u)
OUT_OF_SCOPE_COUNT=0
if [ -d "$(pwd)/documentation" ]; then
  while read -r REL; do
    if ! printf '%s\n' "$CANONICAL_SET" | grep -qxF "$REL"; then
      echo "  OUT_OF_SCOPE  ${REL} (dev-custom — intacto, never touched by /rsct-setup)"
      OUT_OF_SCOPE_COUNT=$((OUT_OF_SCOPE_COUNT + 1))
    fi
  done < <(find "$(pwd)/documentation" -type f -name '*.md' 2>/dev/null \
            | sed "s|^$(pwd)/||" \
            | sort -u)
fi

echo "  Phase 4.5 summary:"
echo "    Canonical CREATE  : ${CREATE_COUNT}"
echo "    Canonical UPDATE  : ${UPDATE_COUNT}"
echo "    Canonical SKIP    : ${SKIP_COUNT}"
echo "    Canonical PRESERVE: ${PRESERVE_COUNT}"
echo "    Dev-custom OUT_OF_SCOPE: ${OUT_OF_SCOPE_COUNT} (intacto)"
```

**Anti-drift contract — what this loop guarantees:**

- A dev-custom path (`documentation/deployment/runbook.md`,
  `documentation/api/endpoints-reference.md`, anything outside
  `CANONICAL_DOCS`) is **NEVER** touched. The OUT_OF_SCOPE branch
  only logs the path, it never edits, never reads beyond `find`,
  never adds a marker, never adds frontmatter, never "completes"
  the file's structure, never invents a category for it.
- Adding a new canonical file requires editing `CANONICAL_DOCS`
  here AND adding the corresponding template at
  `doc-templates/<template_relpath>`. There is no path that adds
  a marker to a dev-custom file at runtime — by design.
- The 4-state classifier (CREATE / UPDATE / SKIP / PRESERVE) applies
  ONLY to entries in `CANONICAL_DOCS`. The classifier has no
  awareness of files outside that set.
- If a reading agent proposes any of: "add marker to dev-custom
  file", "add frontmatter to dev-custom file", "integrate
  `documentation/<X>/` into the RSCT marker system", "invent
  category `<runbook|deploy-spec|…>` for dev-custom files" — that
  is **scope creep beyond the framework contract**. Refuse and
  exit.

Rules carried over from prior versions:
- Use `<TODO: describe X>` placeholders for project-specific content
  inside canonical files.
- Ensure 1:1 pairing between `documentation/modules/` and
  `documentation/impact/` when both are present (dev manages).

### 4.5b — Knowledge graph (institutional consciousness layer)

> **Uninstall counterpart (LOW-20 note):** there is no dedicated
> Phase 4.5b in `prompts/03-uninstall.md` because every file created
> here lives under `documentation/knowledge/` and carries the standard
> `<!-- RSCT-GENERATED v=1.0.0 ... -->` marker. They are removed by
> the generic `documentation/` scrub in uninstall Phase 4.4 alongside
> the rest of the setup-created docs — same SHA256-protection, same
> classification, same dev-choice flow. No special-case logic needed.

The knowledge graph is the tacit-knowledge substrate consumed by
`rsct-mcp` (when installed) to give Claude the "senior architect" recall
described in [`mcp-server/README.md`](../mcp-server/README.md) (M1
Recall tools — `rsct_get_knowledge`, `rsct_get_architecture`,
`rsct_get_decisions`, `rsct_check_premise`). Even without the MCP
installed, the files are valuable as human-readable institutional memory.

**Canonical bash — knowledge graph classifier (mirror of Phase 4.5
with its own closed set):**

```bash
echo "  CHECKPOINT: Phase 4.5b executing canonical documentation/knowledge/* writer"

# CANONICAL_KNOWLEDGE: closed list. Anything in documentation/knowledge/
# NOT in this list is dev-custom and protected by the OUT_OF_SCOPE
# branch (same contract as Phase 4.5).
CANONICAL_KNOWLEDGE="\
documentation/knowledge/README.md|knowledge/README.md.template
documentation/knowledge/business-glossary.md|knowledge/business-glossary.md.template
documentation/knowledge/business-rules.md|knowledge/business-rules.md.template
documentation/knowledge/anti-decisions.md|knowledge/anti-decisions.md.template
documentation/knowledge/incident-log.md|knowledge/incident-log.md.template
documentation/knowledge/stakeholder-map.md|knowledge/stakeholder-map.md.template
documentation/knowledge/team-capabilities.md|knowledge/team-capabilities.md.template
documentation/knowledge/vendor-relationships.md|knowledge/vendor-relationships.md.template
documentation/knowledge/cost-constraints.md|knowledge/cost-constraints.md.template
documentation/knowledge/workflow-rituals.md|knowledge/workflow-rituals.md.template
documentation/knowledge/domain-edge-cases.md|knowledge/domain-edge-cases.md.template"

KG_CREATE=0; KG_UPDATE=0; KG_SKIP=0; KG_PRESERVE=0

# Same process-substitution idiom as Phase 4.5 — counters MUST survive
# the loop body. `| while` would zero them out.
while IFS='|' read -r TARGET_REL TEMPLATE_REL; do
  [ -z "$TARGET_REL" ] && continue
  TARGET="$(pwd)/${TARGET_REL}"
  TEMPLATE="$HOME/.rsct/doc-templates/${TEMPLATE_REL}"

  if [ ! -f "$TEMPLATE" ]; then
    echo "  ⚠ ${TARGET_REL}: TEMPLATE_MISSING — framework bug" >&2
    continue
  fi

  # CAP-23: substitute [APP_NAME] + [CREATED_AT] (mirror of Phase 4.5).
  # Every knowledge template has "last_capture: [CREATED_AT]" at line 6
  # of its body — pre-v0.7.6 that placeholder shipped verbatim to disk.
  #
  # CAP-35: preserve existing `last_capture: YYYY-MM-DD` from TARGET
  # across re-runs (mirror of Phase 4.5). See Phase 4.5 docstring for
  # full rationale.
  EFFECTIVE_CREATED_AT="${APPLIED_AT_DATE}"
  if [ -f "$TARGET" ]; then
    EXISTING_LAST_CAPTURE=$(tr -d '\r' < "$TARGET" 2>/dev/null \
      | grep -E '^last_capture:[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]]*$' \
      | head -1 \
      | sed -E 's/^last_capture:[[:space:]]+([0-9]{4}-[0-9]{2}-[0-9]{2}).*$/\1/')
    if [ -n "$EXISTING_LAST_CAPTURE" ]; then
      EFFECTIVE_CREATED_AT="$EXISTING_LAST_CAPTURE"
    fi
  fi
  TEMPLATE_BODY=$(tail -n +2 "$TEMPLATE" | tr -d '\r' \
    | sed -e "s/\[APP_NAME\]/${APP_NAME}/g" \
          -e "s/\[CREATED_AT\]/${EFFECTIVE_CREATED_AT}/g")
  TEMPLATE_BODY_SHA=$(printf '%s\n' "$TEMPLATE_BODY" | sha256_compute)
  MARKER="<!-- RSCT-GENERATED v=1.0.0 created=${APPLIED_AT} sha256-body=${TEMPLATE_BODY_SHA} -->"

  if [ ! -f "$TARGET" ]; then
    # B1 + A2 (field-report) — same rationale as Phase 4.5: relative mkdir to
    # survive a UNC root, abort on mkdir/write failure, and refuse to log/count
    # CREATE for a file that never landed on disk.
    mkdir -p "$(dirname "$TARGET_REL")" || { echo "  ⚠ ERROR: cannot create directory for ${TARGET_REL}" >&2; exit 1; }
    { printf '%s\n' "$MARKER"; printf '%s\n' "$TEMPLATE_BODY"; } > "$TARGET" || { echo "  ⚠ ERROR: write failed for ${TARGET_REL}" >&2; exit 1; }
    if [ ! -f "$TARGET" ]; then
      echo "  ⚠ ERROR: ${TARGET_REL} not created (write succeeded but file is absent) — aborting" >&2
      exit 1
    fi
    # CAP-23 anti-regression — same closed list as Phase 4.5.
    if grep -qE '\[(APP_NAME|CREATED_AT|ORG_SLUG|APPLIED_AT|MODE|SETUP_COMMIT_SHA_BEFORE|PROTECTED_BRANCHES_JSON_ARRAY|TEST_FRAMEWORK)\]' "$TARGET"; then
      echo "  ⚠ ERROR: ${TARGET_REL} contains unsubstituted placeholder after CREATE — framework bug" >&2
      exit 1
    fi
    echo "  CREATE  ${TARGET_REL}"
    KG_CREATE=$((KG_CREATE + 1))
    continue
  fi

  USER_MARKER_SHA=$(head -n 1 "$TARGET" \
    | sed -n 's/.*sha256-body=\([a-f0-9]\{64\}\).*/\1/p')
  USER_BODY_SHA=$(tail -n +2 "$TARGET" | tr -d '\r' | sha256_compute)

  if [ "$USER_BODY_SHA" = "$USER_MARKER_SHA" ]; then
    if [ "$USER_BODY_SHA" = "$TEMPLATE_BODY_SHA" ]; then
      echo "  SKIP    ${TARGET_REL}"
      KG_SKIP=$((KG_SKIP + 1))
    else
      { printf '%s\n' "$MARKER"; printf '%s\n' "$TEMPLATE_BODY"; } > "$TARGET" || { echo "  ⚠ ERROR: write failed for ${TARGET_REL}" >&2; exit 1; }
      if grep -qE '\[(APP_NAME|CREATED_AT|ORG_SLUG|APPLIED_AT|MODE|SETUP_COMMIT_SHA_BEFORE|PROTECTED_BRANCHES_JSON_ARRAY|TEST_FRAMEWORK)\]' "$TARGET"; then
        echo "  ⚠ ERROR: ${TARGET_REL} contains unsubstituted placeholder after UPDATE — framework bug" >&2
        exit 1
      fi
      echo "  UPDATE  ${TARGET_REL}"
      KG_UPDATE=$((KG_UPDATE + 1))
    fi
  else
    echo "  PRESERVE ${TARGET_REL}: dev-edited"
    KG_PRESERVE=$((KG_PRESERVE + 1))
  fi
done < <(printf '%s\n' "$CANONICAL_KNOWLEDGE")

# OUT_OF_SCOPE scan inside documentation/knowledge/ — read-only.
echo "  CHECKPOINT: Phase 4.5b scanning documentation/knowledge/ for OUT_OF_SCOPE paths"
KG_CANONICAL_SET=$(printf '%s\n' "$CANONICAL_KNOWLEDGE" | awk -F'|' '{print $1}' | sort -u)
KG_OOS=0
if [ -d "$(pwd)/documentation/knowledge" ]; then
  while read -r REL; do
    if ! printf '%s\n' "$KG_CANONICAL_SET" | grep -qxF "$REL"; then
      echo "  OUT_OF_SCOPE  ${REL} (dev-custom — intacto)"
      KG_OOS=$((KG_OOS + 1))
    fi
  done < <(find "$(pwd)/documentation/knowledge" -type f -name '*.md' 2>/dev/null \
            | sed "s|^$(pwd)/||" \
            | sort -u)
fi

echo "  Phase 4.5b summary:"
echo "    Canonical CREATE/UPDATE/SKIP/PRESERVE: ${KG_CREATE}/${KG_UPDATE}/${KG_SKIP}/${KG_PRESERVE}"
echo "    Dev-custom OUT_OF_SCOPE: ${KG_OOS} (intacto)"
```

Placeholder substitution per file:
- `[APP_NAME]` → from Phase 1.1
- `[CREATED_AT]` → `applied_at` from Phase 4.4 (single timestamp for whole run)

**Rules specific to the knowledge graph:**
- All 10 files land **empty of real entries** by design — the templates
  include schema + example + anti-example + a single `<TODO: ...>` marker
  for the first entry. **Never** fabricate institutional knowledge during
  setup; that produces fake content the dev then has to delete.
- The graph is populated through **just-in-time capture during normal
  conversation** (not a scheduled ritual). When Claude detects a trigger
  — new domain term, new business rule, vendor choice, dev override,
  plan rejection, incident, anti-pattern — it proposes a structured
  entry inline; the dev confirms in 5-30 seconds. Setup just lays the
  substrate; population happens inside the existing dialogue flow. See
  the "Capture model" section of `documentation/knowledge/README.md`.
- The knowledge graph is consumed by `rsct-mcp` tools when present, but
  remains useful as human-readable docs even without the MCP installed.

### 4.6 — Memory entries (content-SHA update)

Use the `PROJECT_ENCODED` value printed in step 1.7.

```bash
MEMORY_DIR="$HOME/.claude/projects/[PROJECT_ENCODED]/memory"
mkdir -p "$MEMORY_DIR"
RSCT_TEMPLATE_VERSION="1.0.0"   # incoming framework version (used only in marker)
```

**Classification per entry — 4 states (content-SHA, not version string):**

The feedback memory entries are processed by the **canonical loop** below —
**execute it literally; do NOT hand-write the iteration** (Phases 4.5/4.5b ship
the same shape, and reinventing it is exactly how the `feedback_*.md.template`
zero-match footgun happened — field-report G1). It iterates
`~/.rsct/memory-templates/feedback_*.md` (the feedback templates carry **no**
`.template` suffix — only `MEMORY.md.template` does), classifies each entry into
one of the four states, and executes it inline. `MEMORY.md` (the index) is
handled in its own block below because it has the additive-merge special case.

```bash
echo "  CHECKPOINT: Phase 4.6 executing canonical content-SHA classifier loop over feedback memory entries"
MEM_CREATE=0; MEM_UPDATE=0; MEM_SKIP=0; MEM_PRESERVE=0
# `[ -f ]` makes an empty glob a clean no-op. tr -d '\r' normalizes CRLF so the
# SHA is stable cross-OS (Git Bash autocrlf vs Linux/macOS). The placeholder
# sed is a no-op for feedback bodies (they carry none) but stays uniform with
# MEMORY.md.template so a future placeholder cannot silently leak (CAP-23). The
# writer mirrors Phase 4.5: marker line 1, body from line 2 — so the marker SHA
# matches the bytes the next re-run's `tail -n +2` reads back.
for SOURCE_TEMPLATE in "$HOME/.rsct/memory-templates/"feedback_*.md; do
  [ -f "$SOURCE_TEMPLATE" ] || continue
  NAME=$(basename "$SOURCE_TEMPLATE")          # feedback_<name>.md (no .template suffix)
  TARGET="$MEMORY_DIR/$NAME"

  TEMPLATE_BODY_RESOLVED=$(tail -n +2 "$SOURCE_TEMPLATE" \
    | tr -d '\r' \
    | sed -e "s/\[APP_NAME\]/${APP_NAME}/g" \
          -e "s/\[CREATED_AT\]/${APPLIED_AT_DATE}/g")
  TEMPLATE_BODY_SHA=$(printf '%s\n' "$TEMPLATE_BODY_RESOLVED" | sha256_compute)
  MARKER="<!-- RSCT-GENERATED v=${RSCT_TEMPLATE_VERSION} created=${APPLIED_AT} sha256-body=${TEMPLATE_BODY_SHA} -->"

  if [ ! -f "$TARGET" ]; then                                  # CREATE
    { printf '%s\n' "$MARKER"; printf '%s\n' "$TEMPLATE_BODY_RESOLVED"; } > "$TARGET" \
      || { echo "  ⚠ ERROR: write failed for memory/$NAME" >&2; exit 1; }
    [ -f "$TARGET" ] || { echo "  ⚠ ERROR: memory/$NAME not created — aborting" >&2; exit 1; }
    echo "  CREATE   memory/$NAME"; MEM_CREATE=$((MEM_CREATE + 1)); continue
  fi

  # Existing file: 4-state classify by content-SHA (not version string).
  USER_MARKER_SHA=$(head -n 1 "$TARGET" | sed -n 's/.*sha256-body=\([a-f0-9]\{64\}\).*/\1/p')
  USER_BODY_SHA=$(tail -n +2 "$TARGET" | tr -d '\r' | sha256_compute)
  if [ "$USER_BODY_SHA" = "$USER_MARKER_SHA" ]; then           # dev did NOT edit
    if [ "$USER_BODY_SHA" = "$TEMPLATE_BODY_SHA" ]; then
      echo "  SKIP     memory/$NAME"; MEM_SKIP=$((MEM_SKIP + 1))
    else                                                        # UPDATE — identical writer to CREATE
      { printf '%s\n' "$MARKER"; printf '%s\n' "$TEMPLATE_BODY_RESOLVED"; } > "$TARGET" \
        || { echo "  ⚠ ERROR: write failed for memory/$NAME" >&2; exit 1; }
      echo "  UPDATE   memory/$NAME: template body changed since install"; MEM_UPDATE=$((MEM_UPDATE + 1))
    fi
  else                                                          # PRESERVE_WITH_WARNING
    echo "  PRESERVE memory/$NAME: edited after install (body sha mismatch). To force update: rm the file and re-run setup."
    MEM_PRESERVE=$((MEM_PRESERVE + 1))
  fi
done
echo "  Phase 4.6 feedback summary: CREATE=$MEM_CREATE UPDATE=$MEM_UPDATE SKIP=$MEM_SKIP PRESERVE=$MEM_PRESERVE"
```

**Why content-SHA (not version-string) comparison:** the marker schema
id (`v=1.0.0`) is intentionally stable — it changes only when the marker
*format* changes, never per release. A version-string compare would
silently SKIP every UPDATE during the dev cycle (case observed in v0.6.4:
body edits to `feedback_architect-code-changes.md` and
`feedback_branch-protection.md` were skipped by re-runs on existing
projects because `v=1.0.0` matched). Comparing the user file's body SHA
against the resolved template SHA captures **every** content change
without requiring a schema-id bump.

**Backward compat:** the marker shape
(`<!-- RSCT-GENERATED v=X created=Y sha256-body=Z -->`) is unchanged.
Files created by any prior `/rsct-setup` version already carry
`sha256-body=...` on line 1; this new classifier reads the same field
and works transparently. No migration step required.

**The four actions are implemented by the loop above:** `CREATE` writes the
marker + resolved body; `UPDATE` re-runs the **identical** writer (never a
divergent one — a mismatched marker SHA would break the next re-run's
classification); `SKIP` does nothing; `PRESERVE` leaves a dev-edited file
untouched and warns (`rm` + re-run to force). `MEMORY.md` follows the same
4-state logic with the additive-merge special case below.

**MEMORY.md (the index) — same content-SHA classification:**

Apply the same 4-state classifier to `MEMORY.md`. Special handling:
- `CREATE`: write fresh from `MEMORY.md.template` (substitute `[APP_NAME]`).
- `UPDATE`: regenerate from template (safe because dev did not edit).
- `SKIP`: body sha already matches incoming template.
- `PRESERVE_WITH_WARNING`: dev edited. **Run the additive-merge bash
  below — do NOT skip it on a "no-op" rationale.** Prior versions of
  this prompt left the additive merge as prose only, which led to
  silent skips when the template gained new entries (CAP-13 incident,
  dogfood run 2026-06-07). The marker stays with the original
  sha — `/rsct-uninstall` will flag MEMORY.md as MODIFIED and handle
  accordingly.

**Additive merge — bash (PRESERVE_WITH_WARNING only):**

For every `feedback_<name>.md` referenced in the incoming template that
is NOT yet referenced in the user's MEMORY.md, append the matching
entry — converted to the user's existing entry style — at the end of
the file. This is the only path that mutates a PRESERVED MEMORY.md,
and it only ever adds — never modifies or removes existing lines.

The framework supports two entry styles natively:

| Style    | Shape                                                                                  |
|----------|----------------------------------------------------------------------------------------|
| template | `- **Title** — description → \`feedback_<slug>.md\`` (the framework default)           |
| link     | `- [Title](feedback_<slug>.md) — description` (markdown link, common dev customization) |

Detection picks the style from the first existing `feedback_*.md`
reference in the user's MEMORY.md. If the file has no existing
reference (rare — only happens when the user started from a blank
MEMORY.md), `USER_STYLE=template` and we emit a hint. If the
reference shape matches neither pattern, `USER_STYLE=unknown` and we
fall back to template style with a per-line WARN.

```bash
SOURCE_MEMORY_TEMPLATE="$HOME/.rsct/memory-templates/MEMORY.md.template"
TARGET_MEMORY="$MEMORY_DIR/MEMORY.md"
APPENDED=0
UNKNOWN_STYLE=0

# Detect the user's entry style from the first existing feedback_*.md reference.
SAMPLE_LINE=$(grep -F 'feedback_' "$TARGET_MEMORY" | head -n 1)
case "$SAMPLE_LINE" in
  *'](feedback_'*)  USER_STYLE="link" ;;
  *'`feedback_'*)   USER_STYLE="template" ;;
  '')               USER_STYLE="template" ;;   # empty MEMORY.md — use template default
  *)                USER_STYLE="unknown" ;;     # neither pattern matched
esac
echo "  MEMORY.md detected entry style: $USER_STYLE"

# Iterate over every feedback_*.md filename referenced in the template.
# Use process substitution `< <(...)` so APPENDED / UNKNOWN_STYLE
# survive the loop (a pipe `| while` would run the body in a subshell
# and discard counter updates). sed is POSIX-BRE-only — portable
# across Git Bash / Linux / macOS sed.
while read -r FB_FILE; do
  grep -qF "$FB_FILE" "$TARGET_MEMORY" && continue

  # Pull the full template line that mentions this feedback file.
  TEMPLATE_LINE=$(grep -F "$FB_FILE" "$SOURCE_MEMORY_TEMPLATE" | head -n 1)

  # Convert to USER_STYLE (template is the canonical shape, so it's
  # a no-op when USER_STYLE=template; link extracts title + body and
  # rewraps; unknown falls back to template with a per-line WARN).
  case "$USER_STYLE" in
    template)
      NEW_LINE="$TEMPLATE_LINE"
      ;;
    link)
      # Template shape: `- **TITLE** — BODY → \`FB_FILE\``
      TITLE=$(printf '%s' "$TEMPLATE_LINE" | sed -n 's/^- \*\*\(.*\)\*\* — .*/\1/p')
      BODY=$(printf '%s' "$TEMPLATE_LINE" \
        | sed -n 's/^- \*\*[^*]*\*\* — \(.*\) → `[^`]*`$/\1/p')
      if [ -n "$TITLE" ] && [ -n "$BODY" ]; then
        NEW_LINE="- [${TITLE}](${FB_FILE}) — ${BODY}"
      else
        # Template line did not match the canonical shape — fall back
        # to the raw template line and mark unknown so the WARN fires.
        NEW_LINE="$TEMPLATE_LINE"
        UNKNOWN_STYLE=$((UNKNOWN_STYLE + 1))
      fi
      ;;
    unknown|*)
      NEW_LINE="$TEMPLATE_LINE"
      UNKNOWN_STYLE=$((UNKNOWN_STYLE + 1))
      ;;
  esac

  printf '%s\n' "$NEW_LINE" >> "$TARGET_MEMORY"
  echo "  + MEMORY.md additive-merge: appended entry for $FB_FILE (style=$USER_STYLE)"
  APPENDED=$((APPENDED + 1))
done < <(sed -n 's/.*`\(feedback_[a-z0-9-][a-z0-9-]*\.md\)`.*/\1/p' "$SOURCE_MEMORY_TEMPLATE" | sort -u)
```

**Format-alignment WARN** — emit one of the following advisories in the
Phase 5 report based on the run:

- `APPENDED > 0` and `USER_STYLE=template`: no WARN, the appended lines
  match the existing style.
- `APPENDED > 0` and `USER_STYLE=link`: log
  `INFO: MEMORY.md additive merge appended N entr(y|ies), auto-converted
  to your [title](file.md) link style.`
- `APPENDED > 0` and `USER_STYLE=unknown` (or `UNKNOWN_STYLE > 0`): log
  `WARN: MEMORY.md additive merge appended N entr(y|ies) using template
  style because your existing entry shape did not match the two supported
  styles (template **Title** ... → \`file.md\`, or markdown [Title](file.md)
  — body). Review the appended line(s) and normalize manually if needed.`

**Final report in Phase 5:**

Show counts so the dev knows exactly what happened:
```
Memory entries:
  Created  : N  (new files)
  Updated  : M  (template body changed since install, files unedited)
  Skipped  : K  (body sha matches incoming template)
  Preserved: P  (you edited these — manual rm to force update)
```

If `P > 0`, also list the file names so the dev can decide.

**Anti-scope-creep — OUT_OF_SCOPE memory entries (CAP-19):**

Mirror of the Phase 4.5 / 4.5b anti-drift contract. `MEMORY_DIR`
typically holds dev-custom entries alongside the canonical
`feedback_*.md` and `MEMORY.md` set — projects in real use have
been observed with `project_overview.md`, `project_docs_structure.md`,
`feedback_test-coverage.md`, `feedback_ida-volta-flow.md`, and
similar dev-authored memories. These have **NO template**, are
NEVER touched by Phase 4.6, and must be reported as `OUT_OF_SCOPE`
so the dev sees them surviving the run intact.

```bash
echo "  CHECKPOINT: Phase 4.6 scanning $MEMORY_DIR for OUT_OF_SCOPE (dev-custom) memory entries"

# CANONICAL_MEMORY: closed list — every memory file the framework owns.
# Build from the template directory so the list stays in sync with
# what ~/.rsct/memory-templates/ ships. Anything in MEMORY_DIR NOT in
# this set is dev-custom and protected from any mutation by this
# phase. The loop below ONLY logs; it never reads bodies, never adds
# markers, never proposes "integration".
CANONICAL_MEMORY=$(ls "$HOME/.rsct/memory-templates/" 2>/dev/null \
  | sed 's/\.template$//' \
  | sort -u)
MEM_OOS=0
if [ -d "$MEMORY_DIR" ]; then
  # Process substitution so MEM_OOS survives the loop body
  # (see "anti-pattern #1" in CLAUDE.md).
  while read -r MEM_FILE; do
    [ -z "$MEM_FILE" ] && continue
    if ! printf '%s\n' "$CANONICAL_MEMORY" | grep -qxF "$MEM_FILE"; then
      echo "  OUT_OF_SCOPE  ${MEM_FILE} (dev-custom memory — intacto, never touched)"
      MEM_OOS=$((MEM_OOS + 1))
    fi
  done < <(ls "$MEMORY_DIR" 2>/dev/null | sort -u)
fi
echo "  Phase 4.6 OUT_OF_SCOPE: ${MEM_OOS} dev-custom memory entr(y|ies) intact"
```

**Anti-drift contract — same as Phase 4.5 / 4.5b:**

If a reading agent proposes any of: "add marker to dev-custom
memory file", "rename dev-custom memory to match a canonical slug",
"merge dev-custom content into a canonical entry", "integrate
`project_*.md` into the marker system" — that is **scope creep
beyond the framework contract**. Refuse and exit.

The Phase 4.6 classifier loop iterates ONLY over
`~/.rsct/memory-templates/*.template`. The classifier has no
awareness of files outside that set. The OUT_OF_SCOPE scan above
is purely informational — it does not feed back into any mutation
path.

### 4.7 — Project conventions scaffold (optional, consent-based)

`CONVENTIONS.md` at the **project root** is the prescriptive home for *how new
code must be written* in this project — naming, schema/migration patterns,
identifier language, the mold for a new domain/module. It is the **prescriptive
*how***, distinct from `documentation/decisions.md` (the *why/when* of a choice)
and `documentation/knowledge/anti-decisions.md` (paths tried and abandoned); a
convention often *derives* from an ADR. It is **dev-owned and committable** —
NOT an RSCT-managed/SHA-tracked file (no `RSCT-GENERATED` marker) and NOT
gitignored.

This step is **opt-in** and **non-destructive**:

- If `./CONVENTIONS.md` already exists → **skip** (leave it untouched — it's the
  dev's).
- If absent → make a **single-line offer**, e.g. *"Scaffold an empty
  `CONVENTIONS.md` skeleton at the project root now? (you fill it in later)"*.
  Do **not** brainstorm or pre-fill its content — the default is a blank
  template the dev populates whenever conventions actually emerge (CAP-56). Run
  the block below **only on an explicit yes**; if the dev declines or stays
  silent, do nothing.

```bash
echo "  CHECKPOINT: Phase 4.7 evaluating optional CONVENTIONS.md scaffold"
# Relative path (cwd is the project root) so a UNC root (//wsl.localhost/...)
# does not break the write (B1/CAP-38). No RSCT marker — this is a one-time,
# dev-owned scaffold, not a managed doc. Idempotent: writes only when absent.
CONV_TARGET="CONVENTIONS.md"
CONV_TEMPLATE="$HOME/.rsct/doc-templates/CONVENTIONS.md.template"
if [ -f "$CONV_TARGET" ]; then
  echo "  CONVENTIONS.md already present — left untouched (dev-owned)."
elif [ ! -f "$CONV_TEMPLATE" ]; then
  echo "  CONVENTIONS.md template not found in ~/.rsct/doc-templates — skipping scaffold."
else
  sed "s/\[APP_NAME\]/${APP_NAME}/g" "$CONV_TEMPLATE" > "$CONV_TARGET" \
    || { echo "  ⚠ ERROR: cannot write CONVENTIONS.md" >&2; exit 1; }
  echo "  CREATE  CONVENTIONS.md (project root, committable — fill it in and commit for the team)"
fi
```

`CONVENTIONS.md` must stay **trackable**: the RSCT `.gitignore` block (Phase
4.4b) does not list it, so it is committable by design (the team's shared
standard, like `decisions.md`). §B (consult it before writing code) and §H (the
decisions × anti-decisions × conventions taxonomy) cover when the agent reads
and proposes conventions.

### 4.8 — Register this app in the universe (optional, consent-based)

When this project belongs to an org-level **universe** (a `universe.local` was
discovered in Phase 1.9 and persisted to `.rsct.json`), setup can register the app
in that universe: create `applications/<app>/README.md` from the template and add
`<app>` to `.universe.json` `registered_apps[]`. This is the action behind the
`rsct_status` / `rsct_load_context` "this app is not registered" hint (T1.a).

This step is **opt-in** and writes into the universe's **own git repository**:

- If no universe resolves, or the app is already registered → the block below is a
  safe **no-op** (run it anyway; it self-guards).
- If the app is **not** registered → make a **single-line offer**, e.g. *"Register
  this app in the universe at `<path>`? `[y/N]`"*. Writing into another repo must be
  a deliberate **yes** — run the block **only on an explicit yes**; on decline or
  silence, do nothing.
- **RSCT never touches the universe's git** — it writes working files only and
  **never** `git add` / `commit` / `push` there. After it writes, review and commit
  inside the universe repo yourself (the §0 universe rule: local-first, remote-with-OK).
- It **never overwrites** an existing `applications/<app>/` (warns instead).

```bash
echo "  CHECKPOINT: Phase 4.8 registering this app in the universe (consented)"
# Self-contained + cross-OS via node: reads identity + universe path from the
# .rsct.json written in Phase 4.4 (the AI runs blocks separately, so earlier-phase
# shell vars are not assumed in scope). Appends to registered_apps[] by TEXT-SPLICE
# — never JSON.parse->stringify the whole .universe.json (CLAUDE.md #5; .universe.json
# is NOT a documented exception). No apostrophes anywhere in this node program (a
# stray apostrophe would close the single-quoted node -e — CAP-20 / V2 class).
node -e '
  const fs = require("fs");
  const path = require("path");
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(".rsct.json", "utf8")); }
  catch (e) { console.error("  WARN: .rsct.json unreadable — skipping universe registration."); process.exit(0); }
  const app = cfg.app && cfg.app.name;
  const org = (cfg.app && cfg.app.org) || "";
  const uniLocal = cfg.universe && cfg.universe.local;
  if (!app || !uniLocal) { console.log("  No universe.local / app in .rsct.json — skipping registration."); process.exit(0); }
  const uni = path.isAbsolute(uniLocal) ? uniLocal : path.resolve(process.cwd(), uniLocal);
  if (!fs.existsSync(path.join(uni, ".universe.json"))) { console.log("  Universe not found/invalid at " + uni + " — skipping registration."); process.exit(0); }
  const appDir = path.join(uni, "applications", app);

  // Append app to registered_apps[] by text-splice (bracket-balanced walk); idempotent.
  function appendRegistry() {
    const target = path.join(uni, ".universe.json");
    let txt;
    try { txt = fs.readFileSync(target, "utf8"); } catch (e) { return; }
    const m = txt.match(/("registered_apps"[ \t]*:[ \t]*)\[/);
    if (!m) { console.error("  WARN: registered_apps[] not found in .universe.json — add " + JSON.stringify(app) + " to it manually."); return; }
    const openIdx = m.index + m[0].length - 1;
    let i = openIdx + 1, depth = 1, inStr = false, esc = false;
    for (; i < txt.length && depth > 0; i++) {
      const c = txt[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === "\"") inStr = !inStr;
      else if (!inStr && c === "[") depth++;
      else if (!inStr && c === "]") depth--;
    }
    const closeIdx = i - 1;
    const inner = txt.slice(openIdx + 1, closeIdx);
    const elems = inner.split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    if (elems.indexOf(JSON.stringify(app)) !== -1) { console.log("  index already lists " + app); return; }
    elems.push(JSON.stringify(app));
    const ml = inner.indexOf("\n") !== -1;
    const rendered = ml ? ("\n    " + elems.join(",\n    ") + "\n  ") : elems.join(", ");
    fs.writeFileSync(target, txt.slice(0, openIdx + 1) + rendered + txt.slice(closeIdx), "utf8");
    console.log("  indexed " + app + " in .universe.json registered_apps[]");
  }

  if (fs.existsSync(appDir)) {
    console.log("  applications/" + app + "/ already exists in the universe — left as-is (verify it is this repo).");
    appendRegistry();
    process.exit(0);
  }

  const tmpl = path.join(process.env.HOME || "", ".rsct", "universe-templates", "applications", "_app.md.template");
  fs.mkdirSync(appDir, { recursive: true });
  let body;
  try { body = fs.readFileSync(tmpl, "utf8").split("[APP_NAME]").join(app).split("[ORG_SLUG]").join(org); }
  catch (e) { body = "# " + app + "\n\n(app template not found; minimal stub — fill this in)\n"; }
  fs.writeFileSync(path.join(appDir, "README.md"), body, "utf8");
  console.log("  CREATE  applications/" + app + "/README.md in the universe");
  appendRegistry();
  console.log("  NOTE: modified the universe repo at " + uni + " — RSCT never commits the universe; review and commit THERE yourself.");
' || { echo "  ERROR: universe registration failed" >&2; exit 1; }
```

Idempotent: a second run sees `applications/<app>/` and only reconciles the index
(never overwrites the README). The universe repo is left with **uncommitted** working
changes on purpose — committing there is the dev's call.

### 4.9 — Update-check consent (optional, ask-once)

T4: `rsct_status` can surface a one-line "a newer RSCT release is available" hint at
session start. It is **opt-in** — until consent is recorded, the MCP server makes NO
network call. This step ASKS ONCE (it never re-asks once `~/.rsct/update-check.json`
carries a `consent` field) and records the answer. The check is **cached (~daily),
fail-silent, and suggest-only** — it never auto-updates anything.

Ask the dev (only when consent is not yet recorded):
> *"Allow RSCT to check GitHub for a newer release at session start? It is cached
> (~once/day), never blocks, and only suggests — never auto-updates. `[y/N]`"*

Set `CONSENT` to `yes` or `no` from the answer (default `no`), then record it:

```bash
echo "  CHECKPOINT: Phase 4.9 executing canonical update-check consent (ask-once)"
UPDATE_CHECK_FILE="$HOME/.rsct/update-check.json"
HAS_CONSENT="no"
[ -f "$UPDATE_CHECK_FILE" ] && grep -q '"consent"' "$UPDATE_CHECK_FILE" 2>/dev/null && HAS_CONSENT="yes"
if [ "$HAS_CONSENT" = "yes" ]; then
  echo "  update-check consent already recorded — no change (ask-once)"
else
  # CONSENT is set from the dev's answer above; default to "no" (opt-in / privacy-first).
  CONSENT="${CONSENT:-no}"
  mkdir -p "$HOME/.rsct"
  # RSCT-owned runtime file — a small Node merge is fine (preserves any cache fields).
  # Path passed as argv (no pwd reliance); double-quoted JS only (no apostrophes — CAP-42).
  node -e '
    var fs = require("fs");
    var p = process.argv[1];
    var consent = process.argv[2] === "yes" ? "yes" : "no";
    var o = {};
    try { var prev = JSON.parse(fs.readFileSync(p, "utf8")); if (prev && typeof prev === "object") o = prev; } catch (e) { o = {}; }
    o.consent = consent;
    var tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, p);
    console.log("  update-check consent recorded: " + consent);
  ' "$UPDATE_CHECK_FILE" "$CONSENT"
fi
```

### 4.10 — Topology confirmation (mono / monorepo / multi-repo)

T2: record the repo's **topology** so the contract-surface gate knows whether to
enforce. The MCP **infers** it from on-disk signals; this step lets the dev
**confirm** it and persists the answer to `.rsct.json` (`topology.mode`). The gate
(`rsct_request_commit`) enforces contracts **only** when the confirmed mode is
**`multi-repo`**; `mono` / `monorepo` are recorded but never gated.

Steps:
1. Call **`mcp__rsct__rsct_get_topology`** and read `topology.confirmed_mode`,
   `topology.inferred_mode`, `topology.signals` (universe presence, registered-app
   count, nested app markers), and `hints`.
2. Decide whether to ASK — **ask-once**: do NOT re-prompt a topology the dev already
   settled unless the signals changed:
   - **`confirmed_mode` is null** (first run / a pre-T2 project being upgraded): ASK.
   - **`confirmed_mode` is set and no hint warns of a contradiction** (the signals still
     agree): do NOT re-ask — re-confirm SILENTLY with the existing `confirmed_mode`.
   - **`confirmed_mode` is set but a hint says the signals now suggest a DIFFERENT mode**
     (e.g. a `mono` repo that grew into `multi-repo` — the RV2 downgrade hint): surface
     the change and ASK whether to update.
   When asking:
   > *"Detected topology: **<inferred_mode>** (signals: <…>). Confirm the repo
   > topology — `mono` (one repo, one app), `monorepo` (many apps in this repo), or
   > `multi-repo` (many repos under the universe; the contract gate applies — it
   > protects the repo that PRODUCES a shared surface, not the consumers)? [default:
   > <confirmed_mode if set, else inferred_mode>]"*
3. Set `TOPOLOGY_MODE` to the resulting mode (`mono` / `monorepo` / `multi-repo`) — the
   dev's answer when asked, or the existing `confirmed_mode` when re-confirming silently
   (the splice is idempotent — re-writing the same value is a safe no-op). For a
   non-interactive run, `RSCT_TOPOLOGY_MODE` pre-seeds it.

Idempotent (re-running updates the value in place; no duplicate key) and it **never
reformats** the rest of `.rsct.json` (text-splice — `.rsct.json` is NOT a documented
JSON-merge exception; CLAUDE.md #5).

```bash
echo "  CHECKPOINT: Phase 4.10 executing canonical topology persistence (text-splice)"
RSCT_JSON=".rsct.json"
CONFIRMED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ)
# TOPOLOGY_MODE comes from the dev's confirmation above (mono|monorepo|multi-repo).
# RSCT_TOPOLOGY_MODE pre-seeds it for non-interactive / CI runs.
TOPOLOGY_MODE="${TOPOLOGY_MODE:-${RSCT_TOPOLOGY_MODE:-}}"
case "$TOPOLOGY_MODE" in
  mono|monorepo|multi-repo) ;;
  *) echo "  No valid topology confirmed (got '${TOPOLOGY_MODE}') — leaving .rsct.json topology unset (gate stays OFF)."; TOPOLOGY_MODE="" ;;
esac
if [ -n "$TOPOLOGY_MODE" ] && [ -f "$RSCT_JSON" ]; then
  # Persist topology.mode by TEXT-SPLICE — never JSON.parse->stringify the managed
  # .rsct.json (CLAUDE.md #5; .rsct.json is NOT a documented exception). Path via
  # argv (no pwd reliance); double-quoted JS only (no apostrophes — CAP-42). The
  # regex is anchored on "topology" so a sibling "install"."mode" is never touched;
  # the char class [ \t\r\n] is CRLF-tolerant.
  node -e '
    var fs = require("fs");
    var f = process.argv[1], mode = process.argv[2], at = process.argv[3];
    var s;
    try { s = fs.readFileSync(f, "utf8"); } catch (e) { console.error("  WARN: .rsct.json unreadable — topology not persisted."); process.exit(0); }
    var eol = /\r\n/.test(s) ? "\r\n" : "\n";
    var hasTopo = /"topology"[ \t\r\n]*:[ \t\r\n]*\{/.test(s);
    if (hasTopo) {
      s = s.replace(/("topology"[ \t\r\n]*:[ \t\r\n]*\{[^}]*?"mode"[ \t\r\n]*:[ \t\r\n]*")[^"]*(")/, "$1" + mode + "$2");
      if (/"topology"[ \t\r\n]*:[ \t\r\n]*\{[^}]*?"confirmed_at"[ \t\r\n]*:[ \t\r\n]*"/.test(s)) {
        s = s.replace(/("topology"[ \t\r\n]*:[ \t\r\n]*\{[^}]*?"confirmed_at"[ \t\r\n]*:[ \t\r\n]*")[^"]*(")/, "$1" + at + "$2");
      } else {
        s = s.replace(/("topology"[ \t\r\n]*:[ \t\r\n]*\{[^}]*?"mode"[ \t\r\n]*:[ \t\r\n]*"[^"]*")/, "$1, \"confirmed_at\": \"" + at + "\"");
      }
    } else {
      var m = s.match(/^([ \t\r\n]*\{[ \t\r\n]*)/);
      if (!m) { console.error("  WARN: .rsct.json root object not found — topology not persisted."); process.exit(0); }
      var block = "\"topology\": { \"mode\": \"" + mode + "\", \"confirmed_at\": \"" + at + "\" }," + eol + "  ";
      s = s.slice(0, m[0].length) + block + s.slice(m[0].length);
    }
    fs.writeFileSync(f, s, "utf8");
    console.log("  topology.mode persisted: " + mode);
  ' "$RSCT_JSON" "$TOPOLOGY_MODE" "$CONFIRMED_AT"
  if grep -q '"topology"' "$RSCT_JSON" 2>/dev/null; then echo "  OK: topology recorded"; else echo "  ERROR: topology persistence failed" >&2; exit 1; fi
fi
```

### 4.11 — Declare cross-repo contracts (DX-1b, guided) — multi-repo + ≥2 apps only

Offer guided contract authoring **ONLY** when ALL hold (else skip silently — near-zero-config):
- `TOPOLOGY_MODE == 'multi-repo'` (confirmed this run or already in `.rsct.json`), AND
- the LINKED universe resolves (`.rsct.json` `universe.local`), AND
- `rsct_get_topology` `topology.signals.registered_apps_count >= 2` — i.e. the universe has ≥2
  `applications/<dir>/` directories (the gate's ground truth; NOT the `registered_apps[]` JSON array).
  A contract needs a producer AND a consumer, so it's meaningless with fewer than 2 apps.
If `rsct-mcp` is not installed (no count available), SKIP — this is a second-run capability, like the
create-offer. Reuse the `rsct_get_topology` call from Phase 4.10; don't re-implement the count.

[Offer — consent-gated, ONE line:]
> "This universe has N apps (`<list registered apps>`). Want to declare a *contract* — a surface one
>  app PUBLISHES that others consume (the gate then blocks a producer commit that breaks it)? I'll ask
>  the details and add it to `contracts.json`; you review + commit the universe yourself. `[y/N]`"

On **NO** → skip (no mutation). On **YES** → the guided Q&A below, then the splice. The framework GUIDES
the questions but **NEVER invents** the relationships (the contract content is the dev's domain):
1. **producer** — default = THIS app's name; confirm, or pick another registered app. (The producer is
   the repo whose surface is gated.)
2. **id** — a unique slug; suggest `<producer>-api`; the dev confirms/edits.
3. **surface** — ask the dev for path globs in the producer repo. Glob rules (restate from the template
   `_help`): `*` `**` `?` only (no brace/char-class sets); a `dir/**` glob needs the trailing slash and
   does NOT match a sibling `dir.ext`. Need ≥1 glob — WARN if empty (an empty surface can never gate).
4. **consumers** — present the OTHER registered apps (EXCLUDE the chosen producer — an app can't consume
   its own surface); the dev picks which depend on the surface.
5. **description** — optional one-liner.
**Registered-name check (PH-2):** if the chosen producer or any consumer is NOT one of the universe's
registered apps (the `applications/<dir>/` names ∪ `.universe.json` `registered_apps[]`), **WARN** the dev —
the gate matches names **exactly** (case-sensitive), so an unregistered / mis-cased name silently never gates
(this is what `rsct_get_topology` flags later). The dev may still proceed (contract content is theirs), but it
is usually a typo or a not-yet-registered app; prefer the canonical `app.name`, never the folder name.
PREVIEW the assembled entry as JSON and require an **explicit approval** before writing.

**Safe value handoff (BINDING — injection safety).** The answers are dev free text. To keep them out of
the shell AND the `node -e` source, WRITE each answer **verbatim** to a scratch file using your
file-write tool (NOT a shell heredoc/echo — zero shell quoting) under a fresh dir `$CONTRACT_SCRATCH`:
- `$CONTRACT_SCRATCH/id`, `/producer`, `/description` (one scalar file each; omit `description` if empty),
- `$CONTRACT_SCRATCH/surface/1`, `/2`, … (one file per glob),
- `$CONTRACT_SCRATCH/consumers/1`, `/2`, … (one file per app).
Then set `CONTRACTS_JSON` to the LINKED universe's `contracts.json` path and run the block. `node` reads
each file and `JSON.stringify`s it, so a `"` / `\` / `$` / newline in any answer is neutralised. The
write is **additive + idempotent by `id`** (an existing `id` is left untouched) and **RSCT never commits
the universe** — after it writes, review + commit `contracts.json` in the universe repo yourself.

```bash
echo "  CHECKPOINT: Phase 4.11 executing contract additive-splice (text-splice)"
# CONTRACT_SCRATCH: dir of verbatim answer files (see above). CONTRACTS_JSON: the linked
# universe's contracts.json. Dev free-text reaches node ONLY as opaque file content — never
# the node -e source nor a shell assignment — so JSON.stringify makes it injection-safe.
CONTRACT_SCRATCH="${CONTRACT_SCRATCH:-}"
CONTRACTS_JSON="${CONTRACTS_JSON:-}"
if [ -z "$CONTRACT_SCRATCH" ] || [ ! -d "$CONTRACT_SCRATCH" ] || [ -z "$CONTRACTS_JSON" ] || [ ! -f "$CONTRACTS_JSON" ]; then
  echo "  SKIP: contract scratch dir or contracts.json missing — nothing spliced."
else
  # Additive bracket-balanced splice into the "contracts": [ ... ] array (mirrors Phase 4.8
  # appendRegistry). Never JSON.parse->stringify the whole file (CLAUDE.md #5); the only parses
  # are READ-ONLY (idempotency on the array region + a post-mutation validity check). Double-quoted
  # JS only (no apostrophe inside the single-quoted node -e); CRLF-tolerant; paths via argv.
  node -e '
    var fs = require("fs"), path = require("path");
    var dir = process.argv[1], target = process.argv[2];
    function rd(p) { try { return fs.readFileSync(p, "utf8").replace(/\r/g, "").replace(/\n+$/, "").trim(); } catch (e) { return ""; } }
    function rdArr(sub) { var d = path.join(dir, sub), out = []; try { fs.readdirSync(d).sort().forEach(function (n) { var v = rd(path.join(d, n)); if (v) out.push(v); }); } catch (e) {} return out; }
    var entry = { id: rd(path.join(dir, "id")), producer: rd(path.join(dir, "producer")), surface: rdArr("surface"), consumers: rdArr("consumers") };
    var desc = rd(path.join(dir, "description"));
    if (desc) entry.description = desc;
    if (!entry.id || !entry.producer) { console.error("  WARN: contract id/producer missing — nothing spliced."); process.exit(0); }
    var s;
    try { s = fs.readFileSync(target, "utf8"); } catch (e) { console.error("  WARN: contracts.json unreadable — nothing spliced."); process.exit(0); }
    var m = s.match(/("contracts"[ \t\r\n]*:[ \t\r\n]*)\[/);
    if (!m) { console.error("  WARN: contracts array not found — add the entry by hand."); process.exit(0); }
    var openIdx = m.index + m[0].length - 1;
    var i = openIdx + 1, depth = 1, inStr = false, esc = false;
    for (; i < s.length && depth > 0; i++) {
      var c = s[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === "\"") inStr = !inStr;
      else if (!inStr && c === "[") depth++;
      else if (!inStr && c === "]") depth--;
    }
    var closeIdx = i - 1;
    var inner = s.slice(openIdx + 1, closeIdx);
    var arr;
    try { arr = JSON.parse("[" + inner + "]"); } catch (e) { console.error("  WARN: existing contracts array is not valid JSON — fix it by hand first."); process.exit(0); }
    if (arr.some(function (e) { return e && e.id === entry.id; })) { console.log("  contracts.json already has id=" + entry.id + " — left as-is (no overwrite)."); process.exit(0); }
    var obj = JSON.stringify(entry);
    var ml = inner.indexOf("\n") !== -1;
    var rendered;
    if (inner.trim().length === 0) {
      rendered = ml ? ("\n    " + obj + "\n  ") : obj;
    } else {
      var tail = inner.replace(/[ \t\r\n]+$/, "");
      rendered = ml ? (tail + ",\n    " + obj + "\n  ") : (tail + ", " + obj);
    }
    var out = s.slice(0, openIdx + 1) + rendered + s.slice(closeIdx);
    try { JSON.parse(out); } catch (e) { console.error("  ERROR: splice would produce invalid JSON — aborted, contracts.json untouched."); process.exit(1); }
    fs.writeFileSync(target, out, "utf8");
    console.log("  added contract id=" + entry.id + " to contracts.json — review + commit the universe yourself.");
  ' "$CONTRACT_SCRATCH" "$CONTRACTS_JSON"
fi
```

After a successful splice, offer **"Declare another contract? `[y/N]`"** — each iteration RE-ENTERS the
Q&A and requires its OWN preview + explicit approval before its write (no blanket up-front yes). When
done, remind the dev once: the universe repo has **uncommitted** working changes — review + commit
`contracts.json` there yourself (RSCT never commits the universe).

### 4.V — INV-2.3 poison-pill closer (SessionStart sanitizer hook)

The §C-gated tools (`rsct_request_commit/_push/_merge`) require an
out-of-band `dev_approval` before mutating git. A "trust forever"
entry like `Bash(git commit:*)` in `.claude/settings.local.json` (or
the shared `.claude/settings.json`) would let the model bypass §C by
running git commit directly. This step installs a Claude Code
SessionStart hook that strips such entries at every session boot —
closing the bypass vector at the mechanical layer.

**Patterns stripped** (from `permissions.allow[]` in both
`.claude/settings.json` and `.claude/settings.local.json`):

- `Bash(git commit*)` / `Bash(git commit:*)` / `Bash(git commit -m "x")`
- `Bash(git push*)` / `Bash(git push:*)`
- `Bash(git merge*)` / `Bash(git merge:*)`
- `Bash(git*)` / `Bash(git:*)`
- `Bash(*)` / `Bash(:*)`

Benign entries (`Bash(npm test)`, `Edit`, `Read`, `WebFetch(domain:*)`,
`mcp__rsct__*`, even read-only git like `Bash(git status)`) are
preserved.

**Skipped when:** the `rsct-mcp` companion is NOT installed (sanitizer
script unavailable). Phase 4.V logs a clear warning and continues —
the rest of the framework still works; only the §C ceiling is left
with a bypass surface until `rsct-mcp` is installed and `/rsct-setup`
is re-run.

**4.V.a — Locate the sanitizer script**

The script ships inside the `rsct-mcp` npm package as
`dist/scripts/sanitize-permissions.js`. Discover its source path:

```bash
SANITIZER_SRC=""

# Candidate 1: rsct-mcp installed globally via `npm install -g .`
if command -v npm >/dev/null 2>&1; then
  NPM_GLOBAL_ROOT=$(npm root -g 2>/dev/null)
  # B3 (field-report): on Windows `npm root -g` returns a NATIVE path
  # (C:\Users\...\node_modules) with backslashes. The downstream `[ -f ]`,
  # `dirname`, and `tail` worked only by Git Bash mixed-separator tolerance
  # (C:\...\node_modules/rsct-mcp/dist/...) — fragile. Normalize to a POSIX
  # path under MSYS/MinGW/Cygwin via `cygpath -u`. On Linux/macOS cygpath does
  # not exist, so `command -v` fails and the value is preserved unchanged —
  # portable across all three OSes.
  if [ -n "$NPM_GLOBAL_ROOT" ] && command -v cygpath >/dev/null 2>&1; then
    NPM_GLOBAL_ROOT=$(cygpath -u "$NPM_GLOBAL_ROOT" 2>/dev/null || printf '%s' "$NPM_GLOBAL_ROOT")
  fi
  if [ -n "$NPM_GLOBAL_ROOT" ] && \
     [ -f "$NPM_GLOBAL_ROOT/rsct-mcp/dist/scripts/sanitize-permissions.js" ]; then
    SANITIZER_SRC="$NPM_GLOBAL_ROOT/rsct-mcp/dist/scripts/sanitize-permissions.js"
  fi
fi

# Candidate 2: source-clone development path
# (Override via env var RSCT_FRAMEWORK_SOURCE pointing at the framework root)
if [ -z "$SANITIZER_SRC" ] && [ -n "$RSCT_FRAMEWORK_SOURCE" ] && \
   [ -f "$RSCT_FRAMEWORK_SOURCE/mcp-server/dist/scripts/sanitize-permissions.js" ]; then
  SANITIZER_SRC="$RSCT_FRAMEWORK_SOURCE/mcp-server/dist/scripts/sanitize-permissions.js"
fi

if [ -z "$SANITIZER_SRC" ]; then
  echo "WARN: rsct-mcp sanitizer script not found."
  echo "      Phase 4.V skipped — INV-2.3 poison-pill closer not installed."
  echo "      To install: install rsct-mcp companion (mcp-server/README.md),"
  echo "      then re-run /rsct-setup."
fi
```

Once `SANITIZER_SRC` is resolved, extract the `rsct-mcp` version from
the adjacent `package.json`. Used in Phase 4.V.b to stamp the copied
script with the version that produced it, so future re-runs can detect
drift and warn the dev.

```bash
RSCT_MCP_VERSION=""
if [ -n "$SANITIZER_SRC" ]; then
  # SANITIZER_SRC is always at <root>/dist/scripts/sanitize-permissions.js,
  # so package.json sits three dirnames up.
  CANDIDATE_PKG_JSON="$(dirname "$(dirname "$(dirname "$SANITIZER_SRC")")")/package.json"
  if [ -f "$CANDIDATE_PKG_JSON" ]; then
    RSCT_MCP_VERSION=$(
      grep -E '^\s*"version"' "$CANDIDATE_PKG_JSON" 2>/dev/null \
        | head -1 \
        | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
    )
  fi
fi
RSCT_MCP_VERSION="${RSCT_MCP_VERSION:-unknown}"
```

**4.V.b — Copy the script into the project (idempotent, version-stamped)**

The copied script gains a version stamp on line 2 so a later run of
`/rsct-setup` can compare against the source's current version and
warn the dev that an upgrade is landing — MED-11 in the post-M2 audit.
The script is invoked as `node <path>` from the hook, so a `// comment`
between the shebang and the imports is parsed away by Node without
behavioral change.

```bash
echo "  CHECKPOINT: Phase 4.V.b executing canonical sanitizer script copy"
if [ -n "$SANITIZER_SRC" ]; then
  # B1 (field-report): relative mkdir so a UNC project root (//wsl.localhost/...
  # on WSL2-from-Windows) does not trip EROFS walking from the read-only mount
  # root. The cwd is the project root; the absolute write below still works.
  mkdir -p ".rsct/scripts" || { echo "  ⚠ ERROR: cannot create .rsct/scripts" >&2; exit 1; }
  # B4 (field-report): the sanitizer ships as ESM (`import ... from 'fs'`). When
  # copied as a bare `.js`, Node resolves the module type from the NEAREST
  # package.json walking up the tree — in a CommonJS project (Laravel/Vite, or
  # any project whose root package.json lacks "type":"module"), or with no
  # package.json at all, `.js` defaults to CommonJS and Node throws "Cannot use
  # import statement outside a module" when the SessionStart hook runs it. A
  # package.json scoped to .rsct/scripts/ pins ESM regardless of the host
  # project's module system.
  # F2 (field-report): write ONLY when absent or content actually differs. The
  # file is byte-identical every run, so an unconditional rewrite flips CRLF->LF
  # on autocrlf=true Windows checkouts and shows a phantom 'modified' file with
  # an empty diff. The `$(...)` strips the trailing newline; `tr -d '\r'`
  # normalizes CRLF so the compare is content-only (anti-pattern #4).
  RSCT_SCRIPTS_PKG='{ "type": "module" }'
  if [ ! -f ".rsct/scripts/package.json" ] \
     || [ "$(tr -d '\r' < ".rsct/scripts/package.json" 2>/dev/null)" != "$RSCT_SCRIPTS_PKG" ]; then
    printf '%s\n' "$RSCT_SCRIPTS_PKG" > ".rsct/scripts/package.json" \
      || { echo "  ⚠ ERROR: cannot write .rsct/scripts/package.json" >&2; exit 1; }
  fi
  TARGET="$(pwd)/.rsct/scripts/sanitize-permissions.js"

  # Read existing version stamp if a prior /rsct-setup placed one.
  # Stamp format on line 2: "// rsct-mcp v=X.Y.Z — installed ..."
  EXISTING_MCP_VERSION=""
  if [ -f "$TARGET" ]; then
    EXISTING_MCP_VERSION=$(sed -n '2p' "$TARGET" 2>/dev/null \
      | grep -oE 'v=[0-9][^ ]*' | sed 's/^v=//')
  fi

  # Print a clear status line before overwriting.
  if [ -z "$EXISTING_MCP_VERSION" ]; then
    if [ -f "$TARGET" ]; then
      echo "  installing sanitizer (rsct-mcp v$RSCT_MCP_VERSION) — replacing unstamped copy"
    else
      echo "  installing sanitizer (rsct-mcp v$RSCT_MCP_VERSION)"
    fi
  elif [ "$EXISTING_MCP_VERSION" = "$RSCT_MCP_VERSION" ]; then
    echo "  sanitizer at rsct-mcp v$RSCT_MCP_VERSION (checking for changes)"
  else
    echo "  ⚠ updating sanitizer: rsct-mcp v$EXISTING_MCP_VERSION → v$RSCT_MCP_VERSION"
  fi

  # Target content: shebang line 1, version stamp line 2 (DETERMINISTIC — no
  # per-run timestamp), then the source body from line 2 (skip its shebang).
  # G2 (field-report): the old stamp embedded `installed at <timestamp>`, so an
  # unconditional rewrite churned the file on EVERY re-run (a 1-line diff + a
  # CRLF flip on autocrlf=true Windows) even when the rsct-mcp version was
  # identical. Drop the timestamp (drift detection keys off the `v=` version,
  # which stays; install time is already in git history / the audit log) and
  # write ONLY when the content differs. `tr -d '\r'` makes the compare
  # content-only so a CRLF-normalized on-disk copy is not needlessly rewritten.
  SANITIZER_DESIRED=$(
    echo "#!/usr/bin/env node"
    echo "// rsct-mcp v=$RSCT_MCP_VERSION — installed by /rsct-setup"
    tail -n +2 "$SANITIZER_SRC"
  )
  if [ -f "$TARGET" ] && [ "$(tr -d '\r' < "$TARGET")" = "$(printf '%s' "$SANITIZER_DESIRED" | tr -d '\r')" ]; then
    echo "  sanitizer already current (rsct-mcp v$RSCT_MCP_VERSION) — no rewrite needed"
  else
    printf '%s\n' "$SANITIZER_DESIRED" > "$TARGET" \
      || { echo "  ⚠ ERROR: write failed for .rsct/scripts/sanitize-permissions.js" >&2; exit 1; }
    # A2 (field-report): confirm the copy landed before the phase reports success.
    if [ ! -f "$TARGET" ]; then
      echo "  ⚠ ERROR: .rsct/scripts/sanitize-permissions.js not created — aborting" >&2
      exit 1
    fi
  fi
fi
```

Re-running `/rsct-setup` overwrites the in-project copy with the
shipped version (always — the source is the source of truth). The
diff message gives the dev visibility into an `rsct-mcp` upgrade that
just landed. Devs should NOT hand-edit `.rsct/scripts/`.

**4.V.c — Register the SessionStart hook (idempotent)**

Hook entry shape registered in `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PROJECT_DIR}/.rsct/scripts/sanitize-permissions.js"
          }
        ]
      }
    ]
  }
}
```

The script also reads `--project-root`, `$CLAUDE_PROJECT_DIR`, and
finally falls back to `cwd` — so Windows path-mangling of
`${CLAUDE_PROJECT_DIR}` in the command string does not break the
hook.

Idempotency check: scan existing `hooks.SessionStart[]` for any
command containing the substring `.rsct/scripts/sanitize-permissions.js`.
If present → no-op. If absent → append.

```bash
echo "  CHECKPOINT: Phase 4.V.c executing canonical structured-merge SessionStart hook install"
# EXCEPTION: structured merge required. This is the only block in 01-setup.md
# that legitimately uses JSON.parse / JSON.stringify on .claude/settings.json.
# Reason: the hook entry has to nest into hooks.SessionStart[].hooks[] — a
# text-based regex insertion cannot guarantee correct nesting across the
# legitimate variability of dev-customized settings.json shapes. The reformat
# of dev whitespace inside .claude/settings.json is the accepted cost here;
# this file is framework-managed for its hook section, and the dev's other
# settings (model, theme, etc.) survive JSON.parse round-trip semantically
# intact.
if [ -n "$SANITIZER_SRC" ]; then
  SETTINGS_PATH="$(pwd)/.claude/settings.json"
  # B1 (field-report): relative mkdir to survive a UNC project root
  # (//wsl.localhost/...). SETTINGS_PATH stays absolute — node reads/writes the
  # UNC path fine; only `mkdir -p` walking the read-only mount root is hostile.
  mkdir -p ".claude" || { echo "  ⚠ ERROR: cannot create .claude" >&2; exit 1; }
  node -e '
    const fs = require("fs");
    const target = process.argv[1];
    const HOOK_CMD = "node ${CLAUDE_PROJECT_DIR}/.rsct/scripts/sanitize-permissions.js";
    const MARKER = ".rsct/scripts/sanitize-permissions.js";
    let settings = {};
    if (fs.existsSync(target)) {
      try {
        settings = JSON.parse(fs.readFileSync(target, "utf8"));
      } catch (e) {
        console.error("ERROR: " + target + " is malformed JSON — fix manually then re-run /rsct-setup.");
        process.exit(1);
      }
    }
    settings.hooks = settings.hooks || {};
    settings.hooks.SessionStart = settings.hooks.SessionStart || [];
    const already = settings.hooks.SessionStart.some(group =>
      Array.isArray(group && group.hooks) && group.hooks.some(h =>
        h && typeof h.command === "string" && h.command.indexOf(MARKER) !== -1
      )
    );
    if (already) {
      console.log("RSCT SessionStart sanitizer hook already present — no change.");
    } else {
      settings.hooks.SessionStart.push({
        hooks: [{ type: "command", command: HOOK_CMD }]
      });
      fs.writeFileSync(target, JSON.stringify(settings, null, 2) + "\n", "utf8");
      console.log("Installed RSCT SessionStart sanitizer hook in " + target);
    }
  ' "$SETTINGS_PATH"
fi
```

**4.V.d — Install the PreToolUse edit-scope guard (plan-lifecycle-v2)**

The `edit-scope-guard.js` script ships in the SAME `rsct-mcp`
`dist/scripts/` directory as the sanitizer. Registered as a **PreToolUse**
hook matched on the four editor tools, it BLOCKS an `Edit`/`Write`/
`MultiEdit`/`NotebookEdit` (exit code 2) when the RSCT context is stale (a
plan closed) or the target is out of the active spec scope — the mechanical
half of the re-bootstrap gate (item 5). It fails **open** on any infra fault
(missing/corrupt state, unmanaged project) so a broken guard never bricks
editing. Gate the whole phase on `[ -n "$SANITIZER_SRC" ]` (rsct-mcp
available, from 4.V.a) — the guard ships in the same package.

```bash
echo "  CHECKPOINT: Phase 4.V.d executing canonical edit-scope guard install"
if [ -n "$SANITIZER_SRC" ]; then
  # The guard sits beside the sanitizer (same dist/scripts/ dir).
  GUARD_SRC="$(dirname "$SANITIZER_SRC")/edit-scope-guard.js"
  if [ ! -f "$GUARD_SRC" ]; then
    echo "  ⚠ edit-scope-guard.js not found beside the sanitizer (older rsct-mcp?) — PreToolUse guard skipped; rebuild/upgrade rsct-mcp and re-run /rsct-setup." >&2
  else
    mkdir -p ".rsct/scripts" || { echo "  ⚠ ERROR: cannot create .rsct/scripts" >&2; exit 1; }
    GUARD_TARGET="$(pwd)/.rsct/scripts/edit-scope-guard.js"
    # Version-stamped, content-diff-gated write (mirror 4.V.b): shebang line 1,
    # deterministic stamp line 2, source body from line 2. `tr -d '\r'` makes the
    # compare content-only so a CRLF-normalized on-disk copy is not rewritten
    # (anti-pattern #4). No per-run timestamp (drift keys off `v=`).
    GUARD_DESIRED=$(
      echo "#!/usr/bin/env node"
      echo "// rsct-mcp v=$RSCT_MCP_VERSION — installed by /rsct-setup"
      tail -n +2 "$GUARD_SRC"
    )
    if [ -f "$GUARD_TARGET" ] && [ "$(tr -d '\r' < "$GUARD_TARGET")" = "$(printf '%s' "$GUARD_DESIRED" | tr -d '\r')" ]; then
      echo "  edit-scope guard already current (rsct-mcp v$RSCT_MCP_VERSION) — no rewrite needed"
    else
      printf '%s\n' "$GUARD_DESIRED" > "$GUARD_TARGET" \
        || { echo "  ⚠ ERROR: write failed for .rsct/scripts/edit-scope-guard.js" >&2; exit 1; }
      [ -f "$GUARD_TARGET" ] || { echo "  ⚠ ERROR: edit-scope-guard.js not created — aborting" >&2; exit 1; }
      echo "  installed edit-scope guard (rsct-mcp v$RSCT_MCP_VERSION)"
    fi

    # Register the PreToolUse hook (idempotent structured merge — same sanctioned
    # JSON.parse/stringify exception as 4.V.c: the entry nests into
    # hooks.PreToolUse[].hooks[] with a `matcher`, so a text splice cannot
    # guarantee correct shape). The command reads $CLAUDE_PROJECT_DIR / cwd, so
    # Windows path-mangling of the literal does not break it.
    SETTINGS_PATH="$(pwd)/.claude/settings.json"
    mkdir -p ".claude" || { echo "  ⚠ ERROR: cannot create .claude" >&2; exit 1; }
    node -e '
      const fs = require("fs");
      const target = process.argv[1];
      const HOOK_CMD = "node ${CLAUDE_PROJECT_DIR}/.rsct/scripts/edit-scope-guard.js";
      const MARKER = ".rsct/scripts/edit-scope-guard.js";
      const MATCHER = "^(Edit|Write|MultiEdit|NotebookEdit)$";
      let settings = {};
      if (fs.existsSync(target)) {
        try {
          settings = JSON.parse(fs.readFileSync(target, "utf8"));
        } catch (e) {
          console.error("ERROR: " + target + " is malformed JSON — fix manually then re-run /rsct-setup.");
          process.exit(1);
        }
      }
      settings.hooks = settings.hooks || {};
      settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
      const already = settings.hooks.PreToolUse.some(group =>
        Array.isArray(group && group.hooks) && group.hooks.some(h =>
          h && typeof h.command === "string" && h.command.indexOf(MARKER) !== -1
        )
      );
      if (already) {
        console.log("RSCT PreToolUse edit-scope guard hook already present — no change.");
      } else {
        settings.hooks.PreToolUse.push({
          matcher: MATCHER,
          hooks: [{ type: "command", command: HOOK_CMD }]
        });
        fs.writeFileSync(target, JSON.stringify(settings, null, 2) + "\n", "utf8");
        console.log("Installed RSCT PreToolUse edit-scope guard hook in " + target);
      }
    ' "$SETTINGS_PATH"
  fi
fi
```

Re-running `/rsct-setup` refreshes the copied guard and is idempotent on
the hook entry (keyed off the `.rsct/scripts/edit-scope-guard.js`
substring). Devs should NOT hand-edit `.rsct/scripts/`.

**4.V.c2 — Register project-scope MCP (committable `.mcp.json`) (CAP-48)**

When the dev chose **[2] Project scope** at install time, `scripts/install.sh`
wrote `project` to `$HOME/.rsct/mcp-scope`. This step materializes that choice
as a committable `.mcp.json` in the project root, so the whole team shares the
`rsct` MCP registration via git (each teammate still needs `rsct-mcp` on their
PATH — i.e. they ran the installer). For `user` / `skip` / absent, this step is
a no-op — a user-scope registration already resolves in every project.

Gate on `[ -n "$SANITIZER_SRC" ]` (rsct-mcp available, from 4.V.a) AND the flag.

```bash
echo "  CHECKPOINT: Phase 4.V.c2 evaluating project-scope MCP registration"
# Guard the read with [ -f ] first: a `< missing` redirect prints "No such
# file" to the shell's stderr BEFORE the command's own `2>/dev/null` applies,
# so the bare redirect would leak noise when no install flag exists (e.g. the
# prompt was run without scripts/install.sh).
MCP_SCOPE=""
[ -f "$HOME/.rsct/mcp-scope" ] && MCP_SCOPE="$(tr -d '\r' < "$HOME/.rsct/mcp-scope" | head -1)"
if [ -n "$SANITIZER_SRC" ] && [ "$MCP_SCOPE" = "project" ]; then
  MCP_JSON="$(pwd)/.mcp.json"
  # EXCEPTION: structured merge required. Like the .claude/settings.json hook
  # block (4.V.c), the rsct entry must nest into mcpServers.<name>, so a text
  # splice cannot guarantee correct shape across dev-customized .mcp.json files.
  # The server NAME "rsct" IS the marker (JSON has no comments) — see the
  # `.mcp.json` marker convention in Phase 4.4b.
  #
  # The entry uses `args: []` (the form `claude mcp add` writes) — NO hardcoded
  # path and NO `${workspaceFolder}` placeholder. CAP-49: an earlier version
  # wrote `args:["--project-root","${workspaceFolder}"]`, but Claude Code does
  # NOT expand that placeholder — the server received it literally and resolved
  # it against its cwd (C:\Windows on WSL-from-Windows), reporting
  # rsct_installed:false for EVERY user. With empty args the server auto-detects
  # the root (cwd / CLAUDE_PROJECT_DIR), which is also what keeps the committed
  # file portable for the team (no machine-specific path). Idempotent by key,
  # and it MIGRATES a stale CAP-48 entry whose args still carry the placeholder.
  node -e '
    const fs = require("fs");
    const target = process.argv[1];
    let cfg = {};
    if (fs.existsSync(target)) {
      try { cfg = JSON.parse(fs.readFileSync(target, "utf8")); }
      catch (e) { console.error("ERROR: " + target + " is malformed JSON — fix manually then re-run /rsct-setup."); process.exit(1); }
    }
    cfg.mcpServers = cfg.mcpServers || {};
    const existing = cfg.mcpServers.rsct;
    const argsArr = existing && Array.isArray(existing.args) ? existing.args : [];
    const stale = argsArr.some(a => typeof a === "string" && (a.indexOf("${") !== -1 || a === "--project-root"));
    if (existing && !stale) {
      console.log("  .mcp.json already registers rsct (project scope) — no change.");
    } else if (existing && stale) {
      cfg.mcpServers.rsct = { ...existing, args: [] };
      fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      console.log("  migrated .mcp.json: dropped the broken ${workspaceFolder} arg (CAP-49) — commit the change.");
    } else {
      cfg.mcpServers.rsct = { command: "rsct-mcp", args: [] };
      fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      console.log("  registered rsct in .mcp.json (project scope) — commit it to share with your team.");
    }
  ' "$MCP_JSON"
  echo "    Note: each teammate still needs rsct-mcp installed (binary on PATH)."
  echo "    If you ALSO have a user-scope rsct registration, it already resolves"
  echo "    locally — the committed .mcp.json is what makes it portable to the team."
elif [ -n "$SANITIZER_SRC" ]; then
  # CAP-50 (audit #3): scope is not 'project'. If a committed project .mcp.json
  # already registers rsct (a teammate set it up, or this dev switched scope),
  # do NOT touch it — it is shared via git; rewriting/removing it here would
  # surprise the team or dirty the tree. Just inform. (A stale ${workspaceFolder}
  # arg is harmless at runtime — the server sanitizes it, CAP-49 — and a
  # project-scope re-run or /rsct-uninstall will migrate/remove it.)
  MCP_JSON="$(pwd)/.mcp.json"
  if [ -f "$MCP_JSON" ] && grep -q '"rsct"' "$MCP_JSON" 2>/dev/null; then
    echo "  Phase 4.V.c2: MCP scope is '${MCP_SCOPE:-unset}', but this project has a committed"
    echo "    .mcp.json registering rsct (project scope). Leaving it intact (shared via git)."
    echo "    Run /rsct-uninstall to remove it, or re-run setup with project scope to refresh it."
  else
    echo "  Phase 4.V.c2: MCP scope is '${MCP_SCOPE:-unset}' (not project) — .mcp.json not written."
  fi
fi
```

The `.mcp.json` is meant to be **committed** (team sharing). The RSCT
`.gitignore` block (Phase 4.4b) does NOT list `.mcp.json`, so it stays
trackable. (The framework repo's own `.gitignore` ignores its dev `.mcp.json`,
but that is the framework repo — not a target project.)

**4.V.d — Verify**

After `/rsct-setup` completes, restart Claude Code so the hook is
loaded. Next session boot will:

1. Fire the SessionStart hook.
2. Run `node .rsct/scripts/sanitize-permissions.js`.
3. Strip any matching poison-pill entry from
   `.claude/settings{,.local}.json`.
4. Append a `sanitize.stripped` or `sanitize.malformed` line to
   `.rsct/audit.log` if anything was changed.
5. Exit 0 unconditionally — a malformed settings file logs to stderr
   but never blocks session start.

**INV-2.3 closes here.** Without 4.V, the §C ceiling has a "trust
forever" bypass surface; with 4.V, that surface is wiped at every
session boot.

---

## Phase 5 — Review and commit

1. Show CLAUDE.md diff — highlight migrated sections and new sections separately.
2. List all files created/modified — names only:
   - `.rsct.json` (with install block)
   - `documentation/` files (each with RSCT-GENERATED header)
   - memory entries (each with RSCT-GENERATED header)
3. **Stamp the §0 bootstrap marker** (C2, field-report) — when `rsct-mcp` is
   installed, call `mcp__rsct__rsct_status` **once now**. `/rsct-setup` itself
   never calls `rsct_status`/`rsct_load_context`, so `.rsct/phase-state.json`
   is created without a `bootstrap_at` stamp — and the very first
   `rsct_request_commit` / `_push` / `_merge` after setup then warns "bootstrap
   not detected" even though setup just ran. One `rsct_status` call stamps the
   marker (`stampBootstrapMarker`, CAP-31) and silences that spurious warning.
   Skip when `rsct-mcp` is not installed (no tool to call).
   - **Windows/WSL caveat (field-report F5):** the MCP server in THIS session is
     still running with the config from before setup. If a project-scope
     `.mcp.json` was just created or migrated this run (Phase 4.V.c2), the server
     has not reloaded it, and on WSL-from-Windows its cwd is `C:\Windows` — so a
     bare `rsct_status` may resolve the wrong root / `rsct_installed: false`.
     Pass `project_root` **explicitly** (the absolute project path) to this
     `rsct_status` call until Claude Code is restarted and the server reloads.
4. Run leak review — **tracked diff AND untracked new files**:
   ```bash
   # C3 (field-report): `git diff` alone does NOT see the files setup just
   # CREATED (documentation/, .rsct.json, memory entries, the sanitizer) —
   # they are untracked until `git add`. Scan both. The definitive gate is
   # still rsct_request_commit's INV-6 (staged diff) at commit time; this is
   # the pre-commit human review. `-iE` is portable (the `-i`+`-F` combo
   # SIGABRTs on Git Bash grep 3.0 — see CLAUDE.md anti-pattern #7 — but `-iE`
   # is fine). `grep -I` skips binaries; trailing /dev/null forces filenames.
   LEAK_RE="password|secret|token|api[_.]key|jwt|cpf|/home/[a-zA-Z]|C:\\\\Users\\\\"
   git diff 2>/dev/null | grep -iE "$LEAK_RE"
   while IFS= read -r f; do
     [ -f "$f" ] || continue
     # #3 (field-report): skip framework-GENERATED artifacts from this HUMAN
     # review — their content is canonical template text (the §E/§H rules
     # literally name "secret/token/jwt/cpf") or, for .rsct.json, the
     # secrets_extra_patterns var NAMES by design — so they are noise, not real
     # leaks. The definitive gate (rsct_request_commit's INV-6 on the staged
     # diff) still scans everything; dev-authored files are NOT skipped here.
     case "$f" in
       .rsct.json) continue ;;
     esac
     head -n 1 "$f" 2>/dev/null | grep -q 'RSCT-GENERATED' && continue
     grep -IinE "$LEAK_RE" "$f" /dev/null
   done < <(git ls-files --others --exclude-standard 2>/dev/null)
   ```
5. Suggest commit message (< 100 chars):
   ```
   chore: apply RSCT v1.0.0 [migrated: §X §Y] [added: §Z] + docs
   ```
6. **Wait for updated OK** before `git add` / `commit` / `push`.
7. If on protected branch: require explicit reconfirmed OK.
8. **Fresh-install pointer (DX-1):** if `rsct-mcp` was NOT installed/loaded during THIS run
   (so Phase 1.9b was skipped — typically the first `/rsct-setup`, before the IDE restart
   that loads the MCP), print: "RSCT installed. Restart the IDE and run `/rsct-setup` again —
   then I can detect the other repositories in your org and offer to set up shared governance
   (universe + contracts)." This is the honest second-run capability (the
   detector loads only after the restart). Skip this line when the MCP was already available
   this run (the orchestration already happened in Phase 3).

---

## Reminder: §B always includes §F and §G checks

When presenting any development plan in future sessions:

**§F check**: "Does this flow change persistent state? Is a reverse operation
needed? Who has permission to execute it?"

**§G check**: "Do you want automated tests included in this plan?"
- Yes → add test strategy as part of the plan options
- No → confirm manual tests before closing the task

---

## Reminder: this install is reversible

Everything `/rsct-setup` does to the project can be undone by `/rsct-uninstall`.
The robustness depends on:
- **RSCT markers** added by this setup (in CLAUDE.md sections and at the top
  of every generated file) — uninstall scans for these
- **`install.setup_commit_sha_before`** in `.rsct.json` — uninstall uses this
  to offer `git checkout` restore for migrated PT-BR sections
- **SHA256 in each file marker** — uninstall uses this to detect dev edits
  and protect modified files from accidental deletion

If any of these are missing or tampered with, uninstall will report the
issue and require user decision before acting.
