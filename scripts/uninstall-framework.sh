#!/usr/bin/env bash

set -e

WSL_FLAG="no"
for arg in "$@"; do
  case "$arg" in
    --wsl) WSL_FLAG="yes" ;;
  esac
done

IS_WSL="no"
if [ -f /proc/sys/kernel/osrelease ] && \
   grep -qiE "microsoft|wsl" /proc/sys/kernel/osrelease 2>/dev/null; then
  IS_WSL="yes"
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/rsct-lib.sh"

WSL_VERDICT=$(rsct_wsl_verdict "$IS_WSL" "$WSL_FLAG")
case "$WSL_VERDICT" in
  normal|wsl) ;;
  stop-not-wsl)
    echo "ERROR: --wsl was given, but this is not WSL (Windows Subsystem for Linux)."
    echo "  --wsl is for an install made for a Claude Code inside a WSL distro: run this"
    echo "  uninstaller from a shell inside that distro. Here, run it without --wsl."
    exit 1
    ;;
  *)
    echo "════════════════════════════════════════════════════════"
    echo "ERROR: This script is running under WSL (Windows Subsystem for Linux)."
    echo "════════════════════════════════════════════════════════"
    echo ""
    echo "If your install is for Claude Code on Windows, it lives at"
    echo "C:/Users/<user>/.rsct/: open Git Bash on Windows (Start menu → Git Bash)"
    echo "and re-run:"
    echo "  bash /c/Users/<you>/path/to/rsct-framework/scripts/uninstall-framework.sh"
    echo ""
    echo "If you installed RSCT inside this WSL distro (with --wsl), re-run with --wsl:"
    echo "  bash scripts/uninstall-framework.sh --wsl"
    exit 1
    ;;
esac

WINDOWS_RSCT_MCP=""
if [ "$WSL_VERDICT" = "wsl" ]; then
  if [ ! -x "$RSCT_WSLPATH" ]; then
    echo "ERROR: --wsl needs $RSCT_WSLPATH to tell Windows programs from Linux ones,"
    echo "  and it is not there (a container that shares the WSL kernel?). Nothing was removed."
    exit 1
  fi
  WINDOWS_RSCT_MCP=$(type -P rsct-mcp 2>/dev/null || true)
  if [ -n "$WINDOWS_RSCT_MCP" ] && ! rsct_tool_is_windows "$WINDOWS_RSCT_MCP"; then
    WINDOWS_RSCT_MCP=""
  fi
  PATH=$(rsct_linux_path "$PATH")
  if [ -z "$PATH" ]; then
    echo "ERROR: --wsl: no folder on PATH could be confirmed to be on WSL's Linux side"
    echo "  ($RSCT_WSLPATH gave no Linux answer for any of them). Nothing was removed."
    exit 1
  fi
  export PATH
  hash -r
  unset -f node npm claude rsct-mcp 2>/dev/null || true
  for tool in node npm claude; do
    tool_path=$(type -P "$tool" 2>/dev/null || true)
    if [ -n "$tool_path" ] && rsct_tool_is_windows "$tool_path"; then
      echo "ERROR: --wsl: '$tool' at $tool_path is a Windows program, or could not be checked."
      echo "  Nothing was removed."
      exit 1
    fi
  done
fi

ASSUME_YES="${RSCT_ASSUME_YES:-}"
SKIP_MCP="${RSCT_SKIP_MCP:-}"
for arg in "$@"; do
  case "$arg" in
    -y|--yes)   ASSUME_YES=1 ;;
    --skip-mcp) SKIP_MCP=1 ;;
  esac
done

CLAUDE_HINT="claude"
LINUX_CLAUDE=$(type -P claude 2>/dev/null || true)
if [ "$WSL_VERDICT" = "wsl" ] && [ -n "$LINUX_CLAUDE" ]; then
  CLAUDE_HINT="\"$LINUX_CLAUDE\""
fi

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

HOST_CFG=$(rsct_host_config)

