// A module's data_version (spec §6.4.1): code never starts on data newer than it; the marker lives in the data dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDataVersion } from "../src/loader/data-version.ts";

const dir = (marker) => { const d = mkdtempSync(join(tmpdir(), "data-version-")); if (marker !== undefined) writeFileSync(join(d, ".data_version"), `${marker}\n`); return d; };
const marker = (d) => readFileSync(join(d, ".data_version"), "utf8");

test("A15: declared 1, marker 2 refuses and leaves the marker", () => {
  const d = dir(2);
  assert.throws(() => checkDataVersion("acme", 1, d), /^Error: acme: data_version 1 is older than its data \(2\)$/);
  assert.equal(marker(d), "2\n");
});

test("declared 2, marker 1 writes 2 and starts; a staged check writes nothing", () => {
  const d = dir(1);
  checkDataVersion("acme", 2, d, false);
  assert.equal(marker(d), "1\n");
  checkDataVersion("acme", 2, d);
  assert.equal(marker(d), "2\n");
  const fresh = dir();
  checkDataVersion("acme", 0, fresh);
  assert.equal(marker(fresh), "0\n");
});

test("a marker that is a symlink refuses, and its target is never written", () => {
  const d = dir(), target = join(dir(), "elsewhere");
  writeFileSync(target, "keep\n");
  symlinkSync(target, join(d, ".data_version"));
  assert.throws(() => checkDataVersion("acme", 0, d), /is not a regular file/);
  assert.equal(readFileSync(target, "utf8"), "keep\n");
});
