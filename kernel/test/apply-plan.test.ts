// kernel.apply's planner (apply-tier.ts) through the write lifecycle: a module holding the role kernel.apply files a release
// bump through writes.request like any requester; the kernel reads the commit from the code host, refuses what code refuses,
// lists the module authority it brings, and the executor lands it once.
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
const codehost = { kind: "module", module: "github", roles: ["kernel.tasks", "kernel.apply"], tools: {} };
const NEW_AUTHORITY = { modules: { acme: { base: { name: "acme" }, head: { name: "acme", privileged: ["git-credential"] }, codeChanged: false } }, marketplaces: [] };

/** One kernel: records, the planner over a fake code host and product git, the executor over a fake host that counts. */
function kernel({ modules = { modules: {}, marketplaces: [] }, reviewer = "approve", texts = { base: yaml(OLD), head: yaml(NEW) }, verifyRelease = async () => null, autonomy = "full" } = {}) {
  const h = { reads: 0, lands: [], launches: [], gens: [] };
  // The commit as the code host reads it, at plan and again at the land.
  const commit = () => ({ files: ["instance.yaml"], texts: { base: { "instance.yaml": texts.base }, head: { "instance.yaml": texts.head } }, diff: `-product: ${OLD}\n+product: ${NEW}\n` });
  const planner = createApplyPlanner({
    instanceRepo: () => "acme/aidenhq-instance",
    read: async (s) => (h.reads++, h.read = s, commit()),
    product: { onMain: async () => true, isAncestor: async (a, b) => a === OLD && b === NEW, log: async () => "bbbbbbb feat: something (#1)" },
    modules: () => modules, verifyRelease,
  });
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "apply-plan-")), "kernel.db"));
  const applies = createApply({
    // Each launch is an apply that ends at once in a good generation of the instance's main, which contains the commit.
    db: records.db, pollMs: 5, generations: () => h.gens, contains: async () => true, tail: async () => "",
    codehost: { read: async () => commit(), land: async (s) => (h.lands.push(s), { landed: s.sha }) },
    launch: async (u) => { h.launches.push(u); h.gens.push({ n: h.gens.length + 1, instance: "e".repeat(40), health: "good" }); },
    unit: async () => ({ loaded: false, active: "inactive", sub: "dead", result: "" }),
  });
  // kernel.apply is the kernel's own kind, planned and executed here.
  const writes = createWrites({
    records, registry: () => ({ "kernel.apply": KERNEL_KINDS["kernel.apply"] }), connections: () => ({}), secret: () => "", resolver: {},
    repos: () => ({ product: "acme/aidenhq", instance: "acme/aidenhq-instance" }),
    reviews: { request: async () => ({ decision: reviewer, reason: "read it", model: "~acme/reviewer" }) },
    onTask: { open: async () => true, notify: async () => {} }, replay: async () => ({ ok: false, text: "" }),
    native: { "kernel.apply": applies.execute }, planners: { "kernel.apply": planner }, resume: ["kernel.apply"], autonomy: () => autonomy,
  });
  return { h, records, writes };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test("a release bump files kernel.apply, planned from the code host's read: the reviewer's, the owner's under autonomy off", async () => {
  const k = kernel();
  const r = await k.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.deepEqual(r.args, { ...BUMP, files: ["instance.yaml"] });
  assert.deepEqual([r.tier, r.state, r.rule], [1, "review", null]);
  assert.match(r.card.details, /<<<PRODUCT_COMMITS\nProduct commits the pin move brings, already on the product's main \(code's account, not the change under review\):\nProduct upgrade aaaaaaaaa → bbbbbbbbb, adding these commits:\nbbbbbbb feat: something \(#1\)\nPRODUCT_COMMITS>>>/);
  // The reviewer gets the same roll-up as its own field, so it shows it apart from the diff a finding may quote (issue #1639).
  assert.equal(r.context?.productCommits, "<<<PRODUCT_COMMITS\nProduct commits the pin move brings, already on the product's main (code's account, not the change under review):\nProduct upgrade aaaaaaaaa → bbbbbbbbb, adding these commits:\nbbbbbbb feat: something (#1)\nPRODUCT_COMMITS>>>");
  assert.ok(r.card.details.includes(r.context!.productCommits!), "the card's copy is the same text the reviewer removes");
  assert.equal(k.h.lands.length, 0, "nothing lands before the reviewer");
  const off = await kernel({ autonomy: "off" }).writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.deepEqual([off.tier, off.rule], [2, "autonomy-off"]);
  // Only a module holding the role files it, and only for a kernel kind the kernel plans: a role named after another
  // module's kind grants nothing.
  await assert.rejects(k.writes.request({ ...codehost, roles: ["kernel.tasks"] }, { kind: "kernel.apply", args: BUMP, task: "TASK-1" }), /no grant on kernel.apply/);
  const merge = { module: "github", floor: 0, tools: [], executor: { url: "http://codehost-github:8100/x", auth_secret: "k" } };
  const other = createWrites({ records: k.records, registry: () => ({ "github.merge": merge, "kernel.apply": KERNEL_KINDS["kernel.apply"] }), connections: () => ({}), secret: () => "", resolver: {}, onTask: { open: async () => true, notify: async () => {} }, replay: async () => ({}) });
  await assert.rejects(other.request({ kind: "module", module: "acme", roles: ["github.merge"], tools: {} }, { kind: "github.merge", args: {}, task: "TASK-1" }), /no grant on github.merge/);
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

test("new module authority, loosened autonomy or raised spend is the AI reviewer's under full autonomy; autonomy off is the owner's", async () => {
  const role = (official) => ({ modules: { acme: { base: { name: "acme" }, head: { name: "acme", roles: { requests: ["kernel.work-read"] } }, codeChanged: false, ...(official ? { official: true } : {}) } }, marketplaces: [] });
  const tierOf = async (o) => { const r = await kernel(o).writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" }); return [r.tier, r.merit, r.state]; };
  // Settings move without the pin (a pin move lands alone).
  const settings = (b, h) => ({ base: `${yaml(OLD)}settings: ${b}\n`, head: `${yaml(OLD)}settings: ${h}\n` });
  for (const o of [{ modules: NEW_AUTHORITY }, { modules: role(true) }, { modules: role(false) }, { texts: settings("{ autonomy: tier0 }", "{ autonomy: full }") }, { texts: settings("{ spend_day_usd: 10 }", "{ spend_day_usd: 20 }") }, { texts: settings("{ quiet_start: on }", "{ quiet_start: off }") }]) {
    const [tier, , state] = await tierOf(o);
    assert.deepEqual([tier, state], [1, "review"], JSON.stringify(o).slice(0, 80));
  }
  assert.deepEqual(await tierOf({ modules: role(false), autonomy: "off" }), [2, 1, "owner"]);
  await assert.rejects(tierOf({ texts: { base: `${yaml(OLD)}settings: { a: 1 }\n`, head: `${yaml(NEW)}settings: { a: 2 }\n` } }), /a product pin move lands alone/);
  // The reviewer's yes runs it: no owner card.
  const k = kernel({ modules: NEW_AUTHORITY });
  const r = await k.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.deepEqual(r.args.authority, ["acme: adds privileged git-credential (owner)"]);
  assert.equal((await k.writes.review(r.id, { verdict: { decision: "approve", code: "clean", reason: "fine", model: "~acme/model-a" }, request: {} })).record.state, "approved");
  for (let i = 0; i < 100 && k.records.get(r.id).state !== "done"; i++) await settle();
  assert.equal(k.records.get(r.id).state, "done", k.records.get(r.id).outcome?.text);
  // The owner's earlier no on the task holds at full autonomy.
  assert.deepEqual([computeTier({ floor: 1, raise: { tier: 2, rule: "release-pin" }, priorVeto: true, autonomy: "full" }).tier, computeTier({ floor: 1, raise: { tier: 2, rule: "release-pin" }, autonomy: "full" }).tier], [2, 1]);
});

test("no apply runs twice: the same bump filed again is the same record, and runs and restarts launch it once", async () => {
  const k = kernel();
  const r = await k.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.equal((await k.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" })).id, r.id);
  assert.equal(k.records.list(["review", "owner", "approved", "claimed", "done"], 100, { task: "TASK-1" }).length, 1);
  await k.writes.review(r.id, { verdict: { decision: "approve", code: "clean", reason: "fine", model: "~acme/model-a" }, request: {} });
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
    product: { onMain: async () => false, isAncestor: async () => false, log: async () => "" }, modules: () => ({}),
  });
  await assert.rejects(off({ args: BUMP }), /is not on the product's main/);
  const stray = createApplyPlanner({ instanceRepo: () => "acme/aidenhq-instance", read: async () => ({ files: ["ops/apply-config.sh"], texts: { base: {}, head: {} }, diff: "x" }), product: {}, modules: () => ({}) });
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
  assert.deepEqual(await tierOf(kernel({ texts, verifyRelease: verified }), "updater"), [1, null], "the updater's verified move");
  assert.deepEqual(asked.at(-1), ["2026.11.3", D3], "verified by the planner, at the head's release and sha");
  // The record says so (args.release, on its card): the owner's request for that release, its official modules' authority
  // included, as code found it; never for anyone else's move, an unverified one, or with auto-updates off.
  const releaseOf = async (k, filer) => (filer === "updater" ? await k.writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: UPDATER }) : await k.writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" })).args.release;
  const withAuthority = { modules: { acme: { base: { name: "acme" }, head: { name: "acme", writes: { post: {} } }, codeChanged: false, official: true } }, marketplaces: [] };
  const filed = await kernel({ texts, verifyRelease: verified, modules: withAuthority }).writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: UPDATER });
  assert.equal(filed.args.release, "2026.11.3");
  // The reviewer reads both after the diff (its request's diff is the card's details), every authority line whole.
  assert.match(filed.card.details, /Release update \(computed by code\): the kernel's updater moves this instance to release 2026\.11\.3[^\n]*auto-updates are on[\s\S]*Module changes \(the authority diff[^\n]*\nacme: adds write kind post \(owner\)/);
  // The owner's auto-update takes the official release's new authority (owner, 2026-11-20): under any autonomy the
  // AI reviewer (never the owner) judges only whether the update is malicious or
  // compromised; every line reaches it whole.
  const tools = Array.from({ length: 30 }, (_, i) => `primer_tool_number_${i}`);
  const official = { modules: { acme: { base: { name: "acme", connections: { primer: { tools: { write: [] } } } }, head: { name: "acme", writes: { post: {} }, connections: { primer: { tools: { write: tools } } }, agents: { bot: { connections: { primer: tools } } } }, codeChanged: true, official: true } }, marketplaces: [] };
  const taken = await kernel({ texts, verifyRelease: verified, modules: official, autonomy: "tier0" }).writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: UPDATER });
  assert.deepEqual([taken.tier, taken.rule], [1, null]);
  assert.ok(taken.card.reason.length <= 300, taken.card.reason);
  const noCode = { modules: { acme: { ...official.modules.acme, codeChanged: false } }, marketplaces: [] };
  const plain = await kernel({ texts, verifyRelease: verified, modules: noCode, autonomy: "tier0" }).writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: UPDATER });
  assert.deepEqual([plain.tier, plain.rule], [1, null]);
  assert.ok(taken.args.authority.some((l) => l.length > 300 && l.includes(tools.at(-1)) && l.endsWith("(owner)")), "a long line, whole");
  assert.ok(taken.args.authority.includes("code changes in acme (review)"));
  assert.match(taken.card.details, new RegExp(`${tools.at(-1)}[^\\n]*\\(owner\\)`));
  // The same move by anyone else, or a module that isn't official: the reviewer's too.
  const mine = await kernel({ texts, verifyRelease: verified, modules: official, autonomy: "tier0" }).writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.equal(mine.tier, 1);
  const third = { modules: { acme: { ...official.modules.acme, official: false } }, marketplaces: [] };
  const notOurs = await kernel({ texts, verifyRelease: verified, modules: third }).writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: UPDATER });
  assert.equal(notOurs.tier, 1);
  const other = await kernel({ texts, verifyRelease: verified, modules: withAuthority }).writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.match(other.card.details, /Module changes[^\n]*\nacme: adds write kind post \(owner\)/);
  assert.doesNotMatch(other.card.details, /Release update/);
  assert.equal(await releaseOf(kernel({ texts, verifyRelease: verified }), "module"), undefined);
  assert.equal(await releaseOf(kernel({ texts, verifyRelease: async () => null, autonomy: "tier0" }), "updater"), undefined);
  // Anyone else filing the same move (an agent's job, a module): the reviewer's, and never verified for them.
  asked.length = 0;
  assert.deepEqual(await tierOf(kernel({ texts, verifyRelease: verified, autonomy: "tier0" }), "module"), [1, null]);
  assert.equal(asked.length, 0);
  // A release the updater's checks refuse, or one with more edited along with it: the reviewer's too.
  assert.deepEqual(await tierOf(kernel({ texts, verifyRelease: async () => null, autonomy: "tier0" }), "updater"), [1, null]);
  const off = { base: rel(OLD, "2026.11.2", D2, "off"), head: rel(NEW, "2026.11.3", D3, "off") };
  assert.equal(await releaseOf(kernel({ texts: off, verifyRelease: async () => off.head, autonomy: "tier0" }), "updater"), undefined);
  assert.equal(UPDATER.kind, "kernel", "a kind no token yields (identity.ts: run, job, module)");
  // The autonomy cap limits agents' writes: under `off` the updater's verified move stays the reviewer's (the owner's standing
  // authority, auto_update), while anyone else's same move is the owner's as before.
  assert.deepEqual(await tierOf(kernel({ texts, verifyRelease: verified, autonomy: "off" }), "updater"), [1, null]);
  assert.deepEqual(await tierOf(kernel({ texts, verifyRelease: verified, autonomy: "off" }), "module"), [2, "autonomy-off"]);
  // ...and the reviewer's yes runs it: no owner card, no shadow note.
  const k = kernel({ texts, verifyRelease: verified, autonomy: "off" });
  const r = await k.writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: UPDATER });
  const { record } = await k.writes.review(r.id, { verdict: { decision: "approve", code: "clean", reason: "verified", model: "~acme/model-a" }, request: {} });
  assert.equal(record.state, "approved");
  await settle();
  assert.equal(k.h.lands.length, 1, "landed on the reviewer's yes");
});

