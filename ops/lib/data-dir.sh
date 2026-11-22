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

aidenhq_data_dir() {
  local root value
  root="$(aidenhq_data_root 2>/dev/null || true)" || return 0
  [ -n "$root" ] || root="$(pwd)"
  if [ -n "${AIDENHQ_DATA_DIR:-}" ]; then
    value="$AIDENHQ_DATA_DIR"
  elif [ -f "$root/.env" ]; then
    value="$(sed -n 's/^[[:space:]]*AIDENHQ_DATA_DIR[[:space:]]*=[[:space:]]*//p' "$root/.env" 2>/dev/null | tail -n 1)" || true
    value="${value%$'\r'}"
    # A quoted value ends at its closing quote (a trailing comment is not part of the path); an unquoted one ends at its
    # first ` #`.
    case "$value" in
      \"*) value="${value#\"}"; value="${value%%\"*}" ;;
      \'*) value="${value#\'}"; value="${value%%\'*}" ;;
      *) value="${value%%[[:space:]]#*}" ;;
    esac
  else
    value=data
  fi
  # The exporter sources `.env`, so `"$HOME/x"` there is a path: expand the forms a setting plausibly uses, without eval.
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
