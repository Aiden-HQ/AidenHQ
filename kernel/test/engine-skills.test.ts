// A job's engine home carries exactly its agent's skills (one-way plan, Task 5): engineState copies the skill folders compile
// resolved (the grants table's `skills`) into <state>/skills/<name>, replacing whatever was there. Box jobs mount the same
// state folder as /codex-home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { engineState, ensureStateDirs } from "../src/sandbox.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "k-skills-"));
  writeFileSync(join(dir, "engines.json"), JSON.stringify({ codex: { module: "test", kind: "codex", dir, bin: "bin/engine", state: "task" }, shared: { module: "test", kind: "shared", dir, bin: "bin/engine", state: "shared" } }));
  const skill = (module, name, files) => {
    const d = join(dir, "modules", module, "skills", name);
    mkdirSync(d, { recursive: true });
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(d, f, ".."), { recursive: true });
      writeFileSync(join(d, f), text);
    }
    return { id: `${module}.${name}`, dir: d };
  };
  return { cfg: { enginesFile: join(dir, "engines.json"), stateDir: join(dir, "state") }, skill, dir };
}

test("a skills/ link a previous job planted in its state folder is removed, never written through", () => {
  const { cfg, skill, dir } = setup();
  const lint = skill("acme", "lint", { "SKILL.md": "---\nname: lint\ndescription: Lint.\n---\n" });
  const state = engineState(cfg, "codex", "task-1");
  const outside = join(dir, "outside");
  mkdirSync(join(outside, "lint"), { recursive: true });
  writeFileSync(join(outside, "lint", "SKILL.md"), "host file\n");
  symlinkSync(outside, join(state, "skills"));
  engineState(cfg, "codex", "task-1", [lint]);
  assert.ok(!lstatSync(join(state, "skills")).isSymbolicLink());
  assert.match(readFileSync(join(state, "skills/lint/SKILL.md"), "utf8"), /name: lint/);
  assert.deepEqual(readdirSync(outside), ["lint"]); // nothing outside changed
  assert.equal(readFileSync(join(outside, "lint", "SKILL.md"), "utf8"), "host file\n");
  assert.notEqual(statSync(join(outside, "lint", "SKILL.md")).mode & 0o222, 0);
});

test("a removed state root is recreated 0700, and its logs with it, before the job's own folder", () => {
  const { cfg, dir } = setup();
  const root = join(dir, "state");
  const state = engineState(cfg, "codex", "task-1");
  // A disk reclaim removes the root between runs: the next launch heals it rather than failing with EACCES.
  rmSync(root, { recursive: true, force: true });
  const again = engineState(cfg, "codex", "task-1");
  assert.equal(again, state);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, "logs")).mode & 0o777, 0o700);
  assert.equal(statSync(again).mode & 0o777, 0o700);
  const { logs } = ensureStateDirs(root);
  assert.equal(logs, join(root, "logs"));
  assert.equal(statSync(logs).mode & 0o777, 0o700);
  // A mode the umask narrowed (or a hand-made root) is healed, not left world-readable.
  chmodSync(root, 0o755);
  ensureStateDirs(root);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(logs).mode & 0o777, 0o700);
});

test("an unusable state root throws once, naming the absolute path, its owner/mode and the kernel's uid, and reports one need", () => {
  const { cfg, dir } = setup();
  const root = join(dir, "state");
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o555); // present but not writable: what a reclaim left, or another user's directory
  const needs: string[] = [];
  try {
    assert.throws(() => engineState(cfg, "codex", "task-1", [], (e, episode) => needs.push(`${episode}\n${e.message}`)), (e: Error) => {
      assert.match(e.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(e.message, /mode 0555/, "the mode found is named");
      assert.match(e.message, /owner uid=\d+ gid=\d+/, "the owner found is named");
      if (typeof process.getuid === "function") assert.match(e.message, new RegExp(`kernel runs as uid=${process.getuid()}`));
      return true;
    });
    // Every job on the episode fails, but the owner is told once: the same failure again is the same need.
    assert.throws(() => engineState(cfg, "codex", "task-2", [], (e, episode) => needs.push(`${episode}\n${e.message}`)));
    assert.equal(needs.length, 1);
    assert.match(needs[0]!, /runner state directory/);
    // Healed, the episode clears: a later break is a new need with its own key, so the owner channel (which drops a repeated
    // alert key within the hour) can't mistake it for the first outage's duplicate.
    chmodSync(root, 0o700);
    ensureStateDirs(root, (e, episode) => needs.push(`${episode}\n${e.message}`));
    chmodSync(root, 0o555);
    assert.throws(() => engineState(cfg, "codex", "task-3", [], (e, episode) => needs.push(`${episode}\n${e.message}`)));
    assert.equal(needs.length, 2);
    const [first, second] = needs.map((n) => n.split("\n")[0]!);
    assert.ok(first.startsWith(`${root}:`), `the alert key names the root: ${first}`);
    assert.notEqual(first, second);

    // A report that couldn't be queued (the notice store busy) is not an episode: the next job tells the owner.
    chmodSync(root, 0o700);
    ensureStateDirs(root);
    chmodSync(root, 0o555);
    const told: string[] = [];
    assert.throws(() => engineState(cfg, "codex", "task-4", [], () => { throw new Error("notice store busy"); }));
    assert.throws(() => engineState(cfg, "codex", "task-5", [], (e) => told.push(e.message)));
    assert.equal(told.length, 1);
  } finally {
    chmodSync(root, 0o700);
  }
});

test("a symlinked state root, or a symlinked ancestor of it, is refused and never followed", () => {
  const { cfg, dir } = setup();
  const outside = join(dir, "outside");
  mkdirSync(join(outside, "state"), { recursive: true });
  symlinkSync(outside, join(dir, "state"));
  assert.throws(() => engineState(cfg, "codex", "task-1"), /symlink, which is never followed/);
  assert.deepEqual(readdirSync(join(outside, "state")), []);

  // A symlinked parent must not have its target chmod'ed: the root inside it keeps the mode it had.
  const tree = join(dir, "tree");
  mkdirSync(join(tree, "state"), { recursive: true });
  chmodSync(join(tree, "state"), 0o755);
  symlinkSync(tree, join(dir, "linked"));
  assert.throws(() => ensureStateDirs(join(dir, "linked", "state")), /ancestor .* is a symlink, which is never followed/);
  assert.equal(statSync(join(tree, "state")).mode & 0o777, 0o755);
});

test("a relative state root keeps its form for the launcher's exact path comparison", () => {
  const { dir } = setup();
  const engines = join(dir, "engines.json");
  const back = relative(process.cwd(), join(dir, "state"));
  const { root, logs } = ensureStateDirs(back);
  assert.equal(root, back);
  assert.equal(logs, join(back, "logs"));
  const dirPath = engineState({ enginesFile: engines, stateDir: back }, "codex", "task-1");
  assert.equal(dirPath, join(back, "codex", "task-1"));
  assert.ok(statSync(dirPath!).isDirectory());
});
