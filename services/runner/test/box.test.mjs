// Box jobs (docs/design/sandboxing.md, the strong tier): an Engineer with a computer runs each turn in a box from the
// launcher (POST /job), through `docker exec`. The real runner (src/main.mjs) as a child process, a fake Paperclip
// (flow-harness), a fake launcher and a fake `docker` (test/fakes/docker.mjs) that plays the agent's turn.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLog } from "./fakes/lib.mjs";
import { registry } from "./fakes/engines.mjs";
import { fakeJail } from "./fakes/jail.mjs";
import { fakePaperclip } from "./flow-harness.mjs";
import { State } from "../src/state.ts";
import { ensureRepo, safeWorkspace } from "../../../modules/codehost-github/src/workspace.ts";
import { freePort, jobsHost } from "./flow-harness.mjs";
import { useEngines } from "../src/agents.mjs";

const RUNNER = join(import.meta.dirname, "../src/main.mjs");
const FAKES = join(import.meta.dirname, "fakes");
const COMPANY = "00000000-0000-4000-8000-000000000001";
const USER = "user-1";

/**
 * The launcher's job routes, as the runner sees them: boxes as files the fake docker reads; `survive` release calls answer
 * "running". Like the real one, it keeps each box's env file and out folder under its jobs folder (`jobsDir`) and records the
 * box's task, agent and workspace in jobs.json beside it: what the kernel checks a box job against.
 */
function fakeLauncher(boxes, jobsDir) {
  const calls = [];
  const opts = { failJob: false, survive: 0, die: false };
  const goneAt = new Map();
  let n = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const send = (status, json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    if (req.headers.authorization !== "Bearer runner-key") return send(401, { error: "unauthorized" });
    calls.push({ route: req.url, body, at: Date.now() });
    const file = (c) => join(boxes, `${c}.json`);
    if (req.url === "/job") {
      if (opts.failJob) return send(500, { error: "docker run failed: no space left" });
      const container = `aidenhq-computer-t${++n}`;
      const outDir = join(jobsDir, container);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(file(container), JSON.stringify({ workspace: body.workspace, outDir, die: opts.die }));
      writeFileSync(join(jobsDir, `${container}.env`), "AIDENHQ_RUN_TOKEN=ahqc_x\nHOME=/workspace/.aidenhq/home\n");
      const recs = existsSync(join(jobsDir, "../jobs.json")) ? JSON.parse(readFileSync(join(jobsDir, "../jobs.json"), "utf8")) : [];
      writeFileSync(join(jobsDir, "../jobs.json"), JSON.stringify([...recs, { container, agentId: body.agentId, issueId: body.issueId, workspace: body.workspace }]));
      return send(200, { container, envFile: join(jobsDir, `${container}.env`), outDir });
    }
    const box = existsSync(file(body.container)) ? JSON.parse(readFileSync(file(body.container), "utf8")) : { gone: true };
    if (req.url === "/job/renew") return box.gone ? send(404, { error: "box gone" }) : send(200, { container: body.container, issueId: body.issueId, workspace: box.workspace });
    if (req.url === "/job/release") {
      if (!box.gone && opts.survive > 0) return opts.survive--, send(200, { state: "running" });
      if (!box.gone) writeFileSync(file(body.container), JSON.stringify({ ...box, gone: true }));
      if (!goneAt.has(body.container)) goneAt.set(body.container, Date.now());
      return send(200, { state: "missing" });
    }
    send(404, { error: "no such route" });
  });
  return { server, calls, opts, goneAt };
}

