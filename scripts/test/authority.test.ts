// The authority diff (spec §5.7): every module change is the AI reviewer's first; new authority adds the owner after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { authorityDiff, diffAll, moduleInputs } from "../compiler/authority.ts";
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
const authority = (head, code = false, b = base) => authorityDiff("acme-crm", b, head, code).changes.some((c) => c.owner);

test("a new write kind, privileged entry, secret, role, write tool, services.grants or returns: trusted each are new authority", () => {
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
    "unrecognised key": with_({ hooks: ["x"] }),
    "a default grant": with_({ default_grants: [{ tools: ["crm.crm_write"] }] }),
  };
  for (const [what, v] of Object.entries(owners)) {
    const [head, b] = Array.isArray(v) ? v : [v, base];
    assert.ok(authority(head, false, b), what);
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

test("H6: a provided secret named like a model key is still only owner:true (the reviewer rejects it)", () => {
  const d = authorityDiff("acme-crm", base, with_({ secrets: { provided: [{ name: "openai_api_key" }] } }), false);
  assert.deepEqual(d.changes, [{ what: "adds secret openai_api_key", owner: true, ownerOnly: true }]);
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

