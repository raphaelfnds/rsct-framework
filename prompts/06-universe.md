# RSCT Universe — 06-universe.md

You are operating the **unified `/rsct-universe` command**. It replaces the two
older commands (`/rsct-init-universe` and `/rsct-canonical-source`) with one
smart, idempotent entry point: it **detects the current state** and does the
right thing — bootstrap the org universe if none exists, adjust/refresh it if
it does, and/or link THIS project to it.

When there is no universe yet, one run does **both**: it creates the universe
and then links this project to it. That is the unification — the dev should
never have to run the command twice to get from nothing to linked.

Read this entire file before executing any action.

---

## What a "universe" is

A single-source-of-truth repository for an organization: architecture diagrams,
governance docs (LGPD, DNS, naming, retention), and the inventory of apps and
hosts. It is created once per org, then every project links to it.

This command unifies two responsibilities that used to be separate commands:

- **Create / adjust the universe repo** (was `/rsct-init-universe`).
- **Link this project to the universe** (was `/rsct-canonical-source`).

The heavy lifting still lives in `prompts/04-init-universe.md` (create/adjust)
and `prompts/02-canonical-source.md` (link). This file is the **dispatcher**:
it runs one shared discovery probe, decides the state, and then instructs you to
execute the matching engine prompt.

---

## ⛔ Execution mandate

Same contract as `prompts/01-setup.md`'s execution mandate:

1. **Execute every fenced `bash` block literally.** Do NOT translate to
   Node / PowerShell / TS. The discovery probe below is the canonical,
   cross-OS-hardened detector; a re-implementation will diverge on EOL / regex
   escaping.
2. **Single sed dialect: ERE (`sed -E`) only** — never paste a BRE
   `sed 's|...\(...\)...|\1|'` form (CAP-18 silent mis-capture). Alternation via
   ERE `(a|b)` or char classes, never `\|`. `tr -d '\r'` before every
   `$`-anchored match or SHA. `case "$(uname -s)"` for any `sed -i` (BSD `''`
   vs GNU). One `sha256_compute` helper — do NOT duplicate divergent copies.
3. **Do NOT reformat managed files.** The engine prompts (02 / 04) use targeted
   `sed`/splice edits, never `JSON.parse → JSON.stringify` round-trips.
4. **CHECKPOINT lines surface obedience.** Keep them.
5. **If a block looks buggy, STOP and report it as a framework bug.**

---

## Phase 1 — Unified silent discovery (no output yet, no mutations)

Run the canonical probe (superset of the old 02 + 04 probes — single ERE
dialect, CRLF-tolerant):

```bash
echo "  CHECKPOINT: Phase 1 executing canonical unified universe discovery probe"

# (a) Org slug — from the git remote (github.com[:/]<org>/...), ERE only; fall
#     back to app.org in .rsct.json. tr -d CR throughout (anti-pattern #4).
REMOTE_URL="$(git config --get remote.origin.url 2>/dev/null | tr -d '\r')"
ORG_SLUG=""
if [ -n "$REMOTE_URL" ]; then
  ORG_SLUG="$(printf '%s\n' "$REMOTE_URL" | sed -E 's#.*github\.com[:/]([^/]+)/.*#\1#' | tr -d '\r')"
fi
if [ -z "$ORG_SLUG" ] && [ -f "./.rsct.json" ]; then
  ORG_SLUG="$(grep -E '"org"' "./.rsct.json" 2>/dev/null \
    | sed -E 's/.*"org"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' | tr -d '\r' | head -1)"
fi

# (b) Universe name = org slug minus a trailing -NN suffix (e.g. acme-01 → acme).
UNIVERSE_NAME="$(printf '%s\n' "$ORG_SLUG" | sed -E 's/-[0-9]+$//')"

# (c) Am I INSIDE a universe repo already? A universe skeleton carries a
#     .universe.json marker and/or a top-level contracts.json (04 writes them).
INSIDE_UNIVERSE="no"
if [ -f "./.universe.json" ] || [ -f "./contracts.json" ]; then
  INSIDE_UNIVERSE="yes"
fi

# (d) Is THIS project already linked? (.rsct.json universe block OR the
#     CLAUDE.md canonical-source markers written by 02.)
PROJECT_LINKED="no"
if [ -f "./.rsct.json" ] && grep -qE '"universe"[[:space:]]*:' "./.rsct.json" 2>/dev/null; then
  PROJECT_LINKED="yes"
fi
if [ "$PROJECT_LINKED" = "no" ] && [ -f "./CLAUDE.md" ] \
   && grep -qF "RSCT-CANONICAL-SOURCE-BEGIN" "./CLAUDE.md" 2>/dev/null; then
  PROJECT_LINKED="yes"
fi

# (e) SUPERSET path probe — search for an existing universe folder across the
#     union of the old 02 + 04 candidate roots, trying BOTH the derived
#     UNIVERSE_NAME and the raw ORG_SLUG, with and without a -universe suffix.
#     First existing directory wins.
UNIVERSE_PATH=""
if [ "$INSIDE_UNIVERSE" = "yes" ]; then
  UNIVERSE_PATH="$(pwd)"
else
  for base in ".." "$HOME/projetos" "$HOME/projects" "$HOME/dev" "$HOME/workspace" "$HOME"; do
    for nm in "$UNIVERSE_NAME" "$ORG_SLUG"; do
      [ -n "$nm" ] || continue
      for cand in "$base/$nm-universe" "$base/$nm/universe" "$base/$nm"; do
        if [ -f "$cand/.universe.json" ] || [ -f "$cand/contracts.json" ]; then
          UNIVERSE_PATH="$cand"
          break 3
        fi
      done
    done
  done
fi

# (f) Ask-once guard: if the dev previously DECLINED creating a universe, honor it.
CREATE_DECLINED=""
if [ -f "./.rsct.json" ]; then
  CREATE_DECLINED="$(grep -E '"create_universe_declined_at"' "./.rsct.json" 2>/dev/null \
    | sed -E 's/.*"create_universe_declined_at"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' | tr -d '\r' | head -1)"
fi

echo "ORG_SLUG=$ORG_SLUG"
echo "UNIVERSE_NAME=$UNIVERSE_NAME"
echo "INSIDE_UNIVERSE=$INSIDE_UNIVERSE"
echo "PROJECT_LINKED=$PROJECT_LINKED"
echo "UNIVERSE_PATH=${UNIVERSE_PATH:-<none found>}"
echo "CREATE_DECLINED=${CREATE_DECLINED:-<no>}"
```

