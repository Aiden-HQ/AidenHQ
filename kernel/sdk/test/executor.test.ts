import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { serveExecutor } from "../src/executor.ts";

const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });

test("an outcome the kernel doesn't take (a restart) is posted until it does, past any fixed number of tries", async (t) => {
  let refusals = 8;
  const got = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (refusals-- > 0) return res.writeHead(503).end("{}");
    got.push({ url: req.url, ...JSON.parse(body) });
    res.writeHead(200).end("{}");
  });
  const handle = serveExecutor({ plan: async () => ({ args: {} }), execute: async () => ({ ok: true, text: "done" }) }, { key: "k", kernelUrl: kernel.url, retryMs: 1 });
  const svc = await listen((req, res) => void handle(req, res));
  t.after(() => { kernel.s.close(); svc.s.close(); });
  const r = await fetch(`${svc.url}/aidenhq/v1/executor/execute`, { method: "POST", headers: { authorization: "Bearer k" }, body: JSON.stringify({ id: "k-0000000000000001", kind: "x.y", args: {}, digest: "d", idempotency_key: "i" }) });
  assert.deepEqual(await r.json(), { accepted: true });
  for (let i = 0; i < 200 && !got.length; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.deepEqual(got, [{ url: "/v1/writes/k-0000000000000001/outcome", ok: true, text: "done" }]);
});

test("a plan-time refusal sends its rule's stable code beside its words, and none when it has no code", async (t) => {
  // A plan that throws with a code (the platform line's rule) and one with words only: the kernel records the code on the
  // job's refusal row, so a dispatcher matches the code and never the message's prose.
  let refusal;
  const handle = serveExecutor({ plan: async () => { throw Object.assign(new Error(refusal.message), refusal.code ? { code: refusal.code } : {}); }, execute: async () => ({ ok: true, text: "done" }) }, { key: "k", kernelUrl: "http://127.0.0.1:9", retryMs: 1 });
  const svc = await listen((req, res) => void handle(req, res));
  t.after(() => svc.s.close());
  const plan = async () => (await fetch(`${svc.url}/aidenhq/v1/executor/plan`, { method: "POST", headers: { authorization: "Bearer k" }, body: JSON.stringify({ kind: "github.pr", args: {} }) })).json();
  refusal = { message: "only the platform line may open this; file it on a task the owner filed", code: "platform-only" };
  assert.deepEqual(await plan(), { error: "only the platform line may open this; file it on a task the owner filed", code: "platform-only" });
  refusal = { message: "head-moved: ask again for its new head" };
  assert.deepEqual(await plan(), { error: "head-moved: ask again for its new head" });
});
