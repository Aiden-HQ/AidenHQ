# shellcheck shell=bash
# Install progress for the installer (aidenhq-distro install.sh), which polls AIDENHQ_PROGRESS= lines:
#   AIDENHQ_PROGRESS=<n>/<total> <percent>% <step> ~<minutes left>
# The installer says where this script's slice of its run sits: AIDENHQ_PROGRESS_BASE=<n>/<total>/<percent>/<span>/<seconds>
# (its step number and count, the percent where the slice starts and how many points wide it is, and the whole install's
# estimated seconds). Unset (an apply or setup run by hand), nothing is printed.
#
# A phase table is a bash array of "phase|estimated seconds|what the owner is told". The seconds are ESTIMATES from the apply
# timing phase names and image sizes, to be replaced by the measured ones: only their ratios matter. n/total stay the
# installer's (the product's run is one of its steps); the percent never goes down because the phases are in run order.

# progress_calc TABLE PHASE: sets PG_N PG_TOTAL PG_PCT PG_END PG_SECS PG_LABEL for the phase; false when there is no slice or no such phase.
progress_calc() {
  [ -n "${AIDENHQ_PROGRESS_BASE:-}" ] || return 1
  local -n pg_tbl=$1
  local pg_p0 pg_span pg_e pg_name pg_w pg_l pg_sum=0 pg_cum=0 pg_hit=0 pg_row=0
  IFS=/ read -r PG_N PG_TOTAL pg_p0 pg_span PG_SECS <<<"$AIDENHQ_PROGRESS_BASE"
  for pg_e in "${pg_tbl[@]}"; do
    IFS='|' read -r pg_name pg_w pg_l <<<"$pg_e"
    if [ "$pg_name" = "$2" ]; then pg_hit=1 pg_row=$pg_w PG_LABEL=$pg_l
    elif [ "$pg_hit" = 0 ]; then pg_cum=$((pg_cum + pg_w)); fi
    pg_sum=$((pg_sum + pg_w))
  done
  [ "$pg_hit" = 1 ] || return 1
  PG_PCT=$((pg_p0 + pg_span * pg_cum / pg_sum)) PG_END=$((pg_p0 + pg_span * (pg_cum + pg_row) / pg_sum))
}

# progress_line TABLE PHASE: the phase starts. A line that would not go up is not printed (phases that share a percent report once): an apply that hands over to a newer
# copy of itself starts its phases again, and the exported AIDENHQ_PROGRESS_LAST carries the last percent across the exec.
progress_line() {
  progress_calc "$@" || return 0
  [ "$PG_PCT" -gt "${AIDENHQ_PROGRESS_LAST:--1}" ] || return 0
  export AIDENHQ_PROGRESS_LAST=$PG_PCT
  printf 'AIDENHQ_PROGRESS=%s/%s %s%% %s ~%s\n' "$PG_N" "$PG_TOTAL" "$PG_PCT" "$PG_LABEL" "$(( ((100 - PG_PCT) * PG_SECS + 5999) / 6000 ))"
}

# progress_after TABLE PHASE: the phase that follows PHASE starts (for a timer that reports the end of each phase).
progress_after() {
  local -n pg_t=$1
  local pg_e pg_name pg_prev=0
  for pg_e in "${pg_t[@]}"; do
    pg_name="${pg_e%%|*}"
    if [ "$pg_prev" = 1 ]; then progress_line "$1" "$pg_name"; return 0; fi
    [ "$pg_name" != "$2" ] || pg_prev=1
  done
}

# progress_slice TABLE PHASE: the AIDENHQ_PROGRESS_BASE for a child that runs inside PHASE (empty when there is no slice).
progress_slice() {
  progress_calc "$@" || return 0
  echo "$PG_N/$PG_TOTAL/$PG_PCT/$((PG_END - PG_PCT))/$PG_SECS"
}
