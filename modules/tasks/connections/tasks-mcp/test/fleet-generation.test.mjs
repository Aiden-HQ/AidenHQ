// fleet_generation_status: the board's apply generations, read through its internal API as the caller (so the board can
// check the caller's own paperclip_tasks grant), and a failure the board reports is an error, never an empty history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.mjs";

const generations = {
  pin: "b".repeat(40),
  generations: [{ n: 7, at: "2026-11-18T00:00:00Z", product: "b".repeat(40), health: "good", reason: null, log: "/state/apply-7.log", revert_of: null }],
};
// The fake Paperclip: only the agent's own profile, so the caller resolves.
const handler = (req, res) => {
  req.on("data", () => {});
  req.on("end", () => res.setHeader("content-type", "application/json").end(JSON.stringify({ id: "me", companyId: "co" })));
};

test("fleet_generation_status reads the board's generations route and passes its answer through", async () => {
  const seen = [];
  const board = (req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, caller: req.headers["x-aidenhq-caller"] });
      res.setHeader("content-type", "application/json").end(JSON.stringify(generations));
    });
  };
  const r = await bridge({ handler, board, agents: { me: { key: "maintainer", roles: ["maintainer"] } } }).call("fleet_generation_status", {});
  assert.equal(r.result.isError, undefined, r.result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(r.result.content[0].text), generations);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/internal/fleet/generation_status");
  assert.equal(seen[0].method, "POST");
  assert.ok(seen[0].caller, "the caller assertion goes with the call: the board checks the grant itself");
});

test("fleet_generation_status surfaces the board's refusal instead of returning nothing", async () => {
  const board = (req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json").end(JSON.stringify({ error: "only an agent granted fleet_generation_status may call this" }));
    });
  };
  const r = await bridge({ handler, board, agents: { me: { key: "maintainer" } } }).call("fleet_generation_status", {});
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /granted fleet_generation_status/);
});
