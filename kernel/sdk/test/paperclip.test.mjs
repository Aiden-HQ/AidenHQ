import assert from "node:assert/strict";
import test from "node:test";
import { PaperclipError, paperclipClient } from "../src/paperclip.ts";

test("each lane routes through the kernel as its caller, and an error carries the status and body", async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ path: url.pathname, method: init.method, auth: init.headers.authorization, extra: init.headers["x-extra"] });
    return url.pathname.endsWith("/missing") ? new Response(JSON.stringify({ error: "no such task", details: 1 }), { status: 404 }) : new Response('{"ok":true}');
  };
  const opts = { url: "http://kernel:3130", token: "t", fetcher, headers: () => ({ "x-extra": "1" }) };
  await paperclipClient({ ...opts, lane: "owner" }).request("GET", "/api/issues/1");
  await paperclipClient({ ...opts, lane: "owner" }).request("PATCH", "/api/issues/1", { status: "done" });
  await paperclipClient({ ...opts, lane: "agent" }).request("GET", "/api/issues/1");
  await paperclipClient({ ...opts, lane: "direct" }).request("GET", "/api/issues/1");
  assert.deepEqual(seen.map((s) => s.path), ["/v1/cp/read/api/issues/1", "/v1/cp/owner/api/issues/1", "/v1/cp/agent/api/issues/1", "/api/issues/1"]);
  assert.ok(seen.every((s) => s.auth === "Bearer t" && s.extra === "1"));
  const err = await paperclipClient({ ...opts, lane: "agent" }).request("GET", "/api/issues/missing?x=1").catch((e) => e);
  assert.ok(err instanceof PaperclipError);
  assert.equal(err.status, 404);
  assert.deepEqual(err.body, { error: "no such task", details: 1 });
  assert.equal(err.message, "Paperclip GET /api/issues/missing → 404: no such task");
});
