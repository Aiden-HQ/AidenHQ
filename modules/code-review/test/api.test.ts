// The service's HTTP API: POST /reviews hands the engine the asker the service verified from the kernel's caller assertion
// (main.ts's verifyCaller), as its own argument, never a field of the request body; a request without an assertion is the
// board's own and has no asker, so the owner hears the batch's summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handler } from "../service/src/api.ts";

const TOKEN = "t-1";
async function reviews(headers, body) {
  const asked = [];
  const engine = { oneoff: async (b, a) => (asked.push([b, a]), [{ id: "cr-1" }]) };
  const res = { writeHead: () => res, end: () => res };
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: "/reviews", headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
  await handler(engine, () => TOKEN, async () => false, async (r) => (r.headers["x-aidenhq-caller"] ? { requester: "Reviewer Manager", task: "WOR-42" } : undefined))(req, res);
  return asked;
}

test("POST /reviews carries the verified asker as the engine's own argument, never the body's requester or task", async () => {
  const asked = await reviews({ "x-aidenhq-caller": "sig" }, { pr_url: "https://github.com/acme/payments/pull/7", requester: "someone else", task: "WOR-1" });
  assert.equal(asked.length, 1);
  const [body, asker] = asked[0];
  assert.deepEqual(asker, { requester: "Reviewer Manager", task: "WOR-42" });
  assert.equal(body.pr_url, "https://github.com/acme/payments/pull/7");
});

test("POST /reviews with no assertion (the board's own call) has no asker: the owner hears the batch's summary", async () => {
  assert.deepEqual(await reviews({}, { pr_url: "https://github.com/acme/payments/pull/7" }), [[{ pr_url: "https://github.com/acme/payments/pull/7" }, undefined]]);
});
