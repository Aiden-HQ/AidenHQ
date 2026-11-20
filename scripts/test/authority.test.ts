// The authority diff (spec §5.7): every module change is the AI reviewer's first; new authority adds the owner after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityDiff, authorityLines, classifyModules, diffAll, marketplaceChanges, moduleInputs, renamed } from "../compiler/authority.ts";
import { OFFICIAL_URL, officialSides } from "../compiler/sources.ts";

const IMG = `example.com/acme/tool:1.0@sha256:${"a".repeat(64)}`;
const base = {
  name: "acme-crm",
  description: "CRM.",
  connections: { crm: { url: "http://crm-mcp:8080/mcp", auth: "crm_service_key", tools: { read: ["crm_search"], write: ["crm_note"] } } },
  services: { run: { "crm-mcp": { image: IMG, port: 8080 } } },
  agents: { closer: { model: "m", connections: { crm: "read" } } },
};
const with_ = (patch) => ({ ...structuredClone(base), ...patch });
const tier = (head, code = false, b = base) => classifyModules([authorityDiff("acme-crm", b, head, code)]);

test("a handbook-only change is Tier 1, no panel", () => {
  const t = tier(structuredClone(base));
  assert.deepEqual([t.tier, t.panel, t.rule, t.reviewFirst], [1, false, "module-config", false]);
  assert.deepEqual(authorityLines([authorityDiff("acme-crm", base, base, false)]), ["acme-crm: text only (review)"]);
});

test("an agent's skills list is module text, like its prompts: the reviewer's, never an unrecognised field", () => {
  const head = with_({ agents: { closer: { ...base.agents.closer, skills: ["acme-crm.follow-up"] } } });
  assert.equal(tier(head).tier, 1);
  assert.deepEqual(authorityLines([authorityDiff("acme-crm", base, head, false)]), ["acme-crm: text only (review)"]);
});

test("a code change without new authority is Tier 1 with panel", () => {
  const head = with_({ services: { run: { "crm-mcp": { image: IMG.replace("1.0", "1.1"), port: 8080, env: { LOG: "debug" } } } } });
  const t = tier(head, true);
  assert.deepEqual([t.tier, t.panel, t.rule], [1, true, "module-config"]);
  // A read tool, a new read-only agent, a description: still the reviewer's alone.
  const more = with_({ description: "x", connections: { crm: { ...base.connections.crm, tools: { read: ["crm_search", "crm_get"], write: ["crm_note"] } } }, agents: { ...base.agents, scout: { model: "m", connections: { crm: "read" } } } });
  assert.equal(tier(more).tier, 1);
});

test("a new write kind, privileged entry, secret, role, write tool, services.grants or returns: trusted each make Tier 2 review-first", () => {
  const conn = base.connections.crm;
  const owners = {
    "write kind": with_({ writes: { publish: { floor: 1 } } }),
    "lowered floor": [with_({ writes: { publish: { floor: 1 } } }), with_({ writes: { publish: { floor: 2 } } })],
    privileged: with_({ privileged: ["docker"] }),
    "generated secret": with_({ generated_secrets: ["crm_extra_key"] }),
    "provided secret": with_({ secrets: { provided: [{ name: "crm_token" }] } }),
    "secrets.state": with_({ secrets: { state: true } }),
    "declared role": with_({ roles: { declares: [{ id: "acme-crm.editor" }] } }),
    "requested role": with_({ roles: { requests: ["acme-crm.editor"] } }),
    "agent role": with_({ agents: { closer: { ...base.agents.closer, roles: ["fleet-read"] } } }),
    "write tool": with_({ connections: { crm: { ...conn, tools: { read: conn.tools.read, write: [...conn.tools.write, "crm_send"] } } } }),
    "destructive tool": with_({ connections: { crm: { ...conn, tools: { ...conn.tools, destructive: ["crm_delete"] } } } }),
    "services.grants": with_({ services: { ...base.services, grants: { apps: ["app_list"] } } }),
    "write tool retagged read": with_({ connections: { crm: { ...conn, tools: { read: ["crm_search", "crm_note"], write: [] } } } }),
    "destructive tool retagged write": [with_({ connections: { crm: { ...conn, tools: { read: conn.tools.read, write: ["crm_note", "crm_delete"] } } } }), with_({ connections: { crm: { ...conn, tools: { ...conn.tools, destructive: ["crm_delete"] } } } })],
    "returns: trusted": with_({ connections: { crm: { ...conn, returns: "trusted" } } }),
    "agent write grant": with_({ agents: { closer: { model: "m", connections: { crm: "write" } } } }),
    "user: image": with_({ services: { run: { "crm-mcp": { image: IMG, port: 8080, user: "image" } } } }),
    "read_only: false": with_({ services: { run: { "crm-mcp": { image: IMG, port: 8080, read_only: false } } } }),
    "ui_port": with_({ services: { run: { "crm-mcp": { image: IMG, port: 8080, ui_port: 3200 } } } }),
    join: with_({ services: { run: { "crm-mcp": { image: IMG, port: 8080, join: ["acme-db"] } } } }),
    egress: with_({ services: { run: { "crm-mcp": { image: IMG, port: 8080, egress: true } } } }),
    "isolation toward trusted": [with_({ isolation: "trusted" }), with_({ isolation: "untrusted" })],
    "model spend": with_({ services: { ...base.services, models: { day_usd: 5 } } }),
    "unrecognised key": with_({ hooks: ["x"] }),
    "a default grant": with_({ default_grants: [{ tools: ["crm.crm_write"] }] }),
  };
  for (const [what, v] of Object.entries(owners)) {
    const [head, b] = Array.isArray(v) ? v : [v, base];
    const t = tier(head, false, b);
    assert.deepEqual([t.tier, t.reviewFirst, t.rule], [2, true, "module-authority"], what);
  }
});

