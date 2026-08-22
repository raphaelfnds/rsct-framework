#!/usr/bin/env bash
# scripts/install.sh
# Installs RSCT framework to ~/.rsct/ and registers Claude Code slash commands.
# Optionally installs the rsct-mcp companion (Node 20+ required).
#
# Run from the framework source directory:
#   bash scripts/install.sh
#
# Or from anywhere with the script's path:
#   bash /path/to/rsct-framework/scripts/install.sh

set -e

# --- Reject WSL on Windows ---
# WSL writes to /home/<user>/.rsct/, but Claude Code on Windows reads from
# C:/Users/<user>/.rsct/ — they are different filesystems and the install
# would silently land in the wrong place. Detect via /proc/sys/kernel/osrelease
# which contains "microsoft" or "WSL" under both WSL1 and WSL2.
if [ -f /proc/sys/kernel/osrelease ] && \
   grep -qiE "microsoft|wsl" /proc/sys/kernel/osrelease 2>/dev/null; then
  echo "════════════════════════════════════════════════════════"
  echo "ERROR: This script is running under WSL (Windows Subsystem for Linux)."
  echo "════════════════════════════════════════════════════════"
  echo ""
  echo "WSL writes to /home/<user>/.rsct/, but Claude Code on Windows"
  echo "looks for ~/.rsct/ at C:/Users/<user>/.rsct/. They are different"
  echo "filesystems — installing here would land in the wrong place and"
  echo "Claude Code would never find it."
  echo ""
  echo "Open Git Bash on Windows (Start menu → Git Bash) and re-run:"
  echo "  cd /c/Users/<you>/path/to/rsct-framework"
  echo "  bash scripts/install.sh"
  echo ""
  echo "If you genuinely want to install under WSL for use by Claude Code"
  echo "running inside WSL (rare), edit this guard out and proceed at"
  echo "your own risk."
  exit 1
fi

# --- Locate source ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$SOURCE_DIR/prompts/01-setup.md" ] || [ ! -f "$SOURCE_DIR/VERSION" ]; then
  echo "ERROR: $SOURCE_DIR does not look like the RSCT framework source."
  echo "Expected to find: $SOURCE_DIR/prompts/01-setup.md and $SOURCE_DIR/VERSION"
  exit 1
fi

# --- Non-interactive mode (CI / provisioning / smoke tests) ---
# RSCT_ASSUME_YES=1 (or -y / --yes) answers every [y/N]/[Y/n]/menu prompt with
# its documented default, so the installer runs unattended. RSCT_SKIP_MCP=1
# (or --skip-mcp) skips the rsct-mcp companion entirely — framework files only,
# no global `npm install -g` / `claude mcp add` side effects.
ASSUME_YES="${RSCT_ASSUME_YES:-}"
SKIP_MCP="${RSCT_SKIP_MCP:-}"
for arg in "$@"; do
  case "$arg" in
    -y|--yes)   ASSUME_YES=1 ;;
    --skip-mcp) SKIP_MCP=1 ;;
  esac
done

# read_or_default <varname> <prompt> <default>
# Interactive: prints the prompt and reads stdin into <varname>.
# Non-interactive (ASSUME_YES): assigns <default> and echoes the choice.
read_or_default() {
  __rod_var="$1"; __rod_prompt="$2"; __rod_def="$3"; __rod_eof_ok="${4:-}"
  if [ -n "$ASSUME_YES" ]; then
    printf '%s%s   (RSCT non-interactive default)\n' "$__rod_prompt" "$__rod_def"
    eval "$__rod_var=\$__rod_def"
  else
    printf '%s' "$__rod_prompt"
    # #73: `read -r` returns non-zero at EOF and `set -e` (:12) turns that into
    # an abort. That is the DEFAULT and it must stay the default — an earlier
    # version of this fix made the fallback unconditional, and the Rv measured
    # what that does: `bash scripts/install.sh </dev/null` with no
    # RSCT_ASSUME_YES stopped cancelling and ran a FULL install instead. The
    # first call site (`Proceed? [y/N]`, :340) displays N but passes a coded
    # default of `y`, so EOF there answered yes to everything — global
    # `npm install -g`, `claude mcp add --scope user`, and on a team machine a
    # recorded `project` silently rewritten to `user`, with none of the
    # ASSUME_YES guards firing because ASSUME_YES was never set. Nothing on
    # screen said a default had been taken.
    #
    # So the fallback is OPT-IN: only a call site that passes a 4th argument
    # gets it, and only the removal-consent prompt does — it is the second
    # question in its branch, and its default is the safe one ("n", remove
    # nothing). A partial final line (EOF with no trailing newline) IS assigned
    # by `read`, so only an EMPTY reply falls back; otherwise the last answer
    # would be discarded.
    if ! read -r __rod_reply; then
      if [ -z "$__rod_eof_ok" ]; then
        # `set -e` turns this into an abort at the call site. Say why: the
        # pre-#73 behaviour was to die here with nothing on screen at all,
        # which reads like a crash rather than a refusal to guess.
        printf '\n⚠ stdin closed with no answer — cancelling.\n' >&2
        printf '  For an unattended install set RSCT_ASSUME_YES=1 (see README).\n' >&2
        return 1
      fi
      if [ -z "$__rod_reply" ]; then
        __rod_reply="$__rod_def"
        printf '%s   (stdin closed — taking the default)\n' "$__rod_def"
      fi
    fi
    eval "$__rod_var=\$__rod_reply"
  fi
}

# --- Compute target paths ---
RSCT_HOME="$HOME/.rsct"
CLAUDE_COMMANDS_DIR="$HOME/.claude/commands"

# --- Resolve the Claude Code host config the way the CLI itself does (#73) ---
# `claude mcp add/remove` is a Node program: it reads CLAUDE_CONFIG_DIR when
# set, otherwise os.homedir() — which on Windows is USERPROFILE, NOT the bash
# $HOME. Until #73 this script hardcoded "$HOME/.claude.json" in three places
# while delegating the actual mutation to that CLI. When the two disagree the
# failure is silent and lands on either side:
#   - detection reads a stale/absent file -> "no user entry" -> the consent is
#     never asked and `project` is recorded while the user-scope entry is still
#     live. That is #73 reproduced WITH the fix installed.
#   - or the removal succeeds against the CLI's file while re-verification reads
#     the other one, and a switch that worked is reported as failed.
# The test harness pins HOME/USERPROFILE/CLAUDE_CONFIG_DIR to one sandbox dir,
# so no test can see the divergence — hence the fix, not a test, is the guard.
# node -e is SINGLE-quoted and builds the separator with String.fromCharCode(92)
# (see the quote-form note at the scope menu below).
# Falls back to $HOME/.claude.json when node is absent (the --skip-mcp path):
# that is the pre-#73 behaviour, so the fallback is never worse than before.
HOST_CFG="$HOME/.claude.json"
if command -v node >/dev/null 2>&1; then
  HOST_CFG_RESOLVED=$(node -e 'var d = process.env.CLAUDE_CONFIG_DIR || require("os").homedir(); process.stdout.write(d.split(String.fromCharCode(92)).join("/") + "/.claude.json")' 2>/dev/null || echo "")
  if [ -n "$HOST_CFG_RESOLVED" ]; then HOST_CFG="$HOST_CFG_RESOLVED"; fi
