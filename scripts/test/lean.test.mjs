// The lean-core ratchet (spec §9) and its checklists (§8.8, §8.9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { measure } from "../lean/count.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const json = (f) => JSON.parse(readFileSync(join(repo, "scripts/lean", f), "utf8"));
const now = measure(repo);

test("lean counters never grow", () => {
  const base = json("baseline.json");
  for (const [k, v] of Object.entries(now)) assert.ok(v <= base[k], `${k} is ${v}, above the baseline ${base[k]} (scripts/lean/baseline.json)`);
});

test("kernel and sdk ceilings", () => {
  assert.ok(now.kernel <= 9000, `kernel is ${now.kernel} lines`);
  assert.ok(now.sdk <= 400, `sdk is ${now.sdk} lines`);
});

test("checklists name real tests", () => {
  const parity = json("parity.json");
  assert.equal(parity.length, 32);
  for (const row of parity) for (const p of row.today) assert.ok(existsSync(join(repo, p)), `parity ${row.n}: ${p}`);
  for (const row of json("adversarial.json")) if (row.test !== null) assert.ok(existsSync(join(repo, row.test)), `${row.id}: ${row.test}`);
});