test("a retag is judged by the highest tag on either side: an agent's list grant on a tool once tagged write stays a write", () => {
  const conn = base.connections.crm;
  const retag = with_({ connections: { crm: { ...conn, tools: { read: ["crm_search", "crm_note"], write: [] } } }, agents: { closer: { model: "m", connections: { crm: ["crm_search", "crm_note"] } } } });
  const owners = authorityDiff("acme-crm", base, retag, false).changes.filter((c) => c.owner).map((c) => c.what);
  assert.deepEqual(owners, ["connection crm: retags crm_note from write to read", "agent closer: write grant on crm (crm_note)"]);
});

test("dropping enforcement is the owner's: a check removed, or the reviewer or executor provider gone", () => {
  const strict = with_({ checks: [{ id: "lint" }, { id: "scan" }], providers: { reviewer: { url: "http://r:1/" }, executor: { url: "http://e:1/" } } });
  const lines = (head) => authorityDiff("acme-crm", strict, head, false).changes.filter((c) => c.owner).map((c) => c.what);
  assert.deepEqual(lines(with_({ checks: [{ id: "lint" }], providers: { reviewer: { url: "http://r:1/" }, executor: { url: "http://e:1/" } } })), ["drops 1 check"]);
  assert.deepEqual(lines(with_({ checks: strict.checks })), ["drops its reviewer provider", "drops its executor provider"]);
  // A check moved to observe mode no longer enforces: dropped too.
  assert.deepEqual(lines(with_({ checks: [{ id: "lint" }, { id: "scan", mode: "observe" }], providers: strict.providers })), ["drops 1 check"]);
  // The same through a replace: B lacking A's check is the owner's.
  const d = authorityDiff("crm-b", undefined, { name: "crm-b" }, false, [{ name: "acme-crm", def: strict }]);
  assert.ok(d.changes.some((c) => c.owner && c.what === "drops 2 checks"));
});

test("an install is measured from untrusted: a trusted module, agent or app says so", () => {
  const owners = (head) => authorityDiff("acme-x", undefined, head, false).changes.filter((c) => c.owner).map((c) => c.what);
  assert.deepEqual(owners({ name: "acme-x", isolation: "untrusted" }), []);
  assert.deepEqual(owners({ name: "acme-x" }), ["isolation trusted"]);
  assert.deepEqual(owners({ name: "acme-x", isolation: "untrusted", agents: { a: { isolation: "trusted" } }, apps: [{ name: "dash", isolation: "trusted" }] }), ["app dash: isolation trusted", "agent a: isolation trusted"]);
  // An existing untrusted module whose app moves to trusted.
  const was = { name: "acme-x", isolation: "untrusted", apps: [{ name: "dash" }] };
  assert.deepEqual(authorityDiff("acme-x", was, { ...was, apps: [{ name: "dash", isolation: "trusted" }] }, false).changes.filter((c) => c.owner).map((c) => c.what), ["app dash: isolation trusted"]);
});

