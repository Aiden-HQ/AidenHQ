import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bumpTitle, definitionsOf, strayFiles, trialHandbookOnly, untrialedNewAgents } from "../src/apply.ts";

test("only instance config can be applied", () => {
  assert.deepEqual(strayFiles(["instance.yaml", "apps.yaml", "agents/chief-of-staff.md", "agents/review-chaser/agent.yaml", "agents/review-chaser/AGENTS.md"]), []);
  assert.deepEqual(strayFiles(["agents/x/run.sh", "agents/X/agent.yaml", "agents/x/y/AGENTS.md"]), ["agents/x/run.sh", "agents/X/agent.yaml", "agents/x/y/AGENTS.md"]);
  assert.deepEqual(strayFiles(["instance.yaml", "ops/apply-config.sh", "config/paperclip.example.yaml", "agents/x/evil.md"]), ["ops/apply-config.sh", "config/paperclip.example.yaml", "agents/x/evil.md"]);
});
test("a product pin move is described honestly", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  assert.equal(bumpTitle({ to: b }), "Product pinned at `bbbbbbbbb`");
  assert.equal(bumpTitle({ from: a, to: b, forward: true }), "Product upgrade `aaaaaaaaa` → `bbbbbbbbb`, adding these commits");
  assert.equal(bumpTitle({ from: a, to: b, forward: false, back: true }), "Product DOWNGRADE (rollback) `aaaaaaaaa` → `bbbbbbbbb`, removing these commits");
  assert.equal(bumpTitle({ from: a, to: b, forward: false, back: false }), undefined); // diverged: refused
});
test("apply-config reads the pin with the same parser (CLI), in every form YAML allows", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const sha = "c".repeat(40);
  for (const line of [`product: ${sha}`, `product: "${sha}"`, `product: '${sha}'  # pinned`]) {
    const f = join(mkdtempSync(join(tmpdir(), "pin-")), "instance.yaml");
    writeFileSync(f, `${line}\nmodules: []\n`);
    assert.equal(execFileSync("node", [new URL("../src/apply.ts", import.meta.url).pathname, "product-pin", f], { encoding: "utf8" }), sha);
  }
});
test("paused Engineers are not assignment targets", async () => {
  const { Paperclip } = await import("../src/paperclip.ts");
  const pc = Object.create(Paperclip.prototype);
  pc.agents = async () => [{ status: "paused", metadata: { setupKey: "aidenhq:engineer" } }, { status: "idle", metadata: { setupKey: "aidenhq:engineer-openrouter" } }];
  assert.deepEqual((await pc.engineerAgents()).map((a) => a.metadata.setupKey), ["aidenhq:engineer-openrouter"]);
});

