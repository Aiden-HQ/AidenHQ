#!/usr/bin/env bash
# Provision the `agents` VM on Proxmox (runs from the Mac, drives `ssh root@proxmox`).
# Idempotent: if a VM named $VM_NAME exists, nothing is changed.
#   ./ops/vm/provision.sh [--dry-run]
set -euo pipefail

PVE_HOST=${PVE_HOST:?set PVE_HOST to your Proxmox host (address or SSH name)}
VM_NAME=${VM_NAME:-agents}
VM_USER=${VM_USER:-aidenhq}   # the VM's login user, which AidenHQ runs as
PVE_STORAGE=${PVE_STORAGE:-local-lvm}
BRIDGE=${BRIDGE:-vmbr0}
SSH_PUB=${SSH_PUB:-$HOME/.ssh/id_ed25519.pub}
IMG_BASE=https://cloud-images.ubuntu.com/noble/current
IMG_NAME=noble-server-cloudimg-amd64.img
IMG_DIR=/var/lib/vz/template/iso

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac
[ -r "$SSH_PUB" ] || { echo "missing public key $SSH_PUB" >&2; exit 2; }

target="root@$PVE_HOST"
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10)

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<PLAN
Plan: on $target create VM '$VM_NAME' (id = next free) 4 vCPU / 8 GiB / 100G on $PVE_STORAGE,
UEFI q35, virtio net on $BRIDGE, DHCP via cloud-init (user $VM_USER, key $(basename "$SSH_PUB")), guest agent on.
Existing: $(ssh "${ssh_opts[@]}" "$target" "qm list | awk '\$2==\"$VM_NAME\"{print \$1}'" || true)
(dry run: nothing executed)
PLAN
  exit 0
fi

ssh "${ssh_opts[@]}" "$target" 'umask 077; cat > /tmp/agents-key.pub' <"$SSH_PUB"

ssh "${ssh_opts[@]}" "$target" bash -s -- "$VM_NAME" "$PVE_STORAGE" "$BRIDGE" "$IMG_BASE" "$IMG_NAME" "$IMG_DIR" <<'REMOTE'
set -euo pipefail
VM_NAME=$1 STORAGE=$2 BRIDGE=$3 IMG_BASE=$4 IMG_NAME=$5 IMG_DIR=$6

existing=$(qm list | awk -v n="$VM_NAME" '$2==n{print $1}')
if [ -n "$existing" ]; then
  echo "VM '$VM_NAME' already exists (id $existing); nothing to do"
  rm -f /tmp/agents-key.pub
  exit 0
fi
VMID=$(pvesh get /cluster/nextid)

img="$IMG_DIR/$IMG_NAME"
if [ ! -s "$img" ]; then
  curl -fsSL -o "$img.part" "$IMG_BASE/$IMG_NAME"
  curl -fsSL "$IMG_BASE/SHA256SUMS" | grep " \*\?$IMG_NAME\$" | sed "s# \*\?$IMG_NAME\$#  $img.part#" | sha256sum -c -
  mv "$img.part" "$img"
fi

qm create "$VMID" --name "$VM_NAME" --ostype l26 --machine q35 --bios ovmf \
  --cpu host --cores 4 --memory 8192 --agent enabled=1 --onboot 1 \
  --scsihw virtio-scsi-single --net0 "virtio,bridge=$BRIDGE" \
  --efidisk0 "$STORAGE:1,efitype=4m,pre-enrolled-keys=0" \
  --scsi0 "$STORAGE:0,import-from=$img,discard=on,ssd=1" --boot order=scsi0 \
  --ide2 "$STORAGE:cloudinit" \
  --ciuser "$VM_USER" --sshkeys /tmp/agents-key.pub --ipconfig0 ip=dhcp
qm disk resize "$VMID" scsi0 100G
rm -f /tmp/agents-key.pub
qm start "$VMID"
echo "created and started VM $VMID ($VM_NAME)"
echo "MAC: $(qm config "$VMID" | sed -n 's/^net0: virtio=\([^,]*\),.*/\1/p')"
REMOTE