test("a replace renames only the ids A declares, and refuses an ambiguous one", () => {
  // `chan-a-notes` is another module's connection A's agent reads: not A's, so it is never renamed (no regex over the JSON).
  const a = { name: "chan-a", connections: { "chan-a": { auth: "chan_a_service_key", tools: { read: ["r"], write: [] } } }, agents: { bot: { connections: { "chan-a": "read", "chan-a-notes": "write" } } } };
  const r = renamed(a, "chan-a", "chan-b");
  assert.deepEqual(Object.keys(r.connections), ["chan-b"]);
  assert.equal(r.connections["chan-b"].auth, "chan_b_service_key");
  assert.deepEqual(r.agents.bot.connections, { "chan-b": "read", "chan-a-notes": "write" });
  assert.throws(() => renamed({ name: "chan-a", connections: { "chan-a.x": {}, "chan-a-x": {}, "chan-b.x": {} }, writes: {} }, "chan-a", "chan-b"), /would both be chan-b/);
  assert.throws(() => renamed({ name: "chan-a", generated_secrets: ["chan_a_key", "chan_b_key"] }, "chan-a", "chan-b"), /would both be chan_b_key/);
  // A grant key that collides after the rename, declared or not, would hide one grant: refused.
  const grants = { name: "chan-a", connections: { "chan-a": { tools: { read: ["r"], write: ["w"] } } }, agents: { bot: { connections: { "chan-a": "read", "chan-b": "write" } } } };
  assert.throws(() => renamed(grants, "chan-a", "chan-b"), /agent bot connections would both be chan-b/);
  const roles = { name: "chan-a", roles: { declares: [{ id: "chan-a.editor" }] }, agents: { bot: { roles: ["chan-a.editor", "chan-b.editor"] } } };
  assert.throws(() => renamed(roles, "chan-a", "chan-b"), /agent bot roles would both be chan-b.editor/);
});

test("H6: a provided secret named like a model key is still only owner:true (the reviewer rejects it)", () => {
  const d = authorityDiff("acme-crm", base, with_({ secrets: { provided: [{ name: "openai_api_key" }] } }), false);
  assert.deepEqual(d.changes, [{ what: "adds secret openai_api_key", owner: true, ownerOnly: true }]);
});

test("a removed module is the reviewer's, unless it carried enforcement", () => {
  assert.equal(tier(undefined).tier, 1);
  assert.equal(tier(undefined, false, with_({ checks: [{ id: "x" }] })).tier, 2);
});

test("B replacing A with equal authority has an empty diff; B adding a secret is owner:true", () => {
  const a = { name: "chan-a", generated_secrets: ["chan_a_service_key"], connections: { "chan-a": { url: "http://a:1/mcp", auth: "chan_a_service_key", tools: { read: ["r"], write: ["post"] } } }, writes: { "chan-a.post": { floor: 1 } } };
  const b = { name: "chan-b", replaces: ["chan-a"], generated_secrets: ["chan_b_service_key"], connections: { "chan-b": { url: "http://b:1/mcp", auth: "chan_b_service_key", tools: { read: ["r"], write: ["post"] } } }, writes: { "chan-b.post": { floor: 1 } } };
  const inputs = moduleInputs({ baseInstance: { modules: ["chan-a"] }, headInstance: { modules: ["chan-b"] }, baseDefs: { "chan-a": a, "chan-b": b }, headDefs: { "chan-a": a, "chan-b": b }, changed: [], official: { base: ["chan-a", "chan-b"], head: ["chan-a", "chan-b"] } });
  assert.deepEqual(Object.keys(inputs), ["chan-b"]);
  const same = diffAll(inputs);
  assert.equal(classifyModules(same).tier, 1);
  assert.deepEqual(same[0].changes.filter((c) => c.owner), []);
  const more = authorityDiff("chan-b", undefined, { ...b, generated_secrets: [...b.generated_secrets, "chan_b_extra"] }, false, [{ name: "chan-a", def: a }]);
  assert.deepEqual(more.changes.filter((c) => c.owner).map((c) => c.what), ["adds secret chan_b_extra"]);
  // `replaces` counts only when this change removes A: with A staying, B is a plain install, diffed against nothing.
  const kept = moduleInputs({ baseInstance: { modules: ["chan-a"] }, headInstance: { modules: ["chan-a", "chan-b"] }, baseDefs: { "chan-a": a, "chan-b": b }, headDefs: { "chan-a": a, "chan-b": b }, changed: [] });
  assert.equal(kept["chan-b"].replacing, undefined);
  assert.equal(classifyModules(diffAll(kept)).tier, 2);
});