if [ "$WSL_VERDICT" = "wsl" ]; then
  NPM_PREFIX=""
  UNSAFE_DESTINATION=$(rsct_wsl_unsafe_destination "$RSCT_HOME" "$CLAUDE_COMMANDS_DIR" "$(dirname "$HOST_CFG")" "$HOST_CFG")
  if [ -z "$UNSAFE_DESTINATION" ] && command -v npm >/dev/null 2>&1; then
    NPM_PREFIX=$(npm prefix -g 2>/dev/null || true)
    if [ -z "$NPM_PREFIX" ]; then
      echo "ERROR: --wsl: 'npm prefix -g' gave no folder, so npm's global folder cannot be checked."
      echo "  Nothing was removed."
      exit 1
    fi
    UNSAFE_DESTINATION=$(rsct_wsl_unsafe_destination "$NPM_PREFIX")
  fi
  if [ -n "$UNSAFE_DESTINATION" ]; then
    echo "ERROR: --wsl: $UNSAFE_DESTINATION is not on WSL's Linux side, or could not be checked."
    echo "  An uninstall for a Claude Code inside WSL must touch only the Linux side;"
    echo "  removing there could change the Windows install. Nothing was removed."
    exit 1
  fi
fi

USER_SCOPE_HAS_RSCT="no"
USER_SCOPE_UNCHECKED=""
if [ -f "$HOST_CFG" ] && ! command -v node >/dev/null 2>&1; then
  USER_SCOPE_UNCHECKED="yes"
fi
if [ -f "$HOST_CFG" ] && command -v node >/dev/null 2>&1; then
  if node -e 'try { var j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit((j.mcpServers && j.mcpServers.rsct) ? 0 : 1); } catch (err) { process.exit(1); }' "$HOST_CFG" 2>/dev/null; then
    USER_SCOPE_HAS_RSCT="yes"
  fi
fi

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
  if [ "$USER_SCOPE_HAS_RSCT" != "yes" ]; then
    echo "Nothing to remove — RSCT framework is not installed on this machine."
    if [ -n "$USER_SCOPE_UNCHECKED" ]; then
      echo "  Not checked: whether rsct is registered at user scope in $HOST_CFG (node is not on PATH)."
    fi
    exit 0
  fi
  if [ -n "$SKIP_MCP" ]; then
    echo "Nothing to remove except the user-scope registration in $HOST_CFG, which --skip-mcp leaves in place."
    exit 0
  fi
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
if [ "$USER_SCOPE_HAS_RSCT" = "yes" ]; then
  if [ -z "$SKIP_MCP" ]; then
    echo "Detected:    rsct registered at user scope in $HOST_CFG (will ask separately)"
  else
    echo "Detected:    rsct registered at user scope in $HOST_CFG (left untouched; --skip-mcp set)"
  fi
fi
if [ -n "$WINDOWS_RSCT_MCP" ]; then
  echo "Not touched: $WINDOWS_RSCT_MCP — the Windows install's rsct-mcp. A Claude Code"
  echo "             inside WSL that still finds it by name would keep running it."
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
        if [ "$WSL_VERDICT" = "wsl" ]; then
          echo "To remove later, run this uninstaller again with --wsl."
        else
          echo "To remove later: npm uninstall -g rsct-mcp"
        fi
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
        if [ "$WSL_VERDICT" = "wsl" ]; then
          echo "  Inside WSL the 'npm' your shell finds may be the Windows one, which would change"
          echo "  the Windows install. Install npm inside WSL, then run this uninstaller again with --wsl."
        else
          echo "  Remove manually with whichever tool installed it (npm, pnpm, yarn)."
        fi
        if [ -n "$PRESENT_MCP_COPY" ]; then
          echo "  $MCP_HOME was left in place. Afterwards, run this uninstaller again."
        fi
      fi
      ;;
  esac
fi

