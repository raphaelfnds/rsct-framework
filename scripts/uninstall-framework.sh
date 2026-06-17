#!/usr/bin/env bash
# scripts/uninstall-framework.sh
# Removes the RSCT framework from this machine.
#
# This is DIFFERENT from /rsct-uninstall (prompts/03-uninstall.md), which
# removes RSCT from a project. This script removes the framework runtime
# (~/.rsct/), its Claude Code slash commands, and (optionally) the global
# rsct-mcp companion install from your machine.
#
# Projects already configured by RSCT are NOT affected by this script —
# they keep their CLAUDE.md, .rsct.json, documentation/, and memory entries.
# To remove RSCT from a project, run /rsct-uninstall (or its full path)
# inside that project BEFORE running this script.

set -e

# --- Reject WSL on Windows ---
# Symmetric to install.sh — if the dev is running this from WSL on a Windows
# machine, the script would scrub ~/.rsct/ at /home/<user>/.rsct/ but the
# actual install lives at C:/Users/<user>/.rsct/. The dev would think the
# uninstall succeeded while the real artefacts stay on disk.
if [ -f /proc/sys/kernel/osrelease ] && \
   grep -qiE "microsoft|wsl" /proc/sys/kernel/osrelease 2>/dev/null; then
  echo "════════════════════════════════════════════════════════"
  echo "ERROR: This script is running under WSL (Windows Subsystem for Linux)."
  echo "════════════════════════════════════════════════════════"
  echo ""
  echo "Your install lives at C:/Users/<user>/.rsct/ on the Windows side."
  echo "Running uninstall from WSL would scrub /home/<user>/.rsct/ instead"
  echo "(a different filesystem) and leave the real install untouched."
  echo ""
  echo "Open Git Bash on Windows (Start menu → Git Bash) and re-run:"
  echo "  bash /c/Users/<you>/path/to/rsct-framework/scripts/uninstall-framework.sh"
  exit 1
fi

RSCT_HOME="$HOME/.rsct"
CLAUDE_COMMANDS_DIR="$HOME/.claude/commands"

# --- Detect what is present ---
PRESENT_RSCT_HOME=""
PRESENT_COMMANDS=()
[ -d "$RSCT_HOME" ] && PRESENT_RSCT_HOME="yes"
for cmd in rsct-setup rsct-init-universe rsct-canonical-source rsct-uninstall; do
  [ -f "$CLAUDE_COMMANDS_DIR/$cmd.md" ] && PRESENT_COMMANDS+=("$cmd")
done

# Detect global rsct-mcp install (companion).
PRESENT_RSCT_MCP=""
RSCT_MCP_BIN=""
if command -v rsct-mcp >/dev/null 2>&1; then
  RSCT_MCP_BIN=$(command -v rsct-mcp)
  PRESENT_RSCT_MCP="yes"
fi

if [ -z "$PRESENT_RSCT_HOME" ] && [ ${#PRESENT_COMMANDS[@]} -eq 0 ] && [ -z "$PRESENT_RSCT_MCP" ]; then
  echo "Nothing to remove — RSCT framework is not installed on this machine."
  exit 0
fi

# --- Show plan ---
# Symmetric with install.sh: report both protocol and code versions so the
# dev sees exactly what is being removed (the code version is the one that
# moves between releases; protocol stays at 1.0.0 across the pre-release
# train and would otherwise look unchanged across re-installs).
EXISTING_VERSION=""
if [ -f "$RSCT_HOME/VERSION" ]; then
  EXISTING_VERSION=$(cat "$RSCT_HOME/VERSION" 2>/dev/null | head -1)
fi
EXISTING_CODE_VERSION=""
if [ -f "$RSCT_HOME/VERSION-CODE" ]; then
  EXISTING_CODE_VERSION=$(cat "$RSCT_HOME/VERSION-CODE" 2>/dev/null | head -1)
fi

echo "════════════════════════════════════════════════════════"
echo "RSCT Framework — Uninstall from machine"
echo "════════════════════════════════════════════════════════"
if [ -n "$PRESENT_RSCT_HOME" ]; then
  # Build a compact version tag for the "Will remove" line. Possible shapes:
  #   (protocol=1.0.0, code=0.7.0) — both files present (post-v0.7.0 install)
  #   (v1.0.0)                     — only legacy VERSION file (pre-v0.7.0)
  #   (no version metadata)        — directory exists but no version markers
  VERSION_TAG=""
  if [ -n "$EXISTING_VERSION" ] && [ -n "$EXISTING_CODE_VERSION" ]; then
    VERSION_TAG="(protocol=${EXISTING_VERSION}, code=${EXISTING_CODE_VERSION})"
  elif [ -n "$EXISTING_VERSION" ]; then
    VERSION_TAG="(v${EXISTING_VERSION})"
  else
    VERSION_TAG="(no version metadata)"
  fi
  echo "Will remove: $RSCT_HOME  ${VERSION_TAG}"
fi
for cmd in "${PRESENT_COMMANDS[@]}"; do
  echo "Will remove: $CLAUDE_COMMANDS_DIR/$cmd.md"
done
if [ -n "$PRESENT_RSCT_MCP" ]; then
  echo "Detected:    global rsct-mcp at $RSCT_MCP_BIN (will ask separately)"
fi
echo ""
echo "NOTE: This does NOT remove RSCT from any project. Projects keep their"
echo "CLAUDE.md, .rsct.json, documentation/, and memory entries. If you want"
echo "to clean a project first, run /rsct-uninstall in that project BEFORE"
echo "running this script."
echo "════════════════════════════════════════════════════════"

printf "Proceed with framework removal? [y/N] "
read -r confirm
case "$confirm" in
  y|Y|yes|YES) ;;
  *) echo "Cancelled."; exit 0 ;;
