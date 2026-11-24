// ops/vm/canary-net.sh: the canary browser's network, and the rule that keeps it to the gate's test listener. A network that
// only wears the right name is not adopted: the nft rules match a bridge name, so a bridge of another name, subnet or gateway
// would be an unguarded, signed-in network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../../ops/vm/canary-net.sh");
const WANT = "ahq-canary|false|10.231.6.0/24|10.231.6.1";

// docker and nft as shell functions, sourced through BASH_ENV: no executable files, no PATH or temp-dir mount can stop them.
const standIn = (dir: string) => {
  const file = join(dir, "stub.bash");
  writeFileSync(file, `docker() {
  printf 'docker %s\\n' "$*" >> "$LOG"
  case "$1 $2" in
    "network inspect")
      [ "\${EXISTS:-0}" = 1 ] || return 1
      case " $* " in *" --format "*) printf '%s\\n' "\${INSPECT:-}" ;; esac
      return 0 ;;
    "network create") return 0 ;;
    "network rm") return "\${RM_FAIL:-0}" ;;
  esac
  return 0
}
nft() { printf 'nft %s\\n' "$*" >> "$LOG"; return "\${NFT_FAIL:-0}"; }
`);
  return file;
};

const run = ({ exists = false, inspect = WANT, remove = false, rmFail = false, nftFail = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "canary-net-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const env = { ...process.env, BASH_ENV: standIn(dir), LOG: log, EXISTS: exists ? "1" : "0", INSPECT: inspect, RM_FAIL: rmFail ? "1" : "0", NFT_FAIL: nftFail ? "1" : "0" };
  const r = spawnSync("bash", [script, ...(remove ? ["--remove"] : [])], { encoding: "utf8", env });
  return { calls: readFileSync(log, "utf8").split("\n").filter(Boolean), out: r.stdout, err: r.stderr, status: r.status };
};

test("canary-net: a fresh host installs the rule before the network exists, then creates it with no inter-container traffic", () => {
  const r = run();
  assert.equal(r.status, 0, r.err);
  const created = r.calls.findIndex((c) => c.startsWith("docker network create"));
  const ruled = r.calls.findIndex((c) => c === "nft -f -");
  assert.ok(ruled >= 0 && created > ruled, r.calls.join("\n")); // the rules go in first
  assert.match(r.calls[created]!, /--subnet 10\.231\.6\.0\/24 --gateway 10\.231\.6\.1/);
  assert.match(r.calls[created]!, /com\.docker\.network\.bridge\.name=ahq-canary/);
  assert.match(r.calls[created]!, /com\.docker\.network\.bridge\.enable_icc=false/);
});

test("canary-net: a re-run adopts the network it made, without recreating it", () => {
  const r = run({ exists: true });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.calls.filter((c) => c.startsWith("docker network create")).length, 0);
  assert.ok(r.calls.includes("nft -f -"));
});

test("canary-net: a network that only has the right name is refused, never adopted", () => {
  for (const wrong of ["docker0|false|10.231.6.0/24|10.231.6.1", "ahq-canary|true|10.231.6.0/24|10.231.6.1", "ahq-canary|false|10.231.9.0/24|10.231.9.1", "ahq-canary|false|10.231.6.0/24|10.231.6.9", ""]) {
    const r = run({ exists: true, inspect: wrong });
    assert.equal(r.status, 1, `${wrong || "(nothing)"} was accepted`);
    assert.match(r.err, /isn't the canary network/);
    assert.equal(r.calls.filter((c) => c.startsWith("docker network create")).length, 0, wrong);
    assert.match(r.out + r.err, /10\.231\.6\.1/); // the message says what was wanted
  }
});

test("canary-net: --remove takes the network away first, and a failed removal keeps the rule", () => {
  const gone = run({ exists: true, remove: true });
  assert.equal(gone.status, 0, gone.err);
  const rm = gone.calls.findIndex((c) => c.startsWith("docker network rm"));
  const table = gone.calls.findIndex((c) => c.startsWith("nft delete table"));
  assert.ok(rm >= 0 && table > rm, gone.calls.join("\n"));

  const stuck = run({ exists: true, remove: true, rmFail: true });
  assert.equal(stuck.status, 1);
  assert.equal(stuck.calls.filter((c) => c.startsWith("nft delete table")).length, 0); // the bridge stays guarded
});

// A reboot restores the network before this unit re-runs; if the rule cannot load then, the restored bridge is unguarded and a
// signed-in browser launched on it could reach anywhere. The run must take the network away, never leave it to be adopted.
test("canary-net: a failed rule takes the restored network away, so nothing launches unguarded", () => {
  const r = run({ exists: true, nftFail: true });
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /couldn't install the aidenhq_canary rule/);
  assert.ok(r.calls.some((c) => c.startsWith("docker network rm aidenhq-canary")), r.calls.join("\n"));
  assert.equal(r.calls.filter((c) => c.startsWith("docker network create")).length, 0);
});
