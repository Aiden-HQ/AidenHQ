import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { engineKit, turn } from "../src/kit.ts";

const ECHO = join(import.meta.dirname, "../../../fixtures/engine-echo");

test("engine-echo passes the kit", async () => {
  await engineKit(ECHO);
});
