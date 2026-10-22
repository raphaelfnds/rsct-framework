#!/usr/bin/env bash

RSCT_WSLPATH=/usr/bin/wslpath

rsct_wsl_verdict() {
  case "$1:$2" in
    no:no) echo normal ;;
    no:yes) echo stop-not-wsl ;;
    yes:yes) echo wsl ;;
    *) echo stop-no-flag ;;
  esac
}

rsct_wslpath_side() {
  case "$1" in
    '\\wsl.localhost\'*|'\\wsl$\'*) echo linux ;;
    *) echo windows ;;
  esac
}

rsct_path_side() {
  local path="$1" answer
  case "$path" in
    /*) ;;
    *) echo unknown; return 0 ;;
  esac
  case "$path" in
    */.|*/./*|*/..|*/../*) echo unknown; return 0 ;;
  esac
  while [ ! -e "$path" ] && [ ! -L "$path" ] && [ "$path" != "/" ]; do
    path="${path%/*}"
    [ -n "$path" ] || path="/"
  done
  if [ -L "$path" ] && [ ! -e "$path" ]; then
    echo unknown
    return 0
  fi
  if answer=$("$RSCT_WSLPATH" -w "$path" 2>/dev/null) && [ -n "$answer" ]; then
    rsct_wslpath_side "$answer"
  else
    echo unknown
  fi
}

rsct_tool_is_windows() {
  local magic=""
  [ "$(rsct_path_side "$1")" = linux ] || return 0
  [ -r "$1" ] || return 0
  IFS= read -r -n 2 magic 2>/dev/null < "$1" || true
  [ "$magic" = "MZ" ]
}

rsct_linux_path() {
  local entry kept=""
  local IFS=':'
  set -f
  for entry in $1; do
    if [ "$(rsct_path_side "$entry")" = linux ]; then
      kept="${kept:+$kept:}$entry"
    fi
  done
  set +f
  printf '%s' "$kept"
}

rsct_host_config() {
  local cfg=""
  if command -v node >/dev/null 2>&1; then
    cfg=$(node -e 'var d = process.env.CLAUDE_CONFIG_DIR || require("os").homedir(); if (process.platform === "win32") d = d.split(String.fromCharCode(92)).join("/"); process.stdout.write(d + "/.claude.json")' 2>/dev/null || true)
  fi
  [ -n "$cfg" ] || cfg="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
  printf '%s' "$cfg"
}

rsct_wsl_unsafe_destination() {
  local dest
  for dest in "$@"; do
    [ -n "$dest" ] || continue
    if [ "$(rsct_path_side "$dest")" != linux ]; then
      printf '%s' "$dest"
      return 0
    fi
  done
  return 0
}
