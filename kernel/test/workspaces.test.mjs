// The disk sweeps (workspaces.ts): a closed task's workspace and cache layers go, an open task's stay; an unused skill runtime goes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkspaceSweep, pruneSkillRuntimes } from "../src/workspaces.ts";

test("a task closed for three days loses its workspace and layers; an open one keeps them", async () => {
  const root = mkdtempSync(join(tmpdir(), "kernel-ws-"));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (task TEXT, at INTEGER, state TEXT)");
  const old = Date.now() - 5 * 86_400_000;
  const issues = { "u-done": { identifier: "WOR-1", status: "done" }, "u-open": { identifier: "WOR-2", status: "in_progress" } };
  for (const [u, i] of Object.entries(issues)) {
    db.prepare("INSERT INTO jobs VALUES (?, ?, 'done')").run(u, old);
    mkdirSync(join(root, "tasks", i.identifier), { recursive: true });
    mkdirSync(join(root, ".cache-layers", i.identifier, "0-.cache", "work", "work"), { recursive: true });
  }
  chmodSync(join(root, ".cache-layers", "WOR-1", "0-.cache", "work", "work"), 0);
  const owner = async (_m, p) => ({ status: 200, json: { ...issues[decodeURIComponent(p.split("/").pop())], updatedAt: new Date(old).toISOString() } });
  await createWorkspaceSweep({ db, owner, workDir: root })();
  assert.equal(existsSync(join(root, "tasks", "WOR-1")), false);
  assert.equal(existsSync(join(root, ".cache-layers", "WOR-1")), false);
  assert.equal(existsSync(join(root, "tasks", "WOR-2")), true);
  assert.equal(existsSync(join(root, ".cache-layers", "WOR-2")), true);
});

test("a skill runtime untouched for a week goes", () => {
  const dir = mkdtempSync(join(tmpdir(), "kernel-rt-"));
  const rt = (h) => join(dir, "c1", "codex-home", "skill-runtimes", "agent", h);
  for (const h of ["stale", "fresh"]) { mkdirSync(rt(h), { recursive: true }); writeFileSync(join(rt(h), "state_5.sqlite"), "x"); }
  const t = new Date(Date.now() - 8 * 86_400_000);
  utimesSync(join(rt("stale"), "state_5.sqlite"), t, t); utimesSync(rt("stale"), t, t);
  pruneSkillRuntimes({ companiesDir: dir });
  assert.equal(existsSync(rt("stale")), false);
  assert.equal(existsSync(rt("fresh")), true);
});