test("a module folded into one that already ran: moved authority is no line, only what is new (distro#70)", () => {
  // The product drops chan-a; chan-b, already running, now carries chan-a's write kind, privileged entry, executor, secret and
  // App grant in its own namespace. instance.yaml still lists chan-a (current() reads it as chan-b): no rewrite.
  const a = { name: "chan-a", privileged: ["speaks-as-owner"], providers: { executor: { url: "http://a:1/x" } }, generated_secrets: ["chan_a_key"], writes: { "chan-a.post": { floor: 1 } }, codehost: { repos: "all" } };
  const b0 = { name: "chan-b", connections: { "chan-b": { url: "http://b:1/mcp", tools: { read: ["r"] } } } };
  const b1 = { ...b0, replaces: ["chan-a"], privileged: ["speaks-as-owner"], providers: { executor: { url: "http://a:1/x" } }, generated_secrets: ["chan_b_key"], writes: { "chan-b.post": { floor: 1 } }, codehost: { repos: "all" } };
  const both = ["chan-a", "chan-b", "chan-c"];
  const diff = (head, { official = { base: both, head: both }, headDefs = { "chan-b": head } } = {}) => diffAll(moduleInputs({ baseInstance: { modules: ["chan-a", "chan-b"] }, headInstance: { modules: ["chan-a", "chan-b", "chan-c"] }, baseDefs: { "chan-a": a, "chan-b": b0 }, headDefs, changed: [], official }));
  const owners = (ds, m = "chan-b") => ds.find((d) => d.module === m).changes.filter((c) => c.owner).map((c) => c.what);
  const moved = diff(b1);
  assert.deepEqual(moved.map((d) => d.module), ["chan-b"]);
  assert.deepEqual(owners(moved), []);
  assert.ok(moved[0].changes.some((c) => c.what === "replaces chan-a"));
  // Only the real delta: a new privileged entry and secret.
  assert.deepEqual(owners(diff({ ...b1, generated_secrets: ["chan_b_key", "chan_b_extra"], privileged: ["speaks-as-owner", "git-credential"] })), ["adds privileged git-credential", "adds secret chan_b_extra"]);
  // A's names are not carried as named: chan_a_key kept under its old name is new to chan-b.
  assert.deepEqual(owners(diff({ ...b1, generated_secrets: ["chan_a_key"] })), ["adds secret chan_a_key"]);
  // An entry both had is had only as one of them whole: a mix of the two is the owner's.
  const a2 = { ...a, connections: { "chan-a": { url: "http://a:1/mcp", tools: { write: ["post"] } } } };
  const conflict = diffAll(moduleInputs({ baseInstance: { modules: ["chan-a", "chan-b"] }, headInstance: { modules: ["chan-b"] }, baseDefs: { "chan-a": a2, "chan-b": b0 }, headDefs: { "chan-b": { ...b1, connections: { "chan-b": { url: "http://b:1/mcp", tools: { read: ["r"], write: ["post"] } } } } }, changed: [], official: { base: both, head: both } }));
  assert.ok(owners(conflict).includes("connections chan-b: chan-b and chan-a both had it, and it is neither one now"));
  // Not official on both sides, or two heirs: no successor. The claim is the owner's and chan-a is removed on its own.
  for (const ds of [diff(b1, { official: { base: ["chan-a"], head: [] } }), diff(b1, { headDefs: { "chan-b": b1, "chan-c": { name: "chan-c", replaces: ["chan-a"] } } })]) {
    assert.ok(owners(ds).includes("replaces chan-a, but is not its one official successor: nothing it had carries over"));
    assert.ok(owners(ds).includes("adds privileged speaks-as-owner"));
    assert.ok(owners(ds, "chan-a").some((w) => /removed/.test(w)));
  }
});

