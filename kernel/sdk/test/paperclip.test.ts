import assert from "node:assert/strict";
import test from "node:test";
import { PaperclipError, paperclipClient } from "../src/paperclip.ts";

test("each lane routes through the kernel as its caller, and an error carries the status and body", async () => {
  const seen: { path: string; method?: string; auth: string; extra: string }[] = [];
  const fetcher: any = async (url: URL, init: { method?: string; headers: Record<string, string> }) => {
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
  const err = await paperclipClient({ ...opts, lane: "agent" }).request("GET", "/api/issues/missing?x=1").catch((e: unknown) => e) as any;
  assert.ok(err instanceof PaperclipError);
  assert.equal(err.status, 404);
  assert.deepEqual(err.body, { error: "no such task", details: 1 });
  assert.equal(err.message, "Paperclip GET /api/issues/missing → 404: no such task");
});

test("an object-shaped kernel error renders its reason, and a body without one its first 300 chars", async () => {
  const fetcher: any = async (url: URL) => {
    if (url.pathname.endsWith("/abc")) return new Response(JSON.stringify({ error: { code: 403, type: "forbidden", message: "WOR-9092 isn't yours to change" } }), { status: 403 });
    if (url.pathname.endsWith("/plain")) return new Response("<html>upstream exploded</html>", { status: 502 });
    return new Response(JSON.stringify({ error: { code: 500, message: "no type given" } }), { status: 500 });
  };
  const opts = { url: "http://kernel:3130", token: "t", lane: "agent" as const, fetcher };
  const objectErr = await paperclipClient(opts).request("PATCH", "/api/issues/abc", { status: "done" }).catch((e: unknown) => e) as any;
  assert.ok(objectErr instanceof PaperclipError);
  assert.equal(objectErr.status, 403);
  assert.equal(objectErr.message, "Paperclip PATCH /api/issues/abc → 403: forbidden: WOR-9092 isn't yours to change");
  assert.ok(!objectErr.message.includes("[object Object]"));
  assert.deepEqual(objectErr.body, { error: { code: 403, type: "forbidden", message: "WOR-9092 isn't yours to change" } });

  const untyped = await paperclipClient(opts).request("GET", "/api/issues/untyped").catch((e: unknown) => e) as any;
  assert.equal(untyped.message, "Paperclip GET /api/issues/untyped → 500: no type given");

  const plain = await paperclipClient(opts).request("GET", "/api/issues/plain").catch((e: unknown) => e) as any;
  assert.equal(plain.message, "Paperclip GET /api/issues/plain → 502: <html>upstream exploded</html>");
});
