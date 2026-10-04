#!/usr/bin/env bash

set -e

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

ASSUME_YES="${RSCT_ASSUME_YES:-}"
SKIP_MCP="${RSCT_SKIP_MCP:-}"
for arg in "$@"; do
  case "$arg" in
    -y|--yes)   ASSUME_YES=1 ;;
    --skip-mcp) SKIP_MCP=1 ;;
  esac
done

read_or_default() {
  __rod_var="$1"; __rod_prompt="$2"; __rod_def="$3"
  if [ -n "$ASSUME_YES" ]; then
    printf '%s%s   (RSCT non-interactive default)\n' "$__rod_prompt" "$__rod_def"
    eval "$__rod_var=\$__rod_def"
  else
    printf '%s' "$__rod_prompt"
    read -r __rod_reply
    eval "$__rod_var=\$__rod_reply"
  fi
}

RSCT_HOME="$HOME/.rsct"
MCP_HOME="$RSCT_HOME/mcp-server"
CLAUDE_COMMANDS_DIR="$HOME/.claude/commands"

mcp_command_is_copy() {
  [ -n "$1" ] || return 1
  if [ "$1" -ef "$MCP_HOME/dist/index.js" ]; then return 0; fi
  [ "$(dirname "$1")/node_modules/rsct-mcp/dist/index.js" -ef "$MCP_HOME/dist/index.js" ]
}

PRESENT_RSCT_HOME=""
PRESENT_COMMANDS=()
[ -d "$RSCT_HOME" ] && PRESENT_RSCT_HOME="yes"
for cmd in rsct-setup rsct-universe rsct-init-universe rsct-canonical-source rsct-uninstall rsct-clean-code; do
  [ -f "$CLAUDE_COMMANDS_DIR/$cmd.md" ] && PRESENT_COMMANDS+=("$cmd")
done

PRESENT_RSCT_MCP=""
RSCT_MCP_BIN=""
if command -v rsct-mcp >/dev/null 2>&1; then
  RSCT_MCP_BIN=$(command -v rsct-mcp)
  PRESENT_RSCT_MCP="yes"
fi
PRESENT_MCP_COPY=""
if [ -d "$MCP_HOME" ]; then
  PRESENT_MCP_COPY="yes"
fi
if [ -n "$PRESENT_RSCT_MCP" ]; then
  MCP_WHERE="global rsct-mcp at $RSCT_MCP_BIN"
else
  MCP_WHERE="rsct-mcp files at $MCP_HOME (no rsct-mcp command on PATH)"
fi

if [ -z "$PRESENT_RSCT_HOME" ] && [ ${#PRESENT_COMMANDS[@]} -eq 0 ] && [ -z "$PRESENT_RSCT_MCP" ]; then
  echo "Nothing to remove — RSCT framework is not installed on this machine."
  exit 0
fi

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
  VERSION_TAG=""
  if [ -n "$EXISTING_VERSION" ] && [ -n "$EXISTING_CODE_VERSION" ]; then
    VERSION_TAG="(protocol=${EXISTING_VERSION}, code=${EXISTING_CODE_VERSION})"
  elif [ -n "$EXISTING_VERSION" ]; then
    VERSION_TAG="(v${EXISTING_VERSION})"
  else
    VERSION_TAG="(no version metadata)"
  fi
  echo "Will remove: $RSCT_HOME  ${VERSION_TAG}"
  if [ -n "$PRESENT_MCP_COPY" ]; then
    echo "             except $MCP_HOME — the rsct-mcp companion's files"
  fi
fi
for cmd in "${PRESENT_COMMANDS[@]}"; do
  echo "Will remove: $CLAUDE_COMMANDS_DIR/$cmd.md"
done
if [ -n "$PRESENT_RSCT_MCP" ] || [ -n "$PRESENT_MCP_COPY" ]; then
  if [ -z "$SKIP_MCP" ]; then
    echo "Detected:    $MCP_WHERE (will ask separately)"
  else
    echo "Detected:    $MCP_WHERE (left untouched; --skip-mcp set)"
  fi
fi
echo ""
echo "NOTE: This does NOT remove RSCT from any project. Projects keep their"
echo "CLAUDE.md, .rsct.json, documentation/, and memory entries. If you want"
echo "to clean a project first, run /rsct-uninstall in that project BEFORE"
echo "running this script."
echo "════════════════════════════════════════════════════════"

read_or_default confirm "Proceed with framework removal? [y/N] " "y"
case "$confirm" in
  y|Y|yes|YES) ;;
  *) echo "Cancelled."; exit 0 ;;
esac

