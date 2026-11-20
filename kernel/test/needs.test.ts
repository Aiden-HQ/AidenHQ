// The needs_owner answer (kernel/sdk/src/vendor/needs.ts): what a connection sends when only the owner can fix it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsOwner, readNeed } from "../sdk/src/vendor/needs.ts";

test("needsOwner and readNeed round-trip", () => {
  const need = { cause: "scope" as const, scope: "repo", detail: "x" };
  const r = needsOwner(need);
  assert.equal(r.content[0].text, "x", "a client that drops structuredContent still reads a sentence");
  assert.deepEqual(readNeed(r), need);
  assert.equal(readNeed({ content: [] }), undefined);
  assert.equal(readNeed({ isError: true, structuredContent: { error: "needs_owner", need: { cause: "weird", detail: "d" } } })?.cause, "not_connected");
  assert.deepEqual(readNeed({ isError: true, structuredContent: { error: "needs_owner", need: { cause: "sso", detail: "d", org: { evil: 1 }, extra: "x" } } }), { cause: "sso", detail: "d" }, "only known string fields");
});
