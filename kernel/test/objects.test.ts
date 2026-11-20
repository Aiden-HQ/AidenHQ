// GitHub objects our own writes made are ours by lookup: a write outcome's refs, and a code host's fact refs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openFacts } from "../src/facts.ts";
import { openRecords } from "../src/records.ts";

const rec = () => openRecords(":memory:");

test("objects: outcome refs are ours", () => {
  const r = rec();
  r.addObjects("k-0123456789abcdef", ["github:O/r#12", "github:o/r@" + "a".repeat(40), "github:o/r#12/comment/7", "nonsense", 5]);
  assert.deepEqual([r.objectOf("github:o/r#12")?.record, r.objectOf("GITHUB:o/r#12/comment/7")?.record], ["k-0123456789abcdef", "k-0123456789abcdef"]);
  assert.equal(r.objectOf("github:o/r#13"), undefined);
  assert.equal(r.objectOf("nonsense"), undefined);
  assert.deepEqual(r.objectsSince("2000-01-01T00:00:00Z"), ["github:o/r#12"], "issues and PRs only, no comment or commit");
});

test("objects: background fact refs are ours", () => {
  const r = rec(), facts = openFacts(r.db);
  const sha = "b".repeat(40);
  facts.record({ type: "pr.merged", subject: "pr:o/r#3", version: "1", at: new Date().toISOString(), actor: "module:github", data: { objects: [`github:o/r@${sha}`, "github:o/r#3"] } });
  assert.equal(r.objectOf(`github:o/r@${sha}`)?.record, "fact:pr.merged");
  facts.record({ type: "pr.merged", subject: "pr:o/r#4", version: "1", at: new Date().toISOString(), actor: "module:slack", data: { objects: ["github:o/r#4"] } });
  assert.equal(r.objectOf("github:o/r#4"), undefined, "only a code host's facts name objects");
});
