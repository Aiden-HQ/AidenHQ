// The apply as one generation (spec §5.7.2): validate before anything restarts, snapshot the touched modules' data (§6.4.1),
// health after the switch, one auto-revert to the last known good with that data put back, the failed pair held off until
// main moves, and ops/rollback.sh restoring the data an older generation needs. The host and its fakes are in
// apply-atomic-world.ts; recovery of a killed apply is in apply-atomic-recover.test.ts. Linux only, like the apply lock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { world, repo, git } from "./apply-atomic-world.ts";

test("a first apply seeds the running pair as the last known good, validates, switches and marks itself good", async () => {
  const w = world();
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(w.gens().map((g) => [g.n, g.health, g.product, g.instance]), [[1, "good", w.p1, w.i1], [2, "good", w.p1, w.i1]]);
  assert.ok(r.out.indexOf("apply timing: validate") < r.out.indexOf("apply timing: compose"), r.out);
  assert.match(readFileSync(w.d("state/apply-2.log"), "utf8"), /generation 2 is good/);
  assert.ok(!existsSync(w.d("prod/config.next")), "the staged copy is cleaned up after the switch");
  // The board mounts this mirror, and it must match the real file after an append and after a mark (which replaces it by
  // rename). The board mounts its directory, never the file: a bind mount of the file would keep the inode a rename replaces.
  assert.equal(readFileSync(w.d("state/board/generations.jsonl"), "utf8"), readFileSync(w.d("state/generations.jsonl"), "utf8"));
  const board = YAML.parse(readFileSync(join(repo, "compose.yaml"), "utf8")).services.board.volumes.find((v) => String(v).endsWith(":/generations:ro"));
  assert.ok(board, "the board mounts the generations mirror");
  assert.match(board, /\/board:\/generations:ro$/, `the mirror's directory, not the file: ${board}`);
});

// Nothing changed = nothing rebuilt and no setup; a new product builds and sets up; an instance-only change sets up (its
// handbooks and config) without a build; a missing image builds again.
test("an apply builds and sets up only what its inputs changed", async () => {
  const w = world();
  const ran = (what) => w.calls().split("\n").filter((l) => l === what).length;
  const apply = async (...args) => { writeFileSync(w.d("calls"), ""); const r = await w.run(...args); assert.equal(r.status, 0, r.out); return r; };
  await apply();
  assert.equal(ran("setup"), 1, "a fresh host runs the setup");
  assert.equal(ran("docker compose build"), 0, "the running product is the seeded last known good's, and its images are here");
  await apply();
  assert.deepEqual([ran("setup"), ran("docker compose build")], [0, 0], "no change: neither");
  w.commitInstance(w.p1, "settings: {x: 1}\n");
  await apply();
  assert.deepEqual([ran("setup"), ran("docker compose build")], [1, 0], "an instance change sets up, and builds nothing");
  const p2 = w.commitProduct("2");
  w.commitInstance(p2);
  await apply();
  assert.deepEqual([ran("setup"), ran("docker compose build")], [1, 1], "a new product builds and sets up");
  await apply();
  assert.deepEqual([ran("setup"), ran("docker compose build")], [0, 0], "and then nothing again");
  // A service image the compose files need but this host lacks: built again, though the product is the same.
  writeFileSync(w.d("bin/docker"), readFileSync(w.d("bin/docker"), "utf8").replace("case \"$*\" in", "case \"$*\" in *\"config --images\"*) echo missing/image ;; *\"image inspect\"*) exit 1 ;; "));
  await apply();
  assert.equal(ran("docker compose build"), 1, "a missing image is built");
});

// A fresh host has no kernel/node_modules: the pin is read with the kernel's own parser, so its deps are installed first.
test("a fresh host with no kernel/node_modules installs the kernel's deps before it reads the pin", async () => {
  const w = world();
  assert.ok(!existsSync(w.d("prod/kernel/node_modules")));
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.equal(w.calls().split("\n").filter((l) => l.startsWith("npm ci --prefix kernel")).length, 1, w.calls());
  assert.equal(w.gens().at(-1).health, "good");
});

