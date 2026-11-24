// Deploy facts (generations.ts): a merged PR is deployed at the first good generation whose commit contains it, found with git off
// the event loop, and a rewrite of the generations file records only its new lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeploys } from "../src/generations.ts";
import { openFacts } from "../src/facts.ts";
import { CODEHOST } from "../src/codehost.ts";

test("a merged PR is deployed at the first good generation containing it, once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  git("commit", "-q", "--allow-empty", "-m", "a");
  const a = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "b");
  const b = git("rev-parse", "HEAD");
  const db = new DatabaseSync(":memory:");
  const facts = openFacts(db);
  const t0 = Date.now();
  facts.record({ type: "pr.merged", subject: "pr:o/r#1", version: `${CODEHOST}/1`, at: new Date(t0 - 1000).toISOString(), actor: "kernel", data: { sha: b } });
  const file = join(dir, "generations.jsonl");
  const line = (n: number, product: string) => JSON.stringify({ n, at: new Date(t0 + n).toISOString(), product, health: "good" }) + "\n";
  writeFileSync(file, line(1, a)); // the generation before the merge's commit: not it
  const deploys = createDeploys({ db, file, repo: dir });
  assert.equal(await deploys(), 1); // deploy.applied 1
  assert.equal(db.prepare("SELECT count(*) AS n FROM facts WHERE type = 'pr.deployed'").get()!.n, 0);
  appendFileSync(file, line(2, b));
  assert.equal(await deploys(), 2); // deploy.applied 2 (generation 1 not written again) and pr.deployed
  const d = db.prepare("SELECT at, json_extract(data, '$.generation') AS g FROM facts WHERE type = 'pr.deployed'").all() as { g: number }[];
  assert.deepEqual(d.map((r) => r.g), [2]);
  assert.equal(await deploys(), 0);
});