test("the owner's settings change is capped like anyone's, unless saved in his board session: then his save decides it", async () => {
  const texts = { base: `product: ${OLD}\nmodules: [core]\nsettings: { autonomy: "off" }\n`, head: `product: ${OLD}\nmodules: [core]\nsettings: { autonomy: "full" }\n` };
  const r = await kernel({ texts, autonomy: "off" }).writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: SETTINGS });
  assert.deepEqual([r.tier, r.merit, r.rule, r.state], [2, 1, "autonomy-off", "owner"], "autonomy off: the owner's");
  // Any change is capped: under off it waits for the owner.
  const plain = { base: texts.base, head: `product: ${OLD}\nmodules: [core]\nsettings: { autonomy: "off", timezone: UTC }\n` };
  assert.equal((await kernel({ texts: plain, autonomy: "off" }).writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: SETTINGS })).tier, 2);
  // Saved in his signed-in board session (the account the kernel checked), it is his own approval: decided as his account at
  // filing, never with the reviewer, and it runs.
  const k = kernel({ texts, autonomy: "off" });
  const saved = await k.writes.fileKernel("kernel.apply", { args: BUMP, task: "TASK-1", requester: SETTINGS, owner: { account: "acct-1", via: "save" } });
  assert.deepEqual([saved.tier, saved.merit, saved.state, saved.decided_by, saved.via], [2, 1, "approved", "account:acct-1", "save"]);
  await settle();
  assert.equal(k.h.lands.length, 1, "landed on his save");
});