// Lean-core 5e: the kernel the instance runs is its own fork (product_fork:) when that descends from the pin; else refused.
test("a product_fork on top of the pin is what runs (and is recorded); one off the pin is refused", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  git(w.d(), "clone", "-q", w.d("p.git"), "fw");
  writeFileSync(w.d("fw", "VERSION"), "1-fork\n");
  git(w.d("fw"), "commit", "-qam", "patch");
  const fork = git(w.d("fw"), "rev-parse", "HEAD");
  // The fork is fetched over https only (a local path is refused); its commit is already here, as a fetch would leave it.
  git(w.d("prod"), "fetch", "-q", w.d("fw"), "main");
  const i2 = w.commitInstance(w.p1, `product_fork: https://example.com/acme-bot/fork.git ${fork}\n`);
  const r = await w.run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /kernel: running the instance's fork \w{12} .* on top of product \w{12}/);
  assert.equal(w.head("prod"), fork);
  assert.deepEqual([w.gens().at(-1).product, w.gens().at(-1).instance, w.gens().at(-1).health], [fork, i2, "good"]);
  git(w.d("fw"), "checkout", "-q", "--orphan", "elsewhere");
  git(w.d("fw"), "commit", "-qm", "unrelated");
  git(w.d("prod"), "fetch", "-q", w.d("fw"), "elsewhere");
  w.commitInstance(w.p1, `product_fork: https://example.com/acme-bot/fork.git ${git(w.d("fw"), "rev-parse", "HEAD")}\n`);
  const bad = await w.run();
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /refusing: product_fork \w{12} does not descend from product \w{12}/);
  assert.equal(w.head("prod"), fork, "still the fork that ran");
  // A fork named by a local path is never fetched (https only).
  git(w.d("fw"), "checkout", "-q", "main");
  writeFileSync(w.d("fw", "VERSION"), "1-fork-2\n");
  git(w.d("fw"), "commit", "-qam", "patch 2");
  w.commitInstance(w.p1, `product_fork: ${w.d("fw")} ${git(w.d("fw"), "rev-parse", "HEAD")}\n`);
  const local = await w.run();
  assert.equal(local.status, 1, local.out);
  assert.match(local.out, /refusing: couldn't fetch product_fork/);
});

test("a staged compile failure leaves the running config byte-identical, both checkouts restored and nothing restarted", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  const files = ["config/paperclip.yaml", "config/kernel/connections.json", "compose.modules.yaml"].map((f) => [f, readFileSync(w.d("prod", f), "utf8")]);
  const callsBefore = w.calls();
  const p2 = w.commitProduct("2");
  w.commitInstance(p2, "broken: true\n");
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /refusing: the staged compile failed; nothing was switched or restarted/);
  for (const [f, text] of files) assert.equal(readFileSync(w.d("prod", f), "utf8"), text, `${f} is untouched`);
  assert.equal(w.head("prod"), w.p1, "the product checkout is back at the running product");
  assert.equal(w.head("inst"), w.i1, "the instance checkout is back at the running instance");
  const after = w.calls().slice(callsBefore.length);
  assert.doesNotMatch(after, /^(compile|recreate|setup)$|systemctl --user (restart|kill)|up -d/m, after);
  assert.equal(w.gens().at(-1).health, "refused");
});

