// The gate's config reader (config-reader.ts): the compile writes gate.json in place, so a read can land mid-write. A torn
// write is tolerated for a moment; a missing or corrupt file fails closed instead of serving a policy nothing backs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfigReader } from "../config-reader.ts";

const cfgOf = (port: number) => JSON.stringify({ port, auth_url: "http://127.0.0.1:3129", identity_key_file: "/k", hosts: {} });

test("a partial in-place write keeps the last good config briefly, then the finished file replaces it", () => {
  let text = cfgOf(3130), mtime = 1, clock = 0;
  const config = createConfigReader("/gate.json", { stat: () => ({ mtimeMs: mtime }), read: () => text, now: () => clock });
  assert.equal(config().port, 3130);
  // The compile truncates the file and starts writing: a torn read at a new mtime keeps the last good config...
  text = '{"port": 3131, "auth_url": "http://127.0.0.1:31';
  mtime = 2;
  assert.equal(config().port, 3130);
  // ...and the next read of the same mtime is still the torn one: no half-written policy is ever parsed as the config.
  assert.equal(config().port, 3130);
  // The write finishes: the reader takes it without waiting out the grace.
  text = cfgOf(3131);
  assert.equal(config().port, 3131);
});

test("a torn read that never finishes fails closed after the grace, not forever on a stale policy", () => {
  let text = cfgOf(3130), mtime = 1, clock = 0;
  const config = createConfigReader("/gate.json", { stat: () => ({ mtimeMs: mtime }), read: () => text, now: () => clock, graceMs: 2000 });
  assert.equal(config().port, 3130);
  text = "";
  mtime = 2;
  assert.equal(config().port, 3130);
  clock = 1999;
  assert.equal(config().port, 3130);
  clock = 2000;
  assert.throws(() => config()); // no config to serve: the gate's request path answers 503
  // A good file later is served again.
  text = cfgOf(3132);
  assert.equal(config().port, 3132);
});

test("a missing file throws (an apply that removed settings.edge removes gate.json), even after a good read", () => {
  let present = true, mtime = 1, clock = 0;
  const config = createConfigReader("/gate.json", {
    stat: () => { if (!present) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return { mtimeMs: mtime }; },
    read: () => cfgOf(3130), now: () => clock,
  });
  assert.equal(config().port, 3130);
  present = false;
  clock = 10;
  assert.throws(() => config(), /ENOENT/);
  // A corrupt file is not a torn write either once the grace passes... and not a torn write at all before a first good read.
  const fresh = createConfigReader("/gate.json", { stat: () => ({ mtimeMs: 1 }), read: () => "{", now: () => 0 });
  assert.throws(() => fresh());
});

test("a corrupt file that stays corrupt fails closed rather than serving the last good policy", () => {
  let text = cfgOf(3130), mtime = 1, clock = 0;
  const config = createConfigReader("/gate.json", { stat: () => ({ mtimeMs: mtime }), read: () => text, now: () => clock, graceMs: 1000 });
  assert.equal(config().port, 3130);
  text = "not json";
  mtime = 2;
  assert.equal(config().port, 3130); // the first torn read starts the grace
  clock = 1000;
  assert.throws(() => config());
  assert.throws(() => config()); // it stays closed; a good file is what opens it again
});