describe("box jobs", () => {
  let dir, runner, env, paperclip, boxLauncher, jobs, output = "";
  const start = () => {
    runner = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", RUNNER], { env, stdio: ["ignore", "pipe", "pipe"] });
    runner.stdout.on("data", (d) => (output += d));
    runner.stderr.on("data", (d) => (output += d));
  };
  const waitFor = async (what, ok, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (ok()) return;
    assert.fail(`timed out waiting for ${what}\n${output.slice(-3000)}\ncomments: ${paperclip.comments.get("part").map((c) => c.body).join("\n---\n")}`);
  };
  const fake = () => readLog(join(dir, "fake.log"));
  const dockerRuns = () => fake().filter((e) => e.kind === "docker").map((e) => e.data);
  const reviews = () => paperclip.patches.filter((p) => p.issue === "PEN-2" && p.status === "in_review").map((p) => ({ ...p, at: p.at }));
  const step = (text) => writeFileSync(join(dir, "step"), text);
  const release = () => writeFileSync(join(dir, "release"), "");
  const say = (text) => paperclip.addComment("part", text);
  const calls = (route) => boxLauncher.calls.filter((c) => c.route === route);
  const lastJob = () => {
    const state = new State(join(dir, "state"));
    try { return state.lastJob("part"); } finally { state.db.close(); }
  };
  const quiet = () => !(paperclip.activity.at(-1)?.running ?? []).some((r) => r.identifier === "PEN-2");

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "aidenhq-box-"));
    const [home, config, secrets, bin, boxes] = ["home", "config", "secrets", "bin", "boxes"].map((d) => join(dir, d));
    for (const d of [home, config, secrets, bin, boxes]) mkdirSync(d, { recursive: true });
    // The fakes' settings baked in: a job's env is the kernel's allowlist.
    const exports = `export FAKE_LOG='${join(dir, "fake.log")}'\nexport FAKE_STEP='${join(dir, "step")}'\n`;
    for (const name of ["codex", "gh"]) {
      writeFileSync(join(bin, name), name === "codex" ? `#!/bin/sh\n${exports}exec "${join(FAKES, `${name}.sh`)}" "$@"\n` : `#!/bin/sh\n${exports}exec "${process.execPath}" "${join(FAKES, `${name}.mjs`)}" "$@"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    fakeJail(bin, join(dir, "fake.log"));
    // The docker client gets only Docker's env from the runner: the fake's own settings are baked into its shim.
    writeFileSync(join(dir, "secret"), "the owner key 0123456789\n");
    writeFileSync(join(bin, "docker"), `#!/bin/sh\nFAKE_SECRET="${join(dir, "secret")}" FAKE_LOG="${join(dir, "fake.log")}" FAKE_STEP="${join(dir, "step")}" FAKE_BOXES="${boxes}" exec "${process.execPath}" "${join(FAKES, "docker.mjs")}" "$@"\n`);
    chmodSync(join(bin, "docker"), 0o755);
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n");
    writeFileSync(join(config, "system.yaml"), `paperclip:\n  company_id: "${COMPANY}"\nuser:\n  names: ["Dana"]\n`);
    writeFileSync(join(config, "engines.json"), JSON.stringify(registry()));
    writeFileSync(join(config, "runner.yaml"), `label: engineer\npoll_seconds: 0.2\nhelper_port: ${await freePort()}\nallowed_orgs: [acme]\nwork_dir: ${join(dir, "work")}\nstate_dir: ${join(dir, "state")}\nmax_concurrent: 1\ntimeout_minutes: 2\nengines:\n  openrouter:\n    model: acme/model-1\nintake:\n  codex_args: []\n  timeout_seconds: 30\nreplies:\n  enabled: false\nreviews:\n  enabled: false\nrecurring:\n  enabled: false\n`);
    for (const [f, v] of [["paperclip_board_key", "board-key"], ["board_internal_token", "board-token"], ["computers_runner_key", "runner-key"], ["engineering_token", "engineering-token"]]) writeFileSync(join(secrets, f), `${v}\n`, { mode: 0o600 });
    const engineers = [{ id: "app-eng", name: "App Engineer", status: "idle", adapterType: "opencode_local", adapterConfig: { model: "openrouter/acme/model-1" }, metadata: { setupKey: "aidenhq:app-engineer", runnerEngine: true, engine: "codex-openrouter", box: true, persona: { name: "Ada" } } }];
    const parent = { id: "parent", identifier: "PEN-1", title: "An apps page", status: "todo", assigneeUserId: USER, createdByUserId: USER, createdByAgentId: null, labels: [], description: "Build a page listing the apps." };
    const part = { id: "part", identifier: "PEN-2", title: "An apps page", status: "todo", parentId: "parent", assigneeAgentId: "app-eng", assigneeUserId: null, createdByUserId: USER, createdByAgentId: null, labels: [], description: "Ada, build a page listing the apps" };
    // The board's completion gate answers slowly, as it can on a loaded runner: a turn's outcome has to be recorded
    // before its reply goes out, or a report reads "running" beside a finished turn.
    paperclip = fakePaperclip({ parent, part, engineers, gateDelayMs: 500, jobs: () => jobs.port });
    // Each patch's time, to order the reply against the box's release.
    const patches = paperclip.patches;
    patches.push = (...xs) => Array.prototype.push.apply(patches, xs.map((x) => ({ ...x, at: Date.now() })));
    boxLauncher = fakeLauncher(boxes, join(home, ".local/state/aidenhq-computers/jobs"));
    await new Promise((r) => paperclip.server.listen(0, "127.0.0.1", r));
    await new Promise((r) => boxLauncher.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${paperclip.server.address().port}`;
    step("slow");
    env = {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH}`,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      AIDENHQ_CONFIG_DIR: config,
      AIDENHQ_SECRETS_DIR: secrets,
      AIDENHQ_ENV_FILE: join(dir, "none.env"),
      AIDENHQ_LAUNCHER_URL: `http://127.0.0.1:${boxLauncher.server.address().port}`,
      PAPERCLIP_URL: url,
      BOARD_INTERNAL_URL: url,
      AIDENHQ_KERNEL_URL: url,
      AIDENHQ_BOX_RELEASE_RETRY_MS: "50",
      FAKE_LOG: join(dir, "fake.log"),
      FAKE_STEP: join(dir, "step"),
      FAKE_BOXES: boxes,
      AIDENHQ_GRADER_URL: `${url}/grader`,
    };
    jobs = jobsHost(env, join(dir, "kernel.db"));
    start();
  });
  after(async () => {
    runner?.kill("SIGKILL");
    await jobs?.stop();
    paperclip?.server.close();
    boxLauncher?.server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs the turn in its own box, survives a runner restart (adopted, lease renewed), and reports only once the box is gone", async () => {
    await waitFor("the agent at work in its box", () => dockerRuns().length === 1 && lastJob()?.run_json);
    const job = calls("/job")[0].body;
    assert.equal(job.agentId, "app-eng");
    assert.equal(job.issueId, "part");
    assert.equal(job.identifier, "PEN-2");
    assert.equal(job.workspace, join(dir, "work/tasks/PEN-2"));
    assert.equal(job.engine, "codex-openrouter");
    assert.equal(job.state, join(dir, "state/codex-openrouter/part"));
    assert.ok(statSync(join(job.state, "AGENTS.md")).isFile(), "its engine's state folder is seeded before the box mounts it");
    const run = dockerRuns()[0];
    assert.deepEqual(run.argv.slice(0, 6), ["exec", "--env-file", join(dir, "home/.local/state/aidenhq-computers/jobs/aidenhq-computer-t1.env"), "-w", "/workspace", "aidenhq-computer-t1"]);
    // The engine module's bin, mounted read-only by the launcher, on the job dir in the launcher's out folder.
    assert.deepEqual(run.argv.slice(-2), ["/opt/aidenhq/engine/bin/engine", "/aidenhq-out/job"]);
    assert.deepEqual([run.spec.contract, run.spec.sandbox.kind, run.spec.model.base_url, run.spec.model.token_env, run.spec.mcp], ["engine@1", "box", "http://10.231.2.1:8200/api/v1", "AIDENHQ_RUN_TOKEN", []]);
    // Nothing of the runner's env reaches the box: the client has only what Docker needs, the box only the launcher's file
    // (and, with a GitHub App, the job's read-only gh token: no App here).
    assert.ok(!run.clientEnv.some((k) => /^(AIDENHQ|PAPERCLIP|BOARD|GH_|GIT_|OPENROUTER)/.test(k)), run.clientEnv.join(","));
    assert.match(run.prompt, /\/workspace/);
    assert.ok(!run.prompt.includes(join(dir, "work")), "the prompt names the paths the box sees");
    const token = JSON.parse(lastJob().run_json).token;
    assert.equal(job.helperToken, token, "the box is bound to the helper token the run uses");

    // A deploy's drain: the runner exits, the box and its run go on (no release).
    const exited = new Promise((r) => runner.once("exit", r));
    runner.kill("SIGUSR2");
    assert.equal(await exited, 75);
    assert.equal(calls("/job/release").length, 0);
    start();
    await waitFor("the adoption", () => output.includes('"following a running job again"') && calls("/job/renew").length > 0);
    const renew = calls("/job/renew")[0].body;
    assert.deepEqual([renew.container, renew.issueId, renew.helperToken], ["aidenhq-computer-t1", "part", token]);

    // The box's process outlives a first release call: the reply waits until the box is confirmed gone.
    boxLauncher.opts.survive = 1;
    release();
    await waitFor("the reply", () => reviews().length > 0, 30_000);
    assert.match(reviews()[0].comment, /Box reply: the page lists the apps\./);
    assert.equal(calls("/job/release").length, 2);
    assert.ok(reviews()[0].at >= boxLauncher.goneAt.get("aidenhq-computer-t1"), "reported after the box was gone");
    // Recorded with the reply, not after it: a restart in that window adopts a run that already ended.
    assert.equal(lastJob().status, "done");
    assert.equal(dockerRuns().length, 1, "adopted, not run again");
  });

  it("a stopped run whose process outlives its client: the release is retried until the box is gone, and only then reported", async () => {
    await waitFor("quiet", quiet);
    step("slow");
    say("Add a filter by owner.");
    await waitFor("the second box run", () => dockerRuns().length === 2);
    const releasesBefore = calls("/job/release").length;
    boxLauncher.opts.survive = 2;
    say("stop");
    await waitFor("the stop", () => reviews().some((p) => /Stopped on request/.test(p.comment ?? "")), 40_000);
    const stopped = reviews().find((p) => /Stopped on request/.test(p.comment ?? ""));
    assert.equal(calls("/job/release").length - releasesBefore, 3, "released, then retried until Docker says it is gone");
    assert.ok(stopped.at >= boxLauncher.goneAt.get("aidenhq-computer-t2"));
    assert.equal(lastJob().status, "cancelled");
  });

  it("a box gone while no runner followed it (its lease lapsed): the adopting runner resumes the task in a new box", async () => {
    await waitFor("quiet", quiet);
    step("slow");
    const jobs = calls("/job").length;
    say("Add paging.");
    await waitFor("the box run", () => calls("/job").length === jobs + 1 && dockerRuns().length === 3);
    const old = `aidenhq-computer-t${jobs + 1}`;
    const exited = new Promise((r) => runner.once("exit", r));
    runner.kill("SIGUSR2");
    assert.equal(await exited, 75);
    // The launcher reaped it meanwhile.
    const file = join(dir, "boxes", `${old}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), gone: true }));
    start();
    await waitFor("the resume in a new box", () => calls("/job").length === jobs + 2 && dockerRuns().length === 4);
    assert.ok(paperclip.comments.get("part").some((c) => /Resumed after a runner restart/.test(c.body)));
    release();
    await waitFor("quiet", quiet);
    assert.equal(lastJob().status, "done");
  });

  it("a failed /job or a box that dies at once: nothing left running, the box released, the failure on the task", async () => {
    await waitFor("quiet", quiet);
    step("");
    boxLauncher.opts.failJob = true;
    const runs = dockerRuns().length;
    say("Try the filter again.");
    await waitFor("the error", () => paperclip.comments.get("part").some((c) => /no space left/.test(c.body)));
    await waitFor("quiet", quiet);
    assert.equal(lastJob().status, "failed");
    assert.equal(dockerRuns().length, runs, "no run without a box");

    boxLauncher.opts.failJob = false;
    boxLauncher.opts.die = true;
    const n = reviews().length;
    say("Once more, please.");
    await waitFor("the failure report", () => reviews().length > n);
    await waitFor("quiet", quiet);
    assert.ok(boxLauncher.goneAt.has("aidenhq-computer-t3"), "the box was released");
    assert.notEqual(lastJob().status, "running");
  });

  it("a specialised Engineer runs only what is assigned to it: never picked, or borrowed as a persona, by its engine kind; a general one in a box is", async () => {
    const { personaFor, pickerFor } = await import("../src/agents.mjs");
    useEngines(registry());
    const box = { id: "app-eng", adapterType: "opencode_local", adapterConfig: {}, metadata: { engine: "codex-openrouter", box: true, brief: "Build apps.", persona: { name: "Ada" } } };
    const light = { id: "sw-eng", adapterType: "opencode_local", adapterConfig: {}, metadata: { engine: "codex-openrouter", box: true, persona: { name: "Linus" } } };
    assert.equal(pickerFor({ kind: "codex-openrouter" }, [box, light]).assigneeAgentId, "sw-eng");
    assert.equal(personaFor("codex-openrouter", [box, light]).name, "Linus");
    assert.equal(personaFor("codex-openrouter", [box, light], box).name, "Ada");
    assert.equal(personaFor("codex-openrouter", [box, light], light).name, "Linus");
  });

  it("a box's events file that is a link to a host file is never read into the reply", async () => {
    await waitFor("quiet", quiet);
    boxLauncher.opts.die = false;
    step("symlink");
    const n = reviews().length;
    say("Show me the page.");
    await waitFor("the reply", () => reviews().length > n);
    await waitFor("quiet", quiet);
    assert.ok(!paperclip.comments.get("part").some((c) => c.body.includes("0123456789")), "the host file stayed out of the task");
  });

  it("a box job's clones share no object file with the runner's cache", async () => {
    const d = mkdtempSync(join(tmpdir(), "aidenhq-copy-"));
    try {
      const g = (cwd, ...a) => execFileSync("git", a, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe" }).toString().trim();
      const cache = join(d, "cache");
      mkdirSync(cache);
      g(cache, "init", "-q", "-b", "main");
      writeFileSync(join(cache, "a"), "a\n");
      g(cache, "add", "a");
      g(cache, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "a");
      g(cache, "update-ref", "refs/remotes/origin/main", "main");
      const objects = (p) => execFileSync("find", [join(p, ".git/objects"), "-type", "f", "-not", "-path", "*/info/*"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      const path = await ensureRepo(join(d, "ws"), { slug: "acme/app", org: "acme", name: "app" }, { cache, remoteUrl: cache, copy: true });
      assert.ok(objects(path).length > 0);
      for (const f of objects(path)) assert.equal(statSync(f).nlink, 1, `${f} is hardlinked`);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("a task cancelled while its run goes on: the run is stopped, its box released, and the task stays cancelled", async () => {
    await waitFor("quiet", quiet);
    step("slow");
    const runs = dockerRuns().length;
    say("Add sorting.");
    await waitFor("the box run", () => dockerRuns().length === runs + 1);
    const gone = boxLauncher.goneAt.size;
    const n = reviews().length;
    paperclip.issues.get("part").status = "cancelled";
    await waitFor("the box released", () => boxLauncher.goneAt.size === gone + 1);
    const released = [...boxLauncher.goneAt.values()].at(-1);
    await waitFor("quiet", quiet);
    assert.equal(lastJob().status, "cancelled");
    assert.equal(reviews().length, n, "never moved back to review");
    assert.ok(!paperclip.patches.some((p) => p.issue === "PEN-2" && p.at >= released), "no status or reply on the closed task");
    paperclip.issues.get("part").status = "in_review";
  });
});

// Hostile-job checks (spec §8.9): what a job could use to reach past its own task folder.
describe("hostile jobs", () => {
  it("H1: a symlinked task folder is refused, and a real one inside the work dir passes", () => {
    const root = mkdtempSync(join(tmpdir(), "h1-"));
    mkdirSync(join(root, "tasks", "WOR-1"), { recursive: true });
    const target = mkdtempSync(join(tmpdir(), "h1-x-"));
    symlinkSync(target, join(root, "tasks", "WOR-2"));
    assert.throws(() => safeWorkspace(root, join(root, "tasks", "WOR-2")), /workspace refused: .* is a symlink/);
    // A link higher up (tasks/ itself) is refused too, and so is a path that leaves the work dir.
    const other = mkdtempSync(join(tmpdir(), "h1-root-"));
    mkdirSync(join(target, "WOR-3"));
    symlinkSync(target, join(other, "tasks"));
    assert.throws(() => safeWorkspace(other, join(other, "tasks", "WOR-3")), /symlink/);
    assert.throws(() => safeWorkspace(root, join(root, "tasks", "..", "..")), /not inside/);
    assert.equal(safeWorkspace(root, join(root, "tasks", "WOR-1")), join(realpathSync(root), "tasks", "WOR-1"));
  });

});
