#!/usr/bin/env bash
# One-time: turn ~/.config/aidenhq (AIDENHQ_SECRETS_DIR) into the encrypted vault view. Run as root on the host:
#   sudo bash ops/vault/init.sh
# Never prints a secret. The gocryptfs recovery key goes only to /root/aidenhq-vault-recovery.txt (0600): copy it to
# your password manager over your own SSH session, then `shred -u` it. Docs: ops/vault/README.md.
set -euo pipefail

U="${AIDENHQ_USER:-${SUDO_USER:-}}"   # the host user AidenHQ runs as (ops/setup.sh sets it; else the sudo caller)
[ -n "$U" ] && [ "$U" != root ] || { echo "set AIDENHQ_USER to the user AidenHQ runs as" >&2; exit 2; }
H=/home/$U
VIEW=$H/.config/aidenhq
CIPHER=$H/.local/share/aidenhq/vault.enc
PLAIN=$H/.config/aidenhq.plain-pre-vault
SEALED=/etc/credstore.encrypted/aidenhq-vault
RECOVERY=/root/aidenhq-vault-recovery.txt
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP=/run/aidenhq-vault-init

die() { echo "init: $*" >&2; exit 1; }
user_systemctl() { runuser -u "$U" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$U")" systemctl --user "$@"; }
[ "$(id -u)" = 0 ] || die "run as root"
[ ! -e "$CIPHER" ] || die "$CIPHER already exists: the vault is initialised"
[ -d "$VIEW" ] && [ ! -e "$PLAIN" ] || die "need an existing $VIEW and no $PLAIN"
# Root never follows a user-controlled symlink: every user path is a real directory, created and moved as the user.
for p in "$H/.config" "$VIEW" "$H/.local" "$H/.local/share"; do [ ! -L "$p" ] || die "$p is a symlink"; done
as_user() { runuser -u "$U" -- "$@"; }
command -v gocryptfs >/dev/null || die "gocryptfs missing (ops/vm/setup.sh)"

# TPM2 when available; otherwise a host key on this disk (protects a copied vault only, not a stolen disk).
if [ "$(systemd-creds has-tpm2 | head -1)" = yes ]; then
  KEY=tpm2
else
  KEY=host
  echo "WARNING: no usable TPM2. The vault password is sealed with a host key stored on this disk." >&2
fi

install -d -m 0700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
head -c 32 /dev/urandom | base64 -w0 > "$TMP/pass"
chmod 0600 "$TMP/pass"

# Seal the password. --tpm2-pcrs= : bound to this TPM only, not to boot measurements (firmware updates can't lock us out).
install -d -m 0700 /etc/credstore.encrypted
systemd-creds encrypt --with-key="$KEY" --tpm2-pcrs= --name=vault-pass "$TMP/pass" "$SEALED"
chmod 0600 "$SEALED"

# Create the encrypted folder as that user. gocryptfs hides the master key when not on a terminal, so the recovery key
# (64 hex characters) is derived from the password with gocryptfs-xray, straight into the root-only file.
as_user install -d -m 0700 "$H/.local/share/aidenhq" "$CIPHER"
cp "$TMP/pass" "$TMP/pass.$U" && chown "$U" "$TMP/pass.$U" && chmod 0400 "$TMP/pass.$U"
chmod 0711 "$TMP"
runuser -u "$U" -- gocryptfs -init -q -passfile "$TMP/pass.$U" "$CIPHER" || die "gocryptfs -init failed"
( umask 077; gocryptfs-xray -dumpmasterkey "$CIPHER/gocryptfs.conf" < "$TMP/pass" > "$RECOVERY" ) || die "could not write the recovery key"
[ "$(tr -d '\n' < "$RECOVERY" | wc -c)" = 64 ] || die "recovery key has an unexpected length"

# Swap the plaintext dir for the (empty) mountpoint. gocryptfs refuses a non-empty mountpoint, so a stray write while
# locked fails loudly; Docker requires the vault and the runner waits for it.
systemctl stop docker.socket docker.service
user_systemctl stop aidenhq-runner || true
as_user mv "$VIEW" "$PLAIN"
as_user install -d -m 0700 "$VIEW"

# The unit names the user and its home: the file in git has USER placeholders, rewritten for $U.
sed -e "s#^User=USER\$#User=$U#" -e "s#/home/USER/#$H/#g" "$HERE/aidenhq-vault.service" > /etc/systemd/system/aidenhq-vault.service
chmod 0644 /etc/systemd/system/aidenhq-vault.service
install -d /etc/systemd/system/docker.service.d
install -m 0644 "$HERE/docker-requires-vault.conf" /etc/systemd/system/docker.service.d/aidenhq-vault.conf
systemctl daemon-reload
systemctl enable --now aidenhq-vault.service
mountpoint -q "$VIEW" || die "vault did not mount; plaintext is untouched at $PLAIN"

# Copy every secret in through the view, then prove the copy is exact.
as_user cp -a "$PLAIN/." "$VIEW/"
if ! diff <(cd "$PLAIN" && find . -type f -print0 | sort -z | xargs -0 sha256sum) \
          <(cd "$VIEW" && runuser -u "$U" -- find . -type f -print0 | sort -z | xargs -0 sha256sum) >/dev/null; then
  die "copy mismatch: plaintext kept at $PLAIN; vault left mounted for inspection"
fi

systemctl start docker.service
user_systemctl start aidenhq-runner || true
echo "vault ready: $(runuser -u "$U" -- find "$VIEW" -type f | wc -l) files encrypted; key: $KEY"
echo "recovery key written to $RECOVERY (root only). Copy it to your password manager, then: sudo shred -u $RECOVERY"
echo "plaintext kept at $PLAIN until the reboot and recovery tests pass (ops/vault/README.md)"
