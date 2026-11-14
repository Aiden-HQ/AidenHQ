import { test } from "node:test";
import assert from "node:assert/strict";
import { isStalePidRefusal } from "../paperclip-recover.mjs";

const refusal = "Error: Refusing to reuse PostgreSQL: its data directory belongs to another instance.";

test("stale pid is recovered only on the exact refusal with no postgres running", () => {
  assert.equal(isStalePidRefusal(refusal, "PID ARGS\n1 tini\n"), true);
  assert.equal(isStalePidRefusal(refusal, "64 /usr/lib/postgresql/16/bin/postgres -D /paperclip"), false);
  assert.equal(isStalePidRefusal("ECONNREFUSED", ""), false);
});
