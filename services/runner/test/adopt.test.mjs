// A deploy restarts the runner under a running Engineer job: the job keeps going untouched, the new
// runner adopts it, and its turn is reported exactly once (no lost reply, no duplicate, no resume).
// The real runner (src/main.mjs) as a child process, a small fake Paperclip, the fake engines (test/fakes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { State } from "../src/state.mjs";

const RUNNER = join(import.meta.dirname, "../src/main.mjs");
const FAKES = join(import.meta.dirname, "fakes");
const COMPANY = "00000000-0000-4000-8000-000000000001";
const USER = "user-1";

function fakePaperclip(issue, engineers) {
  const comments = [];
  const patches = [];
  const activity = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = new URL(req.url, "http://x").pathname;
    const send = (json, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    if (path === `/api/companies/${COMPANY}/labels`) return send([{ id: "label-engineer", name: "engineer" }]);
    if (path === `/api/companies/${COMPANY}/agents`) return send(engineers);
    if (path === `/api/companies/${COMPANY}/routines`) return send([]);
    if (path === `/api/companies/${COMPANY}/issues`) {
      const agent = new URL(req.url, "http://x").searchParams.get("assigneeAgentId");
      return send(agent && agent !== issue.assigneeAgentId ? [] : [issue]);
    }
    if (path === "/api/cli-auth/me") return send({ userId: USER });
    if (path.startsWith(`/api/issues/`)) {
      if (path.endsWith("/comments") && req.method === "GET") return send(comments);
      if (path.endsWith("/attachments")) return send([]);
      if (path.endsWith("/comments")) {
        comments.push({ id: `c${comments.length}`, authorType: "agent", body: JSON.parse(body).body, createdAt: new Date().toISOString() });
        return send({}, 201);
      }
      if (req.method === "PATCH") {
        const { comment, ...rest } = JSON.parse(body);
        patches.push(JSON.parse(body));
        Object.assign(issue, rest, { updatedAt: new Date().toISOString() });
        if (comment) comments.push({ id: `c${comments.length}`, authorType: "agent", body: comment, createdAt: new Date().toISOString() });
        return send(issue);
      }
      return send(issue);
    }
    if (path === "/internal/approvals") return send({ approvals: [] });
    if (path === "/internal/runner/activity") activity.push(JSON.parse(body));
    send({});
  });
  return { server, comments, patches, activity };
}

