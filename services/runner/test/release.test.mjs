// The release train's decisions (src/release.mjs): one bump in flight per target, a fixed batch window from the first merge,
// a tip tried once, and instance.yaml edited in exactly its two pins.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bumpInstance, pinOf, trainDescription, trainStep } from "../src/release.mjs";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const now = "2026-11-18T10:20:00Z";
const step = (s) => trainStep({ windowMinutes: 15, now, green: true, ...s }).do;

test("a new green tip opens a bump, files it once the window from the first merge has passed, and never twice", () => {
  assert.equal(step({ tip: B, pinned: A }), "open");
  assert.equal(step({ tip: B, pinned: A, open: { since: "2026-11-18T10:10:00Z" } }), "wait", "10 minutes in: still batching");
  assert.equal(step({ tip: C, pinned: A, open: { since: "2026-11-18T10:05:00Z" } }), "file", "a later merge doesn't restart the window");
  assert.equal(step({ tip: B, pinned: A, flight: { to: B } }), "idle", "the tip in flight is not bumped twice");
  assert.equal(step({ tip: C, pinned: A, flight: { to: B } }), "open", "a later merge opens the next bump at once");
  assert.equal(step({ tip: C, pinned: A, flight: { to: B }, open: { since: "2026-11-18T09:00:00Z" } }), "wait", "which files only once the one in flight is over");
  assert.equal(step({ tip: B, pinned: A, green: false }), "open", "a merge opens its bump before CI is done");
  assert.equal(step({ tip: B, pinned: A, green: false, open: { since: "2026-11-18T09:00:00Z" } }), "wait", "and files once it passed");
});

test("a tip already tried (rejected, failed or reverted) is not tried again; a pinned one closes the open task", () => {
  assert.equal(step({ tip: B, pinned: A, lastTried: B }), "idle");
  assert.equal(step({ tip: B, pinned: A, lastTried: B, open: { since: now } }), "close");
  assert.equal(step({ tip: B, pinned: B, open: { since: now } }), "close");
  assert.equal(step({ tip: C, pinned: A, lastTried: B }), "open", "a newer merge starts the next bump");
  assert.equal(step({ tip: C, pinned: undefined }), "idle", "no plain pin (a release: instance): nothing opens");
});

test("bumpInstance moves only the product pin and the official marketplace's sha", () => {
  const text = [
    "# the instance",
    `product: ${A} # pinned`,
    "marketplaces:",
    `  - { name: aidenhq, source: { source: github, repo: acme/modules }, sha: ${A} }`,
    `  - { name: other, source: { source: github, repo: acme/other }, sha: ${A} }`,
    "modules: [core, tasks]",
    "",
  ].join("\n");
  const out = bumpInstance(text, { product: B, modules: C });
  assert.equal(out, text.replace(`product: ${A}`, `product: ${B}`).replace(`repo: acme/modules }, sha: ${A}`, `repo: acme/modules }, sha: ${C}`));
  assert.throws(() => bumpInstance("release: x\n", { product: B, modules: C }), /product: <sha>/);
});

test("a modules pin is only a full sha: anything else (a git option, say) is no pin", () => {
  assert.equal(pinOf(`{ "repo": "acme/modules", "sha": "${A}" }`), A);
  for (const bad of ["--output=/home/x/.bashrc", "HEAD", A.slice(0, 12), `${A} --stat`, 7]) assert.equal(pinOf(JSON.stringify({ sha: bad })), undefined, String(bad));
  assert.equal(pinOf("not json"), undefined);
});

test("the description names the authority the pinned manifests add, and leaves the section out when there is none", () => {
  const carries = [{ repo: "acme/modules", sha: A, subject: "(#7)" }];
  const lines = ["codehost: service codehost: unrecognised field github_app (owner)", "codehost: service codehost: adds workspace notes (owner)"];
  const describe = (authority) => trainDescription({ target: "instance", what: "Moves the pins.", carries, authority, windowMinutes: 15, marker: "m" });
  const withLines = describe({ modules: { from: A, to: B }, lines });
  assert.ok(withLines.includes(`from \`${A.slice(0, 12)}\` to \`${B.slice(0, 12)}\``), "names the modules commits the fields arrive from");
  assert.match(withLines, /this bump requests exactly these changes/);
  for (const line of lines) assert.ok(withLines.includes(`- ${line}`), line);
  assert.ok(withLines.includes(`- acme/modules \`${A}\` (#7)`), "the carried commits still list");
  for (const authority of [undefined, { modules: { from: A, to: B }, lines: [] }]) {
    const without = describe(authority);
    assert.ok(!/requests exactly these changes|adds the authority below/.test(without));
    assert.equal(without, describe(undefined), "reads as it did before");
  }
});
