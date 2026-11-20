// The apply's recovery: an apply killed mid-compose (SIGKILL, SIGTERM) is reverted to the last known good by the next
// apply or by --recover. The host and its fakes are in apply-atomic-world.ts; the generation's switch, health and
// rollback cases are in apply-atomic.test.ts. Linux only, like the apply lock it runs under: CI's runners.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { world } from "./apply-atomic-world.ts";

const until = async (ok, ms = 20000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); } };

/** Applies p2 and kills it mid-compose: the whole process group with SIGKILL (no trap runs, nothing is left holding the lock). */
async function killedMidCompose(w) {
  assert.equal((await w.run()).status, 0);
  const p2 = w.commitProduct("2");
  const i2 = w.commitInstance(p2);
  writeFileSync(w.d("ctrl/block"), "");
  const { child, done } = w.start();
  await until(() => existsSync(w.d("ctrl/blocked")));
  process.kill(-child.pid, "SIGKILL");
  await done;
  rmSync(w.d("ctrl/block"));
  assert.deepEqual(w.gens().map((g) => [g.n, g.health]), [[1, "good"], [2, "good"], [3, "pending"]]);
  assert.equal(w.head("prod"), p2, "the checkout sits on the new product, half switched");
  return { p2, i2 };
}

const reverted = (w) => {
  const g = w.gens();
  assert.deepEqual(g.map((x) => [x.n, x.health]), [[1, "good"], [2, "good"], [3, "failed"], [4, "good"]]);
  assert.equal(g[2].reason, "the apply died mid-run");
  assert.ok(g[2].recovered_at);
  assert.deepEqual([g[3].product, g[3].revert_of, g[3].lkg], [w.p1, 3, 2]);
  assert.equal(w.head("prod"), w.p1);
  w.revertedTo(w.p1);
  assert.equal(readFileSync(w.d("prod/data/applied-product"), "utf8").trim(), w.p1);
  assert.match(readFileSync(w.d("state/apply-3.log"), "utf8"), /generation 3: the apply died mid-run, and no apply is finishing it: reverting[\s\S]*apply alert: generation 3 failed \(the apply died mid-run\) and was reverted to generation 2/);
  assert.match(readFileSync(w.d("state/apply-4.log"), "utf8"), /generation 4: re-applying generation 2[\s\S]*compose: recreated what moved[\s\S]*generation 4 is good/);
};

test("an apply SIGKILLed mid-compose is reverted to the last known good by the next apply, which then holds the dead pair", async () => {
  const w = world();
  const { p2, i2 } = await killedMidCompose(w);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  reverted(w);
  assert.match(r.out, /reverted to generation 2/);
  assert.match(r.out, /refusing: product .* failed its health check as generation 3 .* --retry/);
  const retry = await w.run("--retry");
  assert.equal(retry.status, 0, retry.out);
  assert.deepEqual([w.gens().at(-1).product, w.gens().at(-1).instance, w.gens().at(-1).health], [p2, i2, "good"]);
});

test("at boot, --recover finishes a dead apply and applies nothing else; with nothing dead it does nothing", async () => {
  const w = world();
  await killedMidCompose(w);
  const r = await w.run("--recover");
  assert.equal(r.status, 0, r.out);
  reverted(w);
  const again = await w.run("--recover");
  assert.equal(again.status, 0, again.out);
  assert.equal(w.gens().length, 4, "nothing more ran");
});

test("an apply whose shell is killed mid-compose (SIGTERM) reverts itself on the way out", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  w.commitInstance(w.commitProduct("2"));
  writeFileSync(w.d("ctrl/block"), "");
  const { child, done } = w.start();
  await until(() => existsSync(w.d("ctrl/blocked")));
  child.kill("SIGTERM");
  writeFileSync(w.d("ctrl/release"), "");
  const r = await done;
  assert.notEqual(r.code, 0, r.out);
  reverted(w);
});

// The host-metrics timer runs the script of the checkout the apply applied, not the one ops/setup.sh recorded at install
// time: the unit's last EnvironmentFile= (written every apply) names the applied checkout, and systemd reads it after
// ~/.config/aidenhq-checkout.env.
const OLD_HOST_METRICS_UNIT = `[Unit]
Description=AidenHQ host metrics for the monitoring module: unit and container states as node-exporter textfiles (ops/host-metrics.sh)

[Service]
# The product checkout: ~/aidenhq, or where ops/setup.sh recorded it (~/.config/aidenhq-checkout.env).
Environment=AIDENHQ_DIR=%h/aidenhq
EnvironmentFile=-%h/.config/aidenhq-checkout.env
Type=oneshot
ExecStart=/usr/bin/env bash \${AIDENHQ_DIR}/ops/host-metrics.sh
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
`;

// What systemd does with the unit's environment: Environment= first, then each EnvironmentFile= in order (a later one
// wins), then expand ${AIDENHQ_DIR} in ExecStart.
function hostMetricsScript(unit, home) {
  const env = {};
  for (const line of readFileSync(unit, "utf8").split("\n")) {
    const m = /^(Environment|EnvironmentFile)=(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].replaceAll("%h", home);
    if (m[1] === "Environment") {
      for (const kv of value.split(/\s+/)) { const [k, ...v] = kv.split("="); env[k] = v.join("="); }
    } else {
      const file = value.replace(/^-/, "");
      if (!existsSync(file)) continue;
      for (const l of readFileSync(file, "utf8").split("\n")) {
        if (!l || l.startsWith("#")) continue;
        const [k, ...v] = l.split("="); env[k] = v.join("=");
      }
    }
  }
  const exec = /^ExecStart=(.*)$/m.exec(readFileSync(unit, "utf8"))[1];
  return exec.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? "").split(/\s+/).at(-1);
}
