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
// mount can stop it running. It records each call; `status` prints the configured state and rules; `allow` fails on
// FAIL=1. The rules are written to a file so each stays on its own line, as ufw's real output does.
const standIn = (dir: string) => {
  const file = join(dir, "ufw.bash");
  writeFileSync(file, 'ufw() {\n  printf \'%s\\n\' "$*" >> "$UFW_LOG"\n  case "$1" in\n    status) printf \'%s\\n\' "$UFW_STATE"; [ -f "$UFW_RULES" ] && cat "$UFW_RULES" ;;\n    allow) [ "${UFW_FAIL:-0}" = 1 ] && return 1; case " ${UFW_FAIL_PORTS:-} " in *" $2 "*) return 1 ;; esac; return 0 ;;\n  esac\n}\n');
  return file;
};
const run = ({ mode, active = true, status = "", fail = false, failPorts = "" } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ufw-"));
  const log = join(dir, "calls.log");
  const rules = join(dir, "rules");
  writeFileSync(log, "");
  writeFileSync(rules, status);
  const env = { ...process.env, BASH_ENV: standIn(dir), UFW_LOG: log, UFW_RULES: rules, UFW_STATE: active ? "Status: active" : "Status: inactive", UFW_FAIL: fail ? "1" : "0", UFW_FAIL_PORTS: failPorts };
  const r = spawnSync("bash", [script, mode], { encoding: "utf8", env });
  const calls = readFileSync(log, "utf8").split("\n").filter((l) => l && !l.startsWith("status"));
  return { calls, out: r.stdout, err: r.stderr, status: r.status };
};

test("ufw-rules: an inactive or absent ufw changes nothing", () => {
  assert.deepEqual(run({ mode: "tailscale", active: false }).calls, []);
});

// The host listeners containers use, and only those: the kernel's backplane, the launcher and the model gateway on the
// compose bridges' gateway, the model gateway on the computers' bridge gateway, and the gate's test listener on the
// canary browser's bridge (nothing listens there until settings.edge.test_user names the test user).
const HOST_SERVICES = [
  "allow in on br+ to 10.231.0.1 port 3130 proto tcp comment AidenHQ containers to host services",
  "allow in on br+ to 10.231.0.1 port 8199 proto tcp comment AidenHQ containers to host services",
  "allow in on br+ to 10.231.0.1 port 8201 proto tcp comment AidenHQ containers to host services",
  "allow in on ahq-computers to 10.231.2.1 port 8200 proto tcp comment AidenHQ computers to host",
  "allow in on ahq-canary to 10.231.6.1 port 3132 proto tcp comment AidenHQ test-user canary to the gate's test listener",
  "allow in on ahq-computers to 10.231.6.1 port 3132 proto tcp comment AidenHQ app-tester computers to the gate's test listener",
];

test("ufw-rules: every mode opens the host listeners containers use, and nothing on the public interface", () => {
  for (const mode of ["tailscale", "local", "cloudflare"]) assert.deepEqual(run({ mode }).calls, HOST_SERVICES, mode);
});

test("ufw-rules: public keeps its front door's ports and adds the bridge rules", () => {
  assert.deepEqual(run({ mode: "public" }).calls, ["allow 443/tcp", "allow 8446/tcp", "allow 8447/tcp", ...HOST_SERVICES]);
});

// ufw's own `status verbose` output: "ALLOW IN" for incoming rules, the destination and interface, and the source.
const verbose = (lines: string[]) => ["Status: active", "", "To                         Action      From", "--                         ------      ----", ...lines].join("\n");

test("ufw-rules: an allow already listed is not added again, matched per line from ufw's verbose output", () => {
  // A DENY line is not an allow, and neither is an allow from a single source: both are left for the script to handle.
  const status = verbose([
    "10.231.0.1 3130/tcp on br+ ALLOW IN    Anywhere                   # AidenHQ containers to host services",
    "10.231.0.1 8199/tcp on br+ DENY IN     Anywhere                   # AidenHQ containers to host services",
    "10.231.0.1 8201/tcp on br+ ALLOW IN    10.0.0.1                   # AidenHQ containers to host services",
    "10.231.2.1 8200/tcp on ahq-computers ALLOW IN Anywhere            # AidenHQ computers to host",
    "10.231.6.1 3132/tcp on ahq-canary ALLOW IN Anywhere               # AidenHQ test-user canary to the gate's test listener",
    "10.231.6.1 3132/tcp on ahq-computers ALLOW IN Anywhere            # AidenHQ app-tester computers to the gate's test listener",
  ]);
  const r = run({ mode: "tailscale", status });
  // 3130, 8200 and the canary listener are already allowed from Anywhere; 8199's DENY is left in place (not replaced by
  // an allow) and only 8201's source-limited allow, which does not permit the bridge, is replaced by one from Anywhere.
  assert.deepEqual(r.calls, [
    "allow in on br+ to 10.231.0.1 port 8201 proto tcp comment AidenHQ containers to host services",
  ]);
});