// The test-user sign-in identity (docs/design/access.md, "Test-user sign-in"): the apply that names one is the owner's own
// Tier 2 card (WOR-11491), and its card says in plain language which email and apps it adds. Nothing else gets either.
test("an apply that adds or changes settings.edge.test_user plans a Tier 2 raise and says on its card which identity it adds", async () => {
  const edge = (testUser) => `${yaml(OLD)}settings:\n  edge:\n${testUser ? `    test_user: { email: ${testUser.email}, apps: [${testUser.apps.join(", ")}] }\n` : ""}`;
  const add = { base: edge(), head: edge({ email: "canary@aidenhq.test", apps: ["roadmap-keeper"] }) };
  // The plan itself: the raise the planner returns (writes.ts reads it for the tier).
  const plan = (texts) => createApplyPlanner({ instanceRepo: () => "acme/aidenhq-instance", read: async () => ({ files: ["instance.yaml"], texts: { base: { "instance.yaml": texts.base }, head: { "instance.yaml": texts.head } }, diff: "x" }), product: { onMain: async () => true, isAncestor: async () => false, log: async () => "" }, modules: () => ({ modules: {}, marketplaces: [] }) })({ args: BUMP });
  assert.deepEqual((await plan(add)).raise, { tier: 2, rule: "test-user-identity", reason: "adds or changes the instance's agent sign-in identity (settings.edge.test_user)" });
  const r = await kernel({ texts: add }).writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.deepEqual([r.merit, r.rule], [2, "test-user-identity"], "the plan's raise");
  assert.match(r.card.reason!, /adds or changes the instance's agent sign-in identity \(settings\.edge\.test_user\)/);
  assert.match(r.card.changes, /Adds a test sign-in identity: canary@aidenhq\.test as a member of roadmap-keeper, for agents holding app-tester; read-only sessions of up to 60 minutes \(app_page_canary's one 15-minute submission writes\); every mint and revoke audited\.\nAn apply doesn't install the canary network or re-run the computers' rule: on an upgraded host, install ops\/vm\/canary-net\.sh and its aidenhq-canary-net\.service once, re-run ops\/vm\/computer-net\.sh/);
  // Changing the setting (another email, another app) raises it too, the line naming the new values.
  const changed = { base: add.head, head: edge({ email: "canary2@aidenhq.test", apps: ["roadmap-keeper", "notes"] }) };
  const c = await kernel({ texts: changed }).writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.deepEqual([c.merit, c.rule], [2, "test-user-identity"]);
  assert.match(c.card.changes, /canary2@aidenhq\.test as a member of roadmap-keeper, notes/);
  // Another instance.yaml setting (or none at all): no raise, no line.
  for (const texts of [{ base: `${yaml(OLD)}settings: { timezone: UTC }\n`, head: `${yaml(OLD)}settings: { timezone: Europe/London }\n` }, { base: `${yaml(OLD)}settings: { timezone: UTC }\n`, head: `${yaml(OLD)}settings: { timezone: UTC }\n` }]) {
    const plain = await kernel({ texts }).writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
    assert.deepEqual([plain.tier, plain.merit, plain.rule], [1, 1, null]);
    assert.doesNotMatch(plain.card.changes, /test sign-in identity/);
  }
  // Rewriting the setting without changing the identity (key order, app order): no change, so no raise and no line.
  const reordered = { base: add.head, head: `${yaml(OLD)}settings:\n  edge:\n    test_user: { apps: [roadmap-keeper], email: canary@aidenhq.test }\n` };
  const same = await kernel({ texts: reordered }).writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.deepEqual([same.tier, same.merit, same.rule], [1, 1, null]);
  assert.deepEqual((await plan(reordered)).raise, undefined);
  // Removing it: the head has no test_user, so neither the raise nor the line.
  const removed = await kernel({ texts: { base: add.head, head: edge() } }).writes.request(codehost, { kind: "kernel.apply", args: BUMP, task: "TASK-1" });
  assert.deepEqual([removed.tier, removed.merit, removed.rule], [1, 1, null]);
  assert.doesNotMatch(removed.card.changes, /test sign-in identity/);
});