// The worked case: the role template as the Architect's design, through tap 1, a trial edit and tap 2.
const trialYaml = readFileSync(new URL("../../../modules/agent-builder/templates/pr-review-chaser/agent.yaml", import.meta.url), "utf8");
const graduated = trialYaml.replace(/^trial: true\n/m, "").replace("reports_to: architect", "reports_to: chief-of-staff");
const def = "agents/review-chaser/agent.yaml", book = "agents/review-chaser/AGENTS.md";
test("tap 1: a new agent must start in trial", () => {
  assert.deepEqual(definitionsOf([def, book, "instance.yaml"]), [def]);
  assert.deepEqual(untrialedNewAgents([def, book], {}, { [def]: trialYaml }), []);
  assert.deepEqual(untrialedNewAgents([def, book], {}, { [def]: graduated }), ["review-chaser"]);
  assert.deepEqual(untrialedNewAgents([def], { [def]: trialYaml }, { [def]: graduated }), [], "tap 2 changes an existing agent: a card, allowed");
});
test("the trial exception: only handbook edits to agents in trial (on main) land without a tap", () => {
  assert.equal(trialHandbookOnly([book], { [def]: trialYaml }), true);
  assert.equal(trialHandbookOnly([book], { [def]: graduated }), false, "on its own: every change is a card");
  assert.equal(trialHandbookOnly([book], {}), false, "a new agent (not on main yet): tap 1");
  assert.equal(trialHandbookOnly([book, def], { [def]: trialYaml }), false, "its definition changes too: a card");
  assert.equal(trialHandbookOnly([book, "instance.yaml"], { [def]: trialYaml }), false);
  assert.equal(trialHandbookOnly(["agents/review-chaser.md"], { [def]: trialYaml }), false);
  assert.equal(trialHandbookOnly([], {}), false);
});
test("the no-tap path is only for tasks the owner or the Architect (by the grants table's role) started", async () => {
  const { trialNoTapBy } = await import("../src/apply.ts");
  const grants = { agents: { arch: { key: "architect", roles: ["architect"] }, cos: { key: "chief-of-staff", roles: ["fleet-admin"] } } };
  assert.equal(trialNoTapBy({ createdByUserId: "u1", createdByAgentId: null }, grants), true);
  assert.equal(trialNoTapBy({ createdByUserId: null, createdByAgentId: "arch" }, grants), true);
  assert.equal(trialNoTapBy({ createdByUserId: null, createdByAgentId: "cos" }, grants), false, "another agent's task (and its follow-ups): a card");
  assert.equal(trialNoTapBy({ createdByUserId: null, createdByAgentId: "arch" }, undefined), false, "no grants table: fail closed");
  assert.equal(trialNoTapBy({}, grants), false);
  // A task the runner filed with the board key (a Dependabot PR's) names the owner as creator, but is never theirs.
  assert.equal(trialNoTapBy({ createdByUserId: "u1", createdByAgentId: null }, grants, true), false, "runner-made: a card");
});
test("only the Architect's follow-ups on a task it created count as a request (review rounds with the Fleet Engineer)", async () => {
  const { architectFollowUps } = await import("../src/apply.ts");
  const grants = { agents: { arch: { roles: ["architect"] }, cos: { roles: ["fleet-admin"] } } };
  const notes = [{ id: "1", authorAgentId: "arch" }, { id: "2", authorAgentId: "cos" }];
  assert.deepEqual(architectFollowUps(notes, "arch", grants).map((c) => c.id), ["1"]);
  assert.deepEqual(architectFollowUps(notes, "cos", grants), [], "Aiden's or the Researcher's comments start nothing");
  assert.deepEqual(architectFollowUps(notes, "arch", undefined), [], "no grants table: nothing");
  assert.deepEqual(architectFollowUps(notes, undefined, grants), []);
  // A task that already runs without the owner's go-ahead (delegated from an agent's chat or app work): its delegator's
  // follow-ups count whoever it is (e.g. the Roadmap Keeper asking its Engineer for the PR card); others' still don't.
  assert.deepEqual(architectFollowUps(notes, "cos", grants, { approved: true }).map((c) => c.id), ["2"]);
  assert.deepEqual(architectFollowUps(notes, undefined, grants, { approved: true }), []);
  // An agent reopening such a task to todo after its run (Aiden restarting an Engineer task the UI/UX Designer delegated): any agent's comment counts.
  assert.deepEqual(architectFollowUps(notes, "arch", grants, { approved: true, reopened: true }).map((c) => c.id), ["1", "2"]);
  assert.deepEqual(architectFollowUps(notes, "arch", grants, { reopened: true }).map((c) => c.id), ["1"], "an owner-approved task: still only its delegator");
});
test("trial is read as YAML, like compile", async () => {
  const { isTrial } = await import("../src/apply.ts");
  assert.equal(isTrial("trial: true\n"), true);
  assert.equal(isTrial("trial: yes\n"), false);
  assert.equal(isTrial("name: x\n# trial: true\n"), false);
  assert.equal(isTrial("notes: |\n  trial: true\n"), false);
  assert.equal(isTrial("trial: true\ntrial: false\n"), false, "unparseable: not in trial");
  assert.equal(isTrial(undefined), false);
});
test("landing refuses when the guard fails on the exact main it would merge onto", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { landOnMain } = await import("../../../modules/codehost-github/src/git.mjs");
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
  const root = mkdtempSync(join(tmpdir(), "land-"));
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  g(root, "clone", "-q", join(root, "origin.git"), "w");
  const w = join(root, "w");
  mkdirSync(join(w, "agents/review-chaser"), { recursive: true });
  writeFileSync(join(w, def), trialYaml);
  writeFileSync(join(w, book), "v1\n");
  g(w, "add", "-A"); g(w, "commit", "-qm", "trial agent"); g(w, "push", "-q", "origin", "HEAD:main");
  g(w, "checkout", "-qb", "fleet/edit");
  writeFileSync(join(w, book), "v2\n");
  g(w, "commit", "-qam", "handbook edit");
  const shown = g(w, "rev-parse", "HEAD");
  // Meanwhile main graduated the agent (tap 2): the trial no-tap path must not land on top of it.
  g(w, "checkout", "-q", "main");
  writeFileSync(join(w, def), graduated);
  g(w, "commit", "-qam", "graduate"); g(w, "push", "-q", "origin", "main");
  const stillTrial = async (main) => trialHandbookOnly([book], { [def]: g(w, "show", `${main}:${def}`) });
  await assert.rejects(landOnMain(w, "main", shown, "note", { guard: stillTrial }), /no longer/);
  assert.equal(g(w, "show", `origin/main:${book}`), "v1");
});

