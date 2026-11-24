// The service's HTTP API: POST /reviews is the ship module's ask on a fork it adopted (its own token, the kernel says whose);
// any other token is refused. The summary lands on the adoption's task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handler } from "../service/src/api.ts";

test("POST /reviews with the ship module's own token: a one-off of that PR, its summary on the adoption's task; any other token is refused", async () => {
  const run = async (auth) => {
    const asked = [];
    let status = 0;
    const engine = { oneoff: async (b, a) => (asked.push([b, a]), [{ id: "cr-1" }]) };
    const res = { writeHead: (s) => ((status = s), res), end: () => res };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ pr_url: "https://github.com/acme/payments/pull/7", task: "t-9", combos: [{ engine: "x" }] }))]), { method: "POST", url: "/reviews", headers: { authorization: auth } });
    await handler(engine, async (a, module) => a === "Bearer ship-token" && module === "ship")(req, res);
    return { status, asked };
  };
  assert.deepEqual((await run("Bearer ship-token")).asked, [[{ pr_url: "https://github.com/acme/payments/pull/7" }, { requester: "Ship", task: "t-9" }]]);
  assert.deepEqual(await run("Bearer other"), { status: 401, asked: [] });
});
