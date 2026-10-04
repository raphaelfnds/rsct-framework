#!/usr/bin/env bash

set -e

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$SOURCE_DIR/prompts/01-setup.md" ] || [ ! -f "$SOURCE_DIR/VERSION" ]; then
  echo "ERROR: $SOURCE_DIR does not look like the RSCT framework source."
  echo "Expected to find: $SOURCE_DIR/prompts/01-setup.md and $SOURCE_DIR/VERSION"
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
  __rod_var="$1"; __rod_prompt="$2"; __rod_def="$3"; __rod_eof_ok="${4:-}"
  if [ -n "$ASSUME_YES" ]; then
    printf '%s%s   (RSCT non-interactive default)\n' "$__rod_prompt" "$__rod_def"
    eval "$__rod_var=\$__rod_def"
  else
    printf '%s' "$__rod_prompt"
    if ! read -r __rod_reply; then
      if [ -z "$__rod_eof_ok" ]; then
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

RSCT_HOME="$HOME/.rsct"
MCP_HOME="$RSCT_HOME/mcp-server"
CLAUDE_COMMANDS_DIR="$HOME/.claude/commands"

mcp_command_is_copy() {
  [ -n "$1" ] || return 1
  if [ "$1" -ef "$MCP_HOME/dist/index.js" ]; then return 0; fi
  [ "$(dirname "$1")/node_modules/rsct-mcp/dist/index.js" -ef "$MCP_HOME/dist/index.js" ]
}

HOST_CFG="$HOME/.claude.json"
if command -v node >/dev/null 2>&1; then
  HOST_CFG_RESOLVED=$(node -e 'var d = process.env.CLAUDE_CONFIG_DIR || require("os").homedir(); process.stdout.write(d.split(String.fromCharCode(92)).join("/") + "/.claude.json")' 2>/dev/null || echo "")
  if [ -n "$HOST_CFG_RESOLVED" ]; then HOST_CFG="$HOST_CFG_RESOLVED"; fi
fi

MCP_SCOPE_RECORDED=""
MCP_SCOPE_KNOWN=""
if [ -f "$RSCT_HOME/mcp-scope" ]; then
  MCP_SCOPE_RECORDED=$(tr -d '\r' < "$RSCT_HOME/mcp-scope" | head -1)
fi
MCP_SCOPE_LEGACY=""
case "$MCP_SCOPE_RECORDED" in
  project) MCP_SCOPE_DEFAULT="2"; MCP_SCOPE_KNOWN="project" ;;
  skip)    MCP_SCOPE_DEFAULT="1"; MCP_SCOPE_KNOWN="skip"; MCP_SCOPE_LEGACY="1" ;;
  user)    MCP_SCOPE_DEFAULT="1"; MCP_SCOPE_KNOWN="user" ;;
  *)       MCP_SCOPE_DEFAULT="1" ;;
esac

OS_NAME=$(uname -s 2>/dev/null || echo "")
if echo "$OS_NAME" | grep -qiE "MINGW|MSYS|CYGWIN"; then
  RSCT_HOME_FOR_CLAUDE=$(cygpath -m "$RSCT_HOME" 2>/dev/null || echo "$RSCT_HOME")
else
  RSCT_HOME_FOR_CLAUDE="$RSCT_HOME"
fi

EXISTING_VERSION=""
if [ -f "$RSCT_HOME/VERSION" ]; then
  EXISTING_VERSION=$(tr -d '\r' < "$RSCT_HOME/VERSION" | head -1)
fi
EXISTING_CODE_VERSION=""
if [ -f "$RSCT_HOME/VERSION-CODE" ]; then
  EXISTING_CODE_VERSION=$(tr -d '\r' < "$RSCT_HOME/VERSION-CODE" | head -1)
fi
case "$EXISTING_CODE_VERSION" in
  '') ;;
  *[!0-9.]*) EXISTING_CODE_VERSION="unreadable" ;;
esac

