# Secret vault

`~/.config/aidenhq` (`AIDENHQ_SECRETS_DIR`) is a gocryptfs view. The encrypted files are in
`~/.local/share/aidenhq/vault.enc`, and the view is plaintext only while mounted. Its password is a systemd credential
(`/etc/credstore.encrypted/aidenhq-vault`) sealed to the host's TPM2, or, on a host without a usable TPM2, to a host key
on its disk (that protects a copied vault, not a stolen disk). `aidenhq-vault.service` mounts it at boot, Docker requires
it, and `aidenhq-kernel` waits for it.

Everything that reads or writes secrets keeps using `~/.config/aidenhq`. Writes are encrypted as they happen. While
the vault is locked, Docker won't start and the kernel waits; gocryptfs refuses to mount over a non-empty folder, so a
stray plaintext write shows up as a failed unlock (move the stray file out, then start the vault).

## Set up (once)

1. Run `sudo bash ops/vault/init.sh`. Run `ops/vm/setup.sh` first for gocryptfs and the TPM libraries.
2. Copy `/root/aidenhq-vault-recovery.txt` into your password manager over your own SSH session, then
   `sudo shred -u /root/aidenhq-vault-recovery.txt`.
3. After a reboot test and a recovery test, delete the plaintext copy left at `~/.config/aidenhq.plain-pre-vault`.

## Check

- `systemctl status aidenhq-vault` should report `active`.
- `mountpoint ~/.config/aidenhq` should report a mountpoint.

## Unlock with the recovery key

Use this when the VM was rebuilt without its vTPM state, the hardware changed, or the sealed blob is gone. The
recovery key is the master key from your password manager (64 hex characters).

```sh
sudo systemctl stop docker aidenhq-vault
gocryptfs -masterkey=stdin -allow_other ~/.local/share/aidenhq/vault.enc ~/.config/aidenhq   # paste the key, then Enter and Ctrl-D
```

Then re-seal a new password so boots unlock unattended again:
1. `gocryptfs -passwd -masterkey=stdin ~/.local/share/aidenhq/vault.enc`
2. `systemd-creds encrypt --with-key=tpm2 --tpm2-pcrs= --name=vault-pass` (`--with-key=host` without a TPM2) that password to
   `/etc/credstore.encrypted/aidenhq-vault`.
3. Unmount, then `sudo systemctl start aidenhq-vault docker`.

## App secrets

An app's declared `secrets: [KEY, ...]` are files in the vault at `~/.config/aidenhq/apps/<app>/<KEY>` (one value per
file, no trailing newline, mode 0644 inside the 0700 vault). apps-mcp mounts them into every service of the app at
`/run/secrets/<KEY>`; apps read the file (e.g. `POSTGRES_PASSWORD_FILE`). Values never go into env, the generated
compose file or Docker's metadata.

Apps with `database: warehouse` get theirs written for them: on deploy apps-mcp creates role and schema `app_<name>`
on the warehouse (role owns only that schema) and writes `apps/<app>/DATABASE_URL` (and any declared `*_DATABASE_URL`)
once; it never rotates them. Delete the file to get a new password on the next deploy. That is why `apps/` (and only
`apps/`) is mounted read-write into apps-mcp.

## Backups

The encrypted folder is safe to copy anywhere: it can't be read without the TPM or the recovery key. Hypervisor backups
include the vTPM state, so a whole-VM backup can still unlock. That is accepted when those backups stay on your own infrastructure.
