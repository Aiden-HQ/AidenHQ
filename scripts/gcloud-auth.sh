#!/usr/bin/env bash
# Signs AidenHQ in to Google Cloud for Engineer jobs: plain gcloud application-default
# login, with gcloud's own scopes (asking for more got the sign-in blocked by Google's app policy). Run it
# again when the 16-hour Google Cloud session ends: the runner says so on the task. Jobs only ever get a
# one-hour access token (services/runner/src/gcp.mjs); this sign-in stays hidden from them. Opens a
# browser for the Google sign-in.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${AIDENHQ_ENV_FILE:-.env}"
env_get() { sed -n "s/^$1=//p" "$env_file" | tail -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
AIDENHQ_SECRETS_DIR="${AIDENHQ_SECRETS_DIR:-$(env_get AIDENHQ_SECRETS_DIR)}"
: "${AIDENHQ_SECRETS_DIR:?set AIDENHQ_SECRETS_DIR in .env}"
dir="${AIDENHQ_SECRETS_DIR/#\~/$HOME}/gcloud"
umask 077
mkdir -p "$dir" && chmod 0700 "$dir"
run_gcloud() {
  gcloud "$@"
}
# AidenHQ's own gcloud directory: your ~/.config/gcloud is left alone.
CLOUDSDK_CONFIG="$dir" run_gcloud auth application-default login --disable-quota-project
chmod 0600 "$dir/application_default_credentials.json"
# Prove the refresh works the way jobs will use it.
node --input-type=module -e "
import { accessToken } from '$repo/services/runner/src/gcp.mjs';
const r = await accessToken('$dir/application_default_credentials.json').catch((e) => { console.error('error: ' + e.message); process.exit(1); });
console.log('Google Cloud signed in for AidenHQ. Jobs get one-hour tokens (this one valid until ' + new Date(r.expiresAt).toLocaleTimeString() + ', refreshed while they run).');
"
