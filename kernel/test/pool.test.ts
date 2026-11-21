// The pool's fair share (pool.ts): agent jobs and check jobs are each guaranteed half; either borrows the other's idle boxes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, share } from "../src/pool.ts";

const tick = () => new Promise((r) => setImmediate(r));
const setup = (cap = 8) => {
  const s = { agents: 0 };
  const pool = createPool({ capacity: () => cap, agentLive: () => s.agents, sleep: () => new Promise((r) => setImmediate(r)) });
  return { s, pool };
};

test("a kind borrows the other's idle boxes, up to the whole pool", async () => {
  const a = setup();
  for (let i = 0; i < 8; i++) { assert.ok(a.pool.mayAgent(`w${i}`)); a.s.agents++; }
  assert.equal(a.pool.mayAgent("w9"), false);
  const c = setup();
  for (let i = 0; i < 8; i++) await c.pool.takeCheck();
  assert.equal(c.pool.checks(), 8);
});

test("both busy: a check over its half waits until a check ends, and an agent job can't take a freed box from a check still under its half", async () => {
  const { s, pool } = setup();
  s.agents = 4;
  for (let i = 0; i < 4; i++) await pool.takeCheck();
  pool.freeCheck(); // 3 checks, 4 agents, one box free
  let got = false;
  void pool.takeCheck().then(() => { got = true; }); // a 4th check, under its half
  assert.equal(pool.mayAgent("w1"), false, "the agent job is over its half and a check under its half is waiting");
  await tick(); await tick();
  assert.equal(got, true);
});

test("both busy: a check over its half yields a freed box to an agent job under its half", async () => {
  const { s, pool } = setup();
  s.agents = 3;
  for (let i = 0; i < 5; i++) await pool.takeCheck(); // full: 3 agents + 5 checks
  assert.equal(pool.mayAgent("w1"), false); // refused: demand
  pool.freeCheck(); // 4 checks, 3 agents, one box free
  let got = false;
  void pool.takeCheck().then(() => { got = true; }); // a 5th check, over its half
  await tick(); await tick();
  assert.equal(got, false, "it waits, never fails");
  assert.ok(pool.mayAgent("w1"));
  s.agents++; // admitted
  assert.equal(got, false);
  pool.freeCheck(); pool.freeCheck(); // two checks end: room again
  await tick(); await tick();
  assert.equal(got, true);
});

test("the share is half the pool, at least one", () => {
  assert.deepEqual([1, 4, 5, 12, 64].map(share), [1, 2, 2, 6, 32]);
});
