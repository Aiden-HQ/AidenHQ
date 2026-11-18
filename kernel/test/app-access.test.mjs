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