esac

# --- Execute framework removal ---
if [ -n "$PRESENT_RSCT_HOME" ]; then
  rm -rf "$RSCT_HOME"
  echo "Removed: $RSCT_HOME"
fi
for cmd in "${PRESENT_COMMANDS[@]}"; do
  rm -f "$CLAUDE_COMMANDS_DIR/$cmd.md"
  echo "Removed: $CLAUDE_COMMANDS_DIR/$cmd.md"
done

# --- Optional: uninstall global rsct-mcp ---
# Asked separately because some devs may want to keep the MCP server
# (e.g., for projects that already wire it via `.mcp.json`) even after
# removing the framework files. Symmetric to install.sh's mcp prompt.
if [ -n "$PRESENT_RSCT_MCP" ]; then
  echo ""
  echo "────────────────────────────────────────────────────────"
  echo "Companion: rsct-mcp"
  echo "────────────────────────────────────────────────────────"
  echo "Detected global install at: $RSCT_MCP_BIN"
  echo "Projects with rsct registered in .mcp.json will stop seeing"
  echo "the rsct__* tools after this is removed."
  echo ""
  printf "Also remove the global rsct-mcp install? [Y/n] "
  read -r mcp_confirm
  case "$mcp_confirm" in
    n|N|no|NO)
      echo "Kept: $RSCT_MCP_BIN"
      echo "To remove later: npm uninstall -g rsct-mcp"
      ;;
    *)
      if command -v npm >/dev/null 2>&1; then
        if npm uninstall -g rsct-mcp; then
          echo "Removed global rsct-mcp."
        else
          echo "⚠ npm uninstall -g rsct-mcp failed."
          echo "  Common cause on Linux: needs sudo for global npm dir."
          echo "  Retry: sudo npm uninstall -g rsct-mcp"
        fi
      else
        echo "⚠ npm not on PATH — cannot run 'npm uninstall -g rsct-mcp'."
        echo "  Remove manually with whichever tool installed it (npm, pnpm, yarn)."
      fi
      ;;
  esac
fi

# --- Detect Claude Code MCP registration (user scope) and offer removal ---
# Symmetric to install.sh's auto-register flow: if rsct was registered at
# user scope (one-time per machine), offer to unregister with one command.
# Project-scope registrations live inside each project's .mcp.json and are
# documented under MANUAL STEPS below (cannot enumerate every project).
#
# Detection parses ~/.claude.json directly because `claude mcp list` in
# non-TTY (pipe) mode includes project-scope .mcp.json entries — if the
# dev has a project .mcp.json with rsct anywhere in cwd ancestry, the grep
# would false-positive and the script would offer to remove something it
# can't actually remove (user-scope unregister doesn't touch project files).
USER_SCOPE_HAS_RSCT="no"
if command -v claude >/dev/null 2>&1 && \
   [ -f "$HOME/.claude.json" ] && \
   command -v node >/dev/null 2>&1; then
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
  echo ""
  echo "────────────────────────────────────────────────────────"
  echo "Claude Code: rsct registered at user scope"
  echo "────────────────────────────────────────────────────────"
  echo "Detected in ~/.claude.json (top-level mcpServers.rsct)."
  echo "Removing it unregisters the MCP server from every project on"
  echo "this machine that relies on user scope. Project-scope"
  echo ".mcp.json files are untouched and listed under MANUAL STEPS below."
  echo ""
  printf "Also unregister rsct from Claude Code (user scope)? [Y/n] "
  read -r mcp_unreg_confirm
  case "$mcp_unreg_confirm" in
    n|N|no|NO)
      echo "Kept user-scope registration."
      echo "To remove later: claude mcp remove rsct --scope user"
      ;;
    *)
      if claude mcp remove rsct --scope user >/dev/null 2>&1; then
        echo "✓ Unregistered rsct from Claude Code (user scope)."
      else
        echo "⚠ 'claude mcp remove rsct --scope user' failed."
        echo "  Retry manually."
      fi
      ;;
  esac
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "Done. RSCT framework removed from this machine."
echo "════════════════════════════════════════════════════════"
echo ""
echo "⚠ MANUAL STEPS STILL REQUIRED"
echo ""
echo "1. If you used PROJECT scope for any project, remove rsct"
echo "   from each one (we can't enumerate them — only you know"
echo "   which projects opted in):"
echo "      cd /path/to/each-project"
echo "      claude mcp remove rsct --scope project"
echo "   (Or edit each project's .mcp.json by hand and delete"
echo "    the \"rsct\" key under \"mcpServers\".)"
echo ""
echo "2. Restart your IDE / Claude Code after the removals so the"
echo "   tool list reloads and the rsct__* tools disappear."
echo ""
echo "3. If you previously ran /rsct-uninstall in each project,"
echo "   the framework files (CLAUDE.md sections, .rsct.json,"
echo "   documentation/, .rsct/) are already cleaned up. Otherwise"
echo "   run /rsct-uninstall in each project before this script"
echo "   runs (recommended order, but not enforced)."
