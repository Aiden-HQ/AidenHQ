import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSignature, record } from "../src/breaker.ts";

// WOR-4755 (2026-11-14): every head failed code-review the same way, with another run id, time and commit each time.
const eacces = (run, sha) => [{ name: "code-review", lines: [`2026-11-14T16:2${run}:55.1Z Process completed with exit code 127.`, `EACCES: permission denied, mkdir '/opt/hostedtoolcache/node/22.23.5' (run ${run}00${run}, ${sha})`] }];

test("the same failure on two heads trips; another failure, or the same head again, doesn't", () => {
  const a = checkSignature(eacces(1, "89472f5de4a8"));
  const b = checkSignature(eacces(2, "9d0f6c2c391a"));
  assert.equal(a.sig, b.sig, "timestamps, run ids and commits don't make it another failure");
  assert.match(a.short, /^code-review: /);

  let r = record(undefined, a, "head-1");
  assert.equal(r.tripped, false);
  r = record(r.entry, a, "head-1");
  assert.equal(r.tripped, false, "one head read twice is one failure");
  const other = checkSignature([{ name: "tests", lines: ["✖ grades a task (2.1ms)"] }]);
  assert.notEqual(other.sig, a.sig);
  r = record(r.entry, other, "head-2");
  assert.equal(r.tripped, false, "a different failure starts over");
  r = record(r.entry, b, "head-3");
  r = record(r.entry, b, "head-4");
  assert.equal(r.tripped, true, "the same failure on two heads in a row");

  assert.equal(checkSignature([]), undefined, "nothing read is never the same failure");
});
