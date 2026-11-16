// App access helpers (ported from services/board/test/app-access.test.ts; routineWake's run assertions from gate-seam).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNamesApp, routineWake } from "../src/app-access.ts";
import { silent } from "./auth-helpers.mjs";

test("the owner's words name the app, by name or host, as a whole word; anything else is refused with what to ask", () => {
  assert.doesNotThrow(() => assertNamesApp("roadmap-keeper: make ann@x.com an editor", "roadmap-keeper", "roadmap.example.com"));
  assert.doesNotThrow(() => assertNamesApp("give ann@x.com member on Roadmap.Example.com", "roadmap-keeper", "roadmap.example.com"));
  assert.throws(() => assertNamesApp("make ann@x.com an editor", "roadmap-keeper", "roadmap.example.com"), /don't name roadmap-keeper/);
  assert.throws(() => assertNamesApp("roadmap-keeper-2: make ann an editor", "roadmap-keeper", "roadmap.example.com"), /don't name/);
});

test("the feedback wake runs only that app's active routine, found across companies, with only the count", async () => {
  const calls = [];
  const routines = { c1: [{ id: "r-other", title: "App feedback: wiki", status: "active" }], c2: [{ id: "r-crm-old", title: "App feedback: crm", status: "paused" }, { id: "r-crm", title: "App feedback: crm", status: "active" }, { id: "r-wiki", title: "App feedback: wiki", status: "active" }] };
  const cp = async (method, path, body) => {
    calls.push([method, path, body]);
    if (path === "/api/companies") return { status: 200, json: [{ id: "c1" }, { id: "c2" }] };
    const m = /^\/api\/companies\/(c\d)\/routines$/.exec(path);
    if (m) return { status: 200, json: routines[m[1]] };
    return { status: 200, json: {} };
  };
  assert.equal(await routineWake(cp, silent)("crm", 2), true);
  assert.deepEqual(calls.filter(([m]) => m === "POST"), [["POST", "/api/routines/r-crm/run", { source: "api", variables: { count: "2" } }]]);
  assert.ok(!JSON.stringify(calls).includes("r-wiki/run"));
  // No active routine (paused, or not applied yet): nothing to run, and nothing to retry.
  calls.length = 0;
  assert.equal(await routineWake(cp, silent)("nope", 1), true);
  assert.deepEqual(calls.filter(([m]) => m === "POST"), []);
  // A run coalesced into a live one (409) went through; any other failure is retried.
  assert.equal(await routineWake(async (m, p) => (m === "POST" ? { status: 409, json: {} } : cp(m, p)), silent)("crm", 1), true);
  await assert.rejects(routineWake(async (m, p) => (m === "POST" ? { status: 500, json: {} } : cp(m, p)), silent)("crm", 1), /routine run answered 500/);
});