test("a graduation card lists the handbook edits that landed during the trial; other changes don't", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { trialEditsText } = await import("../src/apply.ts");
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
  const w = mkdtempSync(join(tmpdir(), "trialedits-"));
  g(w, "init", "-q", "-b", "main");
  mkdirSync(join(w, "agents/review-chaser"), { recursive: true });
  writeFileSync(join(w, def), trialYaml);
  writeFileSync(join(w, book), "v1\n");
  g(w, "add", "-A"); g(w, "commit", "-qm", "tap 1: add review-chaser");
  writeFileSync(join(w, book), "v1\nmore\n");
  g(w, "commit", "-qam", "chaser: nudge after two days");
  writeFileSync(join(w, "instance.yaml"), "a: 1\n");
  writeFileSync(join(w, book), "v1\nmore\nand more\n");
  g(w, "add", "-A"); g(w, "commit", "-qm", "mixed @ change\u0007 with instance.yaml");
  writeFileSync(join(w, "z"), "1\n"); g(w, "add", "-A"); g(w, "commit", "-qm", "unrelated");
  const base = g(w, "rev-parse", "HEAD");
  const same = { [def]: trialYaml };
  const grad = await trialEditsText(w, base, [def], { base: same, head: { [def]: graduated } });
  assert.match(grad, /review-chaser: 2 handbook changes/);
  assert.match(grad, /chaser: nudge after two days {2}\(\+1 -0\)/);
  assert.match(grad, /2 handbook changes/);
  assert.match(grad, /mixed @ change with instance\.yaml.*also changed: instance\.yaml/, "a mixed commit is listed and marked; @ and control chars in a subject are harmless");
  assert.doesNotMatch(grad, /tap 1|unrelated|\u0007/);
  await assert.rejects(trialEditsText(join(w, "nope"), base, [def], { base: same, head: { [def]: graduated } }), "a failure throws, never reads as no edits");
  assert.equal(await trialEditsText(w, base, [book], { base: same, head: same }), "", "a handbook-only edit isn't a graduation");
  assert.equal(await trialEditsText(w, base, [def], { base: same, head: same }), "", "still in trial");
});

// The host apply, from the runner's side: ops/apply-config.sh refuses at once while another apply holds data/apply.lock
// ("another apply is running"), and a land must wait that out rather than report the change failed. The real lock is held
// by a real process here, so "waited" and "timed out" are read from flock, not from a stub's opinion.
const checkoutWithLock = async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "apply-wait-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data/apply.lock"), "");
  return dir;
};
/** Holds <dir>/data/apply.lock for `ms`, as a running apply does. */
const holdLock = async (dir, ms) => {
  const { spawn } = await import("node:child_process");
  const { join } = await import("node:path");
  const p = spawn("flock", [join(dir, "data/apply.lock"), "sleep", String(ms / 1000)], { stdio: "ignore" });
  const exited = new Promise((r) => p.on("exit", r));
  await new Promise((r) => setTimeout(r, 300));
  return { p, exited };
};

