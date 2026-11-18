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
  // The tree comes back 100 ms into the build: the first attempt misses it and only a retry finds it.
  const swap = spawn(process.execPath, ["-e", `process.stdout.write("ready"); setTimeout(() => require("node:fs").renameSync(process.argv[1], process.argv[2]), Number(process.argv[3]))`, away, modules, "100"], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => swap.stdout.once("data", r));
  const started = Date.now();
  try {
    const state = engineState(cfg, "codex", "task-1", [lint]);
    assert.ok(Date.now() - started >= 150, "the build waited for the folder to come back");
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
