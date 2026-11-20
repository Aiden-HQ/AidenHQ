// A module that `replaces` another carries its finished records: a stored `runner.pr` reads as `github.pr` after start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecords } from "../src/records.ts";
import { renameKinds } from "../src/kind-rename.ts";

test("records of a replaced module's kinds read under the successor's, once", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kinds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const records = openRecords(join(dir, "kernel.db"));
  const card = { sentence: "s", changes: "c", reads: "r", cost: "0", details: "d" };
  const file = (kind, state) => records.file({ kind, module: kind.split(".")[0], args: {}, targets: {}, executor: { module: kind.split(".")[0] }, policy: "p", tier: 0, panel: false, card, requester: { agent: "", key: "k", name: "n", roles: [], kind: "kernel" }, task: "t-1", state });
  file("runner.pr", "done"); file("codehost-github.merge", "done"); file("runner.gone", "done"); file("runner.pr", "review");
  const catalog = [{ name: "github", enabled: true, replaces: ["codehost-github", "runner"] }];
  assert.equal(renameKinds(records.db, catalog, { "github.pr": {}, "github.merge": {} }), 2);
  const list = records.list(["done", "review"], null, { task: "t-1" });
  assert.deepEqual(list.map((r) => [r.kind, r.module, r.state, r.executor.module]).sort(), [["github.merge", "github", "done", "github"], ["github.pr", "github", "done", "github"], ["runner.gone", "runner", "done", "runner"], ["runner.pr", "runner", "review", "runner"]], "unknown kinds and open records stay");
  assert.equal(renameKinds(records.db, catalog, { "github.pr": {}, "github.merge": {} }), 0, "idempotent");
});