test("a land that meets a held apply lock waits it out, then applies", async () => {
  const { applyIsBusy, applyWaitingForLock } = await import("../src/apply.ts");
  const dir = await checkoutWithLock();
  const holder = await holdLock(dir, 2500);
  assert.equal(await applyIsBusy(dir), true, "the lock is held before the land starts");
  const attempts = [];
  const out = await applyWaitingForLock(async () => {
    attempts.push(Date.now());
    return (await applyIsBusy(dir))
      ? { ok: false, text: "refusing: another apply is running (data/apply.lock is held)\n" }
      : { ok: true, text: "apply timing: total 1.0s\n" };
  }, dir, { boundMs: 20_000, pollMs: 100 });
  await holder.exited;
  assert.equal(out.ok, true, out.text);
  assert.equal(out.timedOut, undefined, "a wait that cleared is not a timeout");
  assert.match(out.text, /apply timing/, "the apply ran after the lock cleared");
  assert.ok(attempts.length >= 2, `the apply was tried again once the lock was free (${attempts.length} attempts)`);
  assert.ok(Date.now() - attempts[0] >= 2000, "it waited for the holder rather than refusing");
});

test("an apply lock not released within the bound stops waiting and says it timed out, naming the lock", async () => {
  const { applyWaitingForLock } = await import("../src/apply.ts");
  const dir = await checkoutWithLock();
  const holder = await holdLock(dir, 5000);
  const start = Date.now();
  const out = await applyWaitingForLock(async () => ({ ok: false, text: "refusing: another apply is running (data/apply.lock is held)\n" }), dir, { boundMs: 700, pollMs: 100 });
  const waited = Date.now() - start;
  assert.equal(out.ok, false);
  assert.equal(out.timedOut, true, "a lock still held at the bound is its own outcome, not a plain failure");
  assert.ok(waited >= 700 && waited < 4000, `it stopped at its bound (waited ${waited}ms)`);
  assert.match(out.text, /timed out: data\/apply\.lock was still being refused after waiting 0\.\ds/);
  assert.match(out.text, /was not re-applied on this host/);
  holder.p.kill();
});

test("an apply that fails for its own reason is neither waited on nor relabelled", async () => {
  const { applyWaitingForLock } = await import("../src/apply.ts");
  const dir = await checkoutWithLock();
  const out = await applyWaitingForLock(async () => ({ ok: false, text: "refusing: .env has no AIDENHQ_INSTANCE_DIR\n" }), dir, { boundMs: 5000, pollMs: 50 });
  assert.deepEqual(out, { ok: false, text: "refusing: .env has no AIDENHQ_INSTANCE_DIR\n" });
});

test("the bound alone ends the wait: a lock that keeps being refused is not retried forever because a probe saw it free", async () => {
  const { applyWaitingForLock } = await import("../src/apply.ts");
  // No holder at all: every probe reports the lock free, and the apply refuses on the lock each time anyway -- another
  // apply took it between the probe and the attempt. The bound has to end it, not the probe.
  const dir = await checkoutWithLock();
  let attempts = 0;
  const out = await applyWaitingForLock(async () => {
    attempts += 1;
    return { ok: false, text: "refusing: another apply is running (data/apply.lock is held)\n" };
  }, dir, { boundMs: 600, pollMs: 50 });
  assert.equal(out.ok, false);
  assert.equal(out.timedOut, true, "the bound is spent, so it is a timeout even though the probe says free");
  assert.match(out.text, /timed out: data\/apply\.lock was still being refused after waiting 0\.\ds/);
  assert.ok(attempts < 40, `it stopped at its bound instead of retrying without limit (${attempts} attempts)`);
});