fi

# --- Read the MCP scope recorded by a previous run (#71) ---
# The three menu branches below write this file, and until #71 nothing ever
# read it back: the menu default was the literal "1", so pressing Enter — or
# any RSCT_ASSUME_YES run — rewrote a recorded `project`/`skip` to `user`
# with no warning, and /rsct-setup silently stopped maintaining the project
# .mcp.json (prompts/01-setup.md:3683 gates on this value).
#
# `if` form, not `[ -f … ] && VAR=…`: this script runs under `set -e` (:12),
# where an `&&` chain as the LAST statement of a FUNCTION OR SCRIPT BODY aborts
# the installer (measured: as the last statement of an `if` block it does not).
# Safe here either way, but the `if` cannot be broken by a later move, and it
# matches the two existing marker reads at :139-146.
# `tr -d '\r'` for a hand-edited CRLF file; `head -1` bounds a corrupt one.
MCP_SCOPE_RECORDED=""
MCP_SCOPE_KNOWN=""
if [ -f "$RSCT_HOME/mcp-scope" ]; then
  MCP_SCOPE_RECORDED=$(tr -d '\r' < "$RSCT_HOME/mcp-scope" | head -1)
fi
# MCP_SCOPE_KNOWN is set ONLY on an exact match, and it — never
# MCP_SCOPE_RECORDED — gates the "press Enter to keep it" line. A marker with
# a stray space, different case or a UTF-8 BOM (the #29 class) is non-empty
# but unmapped: offering to "keep" it would promise exactly the silent
# rewrite #71 reports.
#
# #73: the menu is now BINARY — [1] user / [2] project. `skip` stays READABLE as
# a legacy value (machines installed before this change carry it) and resolves
# deterministically to the documented default [1]. It keeps MCP_SCOPE_KNOWN set
# so the "a typo REPLACED your recorded scope" warning below still fires, but
# MCP_SCOPE_LEGACY swaps the "press Enter to keep it" line for one that tells
# the truth: there is no [3] left to keep.
# Resolving to [1] is display/default only — it must NOT make an unattended run
# register user scope. README.md told every teammate on a project-scope team to
# pick [3], so `skip` is the TEAM population: silently adding a user-scope entry
# on their machines would mask the very .mcp.json they share via git (the issue's
# measured behaviour 1), which is the mirror of the removal this issue forbids
# doing unattended. The [1] arm gates on this.
MCP_SCOPE_LEGACY=""
case "$MCP_SCOPE_RECORDED" in
  project) MCP_SCOPE_DEFAULT="2"; MCP_SCOPE_KNOWN="project" ;;
  skip)    MCP_SCOPE_DEFAULT="1"; MCP_SCOPE_KNOWN="skip"; MCP_SCOPE_LEGACY="1" ;;
  user)    MCP_SCOPE_DEFAULT="1"; MCP_SCOPE_KNOWN="user" ;;
  *)       MCP_SCOPE_DEFAULT="1" ;;
esac

# --- Compute path that Claude Code @ references will resolve correctly ---
OS_NAME=$(uname -s 2>/dev/null || echo "")
if echo "$OS_NAME" | grep -qiE "MINGW|MSYS|CYGWIN"; then
  # Windows (Git Bash) — convert /c/Users/... to C:/Users/...
  RSCT_HOME_FOR_CLAUDE=$(cygpath -m "$RSCT_HOME" 2>/dev/null || echo "$RSCT_HOME")
else
  RSCT_HOME_FOR_CLAUDE="$RSCT_HOME"
fi

# --- Detect existing install (protocol + code versions) ---
# Two RELEASE version axes are reported (aligned from v1.0.0 on):
#   PROTOCOL version (e.g., "2.0.0") — the prompts/rules release, read from
#     the single-source /VERSION file at the repo root. Lives in ~/.rsct/VERSION.
#   CODE version (e.g., "1.1.0") — the rsct-mcp companion + prompt
#     mechanics, from version.ts. Lives in ~/.rsct/VERSION-CODE.
# Reporting both lets the dev see drift (e.g. "code 0.6.7 → 0.7.0") even
# when the other axis is unchanged — the case that hid the CAP-9 → CAP-14
# fixes from `npm install -g` "up to date" reporting. Neither is the
# `v=1.0.0` marker SCHEMA ID — that's a separate, frozen idempotency key
# carried inside markers, never stored in these files.
# Both reads use the same `tr -d '\r' | head -1` shape as the incoming axes below.
# ~/.rsct/ can be copied between machines or hand-edited, so a CRLF marker is reachable
# even though the installer only ever writes LF (anti-pattern #4). On Linux/macOS a
# surviving CR makes "2.6.1\r" != "2.6.1" and the report would claim drift on EVERY run
# — issue #44 inverted. Git Bash strips a trailing CR in command substitution, so this
# is exactly the class a Windows-only check cannot see. `[ -f ]` already covers absence,
# so the old `2>/dev/null` goes with it.
EXISTING_VERSION=""
if [ -f "$RSCT_HOME/VERSION" ]; then
  EXISTING_VERSION=$(tr -d '\r' < "$RSCT_HOME/VERSION" | head -1)
fi
EXISTING_CODE_VERSION=""
if [ -f "$RSCT_HOME/VERSION-CODE" ]; then
  EXISTING_CODE_VERSION=$(tr -d '\r' < "$RSCT_HOME/VERSION-CODE" | head -1)
