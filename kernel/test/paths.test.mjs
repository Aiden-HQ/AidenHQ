// The path inventory (kernel/src/paths.ts, scripts/paths.mjs, paths.yaml): it gates exactly the files the product's gate
// lists gate today, every privileged module's folder at least for the reviewer, renames on both sides, and a repository write
// tiered through the kernel by the files its plan read; it fails closed and is itself protected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import YAML from "yaml";
import { pathInventory } from "../../scripts/paths.mjs";
import { authorityDiff } from "../../scripts/compiler/authority.ts";
import { pathRaise, sensitivityOf } from "../src/paths.ts";
import { GATE_CORE } from "../../modules/platform/src/check.mjs";
import { serveExecutor } from "../sdk/src/executor.ts";
import { kernel, serve } from "./helpers.mjs";

const ROOT = join(import.meta.dirname, "../..");
const inv = pathInventory(ROOT);
const product = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 << 20, encoding: "utf8" }).split("\0").filter(Boolean);
// The official modules: the product's own modules/.
const modules = readdirSync(join(ROOT, "modules"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(ROOT, join(e.parentPath, e.name))).filter((f) => !/(^|\/)(node_modules|\.git|dist)\//.test(f));

test("a privileged module's folder is at least the reviewer's, in the modules repo and at the product's modules/", () => {
  const privileged = readdirSync(join(ROOT, "modules")).filter((m) => existsSync(join(ROOT, "modules", m, "module.yaml")) && [YAML.parse(readFileSync(join(ROOT, "modules", m, "module.yaml"), "utf8")).privileged ?? []].flat().length);
  assert.ok(privileged.includes("codehost-github"), privileged.join(", "));
  for (const f of modules.filter((x) => privileged.includes(x.split("/")[1]))) {
    assert.notEqual(sensitivityOf(inv, "product", f).sensitivity, 0, f);
    assert.notEqual(sensitivityOf(inv, "modules", f.replace(/^modules\//, "")).sensitivity, 0, f);
  }
});

test("both sides of a rename count, the highest entry wins, the owner-approval records are the owner's in any repo", () => {
  assert.equal(pathRaise(inv, "product", [{ path: "docs/moved.md", from: "kernel/src/tier.ts" }]).rule, "gate-core");
  assert.equal(pathRaise(inv, "product", [{ path: "docs/a.md" }]), undefined);
  assert.equal(pathRaise(inv, "other", [{ path: ".github/supply-chain-source-exceptions.yaml" }]).tier, 2);
  assert.equal(pathRaise(inv, "product", [{ path: ".github/supply-chain-source-exceptions.yaml" }, { path: "docs/a.md" }]).tier, 2, "2 beats the panel's .github/");
  assert.equal(pathRaise(undefined, "product", [{ path: "docs/a.md" }]).rule, "gate-list-unknown", "no inventory: the owner's");
  assert.equal(pathRaise(inv, "product", undefined).rule, "unknown-files");
});

test("the inventory is protected: a lowered or removed module path, a dropped privilege or a kind that stops reading paths is the owner's", () => {
  const def = { name: "acme", paths: [{ sensitivity: "panel", patterns: ["src/gate.ts"] }], privileged: ["git-credential"], writes: { push: { floor: 0, paths: true } } };
  const owner = (head) => authorityDiff("acme", def, { ...def, ...head }, false).changes.filter((c) => c.owner).map((c) => c.what);
  assert.match(owner({ paths: [{ sensitivity: 1, patterns: ["src/gate.ts"] }] }).join(), /lowers the sensitivity of path/);
  assert.match(owner({ paths: [] }).join(), /lowers the sensitivity of path/);
  assert.match(owner({ privileged: [] }).join(), /drops privileged git-credential/);
  assert.match(owner({ writes: { push: { floor: 0 } } }).join(), /stops reading its paths/);
  assert.deepEqual(owner({ paths: [{ sensitivity: 2, patterns: ["src/gate.ts", "src/other.ts"] }] }), [], "stricter or new entries: the reviewer's");
});

test("a repository write (paths: true) is tiered by the files its plan read: the gate's core is the panel's, no file list the owner's", async (t) => {
  let planned, n = 0;
  const ex = await serve(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
  t.after(() => ex.s.close());
  const k = await kernel(t, {
    secrets: { acme_key: "acme-key" }, repos: { product: "acme/aidenhq", instance: "acme-agents/aidenhq-instance", agentsOrg: "acme-agents" }, paths: inv,
    writes: { "acme.push": { module: "acme", floor: 1, paths: true, tools: [], executor: { url: `${ex.url}/aidenhq/v1/executor`, auth_secret: "acme_key" } } },
  });
  const handler = serveExecutor({ plan: async () => ({ args: {}, ...(planned ? { paths: planned } : {}) }), execute: async () => ({ ok: true, text: "done" }) }, { key: "acme-key", kernelUrl: k.url });
  const file = async (paths) => {
    planned = paths;
    const r = await k.writes.request({ kind: "module", module: "acme", roles: [], tools: {} }, { kind: "acme.push", args: {}, task: `TASK-${++n}` }); // a task each: never the same open request
    return [r.tier, r.panel, r.rule];
  };
  assert.deepEqual(await file([{ repo: "acme-agents/app", files: [{ path: "src/a.ts" }] }]), [1, false, null]);
  assert.deepEqual(await file([{ repo: "acme/aidenhq", files: [{ path: "docs/a.md" }, { path: "kernel/src/tier.ts" }] }]), [1, true, "gate-core"]);
  assert.deepEqual(await file([{ repo: "acme-agents/app", files: [{ path: "src/a.ts" }] }, { repo: "acme/aidenhq", files: [{ path: "docs/new.md", from: "ops/setup.sh" }] }]), [1, true, "gate-core"]);
  assert.equal((await file(undefined))[0], 2, "a plan without its files: the owner's");
  assert.deepEqual(await file([{ repo: "not a repo", files: [] }]), [2, false, "unknown-repos"]);
});

test("a repository write where the product repo isn't known is the owner's, whatever its files", async (t) => {
  const ex = await serve(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
  t.after(() => ex.s.close());
  const k = await kernel(t, { secrets: { acme_key: "acme-key" }, paths: inv, writes: { "acme.push": { module: "acme", floor: 1, paths: true, tools: [], executor: { url: `${ex.url}/aidenhq/v1/executor`, auth_secret: "acme_key" } } } });
  const handler = serveExecutor({ plan: async () => ({ args: {}, paths: [{ repo: "acme/aidenhq", files: [{ path: "kernel/src/tier.ts" }] }] }), execute: async () => ({ ok: true, text: "done" }) }, { key: "acme-key", kernelUrl: k.url });
  const r = await k.writes.request({ kind: "module", module: "acme", roles: [], tools: {} }, { kind: "acme.push", args: {}, task: "TASK-1" });
  assert.deepEqual([r.tier, r.rule], [2, "unknown-repos"]);
});

test("the platform check's module gate list and the inventory's panel paths under modules/ name the same files", () => {
  const drift = modules.filter((f) => GATE_CORE.some((g) => g.test(f)) !== (sensitivityOf(inv, "product", f).sensitivity === "panel"));
  assert.deepEqual(drift, []);
});
