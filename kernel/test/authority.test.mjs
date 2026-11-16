// The authority diff (spec §5.7): every module change is the AI reviewer's first; new authority adds the owner after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorityDiff, authorityLines, classifyModules, diffAll, moduleInputs } from "../src/loader/authority.ts";

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

test("H6: a provided secret named like a model key is still only owner:true (the reviewer rejects it)", () => {
  const d = authorityDiff("acme-crm", base, with_({ secrets: { provided: [{ name: "openai_api_key" }] } }), false);
  assert.deepEqual(d.changes, [{ what: "adds secret openai_api_key", owner: true }]);
});

test("a removed module is the reviewer's, unless it carried enforcement", () => {
  assert.equal(tier(undefined).tier, 1);
  assert.equal(tier(undefined, false, with_({ checks: [{ id: "x" }] })).tier, 2);
});

test("B replacing A with equal authority has an empty diff; B adding a secret is owner:true", () => {
  const a = { name: "chan-a", generated_secrets: ["chan_a_service_key"], connections: { "chan-a": { url: "http://a:1/mcp", auth: "chan_a_service_key", tools: { read: ["r"], write: ["post"] } } }, writes: { "chan-a.post": { floor: 1 } } };
  const b = { name: "chan-b", replaces: ["chan-a"], generated_secrets: ["chan_b_service_key"], connections: { "chan-b": { url: "http://b:1/mcp", auth: "chan_b_service_key", tools: { read: ["r"], write: ["post"] } } }, writes: { "chan-b.post": { floor: 1 } } };
  const inputs = moduleInputs({ baseInstance: { modules: ["chan-a"] }, headInstance: { modules: ["chan-b"] }, baseDefs: { "chan-a": a, "chan-b": b }, headDefs: { "chan-a": a, "chan-b": b }, changed: [] });
  assert.deepEqual(Object.keys(inputs), ["chan-b"]);
  const same = diffAll(inputs);
  assert.equal(classifyModules(same).tier, 1);
  assert.deepEqual(same[0].changes.filter((c) => c.owner), []);
  const more = authorityDiff("chan-b", undefined, { ...b, generated_secrets: [...b.generated_secrets, "chan_b_extra"] }, false, { name: "chan-a", def: a });
  assert.deepEqual(more.changes.filter((c) => c.owner).map((c) => c.what), ["adds secret chan_b_extra"]);
  // `replaces` counts only when this change removes A: with A staying, B is a plain install, diffed against nothing.
  const kept = moduleInputs({ baseInstance: { modules: ["chan-a"] }, headInstance: { modules: ["chan-a", "chan-b"] }, baseDefs: { "chan-a": a, "chan-b": b }, headDefs: { "chan-a": a, "chan-b": b }, changed: [] });
  assert.equal(kept["chan-b"].replacing, undefined);
  assert.equal(classifyModules(diffAll(kept)).tier, 2);
});

test("the CLI prints one line per change between two commits", () => {
  const repo = mkdtempSync(join(tmpdir(), "auth-cli-"));
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  mkdirSync(join(repo, "modules/acme-crm"), { recursive: true });
  writeFileSync(join(repo, "modules/acme-crm/module.yaml"), "name: acme-crm\n");
  g("add", "-A");
  g("commit", "-qm", "a");
  const a = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "modules/acme-crm/module.yaml"), "name: acme-crm\nwrites:\n  publish: { floor: 1 }\n");
  writeFileSync(join(repo, "modules/acme-crm/main.ts"), "export {};\n");
  g("add", "-A");
  g("commit", "-qm", "b");
  const b = g("rev-parse", "HEAD");
  const cli = join(import.meta.dirname, "../src/loader/authority-cli.ts");
  const run = (...args) => execFileSync("node", [cli, ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, AIDENHQ_PRODUCT_DIR: repo, AIDENHQ_INSTANCE_DIR: "" } });
  assert.deepEqual(run(a, b).trim().split("\n"), ["apply authority: acme-crm: adds write kind publish (owner)", "apply authority: acme-crm: code changes (review)"]);
  assert.equal(run(a, a).trim(), "apply authority: none");
  // A commit it can't read, or anything but a full sha: refused (exit 2), never guessed.
  assert.throws(() => run(a, "f".repeat(40)), (e) => e.status === 2);
  assert.throws(() => run("HEAD", b), (e) => e.status === 2);
});