if [ -n "$PRESENT_RSCT_HOME" ]; then
  if [ -n "$PRESENT_MCP_COPY" ]; then
    set +f
    for entry in "$RSCT_HOME"/* "$RSCT_HOME"/.[!.]* "$RSCT_HOME"/..?*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      [ "$entry" = "$MCP_HOME" ] && continue
      rm -rf "$entry"
    done
    if [ -z "$SKIP_MCP" ]; then
      echo "Removed: the framework files in $RSCT_HOME (mcp-server/ is decided in the companion step)"
    else
      echo "Removed: the framework files in $RSCT_HOME (mcp-server/ left untouched; --skip-mcp set)"
    fi
  else
    rm -rf "$RSCT_HOME"
    echo "Removed: $RSCT_HOME"
  fi
fi
for cmd in "${PRESENT_COMMANDS[@]}"; do
  rm -f "$CLAUDE_COMMANDS_DIR/$cmd.md"
  echo "Removed: $CLAUDE_COMMANDS_DIR/$cmd.md"
done

if { [ -n "$PRESENT_RSCT_MCP" ] || [ -n "$PRESENT_MCP_COPY" ]; } && [ -z "$SKIP_MCP" ]; then
  echo ""
  echo "────────────────────────────────────────────────────────"
  echo "Companion: rsct-mcp"
  echo "────────────────────────────────────────────────────────"
  if [ -n "$PRESENT_RSCT_MCP" ]; then
    echo "Detected global install at: $RSCT_MCP_BIN"
  fi
  if [ -n "$PRESENT_MCP_COPY" ]; then
    echo "Companion files: $MCP_HOME"
  fi
  echo "Projects with rsct registered in .mcp.json will stop seeing"
  echo "the rsct__* tools after this is removed."
  echo ""
  read_or_default mcp_confirm "Also remove the global rsct-mcp install? [Y/n] " "y"
  case "$mcp_confirm" in
    n|N|no|NO)
      if [ -n "$PRESENT_RSCT_MCP" ]; then
        echo "Kept: $RSCT_MCP_BIN"
      fi
      if [ -n "$PRESENT_MCP_COPY" ]; then
        echo "Kept: $MCP_HOME"
        echo "To remove both later, run this uninstaller again."
      else
        echo "To remove later: npm uninstall -g rsct-mcp"
      fi
      ;;
    *)
      if command -v npm >/dev/null 2>&1; then
        if npm uninstall -g rsct-mcp; then
          MCP_LEFT=$(command -v rsct-mcp 2>/dev/null || true)
          if mcp_command_is_copy "$MCP_LEFT"; then
            echo "⚠ npm reported success, but the rsct-mcp on PATH still runs from"
            echo "  $MCP_HOME: $MCP_LEFT"
            echo "  It belongs to another npm prefix. The folder was left in place."
          else
            if [ -n "$PRESENT_MCP_COPY" ]; then
              if rm -rf "${RSCT_HOME:?}/mcp-server"; then
                rmdir "$RSCT_HOME" 2>/dev/null || true
                echo "Removed: $MCP_HOME"
              else
                echo "⚠ Could not remove $MCP_HOME (in use?)."
                echo "  Run this uninstaller again once nothing is using it."
              fi
            fi
            if [ -n "$MCP_LEFT" ]; then
              echo "⚠ npm reported success, but an rsct-mcp is still on PATH: $MCP_LEFT"
              echo "  It was not recognised as the copy this framework installed. If it is a"
              echo "  leftover, remove it by hand."
            else
              echo "Removed global rsct-mcp."
            fi
          fi
        else
          echo "⚠ npm uninstall -g rsct-mcp failed."
          echo "  Common cause on Linux: needs sudo for global npm dir."
          echo "  Retry: sudo npm uninstall -g rsct-mcp"
          if [ -n "$PRESENT_MCP_COPY" ]; then
            echo "  $MCP_HOME was left in place. After the retry, run this uninstaller again."
          fi
        fi
      else
        echo "⚠ npm not on PATH — cannot run 'npm uninstall -g rsct-mcp'."
        echo "  Remove manually with whichever tool installed it (npm, pnpm, yarn)."
        if [ -n "$PRESENT_MCP_COPY" ]; then
          echo "  $MCP_HOME was left in place. Afterwards, run this uninstaller again."
        fi
      fi
      ;;
  esac
fi

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
if [ "$USER_SCOPE_HAS_RSCT" = "yes" ] && [ -z "$SKIP_MCP" ]; then
  echo ""
  echo "────────────────────────────────────────────────────────"
  echo "Claude Code: rsct registered at user scope"
  echo "────────────────────────────────────────────────────────"
  echo "Detected in ~/.claude.json (top-level mcpServers.rsct)."
  echo "Removing it unregisters the MCP server from every project on"
  echo "this machine that relies on user scope. Project-scope"
  echo ".mcp.json files are untouched and listed under MANUAL STEPS below."
  echo ""
  read_or_default mcp_unreg_confirm "Also unregister rsct from Claude Code (user scope)? [Y/n] " "y"
  case "$mcp_unreg_confirm" in
    n|N|no|NO)
      echo "Kept user-scope registration."
      echo "To remove later: claude mcp remove rsct --scope user"
      ;;
    *)
      if claude mcp remove rsct --scope user </dev/null >/dev/null 2>&1; then
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
