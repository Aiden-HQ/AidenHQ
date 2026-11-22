#!/usr/bin/env bash
# The host's data directory, resolved one way for every consumer (the runner's backoff marker and the exporter that writes
# `aidenhq_unit_backoff`, the other ops scripts): `AIDENHQ_DATA_DIR` from the environment. Sourced, never run; the path
# printed is absolute, with no trailing slash (but `/` stays `/`).
#
# The environment is the only source. The units that run these scripts get the value from their systemd `EnvironmentFile=`,
# which the apply writes from the host's settings (ops/apply-config-work.sh) -- so ordinary ops code never reads a `.env`
# itself. A relative value is the checkout's, as every ops script treats it, and a leading `~` is the home directory.

# The checkout that holds this lib: this file's own location, never the caller's cwd.
aidenhq_data_root() {
  local here="${BASH_SOURCE[0]%/*}"
  cd "$here/../.." && pwd
}

# NAME [default]: the directory the setting names, taken from the environment as the unit's EnvironmentFile= gave it.
aidenhq_env_dir() {
  local name="$1" dflt="${2-}" root value="${!1:-}"
  [ -n "$value" ] || value="$dflt"
  [ -n "$value" ] || { printf '%s\n' ""; return 0; }
  root="$(aidenhq_data_root 2>/dev/null || true)" || return 0
  [ -n "$root" ] || root="$(pwd)"
  case "$value" in
    '~') value="$HOME" ;;
    '~/'*) value="$HOME/${value#\~/}" ;;
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

# The host's data dir (the default is `<checkout>/data`).
aidenhq_data_dir() {
  aidenhq_env_dir AIDENHQ_DATA_DIR data
}