---

## Phase 2 — State determination + routing

Using the probe results, determine the state and execute the matching engine
prompt. **Announce the detected state to the dev in one line before acting**,
and when a state is destructive-ish (creating a repo) confirm first.

| State | Condition | Action |
|---|---|---|
| **A — Inside the universe** | `INSIDE_UNIVERSE=yes` | **Adjust/refresh** the universe skeleton: execute **`prompts/04-init-universe.md`** in its idempotent re-run/update mode (it never overwrites existing files; only adds what is missing). |
| **B — No universe found** | `INSIDE_UNIVERSE=no` AND `UNIVERSE_PATH=<none>` | **Create the org universe AND link this project — both, in one run.** See "State B is a two-step chain" below. If `CREATE_DECLINED` is set, restate that the dev previously declined and ask whether to proceed anyway before creating. |
| **C — Universe exists, project not linked** | `UNIVERSE_PATH` found AND `PROJECT_LINKED=no` | **Link** this project: execute **`prompts/02-canonical-source.md`** (it writes the `## 0. Canonical architectural source` section into CLAUDE.md and the `.rsct.json` universe block, pointing at `UNIVERSE_PATH`). |
| **D — Exists and linked** | `UNIVERSE_PATH` found AND `PROJECT_LINKED=yes` | **Refresh** the link: re-run **`prompts/02-canonical-source.md`** in its UPDATE mode (idempotent marker re-write) so the canonical-source section reflects any path/name change. Report "already linked — refreshed" when nothing changed. |

**How to "execute" an engine prompt:** READ the referenced prompt file
(`prompts/04-init-universe.md` or `prompts/02-canonical-source.md`) in full and
follow it literally from its Phase 1 onward, reusing the values you already
discovered (`ORG_SLUG`, `UNIVERSE_NAME`, `UNIVERSE_PATH`) instead of
re-probing. Do NOT duplicate their bash here — they remain the canonical
engines; this dispatcher only decides WHICH one runs.

### State B is a two-step chain — create THEN link

This is the whole point of unifying the two commands: a dev with no universe
runs ONE command and ends up with a universe **and** a linked project. `04`
creates the universe; it does not touch this project's `CLAUDE.md` or
`.rsct.json`. So state B must not stop at creation — stopping there leaves the
dev unlinked, having to run `/rsct-universe` a second time to reach state C.

With the dev's OK at each step:

1. **Create** — execute `prompts/04-init-universe.md` (fresh init). Take the
   path it reports as `Universe created at:` as `<new-universe-path>`.
2. **Verify before linking** — the created universe must actually be on disk:

```bash
echo "  CHECKPOINT: Phase 2 executing canonical post-create universe verification"
# NEW_UNIVERSE_PATH is the path 04 reported as "Universe created at:".
NEW_UNIVERSE_PATH="${NEW_UNIVERSE_PATH:-}"
if [ -n "$NEW_UNIVERSE_PATH" ] && [ -f "$NEW_UNIVERSE_PATH/.universe.json" ]; then
  echo "UNIVERSE_CREATED=yes"
  echo "UNIVERSE_PATH=$NEW_UNIVERSE_PATH"
else
  echo "UNIVERSE_CREATED=no"
fi
```

   If `UNIVERSE_CREATED=no` (creation aborted, was declined, or templates were
   missing): **STOP the chain cleanly.** Tell the dev nothing was linked and
   that re-running `/rsct-universe` is safe. Do NOT attempt the link — linking
   to a universe that is not there writes a broken `universe.local`.
3. **Link** — execute `prompts/02-canonical-source.md` with `UNIVERSE_PATH` set
   to the verified `<new-universe-path>`. This is state C's action; it OWNS
   `universe.local`, `canonical_source_added` and the CLAUDE.md section.

Report both outcomes in the final line ("universe created at X and this project
linked to it"), and never claim the link when step 2 stopped the chain.

**Idempotency:** every state is safe to re-run. A → adds only missing skeleton
files; B → after the first run the probe finds the universe, so a re-run lands
in C or D rather than creating a second one; C/D → marker-guarded
CLAUDE.md/`.rsct.json` edits that do not duplicate.

---

## Notes

- The old `/rsct-init-universe` and `/rsct-canonical-source` commands are
  **removed** at install time (`scripts/install.sh` no longer generates their
  stubs and deletes any left over) — only `/rsct-universe` remains for the dev.
  The engine prompt files (02 / 04) stay in the repo because this dispatcher
  reuses them.
- If `rsct-mcp` is installed, its `mcp__rsct__rsct_get_universe` /
  `_get_topology` tools read the linked universe at runtime; this command is
  only about creating/adjusting/linking, not runtime consultation.