test("5b: the tree id at the new sha equals the recorded one → empty diff; the official repository is no owner line", () => {
  const repo = (files) => {
    const d = mkdtempSync(join(tmpdir(), "auth-tree-"));
    const g = (...a) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" }).trim();
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    const commit = (fs) => {
      for (const [p, t] of Object.entries(fs)) { mkdirSync(join(d, p, ".."), { recursive: true }); writeFileSync(join(d, p), t); }
      g("add", "-A");
      g("commit", "-qm", "c");
      return g("rev-parse", "HEAD");
    };
    return { d, sha: commit(files), commit };
  };
  const mod = { "module.yaml": "name: acme-crm\n", "main.ts": "export {};\n" };
  const product = repo(Object.fromEntries(Object.entries(mod).map(([p, t]) => [`modules/acme-crm/${p}`, t])));
  // The modules repository: the same folder at its root, under other commits (a history rewrite) and with root files.
  const mods = repo({ ...Object.fromEntries(Object.entries(mod).map(([p, t]) => [`acme-crm/${p}`, t])), LICENSE: "MIT\n" });
  const f = { cacheDir: mkdtempSync(join(tmpdir(), "auth-cache-")), parse: (t) => ({ name: /name: (\S+)/.exec(t)[1] }) }; // the kernel has no YAML parser; these manifests are one line
  const base = { product: product.sha, modules: ["acme-crm"] };
  const at = (sha) => ({ ...base, marketplaces: [{ name: "aidenhq", source: { source: "url", url: mods.d }, sha }] });
  const diff = (head) => {
    const o = officialSides(base, head, product.sha, product.sha, product.d, f);
    return diffAll(moduleInputs({ baseInstance: base, headInstance: head, ...o }));
  };
  assert.deepEqual(diff(at(mods.sha)), []);
  // A changed folder at the new sha is a change (every file, across two repositories).
  const changed = mods.commit({ "acme-crm/main.ts": "export const x = 1;\n" });
  assert.deepEqual(diff(at(changed)).map((d) => d.changes.map((c) => c.what)), [["code changes"]]);
  // The move itself: to the official repository, no line; anywhere else, the owner's.
  assert.deepEqual(marketplaceChanges(base, { ...base, marketplaces: [{ name: "aidenhq", source: { source: "url", url: OFFICIAL_URL }, sha: mods.sha }] }), []);
  assert.deepEqual(marketplaceChanges(base, at(mods.sha))[0].changes.map((c) => c.owner), [true]);
  // Official is the product's own modules/ at its commit; read from a marketplace, none is.
  assert.deepEqual(officialSides(base, at(mods.sha), product.sha, product.sha, product.d, f).official, { base: ["acme-crm"], head: [] });
  const own = repo({ ...Object.fromEntries(Object.entries(mod).map(([p, t]) => [`modules/acme-crm/${p}`, t])), "modules/marketplace.json": "{}\n" });
  const mine = { product: own.sha, modules: ["acme-crm"] };
  assert.deepEqual(officialSides(mine, mine, own.sha, own.sha, own.d, f).official, { base: ["acme-crm"], head: ["acme-crm"] });
});

test("a per-module pin is official only on the official repository's main; one off it is the owner's, as a fork", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { onOfficialMain } = await import("../compiler/sources.ts");
  const dir = mkdtempSync(join(tmpdir(), "official-"));
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a]).toString().trim();
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a"), "1");
  g("add", "a"), g("commit", "-qm", "a");
  const onMain = g("rev-parse", "HEAD");
  g("checkout", "-qb", "pr");
  writeFileSync(join(dir, "a"), "2");
  g("commit", "-qam", "b");
  const offMain = g("rev-parse", "HEAD");
  const f = { cacheDir: mkdtempSync(join(tmpdir(), "cache-")) };
  assert.equal(onOfficialMain({ url: dir, path: "", sha: onMain, owned: true }, f), true);
  assert.equal(onOfficialMain({ url: dir, path: "", sha: offMain, owned: true }, f), false);
  const d = authorityDiff("crm", { name: "crm" }, { name: "crm" }, false, undefined, { base: undefined, head: `aidenhq pinned at ${offMain.slice(0, 12)}, unreviewed: not on its main (tier declared)` });
  assert.ok(d.changes.some((c) => c.owner && /unreviewed/.test(c.what)));
  assert.equal(authorityDiff("crm", { name: "crm" }, { name: "crm" }, false, undefined, { head: `aidenhq pinned at ${onMain.slice(0, 12)}` }).changes.some((c) => c.owner), false);
});

