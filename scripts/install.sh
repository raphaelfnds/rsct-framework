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

if [ ! -f "$SOURCE_DIR/prompts/01-setup.md" ]; then
  echo "ERROR: $SOURCE_DIR does not look like the RSCT framework source."
  echo "Expected to find: $SOURCE_DIR/prompts/01-setup.md"
  exit 1
fi

# --- Compute target paths ---
RSCT_HOME="$HOME/.rsct"
CLAUDE_COMMANDS_DIR="$HOME/.claude/commands"

# --- Compute path that Claude Code @ references will resolve correctly ---
OS_NAME=$(uname -s 2>/dev/null || echo "")
if echo "$OS_NAME" | grep -qiE "MINGW|MSYS|CYGWIN"; then
  # Windows (Git Bash) — convert /c/Users/... to C:/Users/...
  RSCT_HOME_FOR_CLAUDE=$(cygpath -m "$RSCT_HOME" 2>/dev/null || echo "$RSCT_HOME")
else
  RSCT_HOME_FOR_CLAUDE="$RSCT_HOME"
fi

# --- Detect existing install (protocol + code versions) ---
# Two version axes:
#   PROTOCOL version (e.g., "1.0.0") — the rules contract, stable across
#     the entire pre-release train. Lives in ~/.rsct/VERSION.
#   CODE version (e.g., "0.7.0") — the rsct-mcp companion + prompt
#     mechanics. Bumped per release. Lives in ~/.rsct/VERSION-CODE.
# Reporting both lets the dev see e.g. "code 0.6.7 → 0.7.0" even when
# protocol stays at 1.0.0 — the case that hid the CAP-9 → CAP-14 fixes
# from `npm install -g` "up to date" reporting.
EXISTING_VERSION=""
if [ -f "$RSCT_HOME/VERSION" ]; then
  EXISTING_VERSION=$(cat "$RSCT_HOME/VERSION" 2>/dev/null | head -1)
fi
EXISTING_CODE_VERSION=""
if [ -f "$RSCT_HOME/VERSION-CODE" ]; then
  EXISTING_CODE_VERSION=$(cat "$RSCT_HOME/VERSION-CODE" 2>/dev/null | head -1)
fi

# --- Read incoming versions ---
NEW_VERSION=$(grep -E "^# Version:" "$SOURCE_DIR/prompts/01-setup.md" | head -1 | awk '{print $3}')
[ -z "$NEW_VERSION" ] && NEW_VERSION="unknown"
# Code version from mcp-server/src/lib/version.ts (single source of truth
# per its own docstring; mirrored in mcp-server/package.json).
NEW_CODE_VERSION=""
if [ -f "$SOURCE_DIR/mcp-server/src/lib/version.ts" ]; then
  NEW_CODE_VERSION=$(grep -E "RSCT_MCP_VERSION" "$SOURCE_DIR/mcp-server/src/lib/version.ts" \
    | head -1 | sed -E "s/.*'([^']+)'.*/\1/")
fi
[ -z "$NEW_CODE_VERSION" ] && NEW_CODE_VERSION="unknown"

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
printf "Proceed? [y/N] "
read -r confirm
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
KNOWN_NON_RUNTIME="scripts mcp-server examples .git .github .claude node_modules dist coverage .vscode"

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

cat > "$CLAUDE_COMMANDS_DIR/rsct-canonical-source.md" <<EOF
---
description: Add canonical architectural source section to CLAUDE.md (universe link)
---

@$RSCT_HOME_FOR_CLAUDE/prompts/02-canonical-source.md
EOF

cat > "$CLAUDE_COMMANDS_DIR/rsct-uninstall.md" <<EOF
---
description: Reverse RSCT setup in this project (SHA256-protected, granular)
---

@$RSCT_HOME_FOR_CLAUDE/prompts/03-uninstall.md
EOF

cat > "$CLAUDE_COMMANDS_DIR/rsct-init-universe.md" <<EOF
---
description: Bootstrap a new universe repository for an organization (skeleton)
---