fi
# A marker written by a pre-#44 installer holds a sentence from version.ts's docstring,
# not a version. Read back verbatim it is printed above the [y/N] confirm AND compared,
# so it would announce "drift detected, will update" to a dev whose code never moved.
# "The marker is unreadable" is a different fact, and the one worth saying.
#
# TWO arms on purpose: the EMPTY case must fall through untouched, because empty means
# "no marker" and the report below reads that as `none (fresh install)` via [ -n ].
# Folding '' into the sentinel would make every fresh install claim a broken marker.
# "unreadable" also differs from "unknown" deliberately — the latter is the INCOMING
# axis's parse-miss value, and two different diagnoses must not render identically.
# Self-limiting: the same install that prints it also rewrites the marker.
case "$EXISTING_CODE_VERSION" in
  '') ;;
  *[!0-9.]*) EXISTING_CODE_VERSION="unreadable" ;;
esac

# --- Read incoming versions ---
# PROTOCOL/product version from the single-source /VERSION (issue #7). Missing file →
# the `[ -f ]` guard keeps NEW_VERSION="unknown". CRLF-safe (tr -d '\r'); `head -1`
# keeps the pipeline's exit status = head's (0), so `set -e` can't trip on a tr/redirect
# hiccup. The case-guard then maps any value with a non-digit/non-dot char (incl. a
# `-rc` prerelease) to "unknown" — this axis is display/marker only, never destructive.
NEW_VERSION="unknown"
if [ -f "$SOURCE_DIR/VERSION" ]; then
  NEW_VERSION="$(tr -d '\r' < "$SOURCE_DIR/VERSION" | head -1)"
fi
case "$NEW_VERSION" in
  ''|*[!0-9.]*) NEW_VERSION="unknown" ;;
esac
# Code version from mcp-server/src/lib/version.ts (single source of truth
# per its own docstring; mirrored in mcp-server/package.json).
# Anchored on the DECLARATION, not the bare symbol: version.ts opens with a docstring
# that mentions `RSCT_MCP_VERSION`, so an unanchored match let `head -1` take the prose
# line — which carries no single quotes, so the sed substituted nothing and passed the
# whole sentence through into ~/.rsct/VERSION-CODE. Both sides of the drift comparison
# then read that same prose and the report was permanently "same", hiding exactly the
# code-axis drift this axis exists to surface (issue #44).
#
# TWO independent defences, on purpose — measured by mutation:
#   1. the `^export const` anchor, so the docstring line can never win;
#   2. `sed -n …p`, which PRINTS ONLY lines that actually contain a quoted value —
#      the old `sed -E "s/…/…/"` (no -n) passed every line through unchanged, which
#      is what let the prose escape. Reverting either one alone still yields the
#      correct version; reverting BOTH reproduces #44 and kills four tests.
#
# `sed -n …p` LAST, so the pipeline's exit status is sed's (0 even when nothing
# matched) and a no-match cannot trip a caller running under `set -e`. Putting the
# grep last would return 1 on no-match. The `tr -d '\r'` guards a CRLF checkout
# (anti-pattern #4) — belt to the sed's trailing `.*`, which would also absorb a CR,
# but the pipeline must not depend on that.
NEW_CODE_VERSION=""
if [ -f "$SOURCE_DIR/mcp-server/src/lib/version.ts" ]; then
  NEW_CODE_VERSION=$(tr -d '\r' < "$SOURCE_DIR/mcp-server/src/lib/version.ts" \
    | grep -E "^export const RSCT_MCP_VERSION" \
    | sed -n "s/.*'\([^']*\)'.*/\1/p" | head -1)
fi
# Same numeric guard the protocol axis uses above: a parse miss must degrade to
# "unknown" (fail-visible) instead of writing whatever text happened to match. The
# old `[ -z ]` check only caught the empty case, so a non-empty garbage string passed.
case "$NEW_CODE_VERSION" in
  ''|*[!0-9.]*) NEW_CODE_VERSION="unknown" ;;
esac

# --- Detect Node 20+ for optional MCP companion install ---
NODE_STATUS="missing"
NODE_VERSION_STR=""
if command -v node >/dev/null 2>&1; then
  NODE_VERSION_STR=$(node --version 2>/dev/null || echo "")
  NODE_MAJOR=$(echo "$NODE_VERSION_STR" | sed -E 's/^v([0-9]+).*/\1/')
  if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    NODE_STATUS="ok"
  else
    NODE_STATUS="too_old"
  fi
fi

# Detect npm too — present alongside Node on every real install, but
# users with `node` on PATH and not `npm` (rare nvm misconfig) get a
# clear message instead of a cryptic install failure.
NPM_OK="no"
if command -v npm >/dev/null 2>&1; then
  NPM_OK="yes"
fi

MCP_INSTALLABLE="no"
case "$NODE_STATUS" in
  ok)
    if [ "$NPM_OK" = "yes" ]; then
      MCP_INSTALLABLE="yes"
    fi
    ;;
esac

MCP_NODE_DESC=""
case "$NODE_STATUS" in
  ok)        MCP_NODE_DESC="$NODE_VERSION_STR ✓" ;;
  too_old)   MCP_NODE_DESC="$NODE_VERSION_STR (need 20+; MCP install will be skipped)" ;;
  missing)   MCP_NODE_DESC="not found (MCP install will be skipped)" ;;
esac
if [ "$NODE_STATUS" = "ok" ] && [ "$NPM_OK" != "yes" ]; then
  MCP_NODE_DESC="$NODE_VERSION_STR but npm not on PATH (MCP install will be skipped)"
fi

# --- Summary ---
echo "════════════════════════════════════════════════════════"
echo "RSCT Framework — Install"
echo "════════════════════════════════════════════════════════"
echo "Source dir       : $SOURCE_DIR"
echo "Install target   : $RSCT_HOME"
echo "Slash commands   : $CLAUDE_COMMANDS_DIR"
echo "Path Claude uses : $RSCT_HOME_FOR_CLAUDE"
echo "OS detected      : ${OS_NAME:-unknown}"
echo "Node detected    : $MCP_NODE_DESC"
echo "Incoming protocol: $NEW_VERSION"
echo "Incoming code    : $NEW_CODE_VERSION"
if [ -n "$EXISTING_VERSION" ]; then
  echo "Existing protocol: $EXISTING_VERSION (will be overwritten)"
else
  echo "Existing protocol: none (fresh install)"
fi
if [ -n "$EXISTING_CODE_VERSION" ]; then
  if [ "$EXISTING_CODE_VERSION" = "$NEW_CODE_VERSION" ]; then
    echo "Existing code    : $EXISTING_CODE_VERSION (same — refresh only)"
  else
    echo "Existing code    : $EXISTING_CODE_VERSION → $NEW_CODE_VERSION (drift detected, will update)"
  fi
