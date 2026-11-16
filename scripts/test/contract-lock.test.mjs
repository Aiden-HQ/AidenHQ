// The kernel's contract lock (spec §3.3.5): code, lock and the base lock must agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractLockProblems as problems, generate } from "../lean/contract-lock.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const TODAY = "2026-11-16";
const lock = (entries) => ({ version: 1, entries });
const e = (state, extra = {}) => ({ state, fp: "auth=none", ...extra });
const code = { "route GET /a": "auth=none", "route GET /b": "auth=none" };
const ok = lock({ "route GET /a": e("stable"), "route GET /b": e("experimental") });
const only = (list, re) => assert.ok(list.some((m) => re.test(m)), list.join("\n") || "no problem reported");

test("the committed lock matches the kernel's routes, schemas, manifest keys and providers", async () => {
  const head = JSON.parse(readFileSync(`${repo}kernel/contract.lock.json`, "utf8"));
  const found = problems(null, head, await generate(repo), new Date().toISOString().slice(0, 10));
  assert.deepEqual(found, [], "kernel/contract.lock.json is out of date");
});

test("a route added without a lock edit fails, with how to fix it", () => {
  only(problems(ok, ok, { ...code, "route GET /c": "auth=none" }, TODAY), /route GET \/c: in code but not in the lock.*--write/);
  assert.deepEqual(problems(ok, ok, code, TODAY), []);
});

test("an entry without a state fails", () => {
  only(problems(null, lock({ ...ok.entries, "route GET /b": { fp: "auth=none" } }), code, TODAY), /state must be one of/);
});

test("removing a stable entry fails", () => {
  const head = lock({ "route GET /b": e("experimental") });
  only(problems(ok, head, { "route GET /b": "auth=none" }, TODAY), /stable entry can't be removed/);
});

test("stable to obsolete needs remove_after at least 60 days out", () => {
  const to = (remove_after) => problems(ok, lock({ ...ok.entries, "route GET /a": e("obsolete", { remove_after }) }), code, TODAY);
  assert.deepEqual(to("2027-01-15"), []);
  only(to("2027-01-14"), /at least 2027-01-15/);
});

test("an obsolete entry is removable only after its date", () => {
  const base = lock({ ...ok.entries, "route GET /a": e("obsolete", { remove_after: "2026-12-01" }) });
  const gone = lock({ "route GET /b": e("experimental") });
  only(problems(base, gone, { "route GET /b": "auth=none" }, TODAY), /can't be removed before then/);
  assert.deepEqual(problems(base, gone, { "route GET /b": "auth=none" }, "2026-12-01"), []);
});

test("a stable schema gaining a required property fails", () => {
  const was = lock({ "schema s.json.a": { state: "stable", fp: '{"req":false}' } });
  const now = lock({ "schema s.json.a": { state: "stable", fp: '{"req":true}' } });
  only(problems(was, now, { "schema s.json.a": '{"req":true}' }, TODAY), /stable, so its shape can't change/);
});