@$RSCT_HOME_FOR_CLAUDE/prompts/04-init-universe.md
EOF

# --- Done with framework ---
echo ""
echo "════════════════════════════════════════════════════════"
echo "Installed RSCT v$NEW_VERSION"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Slash commands now available in Claude Code:"
echo "  /rsct-setup              — setup or update a project"
echo "  /rsct-init-universe      — bootstrap a new universe repository"
echo "  /rsct-canonical-source   — add universe canonical source section"
echo "  /rsct-uninstall          — reverse setup in a project"
echo ""

# --- Optional: install rsct-mcp companion ---
if [ -d "$SOURCE_DIR/mcp-server" ] && [ -f "$SOURCE_DIR/mcp-server/package.json" ]; then
  echo "────────────────────────────────────────────────────────"
  echo "Companion: rsct-mcp (Model Context Protocol server)"
  echo "────────────────────────────────────────────────────────"
  echo "Adds 13 tools + 5 resources to Claude Code — §C-gated"
  echo "commit/push/merge, SessionStart sanitizer hook, audit log,"
  echo "and structured project recall. Strongly recommended."
  echo ""

  case "$MCP_INSTALLABLE" in
    yes)
      printf "Install rsct-mcp now? [Y/n] "
      read -r mcp_confirm
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
            # User scope = one-time per machine, works in all projects (low friction)
            # Project scope = per-project .mcp.json, commits to repo (team workflow)
            # Skip = dev does it manually later (full control)
            echo ""
            echo "────────────────────────────────────────────────────────"
            echo "Register rsct-mcp with Claude Code now?"
            echo "────────────────────────────────────────────────────────"
            echo "  [1] User scope (Recommended for solo dev)"
            echo "      → registers globally; rsct__* tools available in"
            echo "        every project on this machine after IDE restart."
            echo "  [2] Project scope (for teams committing .mcp.json)"
            echo "      → must be added per project; instructions printed."
            echo "  [3] Skip — I'll register manually later."
            echo ""
            printf "Choice [1/2/3] (default: 1): "
            read -r mcp_scope

            case "$mcp_scope" in
              2)
                # CAP-48: persist the scope choice so /rsct-setup (which runs in
                # the PROJECT dir, unlike this installer) can materialize a
                # committable project .mcp.json. install.sh cannot create it here
                # — it does not know the target project path.
                printf 'project\n' > "$RSCT_HOME/mcp-scope"
                # E1 (field-report): the dev picked "project" — but if rsct is
                # ALREADY registered at USER scope, that registration applies to
                # every project, so rsct resolves at user scope EVEN where no
                # .mcp.json exists. `claude mcp list` then shows ✓ Connected and
                # masks the chosen scope (the report: "chose project but stayed
                # global, no warning"). Detect the same way the default branch
                # does — parse ~/.claude.json top-level mcpServers.rsct (the key
                # `--scope user` writes; project .mcp.json files are ignored here).
                if [ -f "$HOME/.claude.json" ] && command -v node >/dev/null 2>&1; then
                  if node -e "
                    try {
                      var j = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
                      process.exit((j.mcpServers && j.mcpServers.rsct) ? 0 : 1);
                    } catch (e) { process.exit(1); }
                  " "$HOME/.claude.json" 2>/dev/null; then
                    echo ""
                    echo "⚠ NOTE: rsct is ALREADY registered at USER scope on this machine."
                    echo "  A user-scope entry applies to EVERY project, so 'claude mcp list'"
                    echo "  will show rsct ✓ Connected even where no project .mcp.json exists —"
                    echo "  masking the project scope you just chose. To make project scope the"
                    echo "  EFFECTIVE one, remove the user-scope entry first:"
                    echo "      claude mcp remove rsct --scope user"
                  fi
                fi
                echo ""
                echo "→ Project scope selected (saved to $RSCT_HOME/mcp-scope)."
                echo "  /rsct-setup will AUTOMATICALLY create/update a committable"
                echo "  '.mcp.json' in each project where you run it — no manual"
                echo "  'claude mcp add' needed. Just run /rsct-setup in the project."
                echo ""
                echo "  Share with your team by committing .mcp.json to git. Each"
                echo "  teammate still needs rsct-mcp installed (run this installer)"
                echo "  so the 'rsct-mcp' binary is on their PATH."
                echo ""
                echo "  After /rsct-setup, restart Claude Code and verify with:"
                echo "    claude mcp list   →  rsct: rsct-mcp - ✓ Connected"
                echo ""
                echo "  (To register manually instead: cd <project> &&"
                echo "   claude mcp add rsct rsct-mcp --scope project)"
                echo ""
                echo "  Full doc: see 'Project scope detail' section in"
                echo "  the rsct-framework README.md."
                ;;
              3)
                printf 'skip\n' > "$RSCT_HOME/mcp-scope"
                echo ""
                echo "→ Skipped. To register later:"
                echo "    User scope (1x per machine):   claude mcp add rsct rsct-mcp --scope user"
                echo "    OR project scope (per project): cd <project> && claude mcp add rsct rsct-mcp --scope project"
                ;;
              *)
                # Default: user scope.
                # CAP-48: record the chosen scope so /rsct-setup does NOT
                # materialize a project .mcp.json for a user-scope install.
                printf 'user\n' > "$RSCT_HOME/mcp-scope"
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
                if command -v claude >/dev/null 2>&1; then
                  USER_SCOPE_HAS_RSCT="no"
                  if [ -f "$HOME/.claude.json" ] && command -v node >/dev/null 2>&1; then
                    if node -e "
                      try {
                        var j = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
                        process.exit((j.mcpServers && j.mcpServers.rsct) ? 0 : 1);
                      } catch (e) { process.exit(1); }
                    " "$HOME/.claude.json" 2>/dev/null; then
                      USER_SCOPE_HAS_RSCT="yes"
                    fi
                  fi
                  if [ "$USER_SCOPE_HAS_RSCT" = "yes" ]; then
                    echo "✓ rsct already registered at user scope — no change."
                  else
                    echo ""
                    echo "Registering rsct with Claude Code at user scope..."
                    if claude mcp add rsct rsct-mcp --scope user >/dev/null 2>&1; then
                      echo "✓ rsct registered (user scope)."
                      echo "  Available in every project on this machine after IDE restart."
                    else
                      echo "⚠ 'claude mcp add' failed. Register manually:"
                      echo "    claude mcp add rsct rsct-mcp --scope user"
                    fi
                  fi
                else
                  echo "⚠ 'claude' CLI not on PATH — cannot auto-register."
                  echo "  Once Claude Code is installed, run:"
                  echo "    claude mcp add rsct rsct-mcp --scope user"
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
echo "(If you chose 'Project scope' above, also run"
echo " 'claude mcp add rsct rsct-mcp --scope project' inside each"
echo " target project BEFORE step 2.)"
echo ""
# E1 (field-report): report the EFFECTIVE user-level scope so the dev knows what
# actually resolves, independent of the menu choice above. A lingering user-scope
# entry silently overrides a project-scope intent in every project.
if command -v node >/dev/null 2>&1 && [ -f "$HOME/.claude.json" ] && node -e "
  try { var j = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
    process.exit((j.mcpServers && j.mcpServers.rsct) ? 0 : 1); } catch(e){ process.exit(1); }
" "$HOME/.claude.json" 2>/dev/null; then
  echo "Effective MCP scope: USER — rsct is in ~/.claude.json, active in EVERY project"
  echo "  on this machine (a project .mcp.json would be redundant)."
else
  echo "Effective MCP scope: no user-level rsct — it resolves only where a project"
  echo "  .mcp.json registers it (i.e. true project scope)."
fi
echo ""
echo "To uninstall the framework from this machine (different from"
echo "uninstalling RSCT from a project), run:"
echo "  bash $SOURCE_DIR/scripts/uninstall-framework.sh"
