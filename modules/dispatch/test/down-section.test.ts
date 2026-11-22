import { test } from "node:test";
import assert from "node:assert/strict";
import { downSection } from "../service/src/prompt.ts";

test("a down connection names its account and only that account is skipped (dfeba64b)", () => {
  const s = downSection([{ connection: "google", module: "google", cause: "expired", account: "a@x.com", since: "2026-11-22T10:00:00Z" }, { connection: "slack", module: "slack", cause: "not_connected", since: "2026-11-22T10:00:00Z" }]);
  assert.match(s, /- google \(account a@x\.com\): sign-in expired.*skip that account, the others work/);
  assert.match(s, /- slack: not connected.*skip its tools/);
});