test("ufw-rules: an explicit DENY or LIMIT is preserved and warned about, not replaced", () => {
  const status = verbose([
    "10.231.0.1 3130/tcp on br+ DENY IN     Anywhere",
    "10.231.0.1 8199/tcp on br+ LIMIT IN    Anywhere",
    "10.231.0.1 8201/tcp on br+ REJECT IN   Anywhere",
    "10.231.2.1 8200/tcp on ahq-computers ALLOW IN Anywhere",
    "10.231.6.1 3132/tcp on ahq-canary ALLOW IN Anywhere",
    "10.231.6.1 3132/tcp on ahq-computers ALLOW IN Anywhere",
  ]);
  const r = run({ mode: "tailscale", status });
  // None of the DENY/LIMIT/REJECT rules is replaced; the already-allowed ones (the canary listener included) are skipped.
  assert.deepEqual(r.calls, []);
  assert.match(r.err, /already has a DENY\/LIMIT\/REJECT rule for 10\.231\.0\.1 3130\/tcp on br\+/);
  assert.match(r.err, /sign-in may fail/);
  // A preserved rule is not a missing one: the manual commands must not suggest replacing it.
  assert.doesNotMatch(r.err, /sudo ufw allow/);
});

test("ufw-rules: the whole destination is matched, not a prefix or a narrower rule", () => {
  // "br+extra" is a different interface from "br+"...
  const tail = run({ mode: "tailscale", status: verbose(["10.231.0.1 3130/tcp on br+extra ALLOW IN Anywhere"]) });
  assert.ok(tail.calls.includes("allow in on br+ to 10.231.0.1 port 3130 proto tcp comment AidenHQ containers to host services"));
  // ...and a front-door allow limited to one interface or to IPv6 does not cover the unrestricted rule's traffic.
  const front = run({ mode: "public", status: verbose(["443/tcp on eth0 ALLOW IN Anywhere", "8446/tcp (v6) ALLOW IN Anywhere (v6)"]) });
  assert.ok(front.calls.includes("allow 443/tcp"), front.calls.join(" | "));
  assert.ok(front.calls.includes("allow 8446/tcp"));
  // An unrestricted front-door allow is still skipped.
  const listed = run({ mode: "public", status: verbose(["443/tcp ALLOW IN Anywhere"]) });
  assert.ok(!listed.calls.includes("allow 443/tcp"));
  // An IPv6-only source ("Anywhere (v6)") does not cover IPv4 either, and a custom comment after the source is ignored.
  const v6only = run({ mode: "public", status: verbose(["443/tcp ALLOW IN Anywhere (v6)", "8446/tcp ALLOW IN Anywhere    # custom"]) });
  assert.ok(v6only.calls.includes("allow 443/tcp"));
  assert.ok(!v6only.calls.includes("allow 8446/tcp"));
});

test("ufw-rules: a rule it can't add warns that sign-in will fail, with the commands", () => {
  const r = run({ mode: "tailscale", fail: true });
  assert.equal(r.status, 0);
  assert.match(r.err, /cannot reach the kernel, and sign-in will fail/);
  assert.match(r.err, /ufw allow in on br\+ to 10\.231\.0\.1 port 3130 proto tcp/);
  // Only the rules that failed are printed, not every rule: a prefix/whole match is covered above.
  // Four kernel/launcher/model-gateway rules plus the test listener from the canary's and the computers' bridges.
  assert.equal(r.err.match(/sudo ufw allow in on/g)?.length, 6);
  assert.match(r.err, /ufw allow in on ahq-canary to 10\.231\.6\.1 port 3132 proto tcp/);
});

test("ufw-rules: a front door port it can't add is warned about too, without the container commands", () => {
  const r = run({ mode: "public", failPorts: "443/tcp 8446/tcp 8447/tcp" });
  assert.equal(r.status, 0);
  assert.match(r.err, /HTTPS front door's ports could not be opened/);
  assert.match(r.err, /ufw allow 443\/tcp/);
  assert.match(r.err, /ufw allow 8446\/tcp/);
  assert.match(r.err, /ufw allow 8447\/tcp/);
  // The container rules did not fail, so their commands are not printed.
  assert.doesNotMatch(r.err, /port 3130 proto tcp/);
});

test("ufw-rules: an unreadable ufw status warns instead of silently changing nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ufw-"));
  writeFileSync(join(dir, "ufw.bash"), 'ufw() { case "$1" in status) return 1 ;; esac; }\n');
  const r = spawnSync("bash", [script, "tailscale"], { encoding: "utf8", env: { ...process.env, BASH_ENV: join(dir, "ufw.bash") } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /status could not be read/);
});