NEW_VERSION="unknown"
if [ -f "$SOURCE_DIR/VERSION" ]; then
  NEW_VERSION="$(tr -d '\r' < "$SOURCE_DIR/VERSION" | head -1)"
fi
case "$NEW_VERSION" in
  ''|*[!0-9.]*) NEW_VERSION="unknown" ;;
esac
NEW_CODE_VERSION=""
if [ -f "$SOURCE_DIR/mcp-server/src/lib/version.ts" ]; then
  NEW_CODE_VERSION=$(tr -d '\r' < "$SOURCE_DIR/mcp-server/src/lib/version.ts" \
    | grep -E "^export const RSCT_MCP_VERSION" \
    | sed -n "s/.*'\([^']*\)'.*/\1/p" | head -1)
fi
case "$NEW_CODE_VERSION" in
  ''|*[!0-9.]*) NEW_CODE_VERSION="unknown" ;;
esac

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

read_or_default confirm "Proceed? [y/N] " "y"
case "$confirm" in
  y|Y|yes|YES) ;;
  *) echo "Cancelled."; exit 0 ;;
esac

mkdir -p "$RSCT_HOME"
mkdir -p "$CLAUDE_COMMANDS_DIR"

RUNTIME_DIRS="prompts rules doc-templates memory-templates universe-templates"
KNOWN_NON_RUNTIME="scripts mcp-server examples docs .git .github .claude node_modules dist coverage .vscode"

for dir in $RUNTIME_DIRS; do
  echo "  copying $dir/"
  rm -rf "${RSCT_HOME:?}/$dir"
  cp -r "$SOURCE_DIR/$dir" "$RSCT_HOME/$dir"
done

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

echo "$NEW_VERSION" > "$RSCT_HOME/VERSION"
echo "$NEW_CODE_VERSION" > "$RSCT_HOME/VERSION-CODE"

cat > "$CLAUDE_COMMANDS_DIR/rsct-setup.md" <<EOF
---
description: Apply or update RSCT governance protocol in this project
---

@$RSCT_HOME_FOR_CLAUDE/prompts/01-setup.md
EOF

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

if [ -n "$SKIP_MCP" ]; then
  echo "Skipping rsct-mcp companion (RSCT_SKIP_MCP set) — framework files only."
