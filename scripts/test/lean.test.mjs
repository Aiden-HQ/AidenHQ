// The lean-core checklists (§8.8, §8.9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const json = (f) => JSON.parse(readFileSync(join(repo, "scripts/lean", f), "utf8"));

test("checklists name real tests", () => {
  const parity = json("parity.json");
  assert.equal(parity.length, 32);
  for (const row of parity) for (const p of row.today) assert.ok(existsSync(join(repo, p)), `parity ${row.n}: ${p}`);
  for (const row of json("adversarial.json")) if (row.test !== null) assert.ok(existsSync(join(repo, row.test)), `${row.id}: ${row.test}`);
});