test("a runner restart leaves a running job alone; the next runner adopts it and reports its turn once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aidenhq-adopt-"));
  const [home, config, secrets, bin] = ["home", "config", "secrets", "bin"].map((d) => join(dir, d));
  for (const d of [home, config, secrets, bin]) mkdirSync(d, { recursive: true });
  for (const name of ["bwrap", "codex", "claude", "gh"]) {
    writeFileSync(join(bin, name), name === "bwrap" || name === "codex" ? `#!/bin/sh\nexec "${join(FAKES, `${name}.sh`)}" "$@"\n` : `#!/bin/sh\nexec "${process.execPath}" "${join(FAKES, `${name}.mjs`)}" "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(config, "system.yaml"), `paperclip:\n  company_id: "${COMPANY}"\nuser:\n  names: ["Dana"]\n`);
  writeFileSync(
    join(config, "runner.yaml"),
    `label: engineer\npoll_seconds: 1\nallowed_orgs: [acme]\nwork_dir: ${join(dir, "work")}\nstate_dir: ${join(dir, "state")}\nmax_concurrent: 1\ntimeout_minutes: 2\n` +
      `engines:\n  claude:\n    token_file: ${join(secrets, "claude_oauth_token")}\n    config_dir: ${join(dir, "state/claude")}\n` +
      `gcp:\n  credentials: ${join(secrets, "gcloud.json")}\nreplies:\n  enabled: false\nreviews:\n  enabled: false\nrecurring:\n  enabled: false\n`,
  );
  for (const [f, v] of [["paperclip_board_key", "board-key"], ["claude_oauth_token", "claude-token"], ["board_internal_token", "board-token"]]) writeFileSync(join(secrets, f), `${v}\n`, { mode: 0o600 });
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n");

  const engineers = [{ id: "engineer-claude", name: "Engineer · Claude", status: "idle", adapterType: "claude_local", adapterConfig: {}, metadata: { setupKey: "aidenhq:engineer-claude", persona: { name: "Ada" } } }];
  const issue = { id: "task", identifier: "PEN-7", title: "Look into the flaky test", status: "todo", assigneeAgentId: "engineer-claude", assigneeUserId: null, createdByUserId: USER, labels: [], description: "Ada, look into why the login test is flaky" };
  const paperclip = fakePaperclip(issue, engineers);
  await new Promise((r) => paperclip.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${paperclip.server.address().port}`;
  const step = join(dir, "claude-step");
  // Its `aidenhq` command runs after the restart: the agent's tools still reach the (new) runner.
  writeFileSync(step, "slow\naidenhq status"); // works until the test writes `release` next to the step file
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH}`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    AIDENHQ_CONFIG_DIR: config,
    AIDENHQ_SECRETS_DIR: secrets,
    AIDENHQ_ENV_FILE: join(dir, "none.env"),
    PAPERCLIP_URL: url,
    BOARD_INTERNAL_URL: url,
    FAKE_LOG: join(dir, "fake.log"),
    FAKE_STEP: step,
  };
  let output = "";
  const start = () => {
    const runner = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", RUNNER], { env, stdio: ["ignore", "pipe", "pipe"] });
    runner.stdout.on("data", (d) => (output += d));
    runner.stderr.on("data", (d) => (output += d));
    return runner;
  };
  const claudeRuns = () => (existsSync(env.FAKE_LOG) ? readFileSync(env.FAKE_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === "claude") : []);
  const replies = () => paperclip.patches.filter((p) => p.status === "in_review");
  const waitFor = async (what, ok, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (ok()) return;
    assert.fail(`timed out waiting for ${what}\n${output.slice(-3000)}\ncomments: ${paperclip.comments.map((c) => c.body).join("\n---\n")}`);
  };
  const job = () => {
    const state = new State(join(dir, "state"));
    try {
      return state.lastJob("task");
    } finally {
      state.db.close();
    }
  };
  let pid;
  let runner = start();
  t.after(() => {
    runner.kill("SIGKILL");
    try {
      if (pid) process.kill(-pid, "SIGKILL");
    } catch {}
    paperclip.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // The job starts and works (the fake holds its turn open).
  await waitFor("the agent at work", () => claudeRuns().length === 1 && job()?.run_json);
  pid = JSON.parse(job().run_json).pid;

  // A deploy's drain: the runner exits at once with the code systemd restarts on, and the job runs on.
  const exited = new Promise((r) => runner.once("exit", r));
  runner.kill("SIGUSR2");
  assert.equal(await exited, 75);
  process.kill(pid, 0); // still running
  assert.equal(job().status, "running");
  assert.equal(replies().length, 0, "no reply for a turn still going");

  // The new runner adopts it; the agent finishes; its reply lands once.
  runner = start();
  await waitFor("the new runner to adopt the job", () => output.includes('"adopted a running job"'));
  await waitFor("the board to show the adopted job", () => paperclip.activity.at(-1)?.running.some((r) => r.identifier === "PEN-7"));
  writeFileSync(join(dir, "release"), "");
  await waitFor("the reply", () => replies().length > 0);
  await new Promise((r) => setTimeout(r, 1500)); // a poll or so more: nothing else comes
  assert.equal(replies().length, 1, "reported once");
  assert.match(replies()[0].comment, /Checked every repository; nothing needed changing\./);
  assert.equal(job().status, "done");
  assert.equal(claudeRuns().length, 1, "one run: not resumed, not run again");
  assert.ok(!claudeRuns()[0].data.argv.includes("--resume"));
  const tool = readFileSync(env.FAKE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.kind === "tool").data;
  assert.equal(tool.code, 0, tool.out);
  assert.ok(!paperclip.comments.some((c) => /Resumed after a runner restart|Runner error/.test(c.body)), paperclip.comments.map((c) => c.body).join("\n---\n"));
});