REGISTRATION_LEFT=""
REGISTRATION_UNCONFIRMED=""
if [ "$USER_SCOPE_HAS_RSCT" = "yes" ] && [ -n "$SKIP_MCP" ]; then
  REGISTRATION_LEFT="yes"
fi
if [ "$USER_SCOPE_HAS_RSCT" = "yes" ] && [ -z "$SKIP_MCP" ]; then
  echo ""
  echo "────────────────────────────────────────────────────────"
  echo "Claude Code: rsct registered at user scope"
  echo "────────────────────────────────────────────────────────"
  echo "Detected in $HOST_CFG (top-level mcpServers.rsct)."
  echo "Removing it unregisters the MCP server from every project on"
  echo "this machine that relies on user scope. Project-scope"
  echo ".mcp.json files are untouched and listed under MANUAL STEPS below."
  echo ""
  if ! command -v claude >/dev/null 2>&1; then
    REGISTRATION_LEFT="yes"
    echo "⚠ No 'claude' CLI on PATH to remove it with. It stays in $HOST_CFG."
    if [ "$WSL_VERDICT" = "wsl" ]; then
      echo "  Inside WSL the 'claude' your shell finds may be the Windows one, which would change"
      echo "  the Windows install. Delete the \"rsct\" key under \"mcpServers\" in that file instead,"
      echo "  or install Claude Code's CLI inside WSL and run this uninstaller again with --wsl."
    else
      echo "  Remove it with: claude mcp remove rsct --scope user"
      echo "  (or delete the \"rsct\" key under \"mcpServers\" in that file)."
    fi
  else
    read_or_default mcp_unreg_confirm "Also unregister rsct from Claude Code (user scope)? [Y/n] " "y"
    case "$mcp_unreg_confirm" in
      n|N|no|NO)
        REGISTRATION_LEFT="yes"
        echo "Kept user-scope registration."
        echo "To remove later: $CLAUDE_HINT mcp remove rsct --scope user"
        ;;
      *)
        claude mcp remove rsct --scope user </dev/null >/dev/null 2>&1 || true
        REREAD=0
        node -e 'try { var j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit((j.mcpServers && j.mcpServers.rsct) ? 0 : 1); } catch (err) { process.exit(2); }' "$HOST_CFG" 2>/dev/null || REREAD=$?
        case "$REREAD" in
          0)
            REGISTRATION_LEFT="yes"
            echo "⚠ rsct is still registered at user scope in $HOST_CFG."
            echo "  Retry manually: $CLAUDE_HINT mcp remove rsct --scope user"
            ;;
          1)
            echo "✓ Unregistered rsct from Claude Code (user scope)."
            ;;
          *)
            REGISTRATION_UNCONFIRMED="yes"
            echo "⚠ $HOST_CFG could not be read after the removal, so it is not confirmed."
            echo "  Look for the \"rsct\" key under \"mcpServers\" in it by hand."
            ;;
        esac
        ;;
    esac
  fi
fi

echo ""
echo "════════════════════════════════════════════════════════"
if [ -n "$REGISTRATION_LEFT" ]; then
  echo "Done. The user-scope registration named above is still in place."
elif [ -n "$REGISTRATION_UNCONFIRMED" ]; then
  echo "Done. Not confirmed: whether the user-scope registration named above was removed."
elif [ -n "$USER_SCOPE_UNCHECKED" ]; then
  echo "Done. Not checked: whether rsct is still registered at user scope in $HOST_CFG"
  echo "(node is not on PATH)."
else
  echo "Done. RSCT framework removed from this machine."
fi
echo "════════════════════════════════════════════════════════"
echo ""
echo "⚠ MANUAL STEPS STILL REQUIRED"
echo ""
echo "1. If you used PROJECT scope for any project, remove rsct"
echo "   from each one (we can't enumerate them — only you know"
echo "   which projects opted in):"
echo "      cd /path/to/each-project"
echo "      $CLAUDE_HINT mcp remove rsct --scope project"
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
