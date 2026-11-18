// A job's engine home carries exactly its agent's skills (one-way plan, Task 5): engineState copies the skill folders compile
// resolved (the grants table's `skills`) into <state>/skills/<name>, replacing whatever was there. Box jobs mount the same
// state folder as /codex-home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineState } from "../src/sandbox.ts";

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

test("engineState copies the agent's skills into skills/ and nothing else", () => {
  const { cfg, skill, dir } = setup();
  const lint = skill("acme", "lint", { "SKILL.md": "---\nname: lint\ndescription: Lint.\n---\n", "references/rules.md": "Rules.\n" });
  const review = skill("other", "review", { "SKILL.md": "---\nname: review\ndescription: Review.\n---\n" });
  // A link inside a skill is never followed or copied: only the module's own files reach a job.
  writeFileSync(join(dir, "secret"), "host file\n");
  symlinkSync(join(dir, "secret"), join(lint.dir, "leak"));
  const state = engineState(cfg, "codex", "task-1", [lint, review]);
  mkdirSync(join(state, "skills", "old"));
  const again = engineState(cfg, "codex", "task-1", [lint, review]);
  assert.equal(again, state);
  assert.deepEqual(readdirSync(join(state, "skills")).sort(), [".hash", "lint", "review"]); // the stale one from the last job is gone
  assert.equal(readFileSync(join(state, "skills/lint/references/rules.md"), "utf8"), "Rules.\n");
  assert.ok(!existsSync(join(state, "skills/lint/leak")));
  assert.equal(statSync(join(state, "skills/lint/SKILL.md")).mode & 0o222, 0); // read-only
  const hash = readFileSync(join(state, "skills/.hash"), "utf8");
  assert.match(hash, /^[0-9a-f]{64}\n$/);
  engineState(cfg, "codex", "task-1", [lint, review]);
  assert.equal(readFileSync(join(state, "skills/.hash"), "utf8"), hash); // stable for the same skills
  engineState(cfg, "codex", "task-1", [lint]);
  assert.deepEqual(readdirSync(join(state, "skills")).sort(), [".hash", "lint"]);
  assert.notEqual(readFileSync(join(state, "skills/.hash"), "utf8"), hash);
  // An agent with no skills (a check job): its engine home has no skills/ at all, and the job still starts.
  const none = engineState(cfg, "codex", "task-2");
  assert.ok(existsSync(none) && !existsSync(join(none, "skills")));
  engineState(cfg, "codex", "task-1"); // the agent lost its skills: the last job's are gone too
  assert.ok(!existsSync(join(state, "skills")));
  assert.deepEqual(readdirSync(cfg.stateDir).filter((f) => f.startsWith(".skills-")), []); // nothing left of the build
  assert.throws(() => engineState(cfg, "codex", "task-3", [{ id: "acme.../x", dir: lint.dir }]), /skill acme\.\.\.\/x: not a skill id/);
  assert.throws(() => engineState(cfg, "shared", undefined, [lint]), /engine shared: skills need a per-task state folder/);
});

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

test("engineState rides out an apply that swaps the skill folder away during the build", async () => {
  const { cfg, skill, dir } = setup();
  const lint = skill("acme", "lint", { "SKILL.md": "---\nname: lint\ndescription: Lint.\n---\n", "references/rules.md": "Rules.\n" });
  const modules = join(dir, "modules");
  const away = join(dir, "modules.away");
  renameSync(modules, away);
  // The tree comes back 100 ms into the build, so the first attempt misses it and only a retry finds it.
  const swap = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").renameSync(process.argv[1], process.argv[2]), Number(process.argv[3]))`, away, modules, "100"], { stdio: ["ignore", "pipe", "inherit"] });
  const started = Date.now();
  try {
    const state = engineState(cfg, "codex", "task-1", [lint]);
    assert.ok(Date.now() - started >= 100, "the build waited for the folder to come back");
    assert.match(readFileSync(join(state, "skills/lint/SKILL.md"), "utf8"), /name: lint/);
    assert.equal(readFileSync(join(state, "skills/lint/references/rules.md"), "utf8"), "Rules.\n");
    assert.match(readFileSync(join(state, "skills/.hash"), "utf8"), /^[0-9a-f]{64}\n$/);
    assert.deepEqual(readdirSync(cfg.stateDir).filter((f) => f.startsWith(".skills-")), []);
  } finally {
    swap.kill();
  }
});

test("a skill folder that is really missing still fails after the retries, naming the skill and its path", () => {
  const { cfg, skill } = setup();
  const lint = skill("acme", "lint", { "SKILL.md": "---\nname: lint\n---\n" });
  rmSync(lint.dir, { recursive: true });
  const started = Date.now();
  assert.throws(() => engineState(cfg, "codex", "task-1", [lint]), (err) => {
    assert.equal(err.code, "ENOENT");
    assert.match(err.message, /skill acme\.lint: cannot copy /);
    assert.ok(err.message.includes(lint.dir), err.message);
    return true;
  });
  assert.ok(Date.now() - started >= 1_500, "it retried for about two seconds first");
  assert.deepEqual(readdirSync(cfg.stateDir).filter((f) => f.startsWith(".skills-")), []);
});
