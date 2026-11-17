// kernel/src/front-door.ts: the owner hears about a public certificate that is lapsing or failing, at most every 12 hours.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCertWatch } from "../src/front-door.ts";

test("cert watch: quiet while 48+ hours are left or exposure isn't public; a lapsing or failing certificate tells the owner, at most every 12 hours", async () => {
  const H = 3_600_000, lines = [];
  let now = 0, ip = "203.0.113.7", cert = { validTo: 100 * H }, probed = 0;
  const w = createCertWatch({ ip: () => ip, notify: (l) => lines.push(l), now: () => now, probe: async () => (probed++, cert) });
  await w.tick();
  assert.deepEqual(lines, []);
  cert = { validTo: 20 * H };
  await w.tick();
  assert.match(lines[0], /https:\/\/203\.0\.113\.7 expires in 20 hours/);
  now = 11 * H; cert = { error: "certificate has expired" };
  await w.tick();
  assert.equal(lines.length, 1); // within 12 hours of the last notice
  now = 13 * H;
  await w.tick();
  assert.match(lines[1], /fails to verify \(certificate has expired\)/);
  ip = undefined; probed = 0; now = 40 * H;
  await w.tick();
  assert.deepEqual([probed, lines.length], [0, 2]);
});
