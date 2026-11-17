import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const provision = join(dirname(fileURLToPath(import.meta.url)), "../../ops/vm/provision.sh");

// ssh joins its arguments into one command line for the remote shell, so an empty argument disappears: the stub does the
// same, then runs the remote command here against stub Proxmox tools.
test("provision.sh with no VMID takes Proxmox's next free id", () => {
  const t = mkdtempSync(join(tmpdir(), "prov-"));
  const bin = join(t, "bin");
  mkdirSync(bin);
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub("ssh", `while [[ "$1" == -* ]]; do shift 2; done; shift; cmd="$*"; cmd="\${cmd//\\/tmp\\//${t}/}"; cmd="\${cmd//\\/var\\/lib\\/vz/${t}/vz}"; exec bash -c "$cmd"`);
  stub("qm", `echo "qm $*" >> ${t}/qm.log; [ "$1" = config ] && echo "net0: virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0"; true`);
  stub("pvesh", `echo 123`);
  mkdirSync(join(t, "vz/template/iso"), { recursive: true });
  writeFileSync(join(t, "vz/template/iso/noble-server-cloudimg-amd64.img"), "image"); // downloaded before
  writeFileSync(join(t, "key.pub"), "ssh-ed25519 AAAA test\n");
  const out = execFileSync("bash", [provision], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, PVE_HOST: "pve.example.com", SSH_PUB: join(t, "key.pub"), HOME: t } });
  assert.match(out, /created and started VM 123 \(agents\)/, out);
  const qm = readFileSync(join(t, "qm.log"), "utf8");
  assert.match(qm, /^qm create 123 --name agents .*--ciuser aidenhq /m, qm);
});
