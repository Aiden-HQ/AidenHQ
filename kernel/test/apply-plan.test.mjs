// kernel.apply's planner (apply-tier.ts) through the write lifecycle: a module holding the role kernel.apply files a release
// bump through writes.request like any requester; the kernel reads the commit from the code host, tiers it by the instance
// rules, the module authority it brings and the path inventory, and the executor lands it once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApply } from "../src/apply.ts";
import { createApplyPlanner } from "../src/apply-tier.ts";
import { KERNEL_KINDS } from "../src/kinds.ts";
import { openRecords } from "../src/records.ts";
import { createWrites } from "../src/writes.ts";

const [OLD, NEW, COMMIT] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
const yaml = (product) => `product: ${product}\nmodules: [core]\n`;
const BUMP = { repo: "acme/aidenhq-instance", branch: "fleet/release-acme-7", sha: COMMIT };
const codehost = { kind: "module", module: "codehost-github", roles: ["kernel.tasks", "kernel.apply"], tools: {} };
const NEW_AUTHORITY = { modules: { acme: { base: { name: "acme" }, head: { name: "acme", privileged: ["git-credential"] }, codeChanged: false } }, marketplaces: [] };

/** One kernel: records, the planner over a fake code host and product git, the executor over a fake host that counts. */
function kernel({ modules = { modules: {}, marketplaces: [] }, inventory = { entries: [] }, reviewer = "approve" } = {}) {
  const h = { reads: 0, lands: [], launches: [], units: {} };
  const planner = createApplyPlanner({
    instanceRepo: () => "acme/aidenhq-instance",
    read: async (s) => (h.reads++, { files: ["instance.yaml"], texts: { base: { "instance.yaml": yaml(OLD) }, head: { "instance.yaml": yaml(NEW) } }, diff: `-product: ${OLD}\n+product: ${NEW}\n`, trial: "" }),
    product: { onMain: async () => true, isAncestor: async (a, b) => a === OLD && b === NEW, log: async () => "bbbbbbb feat: something (#1)" },
    modules: () => modules, roles: () => ({}), connections: () => ({}), moduleApps: () => [],
  });
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "apply-plan-")), "kernel.db"));
  const applies = createApply({
    db: records.db, pollMs: 5, generations: () => [], busy: async () => false, tail: async () => "",
    codehost: { read: async () => ({ files: ["instance.yaml"], texts: { base: {}, head: {} }, diff: "" }), land: async (s) => (h.lands.push(s), { landed: s.sha }) },
    launch: async (u) => { h.launches.push(u); h.units[u] = { loaded: true, active: "active", sub: "exited", result: "success" }; },
    unit: async (u) => h.units[u] ?? { loaded: false, active: "inactive", sub: "dead", result: "" },
  });
  // As after the switch: kernel.apply is the kernel's own kind, planned and executed here.
  const { runner: _, ...apply } = KERNEL_KINDS["kernel.apply"];
  const writes = createWrites({
    records, registry: () => ({ "kernel.apply": apply }), connections: () => ({}), secret: () => "", resolver: {}, paths: () => inventory ?? undefined,
    repos: () => ({ product: "acme/aidenhq", instance: "acme/aidenhq-instance" }),
    reviews: { request: async () => ({ decision: reviewer, reason: "read it", model: "~acme/reviewer" }) },
    onTask: { open: async () => true, notify: async () => {} }, replay: async () => ({ ok: false, text: "" }),
    native: { "kernel.apply": applies.execute }, planners: { "kernel.apply": planner }, resume: ["kernel.apply"],
  });
  return { h, records, writes };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test("a release bump files kernel.apply, planned from the code host's read and tiered by the rules and the path inventory", async () => {
  const k = kernel();
  const r = await k.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.deepEqual(r.args, { ...BUMP, files: ["instance.yaml"] });
  assert.deepEqual([r.tier, r.state, r.rule], [1, "review", "pin-forward"]);
  assert.match(r.card.reason, /product pin moves forward/);
  assert.match(r.card.details, /Product upgrade aaaaaaaaa → bbbbbbbbb, adding these commits:\nbbbbbbb feat: something/);
  assert.equal(k.h.lands.length, 0, "nothing lands before the reviewer");
  // The path inventory is a term of the same tier: an owner's path in any repository, or no inventory at all, is the owner's.
  const owned = kernel({ inventory: { entries: [{ repo: "any", pattern: "instance.yaml", sensitivity: 2, source: "paths.yaml" }] } });
  const o = await owned.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.deepEqual([o.tier, o.rule], [2, "owner-path"]);
  const blind = kernel({ inventory: null });
  assert.equal((await blind.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" })).rule, "gate-list-unknown");
  // Only a module holding the role files it, and only for a kernel kind the kernel plans: a role named after another
  // module's kind grants nothing. Until the switch drops `runner`, nobody files kernel.apply through this path.
  await assert.rejects(k.writes.request({ ...codehost, roles: ["kernel.tasks"] }, { kind: "kernel.apply", args: BUMP, task: "TASK-1" }), /no grant on kernel.apply/);
  const merge = { module: "codehost-github", floor: 0, tools: [], executor: { url: "http://codehost-github:8100/x", auth_secret: "k" } };
  const other = createWrites({ records: k.records, registry: () => ({ "codehost-github.merge": merge, "kernel.apply": { ...KERNEL_KINDS["kernel.apply"], runner: undefined } }), connections: () => ({}), secret: () => "", resolver: {}, onTask: { open: async () => true, notify: async () => {} }, replay: async () => ({}) });
  await assert.rejects(other.request({ kind: "module", module: "acme", roles: ["codehost-github.merge"], tools: {} }, { kind: "codehost-github.merge", args: {}, task: "TASK-1" }), /no grant on codehost-github.merge/);
  await assert.rejects(other.request({ ...codehost, roles: ["kernel.apply"] }, { kind: "kernel.apply", args: BUMP, task: "TASK-1" }), /no write kind kernel.apply/, "no planner: not filed");
  const before = createWrites({ records: k.records, registry: () => ({ "kernel.apply": KERNEL_KINDS["kernel.apply"] }), connections: () => ({}), secret: () => "", resolver: {}, onTask: { open: async () => true, notify: async () => {} }, replay: async () => ({}), planners: { "kernel.apply": async () => ({}) } });
  await assert.rejects(before.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" }), /no write kind kernel.apply/);
});

test("a bump that brings new module authority waits for the owner after the reviewer, and lands only on the owner's yes", async () => {
  const k = kernel({ modules: NEW_AUTHORITY });
  const r = await k.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.deepEqual([r.tier, r.state, r.review_first, r.args.ownerRequired], [2, "review", "final", true]);
  assert.deepEqual(r.args.authority, ["acme: adds privileged git-credential (owner)"]);
  const { record } = await k.writes.review(r.id, { input: { tier: 2, rule: "module-authority", reason: "new authority", reviewFirst: true }, request: {} });
  assert.equal(record.state, "owner", "the reviewer's yes goes on to the owner");
  await settle();
  assert.deepEqual([k.h.lands.length, k.h.launches.length], [0, 0]);
  const decided = k.writes.decide(r.id, { digest: r.digest, decision: "approve", by: "owner:telegram", via: "telegram" });
  assert.equal(decided.state, "approved");
  for (let i = 0; i < 100 && k.records.get(r.id).state !== "done"; i++) await settle();
  assert.equal(k.records.get(r.id).state, "done", k.records.get(r.id).outcome?.text);
  assert.deepEqual([k.h.lands.length, k.h.launches.length], [1, 1]);
  // A reviewer's no on new authority is final: the owner never sees it, nothing lands.
  const no = kernel({ modules: NEW_AUTHORITY, reviewer: "reject" });
  const n = await no.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.equal((await no.writes.review(n.id, { input: { tier: 2, rule: "module-authority", reason: "new authority", reviewFirst: true }, request: {} })).record.state, "rejected");
});

test("no apply runs twice: the same bump filed again is the same record, and runs and restarts launch it once", async () => {
  const k = kernel();
  const r = await k.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.equal((await k.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" })).id, r.id);
  assert.equal(k.records.list(["review", "owner", "approved", "claimed", "done"], 100, { task: "TASK-1" }).length, 1);
  await k.writes.review(r.id, { input: { tier: 1, rule: "pin-forward", reason: "forward" }, request: {} });
  await Promise.all([k.writes.run(r.id), k.writes.run(r.id), k.writes.reconcile()]);
  for (let i = 0; i < 100 && k.records.get(r.id).state !== "done"; i++) await settle();
  await k.writes.reconcile();
  await settle();
  assert.equal(k.records.get(r.id).state, "done");
  assert.deepEqual([k.h.lands.length, k.h.launches.length], [1, 1]);
});

test("a change the rules refuse is refused at filing, saying why", async () => {
  // A pin off the product's main, and a file outside the instance config.
  const off = createApplyPlanner({
    instanceRepo: () => "acme/aidenhq-instance",
    read: async () => ({ files: ["instance.yaml"], texts: { base: { "instance.yaml": yaml(OLD) }, head: { "instance.yaml": yaml(NEW) } }, diff: "x" }),
    product: { onMain: async () => false, isAncestor: async () => false, log: async () => "" }, modules: () => ({}), roles: () => ({}), connections: () => ({}), moduleApps: () => [],
  });
  await assert.rejects(off({ args: BUMP }), /is not on the product's main/);
  const stray = createApplyPlanner({ instanceRepo: () => "acme/aidenhq-instance", read: async () => ({ files: ["ops/apply-config.sh"], texts: { base: {}, head: {} }, diff: "x" }), product: {}, modules: () => ({}), roles: () => ({}), connections: () => ({}), moduleApps: () => [] });
  await assert.rejects(stray({ args: BUMP }), /outside the instance config/);
  // Only the configured instance repo, whatever the requester names; the record carries the configured spelling.
  await assert.rejects(stray({ args: { ...BUMP, repo: "acme/aidenhq" } }), /lands only on the instance repo \(acme\/aidenhq-instance\), not acme\/aidenhq/);
  const k = kernel();
  await assert.rejects(k.writes.request(codehost, { kind: "kernel.apply", args: { ...BUMP, repo: "evil/aidenhq-instance" }, task: "TASK-1" }), /lands only on the instance repo/);
  assert.equal((await k.writes.request(codehost, { kind: "kernel.apply", args: { ...BUMP, repo: "ACME/AidenHQ-Instance" }, task: "TASK-1" })).args.repo, "acme/aidenhq-instance");
});