test("a first install's failed health check isn't re-applied as its own last known good", async () => {
  const w = world();
  rmSync(w.d("prod/data/applied-product"));
  writeFileSync(w.d("ctrl/break"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /nothing applied on this host yet: this apply can't auto-revert/);
  assert.doesNotMatch(r.out, /auto-revert: re-applying/);
  assert.deepEqual(w.gens().map((x) => [x.n, x.health]), [[1, "failed"]]);
});

// An older release's updater unit ran the apply as its child: the apply removes that unit only after its health verdict.
test("the retired update units are removed once the generation is good, never while a failed one is being reverted", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  const units = w.d("home/.config/systemd/user");
  mkdirSync(units, { recursive: true });
  for (const u of ["aidenhq-update.service", "aidenhq-update.timer"]) writeFileSync(join(units, u), "[Unit]\n");
  writeFileSync(w.d("ctrl/break"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  w.commitInstance(p2);
  assert.equal((await w.run()).status, 1);
  assert.ok(existsSync(join(units, "aidenhq-update.service")), "a failed generation leaves them");
  rmSync(w.d("ctrl/break"));
  w.commitInstance(w.p1, "x: 1\n");
  assert.equal((await w.run()).status, 0);
  assert.ok(!existsSync(join(units, "aidenhq-update.service")) && !existsSync(join(units, "aidenhq-update.timer")), "a good one removes them");
});

test("A14: a post-apply health failure reverts to the LKG's product, keeps what the instance gained since, and holds the pair until --retry", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  // An app registered after the last known good (apps-mcp commits apps.yaml straight to the instance's main).
  writeFileSync(w.d("iw", "apps.yaml"), "apps:\n  - name: hello\n");
  git(w.d("iw"), "add", "apps.yaml");
  git(w.d("iw"), "commit", "-q", "-m", "apps: add hello");
  git(w.d("iw"), "push", "-q", "origin", "HEAD:main");
  writeFileSync(w.d("ctrl/break"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  const i2 = w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  const g = w.gens();
  assert.deepEqual(g.map((x) => [x.n, x.health]), [[1, "good"], [2, "good"], [3, "failed"], [4, "good"]]);
  assert.match(g[2].reason, /checks that passed before the apply fail now: kernel \(10\.231\.0\.1:3130\)/);
  assert.equal(g[2].log, w.d("state/apply-3.log"));
  assert.deepEqual([g[3].product, g[3].revert_of, g[3].lkg], [w.p1, 3, 2]);
  assert.equal(w.head("prod"), w.p1, "the product is back at the last known good");
  w.revertedTo(w.p1);
  assert.equal(readFileSync(w.d("inst/apps.yaml"), "utf8"), "apps:\n  - name: hello\n", "the app registered since the last known good is kept");
  assert.equal(git(w.d("inst"), "rev-parse", "origin/main"), i2, "the instance's origin/main is not moved");
  const reverted = w.head("inst");
  assert.equal(readFileSync(w.d("prod/data/applied-product"), "utf8").trim(), w.p1);
  assert.match(readFileSync(w.d("state/apply-3.log"), "utf8"), /apply alert: generation 3 failed \(checks that passed .*\) and was reverted to generation 2/);
  // The owner's alert: the monitoring textfile the ApplyFailed rule reads.
  mkdirSync(w.d("data/modules/monitoring/textfile"), { recursive: true });
  execFileSync("bash", [join(repo, "ops/host-metrics.sh")], { env: { PATH: `${w.d("bin")}:/usr/bin:/bin`, HOME: w.d("home"), AIDENHQ_DATA_DIR: w.d("data"), AIDENHQ_STATE_DIR: w.d("state") } });
  assert.match(readFileSync(w.d("data/modules/monitoring/textfile/generations.prom"), "utf8"), /^aidenhq_apply_failed\{n="3",health="failed",.*log=".*apply-3\.log"\} 1$/m);

  // Held: main still resolves to the failed pair, so a plain apply (the runner's) is refused and changes nothing.
  const held = await w.run();
  assert.equal(held.status, 1, held.out);
  assert.match(held.out, /failed its health check as generation 3 .* --retry/);
  assert.equal(w.gens().length, 4, "no new generation");
  assert.equal(w.head("prod"), w.p1);
  assert.equal(w.head("inst"), reverted);

  // --retry from the owner's shell, with the fault gone: it applies, and the instance is back on main.
  rmSync(w.d("ctrl/break"));
  const retry = await w.run("--retry");
  assert.equal(retry.status, 0, retry.out);
  assert.deepEqual(w.gens().at(-1), { ...w.gens().at(-1), product: p2, instance: i2, health: "good" });
  assert.equal(w.head("prod"), p2);
  assert.equal(git(w.d("inst"), "symbolic-ref", "--short", "HEAD"), "main");
});

// A failed auto-revert writes its own log: when the revert's switch fails, its generation names the file that holds the
// failing step's output, not the log of the generation it reverted.
test("a failed auto-revert records its own log naming the step that failed", async () => {
  const w = world();
  assert.equal((await w.run()).status, 0);
  writeFileSync(w.d("ctrl/break"), "");
  writeFileSync(w.d("ctrl/arm-badrevert"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "" });
  const i2 = w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  const g = w.gens();
  assert.deepEqual(g.map((x) => [x.n, x.health]), [[1, "good"], [2, "good"], [3, "failed"], [4, "failed"]]);
  assert.deepEqual([g[3].product, g[3].revert_of, g[3].lkg], [w.p1, 3, 2]);
  assert.equal(g[2].log, w.d("state/apply-3.log"), "the failed generation keeps its own log");
  assert.equal(g[3].log, w.d("state/apply-4.log"), "the failed revert names its own log");
  const revert = readFileSync(g[3].log, "utf8");
  assert.match(revert, /generation 4: re-applying generation 2/);
  assert.match(revert, /compose: recreate failed in the revert/);
  assert.match(revert, /generation 4 failed: the switch failed \(exit 1\)/);
  assert.equal(w.head("prod"), w.p1, "the product is back at the last known good");
  w.revertedTo(w.p1);

  // The failed pair is still held.
  const held = await w.run();
  assert.equal(held.status, 1, held.out);
  assert.match(held.out, /failed its health check as generation 3 .* --retry/);
  assert.equal(w.gens().length, 4, "no new generation");
});

test("a module whose data migrates (marker 0 -> 1) and fails health comes back at marker 0 with its old files, on the LKG code; ops/rollback.sh puts it back later", async () => {
  const w = world();
  const acme = (f) => readFileSync(w.d("prod/data/modules/acme", f), "utf8");
  mkdirSync(w.d("prod/data/modules/acme/state"), { recursive: true });
  writeFileSync(w.d("prod/data/modules/acme/state/db.txt"), "v0 rows\n");
  const first = await w.run();
  assert.equal(first.status, 0, first.out);
  assert.equal(acme(".data_version"), "0\n");
  assert.match(first.out, /generation 2 snapshot: acme \(.*\) in .*\/checkpoints\/gen-2\/acme\.tar/);

  // Generation 3 migrates acme to 1, then fails its health check: the auto-revert puts the data back before p1 starts.
  writeFileSync(w.d("ctrl/break"), "");
  const p2 = w.commitProduct("2", { BAD_HEALTH: "", DATA_VERSION: "1\n" });
  w.commitInstance(p2);
  const r = await w.run();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /generation 3 snapshot: acme/);
  assert.match(r.out, /auto-revert: acme's data is back to/);
  assert.ok(r.out.indexOf("auto-revert: acme") < r.out.indexOf("re-applying generation 2"), r.out);
  assert.equal(acme(".data_version"), "0\n");
  assert.equal(acme("state/db.txt"), "v0 rows\n");
  assert.equal(w.head("prod"), w.p1);
  assert.deepEqual(w.gens().map((g) => [g.n, g.health, g.data_versions?.acme]), [[1, "good", undefined], [2, "good", 0], [3, "failed", 1], [4, "good", 0]]);

  // Fixed and retried, it migrates for good; a rollback to generation 2 restores acme from the first snapshot after it.
  rmSync(w.d("ctrl/break"));
  assert.equal((await w.run("--retry")).status, 0);
  assert.equal(acme(".data_version"), "1\n");
  assert.equal(acme("state/db.txt"), "v0 rows\nv1 migrated\n");
  const plan = await w.sh("ops/rollback.sh", "2", "--plan");
  assert.equal(plan.status, 0, plan.out);
  assert.match(plan.out, new RegExp(`generation 2: product ${w.p1}, instance ${w.i1}\n  acme: data back to \\S+ \\(the snapshot before generation 3\\)`));
  const back = await w.sh("ops/rollback.sh", "2");
  assert.equal(back.status, 0, back.out);
  assert.equal(acme(".data_version"), "0\n");
  assert.equal(acme("state/db.txt"), "v0 rows\n");
  assert.equal(w.head("prod"), w.p1);
  assert.equal((await w.sh("ops/rollback.sh", "2", "--plan")).out.split("\n")[1], "  no module data to restore");

  // A pruned snapshot refuses: every snapshot after generation 2 that holds acme is gone.
  for (const g of ["gen-3", "gen-5"]) rmSync(w.d("home/checkpoints", g), { recursive: true });
  writeFileSync(w.d("prod/data/modules/acme/.data_version"), "1\n");
  const refused = await w.sh("ops/rollback.sh", "2");
  assert.equal(refused.status, 1, refused.out);
  assert.match(refused.out, /refusing: acme: data newer than generation 2 declared, and no snapshot taken after it is kept/);
});
