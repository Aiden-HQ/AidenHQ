#!/usr/bin/env bash
# The host's data directory, resolved one way for every consumer (the runner's backoff marker and the exporter that writes
# `aidenhq_unit_backoff`, the other ops scripts): `AIDENHQ_DATA_DIR` from the environment when a caller set it, else the
# checkout's `.env`. Sourced, never run; the path printed is absolute, with no trailing slash (but `/` stays `/`).
#
# `.env` is read, never sourced: the runner unit starts scripts that have no business running a file of settings, so only
# the one setting asked for is parsed. The value is expanded the way `sh`/`bash` would expand it when sourcing the file --
# a variable and a leading `~` where the shell expands them, nothing inside single quotes, `\$` staying a dollar -- by a
# scanner that never runs or `eval`s the file. A leading `export` is part of the assignment, not the name. A relative value
# is the checkout's, as every ops script treats it.

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

# A `$` at the start of `$1`: sc_value is what the shell would put there, sc_rest what follows. `${NAME}`, `$NAME`, and
# anything else (a lone `$`) as the shell leaves it.
aidenhq_dollar() {
  local r="$1" n
  case "$r" in
    '${'*)
      n="${r#\$\{}"
      case "$n" in
        *'}'*) n="${n%%\}*}"; sc_rest="${r#*\}}"; sc_value="${!n:-}" ;;
        *) sc_rest="${r:1}"; sc_value='$' ;;
      esac ;;
    '$'[A-Za-z_]*)
      n="${r#\$}"; n="${n%%[!A-Za-z0-9_]*}"
      sc_rest="${r:1}"; sc_rest="${sc_rest#"$n"}"; sc_value="${!n:-}" ;;
    *) sc_rest="${r:1}"; sc_value='$' ;;
  esac
}

# The shell's expansion of one raw value: `'...'` literal, `"..."` expanding a variable and the escapes `\$ \` \" \\`, and
# an unquoted stretch expanding a variable, a backslash, and a leading `~` ($HOME, at the start of the value only). A `#` at
# the start of a word ends it, as a comment does. Prints the text; runs and evaluates nothing.
aidenhq_expand() {
  local rest="$1" out="" q="" ch next ws=1
  while [ -n "$rest" ]; do
    if [ "$q" = "'" ]; then
      case "$rest" in
        *\'*) out="$out${rest%%\'*}"; rest="${rest#*\'}"; q=""; ws=0 ;;
        *) out="$out$rest"; rest="" ;;
      esac
      continue
    fi
    if [ "$q" = '"' ]; then
      case "$rest" in
        \"*) q=""; rest="${rest:1}"; continue ;;
        \\*)
          next="${rest:1:1}"
          case "$next" in
            '$'|'`'|'"'|'\') out="$out$next"; rest="${rest:2}" ;;
            *) out="$out\\"; rest="${rest:1}" ;;
          esac
          continue ;;
        '$'*) aidenhq_dollar "$rest"; out="$out$sc_value"; rest="$sc_rest"; continue ;;
        *) out="$out${rest:0:1}"; rest="${rest:1}"; continue ;;
      esac
    fi
    # Unquoted.
    case "$rest" in
      \'*) q="'"; rest="${rest:1}"; ws=0; continue ;;
      \"*) q='"'; rest="${rest:1}"; ws=0; continue ;;
      \\*) next="${rest:1:1}"; out="$out$next"; rest="${rest:2}"; ws=0; continue ;;
      '$'*) aidenhq_dollar "$rest"; out="$out$sc_value"; rest="$sc_rest"; ws=0; continue ;;
      '#'*) [ "$ws" = 1 ] && { rest=""; break; } ;;
      '~'|'~/'*)
        if [ "$ws" = 1 ]; then
          out="$out$HOME"
          if [ "$rest" = "~" ]; then rest=""; else rest="${rest:1}"; fi
          ws=0; continue
        fi ;;
      ' '*|$'\t'*) rest="${rest:1}"; ws=1; continue ;;
    esac
    ch="${rest:0:1}"; out="$out$ch"; rest="${rest:1}"; ws=0
  done
  # Unquoted whitespace ends a word and is not part of the value (a quoted one was kept above).
  out="${out%"${out##*[![:space:]]}"}"
  printf '%s\n' "$out"
}

# NAME [default]: the directory the setting names, expanded as sourcing `.env` would have (aidenhq_expand: a variable and a
# leading `~` expand where the shell expands them, and nothing inside single quotes).
aidenhq_env_dir() {
  local name="$1" dflt="${2-}" root raw value
  root="$(aidenhq_data_root 2>/dev/null || true)" || return 0
  [ -n "$root" ] || root="$(pwd)"
  raw="$(aidenhq_env_raw "$name")"
  value="$(aidenhq_expand "$raw")"
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
