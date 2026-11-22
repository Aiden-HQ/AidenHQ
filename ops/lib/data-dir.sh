#!/usr/bin/env bash
# The host's data directory, resolved one way for every consumer (the runner's backoff marker and the exporter that writes
# `aidenhq_unit_backoff`, the other ops scripts): `AIDENHQ_DATA_DIR` from the environment when a caller set it, else the
# checkout's `.env`. Sourced, never run; the path printed is absolute, with no trailing slash (but `/` stays `/`).
#
# `.env` is read, never sourced: the runner unit starts scripts that have no business running a file of settings, so only
# this one setting is parsed. A value the exporter would get expanded (`$HOME`, `${HOME}`, a leading `~`) is expanded here the
# same way; a relative value is the checkout's, as every ops script treats it.

# The checkout that holds this lib and its `.env`: this file's own location, never the caller's cwd.
aidenhq_data_root() {
  local here="${BASH_SOURCE[0]%/*}"
  cd "$here/../.." && pwd
}

# One setting out of the environment, else the checkout's `.env` (parsed, never sourced): the value as written.
aidenhq_env_value() {
  local root value
  if [ -n "${!1:-}" ]; then printf '%s\n' "${!1}"; return 0; fi
  root="$(aidenhq_data_root 2>/dev/null || true)" || return 0
  [ -n "$root" ] || root="$(pwd)"
  [ -f "$root/.env" ] || return 0
  value="$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$root/.env" 2>/dev/null | tail -n 1)" || return 0
  value="${value%$'\r'}"
  case "$value" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    *) value="${value%%[[:space:]]#*}" ;;
  esac
  printf '%s\n' "$value"
}

aidenhq_data_dir() {
  local root value
  root="$(aidenhq_data_root 2>/dev/null || true)" || return 0
  [ -n "$root" ] || root="$(pwd)"
  value="$(aidenhq_env_value AIDENHQ_DATA_DIR)"
  [ -n "$value" ] || value=data
  # The exporter sourced `.env`, so `"$HOME/x"` there was a path: expand the forms a setting plausibly uses, without eval.
  case "$value" in "~") value="$HOME" ;; "~/"*) value="$HOME/${value#"~/"}" ;; esac
  value="${value//'${HOME}'/$HOME}"
  value="${value//'$HOME'/$HOME}"
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
