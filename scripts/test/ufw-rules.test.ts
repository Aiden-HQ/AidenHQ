// ops/vm/ufw-rules.sh: an active host ufw lets AidenHQ's containers reach the kernel in every exposure mode (issue #1296).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../../ops/vm/ufw-rules.sh");
const run = ({ mode, active = true, status = "", fail = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ufw-"));
  const log = join(dir, "calls.log");
  // A stand-in ufw: records each call; `status` prints the configured rules (or is inactive); allow exits 1 when `fail`.
  writeFileSync(join(dir, "ufw"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in\n  status) printf '%s\\n' ${JSON.stringify(active ? "Status: active" : "Status: inactive")}; printf '%s\\n' ${JSON.stringify(status)} ;;\n  allow) ${fail ? "exit 1" : ":"} ;;\nesac\n`, { mode: 0o755 });
  const out = execFileSync("bash", [script, mode], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: `${dir}:${process.env.PATH}` } });
  const calls = readFileSync(log, "utf8").split("\n").filter((l) => l && !l.startsWith("status"));
  return { calls, out };
};

test("ufw-rules: an inactive or absent ufw changes nothing", () => {
  assert.deepEqual(run({ mode: "tailscale", active: false }).calls, []);
});

// The host listeners containers use, and only those: the kernel's backplane, the launcher and the model gateway on the
// compose bridges' gateway, and the model gateway on the computers' bridge gateway.
const HOST_SERVICES = [
  "allow in on br+ to 10.231.0.1 port 3130 proto tcp comment AidenHQ containers to host services",
  "allow in on br+ to 10.231.0.1 port 8199 proto tcp comment AidenHQ containers to host services",
  "allow in on br+ to 10.231.0.1 port 8201 proto tcp comment AidenHQ containers to host services",
  "allow in on ahq-computers to 10.231.2.1 port 8200 proto tcp comment AidenHQ computers to host",
];

test("ufw-rules: every mode opens the host listeners containers use, and nothing on the public interface", () => {
  for (const mode of ["tailscale", "local", "cloudflare"]) assert.deepEqual(run({ mode }).calls, HOST_SERVICES, mode);
});

test("ufw-rules: public keeps its front door's ports and adds the bridge rules", () => {
  assert.deepEqual(run({ mode: "public" }).calls, [
    "allow 443/tcp",
    "allow 8446/tcp",
    "allow 8447/tcp",
    ...HOST_SERVICES,
  ]);
});

test("ufw-rules: a rule already listed is not added again", () => {
  const status = [
    "10.231.0.1 3130/tcp on br+            ALLOW IN    Anywhere   # AidenHQ containers to host services",
    "10.231.0.1 8199/tcp on br+            ALLOW IN    Anywhere   # AidenHQ containers to host services",
    "10.231.0.1 8201/tcp on br+            ALLOW IN    Anywhere   # AidenHQ containers to host services",
    "10.231.2.1 8200/tcp on ahq-computers  ALLOW IN    Anywhere   # AidenHQ computers to host",
  ].join("\n");
  assert.deepEqual(run({ mode: "tailscale", status }).calls, []);
  assert.deepEqual(run({ mode: "public", status }).calls, ["allow 443/tcp", "allow 8446/tcp", "allow 8447/tcp"]);
});

test("ufw-rules: a rule it can't add warns that sign-in will fail, with the commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "ufw-"));
  writeFileSync(join(dir, "ufw"), "#!/usr/bin/env bash\ncase \"$1\" in status) echo 'Status: active' ;; allow) echo 'ERROR: you need to be root' >&2; exit 1 ;; esac\n", { mode: 0o755 });
  // Setup goes on (a firewall rule must not fail the install), but loudly: the board can't reach the kernel without it.
  const r = spawnSync("bash", [script, "tailscale"], { encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /cannot reach the kernel, and sign-in will fail/);
  assert.match(r.stderr, /ufw allow in on br\+ to 10\.231\.0\.1 port 3130 proto tcp/);
});