else
  echo "Existing code    : none (fresh install)"
fi
echo "════════════════════════════════════════════════════════"

# --- Confirmation ---
read_or_default confirm "Proceed? [y/N] " "y"
case "$confirm" in
  y|Y|yes|YES) ;;
  *) echo "Cancelled."; exit 0 ;;
esac

# --- Create target dirs ---
mkdir -p "$RSCT_HOME"
mkdir -p "$CLAUDE_COMMANDS_DIR"

# --- Copy framework runtime files ---
# Only what slash commands and future CLI need to read at runtime.
# RUNTIME_DIRS is the source of truth. If you add a new top-level
# directory that should ship with the install, append it here.
RUNTIME_DIRS="prompts rules doc-templates memory-templates universe-templates"
# KNOWN_NON_RUNTIME is everything else we expect at source root. The
# WARN below catches anything outside both lists so unfamiliar dirs
# don't silently skip a planned install (MED-10 in the post-M2 audit).
KNOWN_NON_RUNTIME="scripts mcp-server examples docs .git .github .claude node_modules dist coverage .vscode"

for dir in $RUNTIME_DIRS; do
  echo "  copying $dir/"
  rm -rf "${RSCT_HOME:?}/$dir"
  cp -r "$SOURCE_DIR/$dir" "$RSCT_HOME/$dir"
done

