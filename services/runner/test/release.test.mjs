// The release train's decisions (src/release.mjs): one bump in flight per target, a fixed batch window from the first merge,
// a tip tried once, and instance.yaml edited in exactly its two pins.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bumpInstance, pinOf, trainStep } from "../src/release.mjs";

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

test("a second modules pin bump replaces the standing branch (and so adopts its open PR) rather than opening another", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { MODULES_PIN_BRANCH, standOnRemote } = await import("../src/release.mjs");
  const dir = mkdtempSync(join(tmpdir(), "pin-"));
  const sh = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();
  const git = async (cwd, ...a) => sh(cwd, ...a);
  const remote = join(dir, "origin.git");
  sh(dir, "init", "--quiet", "--bare", "-b", "main", remote);
  const seed = join(dir, "seed");
  sh(dir, "clone", "--quiet", remote, seed);
  writeFileSync(join(seed, "modules-pin.json"), `{"sha":"${A}"}\n`);
  sh(seed, "add", "."); sh(seed, "commit", "--quiet", "-m", "main"); sh(seed, "push", "--quiet", "origin", "HEAD:main");
  // One bump, as a task's own clone makes and publishes it.
  const bump = (name, sha) => {
    const c = join(dir, name);
    sh(dir, "clone", "--quiet", remote, c);
    return { c, commit: async () => {
      const wasOnRemote = await standOnRemote(git, c, MODULES_PIN_BRANCH);
      sh(c, "checkout", "--quiet", "-B", MODULES_PIN_BRANCH, wasOnRemote ? `origin/${MODULES_PIN_BRANCH}` : "origin/main");
      sh(c, "reset", "--quiet", "--soft", "origin/main");
      writeFileSync(join(c, "modules-pin.json"), `{"sha":"${sha}"}\n`);
      sh(c, "commit", "--quiet", "-am", `pin ${sha[0]}`);
      return { wasOnRemote, head: sh(c, "rev-parse", "HEAD") };
    } };
  };
  const first = bump("first", B);
  const one = await first.commit();
  assert.equal(one.wasOnRemote, false, "the first bump finds no standing branch");
  sh(first.c, "push", "--quiet", "origin", `${MODULES_PIN_BRANCH}:${MODULES_PIN_BRANCH}`);
  const second = bump("second", C);
  const two = await second.commit();
  assert.equal(two.wasOnRemote, true, "the next bump starts from the standing branch");
  const remoteTip = sh(second.c, "rev-parse", `origin/${MODULES_PIN_BRANCH}`);
  assert.equal(remoteTip, one.head);
  assert.notEqual(two.head, one.head, "a fresh commit: the head the card, CI and the eval receipt bind to changes");
  assert.ok(sh(second.c, "reflog", "show", "--format=%H", `refs/heads/${MODULES_PIN_BRANCH}`).split("\n").includes(remoteTip), "publish's lease may replace GitHub's tip");
  sh(second.c, "push", "--quiet", `--force-with-lease=refs/heads/${MODULES_PIN_BRANCH}:${remoteTip}`, "origin", `${MODULES_PIN_BRANCH}:${MODULES_PIN_BRANCH}`);
  assert.equal(sh(dir, "--git-dir", remote, "rev-parse", MODULES_PIN_BRANCH), two.head);
  assert.equal(sh(dir, "--git-dir", remote, "branch", "--list").split("\n").filter((l) => /modules-pin/.test(l)).length, 1, "one branch, so one PR");
});
