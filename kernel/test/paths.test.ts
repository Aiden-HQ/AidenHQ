// The path inventory (kernel/src/paths.ts, scripts/paths.ts, paths.yaml): it gates exactly the files the product's gate
// lists gate, every privileged module's folder at least for the reviewer, renames on both sides, and a repository write
// tiered through the kernel by the files its plan read; it fails closed and is itself protected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathInventory } from "../../scripts/paths.ts";
import { authorityDiff } from "../../scripts/compiler/authority.ts";
import { globRe } from "../src/paths.ts";
import { serveExecutor } from "../sdk/src/executor.ts";
import { kernel, serve } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../..");
const inv = pathInventory(ROOT);
const product = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 << 20, encoding: "utf8" }).split("\0").filter(Boolean);

test("the inventory is protected: a lowered or removed module path, a dropped privilege or a kind that stops reading paths is the owner's", () => {
  const def = { name: "acme", paths: [{ sensitivity: 2, patterns: ["src/gate.ts"] }], privileged: ["git-credential"], writes: { push: { floor: 0, paths: true } } };
  const owner = (head) => authorityDiff("acme", def, { ...def, ...head }, false).changes.filter((c) => c.owner).map((c) => c.what);
  assert.match(owner({ paths: [{ sensitivity: 1, patterns: ["src/gate.ts"] }] }).join(), /lowers the sensitivity of path/);
  assert.match(owner({ paths: [] }).join(), /lowers the sensitivity of path/);
  assert.match(owner({ privileged: [] }).join(), /drops privileged git-credential/);
  assert.match(owner({ writes: { push: { floor: 0 } } }).join(), /stops reading its paths/);
  assert.deepEqual(owner({ paths: [{ sensitivity: 2, patterns: ["src/gate.ts", "src/other.ts"] }] }), [], "stricter or new entries: the reviewer's");
});

test("a repository write (paths: true) is tiered by the files its plan read: the gate's core and an unknown file list are the reviewer's", async (t) => {
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
    return [r.tier, r.rule];
  };
  assert.deepEqual(await file([{ repo: "acme-agents/app", files: [{ path: "src/a.ts" }] }]), [1, null]);
  assert.deepEqual(await file([{ repo: "acme/aidenhq", files: [{ path: "docs/a.md" }, { path: "kernel/src/tier.ts" }] }]), [1, "reviewed-path"]);
  assert.deepEqual(await file([{ repo: "acme-agents/app", files: [{ path: "src/a.ts" }] }, { repo: "acme/aidenhq", files: [{ path: "docs/new.md", from: "ops/setup.sh" }] }]), [1, "reviewed-path"]);
  assert.deepEqual(await file(undefined), [1, "unknown-files"], "a plan without its files: the reviewer's");
  assert.deepEqual(await file([{ repo: "not a repo", files: [] }]), [1, "unknown-repos"]);
});

test("every product entry of the inventory names a file, so a moved gate file shows up as a dead entry", () => {
  const dead = inv.entries.filter((e) => e.repo !== "modules" && !product.some((f) => globRe(e.pattern).test(f))).map((e) => `${e.source}: ${e.pattern}`);
  assert.deepEqual(dead, []);
});
