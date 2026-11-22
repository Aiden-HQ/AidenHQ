// The kernel's contract lock (spec §3.3.5): code, lock and the base lock must agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractLockProblems as problems, generate } from "../lean/contract-lock.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));

test("the committed lock matches the kernel's routes, schemas, manifest keys and providers", async () => {
  const head = JSON.parse(readFileSync(`${repo}kernel/contract.lock.json`, "utf8"));
  const found = problems(null, head, await generate(repo), new Date().toISOString().slice(0, 10));
  assert.deepEqual(found, [], "kernel/contract.lock.json is out of date");
});
