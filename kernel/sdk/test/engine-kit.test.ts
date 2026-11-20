import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { engineKit, turn } from "../src/kit.ts";

const ECHO = join(import.meta.dirname, "../../../fixtures/engine-echo");

test("engine-echo passes the kit", async () => {
  await engineKit(ECHO);
});

test("the kit fails an engine that exits non-zero", async () => {
  await assert.rejects(engineKit(ECHO, { ECHO_FAIL: "1" }), /exit 3/);
  const r = await turn(ECHO, { kind: "echo", bin: "bin/engine" }, { env: { ECHO_FAIL: "1" } });
  assert.equal(r.code, 3);
});