elif [ -d "$SOURCE_DIR/mcp-server" ] && [ -f "$SOURCE_DIR/mcp-server/package.json" ]; then
  echo "────────────────────────────────────────────────────────"
  echo "Companion: rsct-mcp (Model Context Protocol server)"
  echo "────────────────────────────────────────────────────────"
  echo "Adds 40 tools + 5 resources to Claude Code — §C-gated"
  echo "commit/push/merge, SessionStart sanitizer hook, audit log,"
  echo "and structured project recall. Strongly recommended."
  echo ""

  case "$MCP_INSTALLABLE" in
    yes)
      read_or_default mcp_confirm "Install rsct-mcp now? [Y/n] " "y"
      case "$mcp_confirm" in
        n|N|no|NO)
          echo "Skipped. Any rsct-mcp already on this machine was left as it is."
          echo "  To install or update it later, run this installer again and answer Y."
          ;;
        *)
          echo ""
          echo "Installing rsct-mcp ($MCP_NODE_DESC)..."
          if (
            cd "$SOURCE_DIR/mcp-server" || exit 1
            if [ ! -f dist/index.js ]; then
              echo "  No prebuilt dist/ found — building from source (installs full toolchain)."
              npm install && npm run build || exit 1
            fi
            rm -rf "$MCP_HOME.new" "$MCP_HOME.old" || exit 1
            mkdir -p "$MCP_HOME.new" || exit 1
            while IFS= read -r entry; do
              [ -n "$entry" ] || continue
              cp -R "$entry" "$MCP_HOME.new"/ || exit 1
            done < <(node -e 'var p=JSON.parse(require("fs").readFileSync("package.json","utf8"));["package.json"].concat(p.files||[]).forEach(function(f){console.log(f)})' | tr -d '\r')
            [ -f "$MCP_HOME.new/dist/index.js" ] || exit 1
            if [ -e "$MCP_HOME" ] || [ -L "$MCP_HOME" ]; then
              mv "$MCP_HOME" "$MCP_HOME.old" || exit 1
            fi
            if ! mv "$MCP_HOME.new" "$MCP_HOME"; then
              if [ -e "$MCP_HOME.old" ] || [ -L "$MCP_HOME.old" ]; then
                mv "$MCP_HOME.old" "$MCP_HOME"
              fi
              exit 1
            fi
            rm -rf "$MCP_HOME.old" || true
            cd "$MCP_HOME" || exit 1
            npm install -g . --install-links=false
          ); then
            echo ""
            MCP_CMD=$(command -v rsct-mcp 2>/dev/null || true)
            if mcp_command_is_copy "$MCP_CMD"; then
              if "$MCP_CMD" </dev/null >/dev/null 2>&1; then
                echo "✓ rsct-mcp installed. The command runs from $MCP_HOME —"
                echo "  a copy of this version, not this clone. Switching branches, moving or"
                echo "  deleting the clone does not change it. To update: git pull, then run this"
                echo "  installer again. Keep the clone (or clone again) to uninstall."
              else
                echo "⚠ rsct-mcp was installed at $MCP_HOME but did not start."
                echo "  Claude Code will not get the rsct__* tools until it does."
                echo "  Try it by hand: rsct-mcp </dev/null   (see docs/troubleshooting.md)"
              fi
            else
              echo "⚠ rsct-mcp was copied to $MCP_HOME and npm linked it, but the"
              echo "  'rsct-mcp' on your PATH could not be confirmed to run from that copy:"
              echo "    ${MCP_CMD:-not found}"
              echo "  Claude Code starts whatever 'rsct-mcp' resolves to. If that is a version"
              echo "  manager's shim, try it by hand: rsct-mcp </dev/null. Otherwise put npm's global"
              echo "  bin directory ahead of it on PATH and run this installer again."
            fi

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
            [ -n "$mcp_scope" ] || mcp_scope="$MCP_SCOPE_DEFAULT"

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
                SCOPE_EFFECTIVE=""
                USER_SCOPE_ENTRY="no"
                USER_SCOPE_CMD=""
                if [ -f "$HOST_CFG" ] && command -v node >/dev/null 2>&1; then
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
                    SCOPE_EFFECTIVE="unattended"
                    echo "  RSCT_ASSUME_YES is set — nothing was removed and the"
                    echo "  recorded scope is left unchanged. Re-run interactively"
                    echo "  to complete the switch."
                  else
                    read_or_default mcp_rm "Remove the user-scope rsct entry now? [y/N] " "n" eof-ok
                    case "$mcp_rm" in
                      y|Y|yes|YES)
                        MCP_RM_CLI="no"
                        if command -v claude >/dev/null 2>&1; then
                          if claude mcp remove rsct --scope user </dev/null >/dev/null 2>&1; then
                            MCP_RM_CLI="yes"
                          fi
                        fi
                        MCP_RM_OK="yes"
                        if [ -f "$HOST_CFG" ] && command -v node >/dev/null 2>&1; then
                          if node -e 'try { var j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit((j.mcpServers && j.mcpServers.rsct) ? 0 : 1); } catch (err) { process.exit(1); }' "$HOST_CFG" 2>/dev/null; then
                            MCP_RM_OK="no"
                          fi
                        elif [ "$MCP_RM_CLI" = "no" ]; then
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
                    echo ""
                    echo "→ Recorded scope left unchanged (${MCP_SCOPE_RECORDED:-none})."
                    ;;
                  *)
                    echo ""
                    echo "⚠ INTERNAL: no scope decision was reached (SCOPE_EFFECTIVE empty)."
                    echo "  Nothing was recorded — $RSCT_HOME/mcp-scope still reads"
                    echo "  '${MCP_SCOPE_RECORDED:-none}'. Please report this output as a bug."
                    ;;
                esac
                ;;
              *)
                if [ "$mcp_scope" != "1" ] && [ -n "$MCP_SCOPE_KNOWN" ]; then
                  echo ""
                  echo "⚠ '$mcp_scope' is not 1/2 — applying the documented default (user scope),"
                  echo "  REPLACING the recorded '$MCP_SCOPE_KNOWN'. Re-run and pick again to undo."
                fi
                if [ -n "$MCP_SCOPE_LEGACY" ] && [ -n "$ASSUME_YES" ]; then
                  echo ""
                  echo "→ Legacy 'skip' marker + unattended run — registering nothing"
                  echo "  and leaving the recorded scope as 'skip'. Re-run"
                  echo "  interactively to pick [1] or [2]."
                else
                USER_SCOPE_HAS_RSCT="no"
                if [ -f "$HOST_CFG" ] && command -v node >/dev/null 2>&1; then
                  if node -e 'try { var j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit((j.mcpServers && j.mcpServers.rsct) ? 0 : 1); } catch (err) { process.exit(1); }' "$HOST_CFG" 2>/dev/null; then
                    USER_SCOPE_HAS_RSCT="yes"
                  fi
                fi
                if [ "$USER_SCOPE_HAS_RSCT" = "yes" ]; then
                  echo "✓ rsct already registered at user scope — no change."
                  if [ -n "$MCP_SCOPE_KNOWN" ] && [ "$MCP_SCOPE_KNOWN" != "user" ]; then
                    echo "  Recorded scope changes '$MCP_SCOPE_KNOWN' → 'user'. Any committed"
                    echo "  .mcp.json stays in git but is now masked by this entry, and"
                    echo "  /rsct-setup will no longer create or refresh one."
                  fi
                elif command -v claude >/dev/null 2>&1; then
                  echo ""
                  echo "Registering rsct with Claude Code at user scope..."
                  claude mcp add rsct rsct-mcp --scope user </dev/null >/dev/null 2>&1 || true
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
            MCP_CMD=$(command -v rsct-mcp 2>/dev/null || true)
            if cmp -s "$SOURCE_DIR/mcp-server/dist/index.js" "$MCP_HOME/dist/index.js" 2>/dev/null; then
              if mcp_command_is_copy "$MCP_CMD"; then
                echo "  The copy in $MCP_HOME is this version, and the 'rsct-mcp'"
                echo "  on your PATH runs from it, so the companion is in place. Run this"
                echo "  installer again to reach the scope menu."
              else
                echo "  The copy in $MCP_HOME is this version, but the 'rsct-mcp'"
                echo "  on your PATH could not be confirmed to run from it: ${MCP_CMD:-not found}"
                echo "  On Linux a global npm install may need sudo or a user-level prefix (nvm, n)."
                echo "  With sudo, then run this installer again:"
                echo "    cd \"$MCP_HOME\" && sudo npm install -g . --install-links=false"
              fi
            else
              if mcp_command_is_copy "$MCP_CMD"; then
                echo "  Nothing was replaced: the 'rsct-mcp' on your PATH still runs from the copy"
                echo "  that was already in $MCP_HOME."
              else
                echo "  No copy of this version was put in $MCP_HOME."
              fi
              echo "  Common causes:"
              echo "    - $MCP_HOME is in use by another program."
              echo "    - Missing prebuilt dist/ AND no build toolchain available."
              echo "  Fix the cause and run this installer again."
            fi
          fi
          ;;
      esac
      ;;
    no)
      echo "Skipping rsct-mcp install — $MCP_NODE_DESC"
      echo "Install Node 20+ (and npm), then run this installer again."
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
echo "(Chose 'Project scope' above? /rsct-setup writes and approves the"
echo " project's .mcp.json for you — nothing to register by hand.)"
echo ""
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
echo "  bash \"$SOURCE_DIR/scripts/uninstall-framework.sh\""
