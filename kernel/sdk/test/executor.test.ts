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
