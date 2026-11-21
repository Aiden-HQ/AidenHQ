// ops/vm/ufw-rules.sh: an active host ufw lets AidenHQ's containers reach the kernel in every exposure mode (issue #1296).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../../ops/vm/ufw-rules.sh");
// A stand-in ufw as a shell function, sourced through BASH_ENV: no executable file, so no exec bit, PATH or temp-dir
// mount can stop it running. It records each call; `status` prints the configured state and rules; `allow` fails on FAIL=1.
const standIn = (dir: string) => {
  const file = join(dir, "ufw.bash");
  writeFileSync(file, 'ufw() {\n  printf \'%s\\n\' "$*" >> "$UFW_LOG"\n  case "$1" in\n    status) printf \'%s\\n\' "$UFW_STATE"; printf \'%s\\n\' "$UFW_RULES" ;;\n    allow) [ "${UFW_FAIL:-0}" = 1 ] && return 1; return 0 ;;\n  esac\n}\n');
  return file;
};
const run = ({ mode, active = true, status = "", fail = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ufw-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const env = { ...process.env, BASH_ENV: standIn(dir), UFW_LOG: log, UFW_STATE: active ? "Status: active" : "Status: inactive", UFW_RULES: status, UFW_FAIL: fail ? "1" : "0" };
  const out = execFileSync("bash", [script, mode], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  const calls = readFileSync(log, "utf8").split("\n").filter((l) => l && !l.startsWith("status"));
  return { calls, out };
};

test("ufw-rules: an inactive or absent ufw changes nothing", () => {
  assert.deepEqual(run({ mode: "tailscale", active: false }).calls, []);
});

// The host listeners containers use, and only those: the kernel's backplane, the launcher and the model gateway on the
// compose bridges' gateway, the model gateway on the computers' bridge gateway, and the model gateway's CI listener.
const HOST_SERVICES = [
  "allow in on br+ to 10.231.0.1 port 3130 proto tcp comment AidenHQ containers to host services",
  "allow in on br+ to 10.231.0.1 port 8199 proto tcp comment AidenHQ containers to host services",
  "allow in on br+ to 10.231.0.1 port 8201 proto tcp comment AidenHQ containers to host services",
  "allow in on ahq-computers to 10.231.2.1 port 8200 proto tcp comment AidenHQ computers to host",
  "allow in on ahq-ci to 10.231.4.1 port 8201 proto tcp comment AidenHQ CI runners to the model gateway",
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

test("ufw-rules: an allow already listed is not added again, matched per line", () => {
  // ufw pads columns, and a status line without ALLOW IN (a deny, a limit) doesn't count.
  const status = [
    "To                         Action      From",
    "--                         ------      ----",
    "10.231.0.1 3130/tcp on br+ ALLOW IN    Anywhere  # AidenHQ containers to host services",
    "10.231.0.1 8199/tcp on br+ DENY IN     Anywhere  # AidenHQ containers to host services",
    "10.231.0.1 8201/tcp on br+ ALLOW IN    Anywhere  # AidenHQ containers to host services",
    "10.231.2.1 8200/tcp on ahq-computers ALLOW IN Anywhere # AidenHQ computers to host",
    "10.231.4.1 8201/tcp on ahq-ci ALLOW IN Anywhere # AidenHQ CI runners to the model gateway",
  ].join("\n");
  // The DENY line is not an allow, so that rule is added again; the others are skipped.
  assert.deepEqual(run({ mode: "tailscale", status }).calls, ["allow in on br+ to 10.231.0.1 port 8199 proto tcp comment AidenHQ containers to host services"]);
  assert.deepEqual(run({ mode: "public", status }).calls, ["allow 443/tcp", "allow 8446/tcp", "allow 8447/tcp", "allow in on br+ to 10.231.0.1 port 8199 proto tcp comment AidenHQ containers to host services"]);
});

test("ufw-rules: a rule it can't add warns that sign-in will fail, with the commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "ufw-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  // Setup goes on (a firewall rule must not fail the install), but loudly: the board can't reach the kernel without it.
  const env = { ...process.env, BASH_ENV: standIn(dir), UFW_LOG: log, UFW_STATE: "Status: active", UFW_RULES: "", UFW_FAIL: "1" };
  const r = spawnSync("bash", [script, "tailscale"], { encoding: "utf8", env });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /cannot reach the kernel, and sign-in will fail/);
  assert.match(r.stderr, /ufw allow in on br\+ to 10\.231\.0\.1 port 3130 proto tcp/);
});

test("ufw-rules: a front door port it can't add is warned about too", () => {
  const dir = mkdtempSync(join(tmpdir(), "ufw-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const env = { ...process.env, BASH_ENV: standIn(dir), UFW_LOG: log, UFW_STATE: "Status: active", UFW_RULES: "", UFW_FAIL: "1" };
  const r = spawnSync("bash", [script, "public"], { encoding: "utf8", env });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /ufw allow 443\/tcp/);
  assert.match(r.stderr, /ufw allow 8446\/tcp/);
});

test("ufw-rules: an unreadable ufw status warns instead of silently changing nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ufw-"));
  writeFileSync(join(dir, "ufw.bash"), 'ufw() { case "$1" in status) return 1 ;; esac; }\n');
  const r = spawnSync("bash", [script, "tailscale"], { encoding: "utf8", env: { ...process.env, BASH_ENV: join(dir, "ufw.bash") } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /status could not be read/);
});
