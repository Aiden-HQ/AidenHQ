// A module's data_version (spec §6.4.1): code never starts on data newer than it; the marker lives in the data dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDataVersion } from "../compiler/data-version.ts";

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
  const firstDeploy = join(dir(), "modules", "acme"); // a new module: its data dir doesn't exist yet
  checkDataVersion("acme", 0, firstDeploy);
  assert.equal(marker(firstDeploy), "0\n");
});

test("a marker that is a symlink refuses, and its target is never written", () => {
  const d = dir(), target = join(dir(), "elsewhere");
  writeFileSync(target, "keep\n");
  symlinkSync(target, join(d, ".data_version"));
  assert.throws(() => checkDataVersion("acme", 0, d), /is not a regular file/);
  assert.equal(readFileSync(target, "utf8"), "keep\n");
});

test("an apply snapshots a data module only when it is new or its data_version moves, never for a code-only change", () => {
  const d = mkdtempSync(join(tmpdir(), "gen-touched-"));
  for (const m of ["acme", "beta", "gamma", "delta"]) mkdirSync(join(d, "data/modules", m), { recursive: true });
  mkdirSync(join(d, "config")); mkdirSync(join(d, "config.next"));
  // acme: same version (its code changed: not an input). beta: version moved. gamma: new to the config. delta: dropped. omega: no data dir.
  writeFileSync(join(d, "config/module-data.json"), JSON.stringify({ acme: { data_version: 1 }, beta: { data_version: 0 }, delta: { data_version: 0 } }));
  writeFileSync(join(d, "config.next/module-data.json"), JSON.stringify({ acme: { data_version: 1 }, beta: { data_version: 1 }, gamma: { data_version: 0 }, omega: { data_version: 3 } }));
  const lib = join(dirname(fileURLToPath(import.meta.url)), "../../ops/lib/generations.sh");
  const out = execFileSync("bash", ["-c", `. "${lib}"; genTouched`], { cwd: d, env: { ...process.env, AIDENHQ_DATA_DIR: join(d, "data"), AIDENHQ_STATE_DIR: join(d, "state") }, encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n"), ["beta", "gamma"]);
});
