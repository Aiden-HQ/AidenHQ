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
import { SETTINGS, UPDATER, openRecords } from "../src/records.ts";
import { computeTier } from "../src/tier.ts";
import { createWrites } from "../src/writes.ts";

const [OLD, NEW, COMMIT] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
const yaml = (product) => `product: ${product}\nmodules: [core]\n`;
const BUMP = { repo: "acme/aidenhq-instance", branch: "fleet/release-acme-7", sha: COMMIT };
const codehost = { kind: "module", module: "codehost-github", roles: ["kernel.tasks", "kernel.apply"], tools: {} };
const NEW_AUTHORITY = { modules: { acme: { base: { name: "acme" }, head: { name: "acme", privileged: ["git-credential"] }, codeChanged: false } }, marketplaces: [] };

/** One kernel: records, the planner over a fake code host and product git, the executor over a fake host that counts. */
function kernel({ modules = { modules: {}, marketplaces: [] }, inventory = { entries: [] }, reviewer = "approve", texts = { base: yaml(OLD), head: yaml(NEW) }, verifyRelease = async () => null, autonomy = "full" } = {}) {
  const h = { reads: 0, lands: [], launches: [], units: {} };
  // The commit as the code host reads it, at plan and again at the land.
  const commit = () => ({ files: ["instance.yaml"], texts: { base: { "instance.yaml": texts.base }, head: { "instance.yaml": texts.head } }, diff: `-product: ${OLD}\n+product: ${NEW}\n`, trial: "" });
  const planner = createApplyPlanner({
    instanceRepo: () => "acme/aidenhq-instance",
    read: async (s) => (h.reads++, h.read = s, commit()),
    product: { onMain: async () => true, isAncestor: async (a, b) => a === OLD && b === NEW, log: async () => "bbbbbbb feat: something (#1)" },
    modules: () => modules, roles: () => ({}), connections: () => ({}), moduleApps: () => [], verifyRelease,
  });
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "apply-plan-")), "kernel.db"));
  const applies = createApply({
    db: records.db, pollMs: 5, generations: () => [], busy: async () => false, tail: async () => "",
    codehost: { read: async () => commit(), land: async (s) => (h.lands.push(s), { landed: s.sha }) },
    launch: async (u) => { h.launches.push(u); h.units[u] = { loaded: true, active: "active", sub: "exited", result: "success" }; },
    unit: async (u) => h.units[u] ?? { loaded: false, active: "inactive", sub: "dead", result: "" },
  });
  // kernel.apply is the kernel's own kind, planned and executed here.
  const writes = createWrites({
    records, registry: () => ({ "kernel.apply": KERNEL_KINDS["kernel.apply"] }), connections: () => ({}), secret: () => "", resolver: {}, paths: () => inventory ?? undefined,
    repos: () => ({ product: "acme/aidenhq", instance: "acme/aidenhq-instance" }),
    reviews: { request: async () => ({ decision: reviewer, reason: "read it", model: "~acme/reviewer" }) },
    onTask: { open: async () => true, notify: async () => {} }, replay: async () => ({ ok: false, text: "" }),
    native: { "kernel.apply": applies.execute }, planners: { "kernel.apply": planner }, resume: ["kernel.apply"], autonomy: () => autonomy,
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
  const owned = (autonomy) => kernel({ autonomy, inventory: { entries: [{ repo: "any", pattern: "instance.yaml", sensitivity: 2, source: "paths.yaml" }] } }).writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.deepEqual([(await owned("off")).tier, (await owned("off")).rule], [2, "owner-path"]);
  assert.deepEqual([(await owned("full")).tier, (await owned("full")).rule], [2, "owner-path"], "an owner path (a supply-chain source exception) is the owner's under full autonomy too");
  const blind = kernel({ inventory: null });
  assert.equal((await blind.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" })).rule, "gate-list-unknown");
  // Only a module holding the role files it, and only for a kernel kind the kernel plans: a role named after another
  // module's kind grants nothing.
  await assert.rejects(k.writes.request({ ...codehost, roles: ["kernel.tasks"] }, { kind: "kernel.apply", args: BUMP, task: "TASK-1" }), /no grant on kernel.apply/);
  const merge = { module: "codehost-github", floor: 0, tools: [], executor: { url: "http://codehost-github:8100/x", auth_secret: "k" } };
  const other = createWrites({ records: k.records, registry: () => ({ "codehost-github.merge": merge, "kernel.apply": KERNEL_KINDS["kernel.apply"] }), connections: () => ({}), secret: () => "", resolver: {}, onTask: { open: async () => true, notify: async () => {} }, replay: async () => ({}) });
  await assert.rejects(other.request({ kind: "module", module: "acme", roles: ["codehost-github.merge"], tools: {} }, { kind: "codehost-github.merge", args: {}, task: "TASK-1" }), /no grant on codehost-github.merge/);
  await assert.rejects(other.request({ ...codehost, roles: ["kernel.apply"] }, { kind: "kernel.apply", args: BUMP, task: "TASK-1" }), /no write kind kernel.apply/, "no planner: not filed");
});

test("a job's kernel.apply is read from, and names, the job's own workspace", async () => {
  const k = kernel();
  // A kernel job's identity (identity.ts): a run whose token names kernel.apply, on its task, in its row's workspace.
  const job = { kind: "run", agent: "agent-1", key: "fleet-engineer", name: "fleet-engineer", roles: [], tools: {}, writes: ["kernel.apply"], task: "TASK-1", workspace: "ACME-7", credential: "" };
  const r = await k.writes.request(job, { kind: "kernel.apply", args: BUMP, task: "OTHER-9" });
  assert.equal(r.identifier, "ACME-7");
  assert.equal(r.task, "TASK-1");
  assert.equal(k.h.read.workspace, "ACME-7");
  await assert.rejects(k.writes.request({ ...job, writes: [] }, { kind: "kernel.apply", args: BUMP }), /no grant on kernel.apply/);
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

test("under full autonomy the owner approves only loosening autonomy, raising spend, a non-official module's new authority and what they vetoed", async () => {
  const role = (official) => ({ modules: { acme: { base: { name: "acme" }, head: { name: "acme", roles: { requests: ["kernel.work-read"] } }, codeChanged: false, ...(official ? { official: true } : {}) } }, marketplaces: [] });
  const tierOf = async (o) => { const r = await kernel(o).writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" }); return [r.tier, r.panel, r.args.ownerRequired ?? false]; };
  const settings = (b, h) => ({ base: `${yaml(OLD)}settings: ${b}\n`, head: `${yaml(NEW)}settings: ${h}\n` });
  // An official module's new role (shipped in the product's modules/, reviewed at merge): the panel's.
  assert.deepEqual(await tierOf({ modules: role(true) }), [1, true, false]);
  // The same role under autonomy off: the owner's after the reviewer, as before.
  assert.deepEqual(await tierOf({ modules: role(true), autonomy: "off" }), [2, false, false]);
  // A module that isn't official asking for it: the owner's at any autonomy.
  assert.deepEqual(await tierOf({ modules: role(false) }), [2, false, true]);
  // Loosening autonomy, raising the install's spend cap: the owner's; with an official role in the same change too.
  assert.deepEqual((await tierOf({ texts: settings("{ autonomy: tier0 }", "{ autonomy: full }") }))[0], 2);
  assert.deepEqual((await tierOf({ texts: settings("{ spend_day_usd: 10 }", "{ spend_day_usd: 20 }") }))[0], 2);
  assert.deepEqual((await tierOf({ modules: role(true), texts: settings("{ spend_day_usd: 10 }", "{ spend_day_usd: 20 }") }))[0], 2);
  // Any other setting, ending quiet start: the panel's.
  assert.deepEqual(await tierOf({ texts: settings("{ quiet_start: on }", "{ quiet_start: off }") }), [1, true, false]);
  // The owner's earlier no on the task holds at full autonomy.
  assert.deepEqual([computeTier({ floor: 1, raise: { tier: 2, rule: "release-pin" }, priorVeto: true, autonomy: "full" }).tier, computeTier({ floor: 1, raise: { tier: 2, rule: "release-pin" }, autonomy: "full" }).tier], [2, 1]);
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

// Release updates (docs/design/release-updates.md): only the kernel's updater, moving to exactly the pin its own verification
// of that release writes, while auto-updates are on, is the reviewer's; any other release move is the owner's.
test("a release move is the reviewer's only as the updater's verified move under auto-updates; any other is the owner's below full autonomy", async () => {
  const rel = (product, name, sha, auto = "on") => `product: ${product}\nrelease: { name: "${name}", source: { source: github, repo: Aiden-HQ/aidenhq-distro }, sha: ${sha} }\nmodules: [core]\nsettings: { auto_update: "${auto}" }\n`;
  const [D2, D3] = ["d2".repeat(20), "d3".repeat(20)];
  const texts = { base: rel(OLD, "2026.11.2", D2), head: rel(NEW, "2026.11.3", D3) };
  const asked = [];
  // The updater's verification of 2026.11.3 at D3 on this base writes exactly the head.
  const verified = async (base, name, sha) => (asked.push([name, sha]), base === texts.base && name === "2026.11.3" && sha === D3 ? texts.head : null);
  const tierOf = async (k, filer) => { const r = filer === "updater" ? await k.writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: UPDATER }) : await k.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" }); return [r.tier, r.rule]; };
  assert.deepEqual(await tierOf(kernel({ texts, verifyRelease: verified }), "updater"), [1, "release-pin"], "the updater's verified move");
  assert.deepEqual(asked.at(-1), ["2026.11.3", D3], "verified by the planner, at the head's release and sha");
  // Anyone else filing the same move (an agent's job, a module): the owner's, and never verified for them.
  asked.length = 0;
  assert.deepEqual(await tierOf(kernel({ texts, verifyRelease: verified, autonomy: "tier0" }), "module"), [2, "release-pin"]);
  assert.equal(asked.length, 0);
  // Under full autonomy the same move is the panel's: a release move is not the owner's own authority.
  assert.deepEqual(await tierOf(kernel({ texts, verifyRelease: verified }), "module"), [1, "release-pin"]);
  // A release the updater's checks refuse (older than the base, its sha off the distro's main, no tested stamp): the owner's.
  assert.deepEqual(await tierOf(kernel({ texts, verifyRelease: async () => null, autonomy: "tier0" }), "updater"), [2, "release-pin"]);
  // The verified release, but the head isn't exactly its pin (anything else edited along with it): the owner's.
  assert.deepEqual(await tierOf(kernel({ texts: { ...texts, head: `${texts.head}# more\n` }, verifyRelease: verified, autonomy: "tier0" }), "updater"), [2, "release-pin"]);
  // Auto-updates off: every release move is the owner's.
  const off = { base: rel(OLD, "2026.11.2", D2, "off"), head: rel(NEW, "2026.11.3", D3, "off") };
  assert.deepEqual(await tierOf(kernel({ texts: off, verifyRelease: async () => off.head, autonomy: "tier0" }), "updater"), [2, "release-pin"]);
  assert.equal(UPDATER.kind, "kernel", "a kind no token yields (identity.ts: run, job, module)");
  // The autonomy cap limits agents' writes: under `off` the updater's verified move stays the reviewer's (the owner's standing
  // authority, auto_update), while anyone else's same move is the owner's as before.
  assert.deepEqual(await tierOf(kernel({ texts, verifyRelease: verified, autonomy: "off" }), "updater"), [1, "release-pin"]);
  assert.deepEqual(await tierOf(kernel({ texts, verifyRelease: verified, autonomy: "off" }), "module"), [2, "release-pin"]);
  // ...and the reviewer's yes runs it: no owner card, no shadow note.
  const k = kernel({ texts, verifyRelease: verified, autonomy: "off" });
  const r = await k.writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: UPDATER });
  const { record } = await k.writes.review(r.id, { input: { tier: 1, rule: "release-pin", reason: "verified" }, request: {} });
  assert.equal(record.state, "approved");
  await settle();
  assert.equal(k.h.lands.length, 1, "landed on the reviewer's yes");
});

test("the owner's settings change is capped like anyone's: under autonomy off, loosening autonomy is an owner card", async () => {
  const texts = { base: `product: ${OLD}\nmodules: [core]\nsettings: { autonomy: "off" }\n`, head: `product: ${OLD}\nmodules: [core]\nsettings: { autonomy: "full" }\n` };
  const r = await kernel({ texts, autonomy: "off" }).writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: SETTINGS });
  assert.deepEqual([r.tier, r.merit, r.rule, r.state], [2, 2, "autonomy", "review"], "the owner's on its merits, after the reviewer");
  // A merit-1 change (a setting the panel reads) is capped too: under off it waits for the owner, never the panel alone.
  const plain = { base: texts.base, head: `product: ${OLD}\nmodules: [core]\nsettings: { autonomy: "off", timezone: UTC }\n` };
  assert.equal((await kernel({ texts: plain, autonomy: "off" }).writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: SETTINGS })).tier, 2);
});
