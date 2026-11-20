// Module-owned points (spec §3.6, lean 4c): contributions validated against the owner's schema, compiled per owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.ts";
import { compilePoints } from "../compiler/points.ts";
import { BUNDLE } from "./bundle.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("a contribution needs requires: [owner] and must match the owner's schema; a point with no module is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "owner-"));
  mkdirSync(join(root, "schemas"));
  writeFileSync(join(root, "schemas/p.json"), JSON.stringify({ type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: "^[a-z]+$" } } }));
  const owner = { points: { p: { schema: "schemas/p.json" } } };
  const roots = { owner: root, a: root, b: root };
  assert.deepEqual(compilePoints({ owner, a: { requires: ["owner"], contributes: { "owner.p": [{ id: "x" }] } } }, roots), { owner: { p: [{ id: "x", module: "a" }] } });
  assert.throws(() => compilePoints({ owner, a: { contributes: { "owner.p": [{ id: "x" }] } } }, roots), /module a: contributes to owner\.p without requires: \[owner\]/);
  assert.throws(() => compilePoints({ owner, a: { requires: ["owner"], contributes: { "owner.p": [{ id: "X1" }] } } }, roots), /module a: contributes\.owner\.p\[0\]\.id doesn't match/);
  assert.throws(() => compilePoints({ owner, a: { requires: ["owner"], contributes: { "owner.p": [{ id: "x", sql: "drop" }] } } }, roots), /has no field sql/);
  assert.throws(() => compilePoints({ owner, a: { requires: ["owner"], contributes: { "owner.p": [{ id: "x" }] } }, b: { requires: ["owner"], contributes: { "owner.p": [{ id: "x" }] } } }, roots), /module b: .*id x is already a's/);
  assert.throws(() => compilePoints({ a: { requires: ["owner"], contributes: { "owner.p": [] } } }, roots), /which no enabled module defines/);
});
