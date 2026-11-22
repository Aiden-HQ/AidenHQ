#!/usr/bin/env bash
# The host's data directory, resolved one way for every consumer (the runner's backoff marker and the exporter that writes
# `aidenhq_unit_backoff`, the other ops scripts): `AIDENHQ_DATA_DIR` from the environment when a caller set it, else the
# checkout's `.env`. Sourced, never run; the path printed is absolute, with no trailing slash (but `/` stays `/`).
#
# `.env` is read, never sourced: the runner unit starts scripts that have no business running a file of settings, so only
# the one setting asked for is parsed. The value keeps the quoting the file gave it: a single-quoted `'$HOME/x'` is the
# literal text the shell would have got, a `"$HOME/x"` expands the variable (not `~`, which stays literal inside double
# quotes), and an unquoted `~/x` expands both -- the same text `source .env` would have produced, without running the file.
# A leading `export` is part of the assignment, not the name. A relative value is the checkout's, as every ops script
# treats it.

# The checkout that holds this lib and its `.env`: this file's own location, never the caller's cwd.
aidenhq_data_root() {
  local here="${BASH_SOURCE[0]%/*}"
  cd "$here/../.." && pwd
}

# One setting as written: the environment's value, else the checkout's `.env` (parsed, never sourced), quotes and all.
aidenhq_env_raw() {
  local root value
  if [ -n "${!1:-}" ]; then printf '%s\n' "${!1}"; return 0; fi
  root="$(aidenhq_data_root 2>/dev/null || true)" || return 0
  [ -n "$root" ] || root="$(pwd)"
  [ -f "$root/.env" ] || return 0
  # `NAME=...` or `export NAME=...`, with any spacing around the `=`; the last assignment wins as in the shell.
  value="$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$root/.env" 2>/dev/null | tail -n 1)" || return 0
  printf '%s\n' "${value%$'\r'}"
}

# One setting's value, its quotes removed, never expanded (a caller that wants a path uses aidenhq_env_dir).
aidenhq_env_value() {
  local raw
  raw="$(aidenhq_env_raw "$1")"
  case "$raw" in
    \"*) raw="${raw#\"}"; raw="${raw%%\"*}" ;;
    \'*) raw="${raw#\'}"; raw="${raw%%\'*}" ;;
    *) raw="${raw%%[[:space:]]#*}" ;;
  esac
  printf '%s\n' "$raw"
}

# NAME [default]: the directory the setting names, expanded as sourcing `.env` would have -- `$HOME`/`${HOME}` and a leading
# `~` where the shell expands them, and nothing inside single quotes.
aidenhq_env_dir() {
  local name="$1" dflt="${2-}" root raw value
  root="$(aidenhq_data_root 2>/dev/null || true)" || return 0
  [ -n "$root" ] || root="$(pwd)"
  raw="$(aidenhq_env_raw "$name")"
  case "$raw" in
    \'*) # single-quoted: the shell expands nothing, so neither do we.
      value="${raw#\'}"; value="${value%%\'*}" ;;
    \"*) # double-quoted: variables expand, `~` does not.
      value="${raw#\"}"; value="${value%%\"*}"
      value="${value//'${HOME}'/$HOME}"; value="${value//'$HOME'/$HOME}" ;;
    *) # unquoted: a leading `~`, then a variable; a ` #comment` is not part of it.
      value="${raw%%[[:space:]]#*}"
      case "$value" in "~") value="$HOME" ;; "~/"*) value="$HOME/${value#"~/"}" ;; esac
      value="${value//'${HOME}'/$HOME}"; value="${value//'$HOME'/$HOME}" ;;
  esac
  if [ -z "$value" ]; then value="$dflt"; fi
  [ -n "$value" ] || { printf '%s\n' ""; return 0; }
  case "$value" in
    .|./*) value="${value#./}" ;;
  esac
  case "$value" in
    /*) ;;
    *) value="$root/$value" ;;
  esac
  case "$value" in
    /) ;;
    */) value="${value%/}" ;;
  esac
  printf '%s\n' "$value"
}

# The host's data dir (the default is `<checkout>/data`, as `.env.example` names it).
aidenhq_data_dir() {
  aidenhq_env_dir AIDENHQ_DATA_DIR data
}
