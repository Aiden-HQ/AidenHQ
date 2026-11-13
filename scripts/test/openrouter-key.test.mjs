// checkKey: a good key, a rejected key (with OpenRouter's message) and an unreachable OpenRouter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkKey } from "../openrouter-key.mjs";

const reply = (status, body) => async (url, init) => {
  assert.match(String(url), /\/api\/v1\/key$/);
  assert.equal(init.headers.authorization, "Bearer sk-test");
  return new Response(JSON.stringify(body), { status });
};

test("check: 200 is ok, 401 is rejected with the message, a network error or 5xx is unreachable", async () => {
  const ok = await checkKey({ key: "sk-test", fetch: reply(200, { data: { label: "aidenhq-sam", limit_remaining: 42 } }) });
  assert.deepEqual(ok, { status: "ok", label: "aidenhq-sam", remaining: 42 });
  const bad = await checkKey({ key: "sk-test", fetch: reply(401, { error: { message: "User not found." } }) });
  assert.deepEqual(bad, { status: "rejected", message: "User not found." });
  const down = await checkKey({ key: "sk-test", fetch: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  assert.equal(down.status, "unreachable");
  assert.equal((await checkKey({ key: "sk-test", fetch: reply(503, {}) })).status, "unreachable");
});