test("a code host grant (codehost:) is the owner's to give or widen; dropping it is the reviewer's", () => {
  const grant = { read: { repos: ["acme/*"] } };
  const lines = (b, h) => authorityLines([authorityDiff("acme-crm", b, h, false)]);
  assert.deepEqual(lines(base, with_({ codehost: grant })), ["acme-crm: changes its code host grant (codehost: operations on repos as the owner) (owner)"]);
  assert.deepEqual(lines(with_({ codehost: grant }), with_({ codehost: { ...grant, comment: { repos: ["acme/*"] } } })), ["acme-crm: changes its code host grant (codehost: operations on repos as the owner) (owner)"]);
  assert.deepEqual(lines(with_({ codehost: grant }), base), ["acme-crm: drops its code host grant (review)"]);
});

test("a newly declared fact type is the reviewer's to see; stages are plain", () => {
  const head = with_({ facts: { "pr.merged": { subject: "pr" } }, stages: [{ name: "deploy", from: "pr.merged", to: "pr.deployed" }] });
  assert.deepEqual(authorityLines([authorityDiff("acme-crm", base, head, false)]), ["acme-crm: declares fact pr.merged (review)", "acme-crm: changes stages (review)"]);
  assert.equal(tier(head).tier, 1);
});

test("a code host's service mounts, a channel's transport and credentials, and kernel roles each say what they grant", () => {
  const svc = { ...base.services.run["crm-mcp"], workspaces: "/tasks", points: "/config/points.json" };
  const head = with_({ services: { run: { "crm-mcp": svc } }, roles: { requests: ["kernel.apply"] } });
  assert.deepEqual(authorityLines([authorityDiff("acme-crm", base, head, false)]), [
    "acme-crm: requests role kernel.apply (files instance applies) (owner)",
    "acme-crm: service crm-mcp: job workspaces read-write (owner)",
    "acme-crm: service crm-mcp: reads its points file (review)",
  ]);
  const ch = (channel) => with_({ providers: { channel } });
  assert.deepEqual(authorityLines([authorityDiff("acme-crm", ch({}), ch({ transport: "http://crm-mcp:8080/send", credentials: true }), false)]), [
    "acme-crm: changes provider channel (review)",
    "acme-crm: channel: the kernel sends the owner's messages and its token to http://crm-mcp:8080/send (owner)",
    "acme-crm: channel: gets the owner's credentials (account reset links) (owner)",
  ]);
});

test("a setting's writers are authority: a role added is the owner's, and kernel.settings names the keys and roles", () => {
  const s = (writers) => with_({ settings: { cr: { default: {}, ...(writers ? { writers } : {}) }, poll: { default: 60 } } });
  assert.deepEqual(authorityDiff("acme-crm", s(), s(["closer"]), false, undefined, {}, {}, true).changes, [{ what: "lets roles closer write setting cr", owner: true }]);
  assert.deepEqual(authorityDiff("acme-crm", s(["closer"]), s(["closer", "boss"]), false, undefined, {}, {}, true).changes.map((c) => c.what), ["lets roles boss write setting cr"]);
  assert.deepEqual(authorityDiff("acme-crm", s(["closer"]), s([]), false).changes, [{ what: "text only", owner: false }]);
  assert.deepEqual(authorityDiff("acme-crm", s(), with_({ settings: { cr: { default: { a: 1 } }, poll: { default: 30 } } }), false).changes, [{ what: "text only", owner: false }]);
  const ruled = with_({ settings: { cr: { default: {}, writers: ["closer"], owner: [{ path: "month_usd", raise: true }] }, poll: { default: 60 } } });
  assert.deepEqual(authorityDiff("acme-crm", ruled, s(["closer"]), false, undefined, {}, {}, true).changes.map((c) => c.what), ["changes what agents may change in setting cr without the owner"]);
  const req = { ...s(["closer"]), roles: { requests: ["kernel.settings"] } };
  assert.ok(authorityDiff("acme-crm", base, req, false).changes.some((c) => c.what === "requests role kernel.settings (files its agents' changes to the settings its module names them writers of, as reviewed applies: cr by closer)"));
});