# Warn if SOURCE_DIR has any directory not in either list.
for d in "$SOURCE_DIR"/*/; do
  basename=$(basename "$d")
  case " $RUNTIME_DIRS $KNOWN_NON_RUNTIME " in
    *" $basename "*) ;;
    *)
      echo "  ⚠ WARN: '$basename/' at source root is unfamiliar to install.sh."
      echo "    If it should ship to ~/.rsct/, add it to RUNTIME_DIRS."
      echo "    If it's local-only (cache, scratch, etc), add it to KNOWN_NON_RUNTIME."
      ;;
  esac
done

# Write version markers (protocol + code)
echo "$NEW_VERSION" > "$RSCT_HOME/VERSION"
echo "$NEW_CODE_VERSION" > "$RSCT_HOME/VERSION-CODE"

# --- Write slash command files ---
cat > "$CLAUDE_COMMANDS_DIR/rsct-setup.md" <<EOF
---
description: Apply or update RSCT governance protocol in this project
---

@$RSCT_HOME_FOR_CLAUDE/prompts/01-setup.md
EOF

# plan-lifecycle-v2 Trilha 4: the unified /rsct-universe command REPLACES the
# old /rsct-init-universe and /rsct-canonical-source. Generate the new stub and
# actively remove the two old stubs so ONLY /rsct-universe appears to the dev
# (the engine prompts 02/04 stay in the repo — 06-universe.md reuses them).
cat > "$CLAUDE_COMMANDS_DIR/rsct-universe.md" <<EOF
---
description: Create/adjust the org universe and/or link this project to it (unified)
---

@$RSCT_HOME_FOR_CLAUDE/prompts/06-universe.md
EOF
rm -f "$CLAUDE_COMMANDS_DIR/rsct-init-universe.md" \
      "$CLAUDE_COMMANDS_DIR/rsct-canonical-source.md"

cat > "$CLAUDE_COMMANDS_DIR/rsct-uninstall.md" <<EOF
---
description: Reverse RSCT setup in this project (SHA256-protected, granular)
---

@$RSCT_HOME_FOR_CLAUDE/prompts/03-uninstall.md
EOF

cat > "$CLAUDE_COMMANDS_DIR/rsct-clean-code.md" <<EOF
---
description: Sweep for duplication, scalability and dependency-update opportunities, then route fixes through the RSCT cycle
---

@$RSCT_HOME_FOR_CLAUDE/prompts/05-clean-code.md
EOF

# --- Done with framework ---
echo ""
echo "════════════════════════════════════════════════════════"
echo "Installed RSCT v$NEW_VERSION"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Slash commands now available in Claude Code:"
echo "  /rsct-setup              — setup or update a project"
echo "  /rsct-universe           — create/adjust the org universe and/or link this project"
echo "  /rsct-uninstall          — reverse setup in a project"
echo "  /rsct-clean-code         — sweep for duplication/scalability/dep updates"
echo ""

# --- Optional: install rsct-mcp companion ---
if [ -n "$SKIP_MCP" ]; then
  echo "Skipping rsct-mcp companion (RSCT_SKIP_MCP set) — framework files only."
elif [ -d "$SOURCE_DIR/mcp-server" ] && [ -f "$SOURCE_DIR/mcp-server/package.json" ]; then
  echo "────────────────────────────────────────────────────────"
  echo "Companion: rsct-mcp (Model Context Protocol server)"
  echo "────────────────────────────────────────────────────────"
  echo "Adds 39 tools + 5 resources to Claude Code — §C-gated"
  echo "commit/push/merge, SessionStart sanitizer hook, audit log,"
  echo "and structured project recall. Strongly recommended."
  echo ""

  case "$MCP_INSTALLABLE" in
    yes)
      read_or_default mcp_confirm "Install rsct-mcp now? [Y/n] " "y"
      case "$mcp_confirm" in
        n|N|no|NO)
          echo "Skipped. To install later:"
          echo "  cd $SOURCE_DIR/mcp-server && npm install -g ."
          echo "  (prebuilt; prepend 'npm install && npm run build &&' only when building from source)"
          echo "  Then in a project: claude mcp add rsct rsct-mcp --scope project"
          ;;
        *)
          echo ""
          echo "Installing rsct-mcp ($MCP_NODE_DESC)..."
          # Run in a sub-shell so a failure here doesn't bring down the
          # framework install (which is already on disk and successful).
          #
          # CAP-57: prebuilt-aware install. When the shipped `dist/` is present
          # (the normal case for a release clone) install ONLY the runtime deps
          # globally — no full `npm install`, so the build toolchain (tsup/esbuild)
          # never lands on the user machine and `npm audit` stays clean. The
          # source-build fallback (no dist/) reproduces the old flow verbatim for
          # dev checkouts. `npm install -g .` honors package.json "files":["dist"],
          # so the prebuilt artifact is packed regardless of .gitignore, and there
          # is no `prepare` script, so the global install never triggers a build.
          if (
            cd "$SOURCE_DIR/mcp-server" || exit 1
            if [ -f dist/index.js ]; then
              echo "  Using prebuilt dist/ — installing runtime deps only (no build toolchain)."
              npm install -g .
            else
              echo "  No prebuilt dist/ found — building from source (installs full toolchain)."
              npm install && npm run build && npm install -g .
            fi
          ); then
            echo ""
            echo "✓ rsct-mcp installed globally."

            # --- Ask the dev where to register the MCP server ---
            # #73: BINARY choice. Until now the menu offered three options and
            # only [1] ever acted: [2] recorded `project` and printed manual
            # instructions, so a machine with a user-scope entry kept resolving
            # at user scope in every project — the choice was recorded and never
            # honored. [3] Skip is removed; a scope you never register is not a
            # scope, and the value survives only as a legacy marker (see the
            # MCP_SCOPE_LEGACY note at the top of this script).
            echo ""
            echo "────────────────────────────────────────────────────────"
            echo "Register rsct-mcp with Claude Code now?"
            echo "────────────────────────────────────────────────────────"
            echo "  [1] Solo developer — USER scope (Recommended)"
            echo "      → registers once per machine; rsct__* tools available in"
            echo "        every project on this machine after IDE restart."
            echo "  [2] Team — PROJECT scope (committable .mcp.json)"
            echo "      → /rsct-setup writes and approves a .mcp.json in each"
            echo "        project. Requires REMOVING any user-scope entry, since"
            echo "        a user-scope entry masks project scope everywhere."
            echo ""
            # #71: the default is DERIVED from the recorded scope, so Enter and
            # RSCT_ASSUME_YES both mean "keep what I chose last time".
            # The suffix is mode-aware: an unattended run has no Enter to press,
            # and two adjacent lines saying "press Enter" then "(RSCT
            # non-interactive default)" contradict each other.
            # #73: a recorded `skip` is LEGACY — there is no [3] to keep, so
            # "press Enter to keep it" would be a promise this menu cannot make.
            # Checked BEFORE the generic arm because MCP_SCOPE_KNOWN is set for
            # `skip` too (it still gates the replacement warning below).
            if [ -n "$MCP_SCOPE_LEGACY" ]; then
              echo "  (recorded scope 'skip' is legacy — [3] no longer exists;"
              echo "   the documented default [1] applies, and an unattended run"
              echo "   registers nothing)"
            elif [ -n "$MCP_SCOPE_KNOWN" ]; then
              if [ -n "$ASSUME_YES" ]; then
                echo "  (current: $MCP_SCOPE_KNOWN — kept unless overridden)"
              else
                echo "  (current: $MCP_SCOPE_KNOWN — press Enter to keep it)"
              fi
            elif [ -n "$MCP_SCOPE_RECORDED" ]; then
              echo "  (recorded scope unrecognized — the documented default [1] applies)"
            fi
            read_or_default mcp_scope "Choice [1/2] (default: $MCP_SCOPE_DEFAULT): " "$MCP_SCOPE_DEFAULT"
            # read_or_default assigns the RAW reply on the interactive branch
            # (:75), so an empty line lands as "" and falls through `case` to
            # *) → user. That is the Enter half of #71. Resolved at the CALL
            # SITE deliberately: fixing it inside read_or_default would flip
            # "Proceed? [y/N]" (:279) to proceed-on-Enter, contradicting its
            # own prompt.
            [ -n "$mcp_scope" ] || mcp_scope="$MCP_SCOPE_DEFAULT"

            # #73: `3` is still the most likely keypress even though [3] is gone
            # — README.md told every teammate on a project-scope team to press
            # it, and muscle memory outlives a menu. Left to fall through to *)
            # it registers USER scope, which masks the team's committed
            # .mcp.json in every repo — and on a teammate's fresh machine the
            # *) warning below is gated on a recorded scope, so there would be
            # NOTHING on screen. Normalised here, before dispatch, with a notice
            # that is deliberately NOT gated.
            if [ "$mcp_scope" = "3" ]; then
              echo ""
              echo "⚠ [3] Skip no longer exists — the menu is [1] or [2]."
              echo "  Applying the documented default [1] (user scope)."
              if [ -n "$MCP_SCOPE_KNOWN" ]; then
                echo "  This REPLACES the recorded '$MCP_SCOPE_KNOWN'."
              fi
              echo "  If you meant project scope, re-run and pick [2]."
              mcp_scope="1"
            fi

            case "$mcp_scope" in
              2)
                # #73: project scope now TAKES EFFECT instead of merely being
                # recorded. Measured: a user-scope entry WINS a name collision —
                # the project entry's process is never spawned, approved or not.
                # So "project scope" is a lie for as long as that entry exists,
                # and CAP-48's `printf project` + a warning was recording the lie
                # with the developer's consent attached.
                #
                # The marker is written LAST, from SCOPE_EFFECTIVE, so it records
                # what is TRUE on the machine rather than what was asked for.
                # SCOPE_EFFECTIVE is initialised empty and EVERY arm assigns it.
                #
                # An arm that fell through leaves it EMPTY, so the dispatch below
                # writes NOTHING — the failure mode is silence, not a wrong value.
                # (An earlier version of this comment claimed a fall-through would
                # write `project`. It would not, and believing that is what let the
                # unattended arm go untested: mutation `SCOPE_EFFECTIVE="project"`
                # SURVIVED the suite, because the case that exercises it seeds a
                # marker already reading `project`. Both holes are closed below —
                # `unattended` has its own arm and `*)` is loud.)
                #
                # Every node -e in this file is SINGLE-quoted, and must stay that
                # way. In a DOUBLE-quoted -e body bash collapses `\\` to a single
                # backslash (and `\\b` to a backspace — the MED-16 / CAP-20
                # shape), and `$`/backticks become live shell metacharacters that
                # `bash -n` does not flag. Measured on this repo's own machine.
                # This is plain POSIX double-quote semantics, not an MSYS quirk:
                # it behaves identically on Linux and macOS.
                SCOPE_EFFECTIVE=""
                USER_SCOPE_ENTRY="no"
                USER_SCOPE_CMD=""
                if [ -f "$HOST_CFG" ] && command -v node >/dev/null 2>&1; then
                  # Read-only. Emits the entry's `command` so the consent text can
                  # name what is about to be destroyed: `claude mcp remove` is
                  # blunt where the rest of this is narrow, and [1] only ever
                  # re-adds the plain `rsct-mcp` form — a hand-registered dev
                  # build would not come back.
                  if USER_SCOPE_CMD=$(node -e 'try { var j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); var e = j.mcpServers && j.mcpServers.rsct; if (!e) { process.exit(1); } process.stdout.write(String(e.command || "?")); } catch (err) { process.exit(1); }' "$HOST_CFG" 2>/dev/null); then
                    USER_SCOPE_ENTRY="yes"
                  fi
                fi

                if [ "$USER_SCOPE_ENTRY" = "yes" ]; then
                  echo ""
                  echo "⚠ rsct is registered at USER scope on this machine"
                  echo "  (command: ${USER_SCOPE_CMD:-rsct-mcp})."
                  echo "  A user-scope entry WINS over every project .mcp.json —"
                  echo "  the project entry is never spawned. Project scope cannot"
                  echo "  become effective until that entry is removed."
                  echo ""
                  echo "  This affects EVERY project on this machine, not only the"
                  echo "  one you are working in."
                  echo ""
                  if [ -n "$ASSUME_YES" ]; then
                    # An unattended run must NEVER remove a user-scope entry:
                    # silently de-registering every project on the machine is a
                    # worse defect than the one being fixed. It must not rewrite
                    # the marker either — recording `user` here would destroy a
                    # deliberate `project` on every unattended re-run, which is
                    # #71 from the other side.
                    SCOPE_EFFECTIVE="unattended"
                    echo "  RSCT_ASSUME_YES is set — nothing was removed and the"
                    echo "  recorded scope is left unchanged. Re-run interactively"
                    echo "  to complete the switch."
                  else
                    # 4th arg: this is the ONLY prompt that survives EOF, and it
                    # survives it as "n" — see read_or_default. It is the second
                    # question in this branch, so a piped answer that supplies
                    # the menu choice and stops would otherwise abort the
                    # installer mid-switch.
                    read_or_default mcp_rm "Remove the user-scope rsct entry now? [y/N] " "n" eof-ok
                    case "$mcp_rm" in
                      y|Y|yes|YES)
                        MCP_RM_CLI="no"
                        if command -v claude >/dev/null 2>&1; then
                          # The CLI owns this format — never hand-edit it out.
                          #
                          # `</dev/null` defends against the CLI reading stdin
                          # and swallowing the answer to a LATER prompt: this
                          # branch already asks two questions in sequence, and
                          # `read_or_default` would then see EOF instead of the
                          # developer's reply.
                          # DELIBERATELY UNTESTED — no prompt currently follows
                          # this call, so any test of it would assert nothing and
                          # pass with the redirect deleted. Do not remove it as
                          # dead weight: it becomes load-bearing the moment a
                          # third question is added to this branch, and nothing
                          # will go red when that happens.
                          if claude mcp remove rsct --scope user </dev/null >/dev/null 2>&1; then
                            MCP_RM_CLI="yes"
                          fi
                        fi
                        # RE-VERIFY, UNCONDITIONALLY. The probe is the sole
                        # authority; the CLI's exit code is diagnostic text only.
                        # An earlier version gated the probe on MCP_RM_CLI=yes,
                        # which falsifies success but never failure — so a CLI
                        # that REMOVED the entry and then exited non-zero (this
                        # file's own :737-739 documents those exit codes
                        # differing across Windows wrapper variants) left the
                        # marker recording `user` on a machine where rsct was
                        # then registered nowhere at all. Both directions have to
                        # be checked, or the marker lies again.
                        MCP_RM_OK="yes"
                        if [ -f "$HOST_CFG" ] && command -v node >/dev/null 2>&1; then
                          if node -e 'try { var j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit((j.mcpServers && j.mcpServers.rsct) ? 0 : 1); } catch (err) { process.exit(1); }' "$HOST_CFG" 2>/dev/null; then
                            MCP_RM_OK="no"
                          fi
                        elif [ "$MCP_RM_CLI" = "no" ]; then
                          # Nothing to probe with and the CLI reported failure —
                          # do not claim a removal that cannot be confirmed.
                          MCP_RM_OK="no"
                        fi
                        if [ "$MCP_RM_OK" = "yes" ]; then
                          SCOPE_EFFECTIVE="project"
                          echo "✓ User-scope rsct entry removed — project scope is now effective."
                        else
                          SCOPE_EFFECTIVE="user"
                          echo ""
                          echo "⚠ The user-scope entry could not be removed (or is still present)."
                          echo "  Recording 'user', because that is what still resolves."
                          echo "  Remove it manually and re-run this installer:"
                          echo "      claude mcp remove rsct --scope user"
                        fi
                        ;;
                      *)
                        # Declining must NOT record `project` — that reproduces
                        # today's recorded-but-not-effective state with consent
                        # attached. `user` is what is true.
                        SCOPE_EFFECTIVE="user"
                        echo ""
                        echo "→ Kept the user-scope entry. It stays EFFECTIVE in every"
                        echo "  project, so 'user' is what gets recorded — not 'project'."
                        echo "  /rsct-setup will NOT create or refresh a .mcp.json while"
                        echo "  'user' is the recorded scope. Re-run and confirm the"
                        echo "  removal to switch."
                        ;;
                    esac
                  fi
                else
                  SCOPE_EFFECTIVE="project"
                fi

                case "$SCOPE_EFFECTIVE" in
                  project)
                    printf 'project\n' > "$RSCT_HOME/mcp-scope"
                    echo ""
                    # #71: under RSCT_ASSUME_YES nothing was "selected" this run —
                    # the recorded value was kept. Say which actually happened.
                    if [ "$MCP_SCOPE_KNOWN" = "project" ]; then
                      echo "→ Project scope kept (recorded in $RSCT_HOME/mcp-scope)."
                    else
                      echo "→ Project scope selected (saved to $RSCT_HOME/mcp-scope)."
                    fi
                    echo "  /rsct-setup will AUTOMATICALLY create/update a committable"
                    echo "  '.mcp.json' in each project where you run it AND approve it"
                    echo "  for that project — no manual 'claude mcp add' needed."
                    echo ""
                    echo "  Share with your team by committing .mcp.json to git. Each"
                    echo "  teammate still needs rsct-mcp installed (run this installer)"
                    echo "  so the 'rsct-mcp' binary is on their PATH, and should pick"
                    echo "  [2] here too — a user-scope entry on their machine would"
                    echo "  mask the .mcp.json you just shared."
                    echo ""
                    # HONEST SENTENCE (#73): the installer cannot fix projects that
                    # already exist — it does not write .mcp.json or the approval,
                    # /rsct-setup does. Removing the user-scope entry is therefore
                    # the moment those projects STOP working, and saying which ones
                    # is the difference between an honest AC and the class of
                    # defect this issue is.
                    #
                    # A project is fine only when BOTH halves are in place: its
                    # .mcp.json registers rsct AND .claude/settings.local.json
                    # approves it. Listing only the projects missing a .mcp.json
                    # (the first version of this report) named the wrong set — the
                    # ones the removal actually breaks are those that HAVE one and
                    # are unapproved, which is every project a legacy CAP-48
                    # machine set up while the masking user entry made them work.
                    if [ -f "$HOST_CFG" ] && command -v node >/dev/null 2>&1; then
                      node -e 'try { var fs = require("fs"); function readJson(p) { try { var raw = fs.readFileSync(p, "utf8"); if (raw.charCodeAt(0) === 65279) { raw = raw.slice(1); } return raw.trim() ? JSON.parse(raw) : null; } catch (e) { return null; } } var j = readJson(process.argv[1]); if (!j) { process.exit(0); } var ks = Object.keys(j.projects || {}); var pending = []; for (var i = 0; i < ks.length; i++) { var k = ks[i]; if (!fs.existsSync(k + "/.rsct.json")) { continue; } var m = readJson(k + "/.mcp.json"); var registered = !!(m && m.mcpServers && m.mcpServers.rsct); var s = readJson(k + "/.claude/settings.local.json"); var approved = !!(s && Array.isArray(s.enabledMcpjsonServers) && s.enabledMcpjsonServers.indexOf("rsct") !== -1); if (!registered || !approved) { pending.push(k + (registered ? "   (registered, not approved)" : "   (no .mcp.json)")); } } if (pending.length) { console.log("  " + pending.length + " RSCT project(s) will NOT resolve rsct until /rsct-setup is re-run"); console.log("  in them (it writes the .mcp.json and approves it):"); var cap = pending.length < 20 ? pending.length : 20; for (var n = 0; n < cap; n++) { console.log("      " + pending[n]); } if (pending.length > cap) { console.log("      ... and " + (pending.length - cap) + " more"); } console.log(""); } } catch (e) { }' "$HOST_CFG" 2>/dev/null || true
                    fi
                    echo "  After /rsct-setup, restart Claude Code and verify with:"
                    echo "    claude mcp list   →  rsct: rsct-mcp - ✓ Connected"
                    echo ""
                    echo "  Full doc: see 'Project scope detail' section in"
                    echo "  the rsct-framework README.md."
                    ;;
                  user)
                    printf 'user\n' > "$RSCT_HOME/mcp-scope"
                    ;;
                  unattended)
                    # The ONE legitimate no-write outcome: RSCT_ASSUME_YES met a
                    # user-scope entry, so nothing was removed and nothing may be
                    # recorded. Split out from `*)` on purpose — folding the
                    # deliberate case into the impossible one is what made a
                    # missing assignment indistinguishable from a correct run.
                    echo ""
                    echo "→ Recorded scope left unchanged (${MCP_SCOPE_RECORDED:-none})."
                    ;;
                  *)
                    # UNREACHABLE. Every arm above assigns SCOPE_EFFECTIVE, so an
                    # empty value here means one stopped doing so. Say it loudly:
                    # the whole point of this dispatch is that the marker records
                    # what is true, and a silent no-write leaves the developer
                    # believing a switch happened.
                    echo ""
                    echo "⚠ INTERNAL: no scope decision was reached (SCOPE_EFFECTIVE empty)."
                    echo "  Nothing was recorded — $RSCT_HOME/mcp-scope still reads"
                    echo "  '${MCP_SCOPE_RECORDED:-none}'. Please report this output as a bug."
                    ;;
                esac
                ;;
              *)
                # Default: user scope.
                # #71: this arm is reached by an explicit `1` AND by a typo. Both
                # write `user` — but a typo that REPLACES a recorded scope must
                # not be silent, because the menu just offered to keep it. One
                # mistyped key was otherwise enough to turn `project` into `user`
                # with nothing on screen. No warning on a fresh install: there is
                # nothing to lose, and `user` is the documented default.
                if [ "$mcp_scope" != "1" ] && [ -n "$MCP_SCOPE_KNOWN" ]; then
                  echo ""
                  echo "⚠ '$mcp_scope' is not 1/2 — applying the documented default (user scope),"
                  echo "  REPLACING the recorded '$MCP_SCOPE_KNOWN'. Re-run and pick again to undo."
                fi
                # #73: a legacy `skip` marker resolves to [1] as the MENU DEFAULT,
                # but an unattended run must not ACT on that resolution. README.md
                # told every teammate on a project-scope team to pick [3], so
                # `skip` is the TEAM population: adding a user-scope entry on their
                # machines with no human present would mask the .mcp.json they
                # share via git, in every repo — the mirror of the removal this
                # issue forbids doing unattended.
                if [ -n "$MCP_SCOPE_LEGACY" ] && [ -n "$ASSUME_YES" ]; then
                  echo ""
                  echo "→ Legacy 'skip' marker + unattended run — registering nothing"
                  echo "  and leaving the recorded scope as 'skip'. Re-run"
                  echo "  interactively to pick [1] or [2]."
                else
                # Detection must be SCOPE-SPECIFIC. Previous attempts:
                #   - `claude mcp get rsct`: exit code differs across Windows
                #     wrapper variants (PowerShell .ps1 returns 1 on "not
                #     found"; Git Bash no-ext stub returned 0). False positive.
                #   - `claude mcp list | grep "^rsct:"`: in non-TTY (pipe)
                #     mode, the CLI includes project-scope .mcp.json entries.
                #     Any project .mcp.json with rsct would false-positive
                #     "already registered" and skip user-scope add.
                # Final fix: parse ~/.claude.json directly for the top-level
                # mcpServers.rsct key — that's where `claude mcp add --scope
                # user` writes. Project-scope .mcp.json files are ignored.
                USER_SCOPE_HAS_RSCT="no"
                if [ -f "$HOST_CFG" ] && command -v node >/dev/null 2>&1; then
                  if node -e 'try { var j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit((j.mcpServers && j.mcpServers.rsct) ? 0 : 1); } catch (err) { process.exit(1); }' "$HOST_CFG" 2>/dev/null; then
                    USER_SCOPE_HAS_RSCT="yes"
                  fi
                fi
                if [ "$USER_SCOPE_HAS_RSCT" = "yes" ]; then
                  echo "✓ rsct already registered at user scope — no change."
                  # A deliberate [1] on a machine recorded as `project` DOES
                  # change something, even when the entry is already there: the
                  # marker flips, and /rsct-setup stops maintaining every
                  # committed .mcp.json. "no change" alone would be the silent
                  # replacement #71 exists to stop, just reached on purpose.
                  if [ -n "$MCP_SCOPE_KNOWN" ] && [ "$MCP_SCOPE_KNOWN" != "user" ]; then
                    echo "  Recorded scope changes '$MCP_SCOPE_KNOWN' → 'user'. Any committed"
                    echo "  .mcp.json stays in git but is now masked by this entry, and"
                    echo "  /rsct-setup will no longer create or refresh one."
                  fi
                elif command -v claude >/dev/null 2>&1; then
                  echo ""
                  echo "Registering rsct with Claude Code at user scope..."
                  claude mcp add rsct rsct-mcp --scope user </dev/null >/dev/null 2>&1 || true
                  # RE-VERIFY, UNCONDITIONALLY (#73). Until this issue the arm
                  # wrote `user` to the marker BEFORE it even tried to register
                  # and never checked afterwards, so a missing `claude` or an add
                  # that reported success without landing left the marker
                  # claiming a scope that does not resolve — the same
                  # recorded-but-not-effective defect as [2], on the other side
                  # of the menu, and what AC 3 rides on.
                  #
                  # The probe runs whatever the CLI's exit code was. Gating it on
                  # success falsifies success but never failure: a `claude` that
                  # ADDED the entry and then exited non-zero (see the Windows
                  # wrapper note above) would be reported as "not registered"
                  # while user scope was in fact live, and the marker would be
                  # left recording `project`.
                  if [ -f "$HOST_CFG" ] && command -v node >/dev/null 2>&1; then
                    if node -e 'try { var j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit((j.mcpServers && j.mcpServers.rsct) ? 0 : 1); } catch (err) { process.exit(1); }' "$HOST_CFG" 2>/dev/null; then
                      USER_SCOPE_HAS_RSCT="yes"
                    fi
                  fi
                  if [ "$USER_SCOPE_HAS_RSCT" = "yes" ]; then
                    echo "✓ rsct registered (user scope)."
                    echo "  Available in every project on this machine after IDE restart."
                  else
                    echo "⚠ rsct is NOT registered at user scope in $HOST_CFG."
                    echo "  Register manually, then re-run this installer:"
                    echo "    claude mcp add rsct rsct-mcp --scope user"
                  fi
                else
                  echo "⚠ 'claude' CLI not on PATH — cannot auto-register."
                  echo "  Once Claude Code is installed, run:"
                  echo "    claude mcp add rsct rsct-mcp --scope user"
                fi
                # CAP-48: the marker gates whether /rsct-setup materializes a
                # project .mcp.json. #73: it is written LAST, and only when user
                # scope is actually effective — recording a scope that does not
                # resolve is the defect this issue removes.
                if [ "$USER_SCOPE_HAS_RSCT" = "yes" ]; then
                  printf 'user\n' > "$RSCT_HOME/mcp-scope"
                else
                  echo "  Recorded scope left unchanged (${MCP_SCOPE_RECORDED:-none}) —"
                  echo "  'user' is not recorded until the entry actually exists."
                fi
                fi
                ;;
            esac
          else
            echo ""
            echo "⚠ rsct-mcp install failed."
            echo "  Framework is OK and installed at $RSCT_HOME."
            echo "  Common causes:"
            echo "    - Linux: global npm install needs sudo or a user-level prefix (nvm, n)."
            echo "    - Slow network: the npm install timed out."
            echo "    - Missing prebuilt dist/ AND no build toolchain available."
            echo "  Retry (prebuilt):"
            echo "    cd $SOURCE_DIR/mcp-server && npm install -g ."
            echo "  Or build from source:"
            echo "    cd $SOURCE_DIR/mcp-server && npm install && npm run build && npm install -g ."
          fi
          ;;
      esac
      ;;
    no)
      echo "Skipping rsct-mcp install — $MCP_NODE_DESC"
      echo "Install Node 20+ (and npm), then run from $SOURCE_DIR/mcp-server:"
      echo "  npm install -g .   (prebuilt; or 'npm install && npm run build && npm install -g .' to build from source)"
      ;;
  esac
  echo ""
fi

echo "════════════════════════════════════════════════════════"
echo "⚠ MANUAL STEPS STILL REQUIRED"
echo "════════════════════════════════════════════════════════"
echo ""
echo "1. Restart your IDE / Claude Code NOW."
echo "   Slash commands AND MCP server registrations are loaded at"
echo "   IDE startup — until you fully close and reopen, typing"
echo "   /rsct-setup will show 'No matching commands' and the"
echo "   rsct__* tools won't appear in the Claude tool list."
echo ""
echo "2. Inside each project where you want rsct active, run:"
echo "      /rsct-setup"
echo "   This writes CLAUDE.md, documentation/, memory entries,"
echo "   and the SessionStart sanitizer hook. Per-project, one-time."
echo ""
# #73: this used to order a manual `claude mcp add rsct rsct-mcp --scope
# project` in every target project — stale since CAP-48, and after #73 it
# contradicts step 2 outright. /rsct-setup writes the .mcp.json AND approves it
# for that project; there is no manual registration step left.
echo "(Chose 'Project scope' above? /rsct-setup writes and approves the"
echo " project's .mcp.json for you — nothing to register by hand.)"
echo ""
# E1 (field-report): report the EFFECTIVE user-level scope so the dev knows what
# actually resolves, independent of the menu choice above. A lingering user-scope
# entry silently overrides a project-scope intent in every project.
# #73: reads HOST_CFG (CLAUDE_CONFIG_DIR / os.homedir()) rather than a hardcoded
# $HOME, so this report cannot disagree with the CLI that owns the file.
if command -v node >/dev/null 2>&1 && [ -f "$HOST_CFG" ] && node -e 'try { var j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit((j.mcpServers && j.mcpServers.rsct) ? 0 : 1); } catch (err) { process.exit(1); }' "$HOST_CFG" 2>/dev/null; then
  echo "Effective MCP scope: USER — rsct is in $HOST_CFG, active in EVERY project"
  echo "  on this machine (a project .mcp.json would be masked by it)."
else
  echo "Effective MCP scope: no user-level rsct — it resolves only where a project"
  echo "  .mcp.json registers it AND that project has approved it (i.e. true"
  echo "  project scope; /rsct-setup does both)."
fi
echo ""
echo "To uninstall the framework from this machine (different from"
echo "uninstalling RSCT from a project), run:"
echo "  bash $SOURCE_DIR/scripts/uninstall-framework.sh"
