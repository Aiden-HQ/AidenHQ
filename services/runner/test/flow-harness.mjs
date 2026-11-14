// Shared by the flow-*.test.mjs files (one conversation each, so node runs them side by side): the real runner
// (src/main.mjs) as a child process, talking to a fake Paperclip, with fake engines (test/fakes: bwrap, codex,
// claude, gh) and local repositories for GitHub.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { State } from "../src/state.mjs";

const RUNNER = join(import.meta.dirname, "../src/main.mjs");
const FAKES = join(import.meta.dirname, "fakes");
const COMPANY = "00000000-0000-4000-8000-000000000001";
const USER = "user-1";

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: { ...process.env, ...gitEnv }, stdio: "pipe" }).toString().trim();
// Not tied to any one flow's home: flows may run side by side, and this helper must outlive the flow that last set it up.
const gitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "init.defaultBranch",
  GIT_CONFIG_VALUE_0: "main",
  GIT_CONFIG_KEY_1: "protocol.file.allow",
  GIT_CONFIG_VALUE_1: "always",
};

/** A Paperclip with one parent task (the user's) and one part of it for Ada. */
export function fakePaperclip({ parent, part, engineers, parentComments = [], partComments = [], others = [], grades = new Map(), gradingOff = false, gateDelayMs = 0 }) {
  const gradeLog = [];
  const graderCalls = [];
  const graderAnswers = [];
  const issues = new Map([parent, part, ...others.map((o) => o.issue)].map((i) => [i.id, i]));
  const comments = new Map([[parent.id, parentComments], [part.id, partComments], ...others.map((o) => [o.issue.id, o.comments])]);
  const patches = [];
  const activity = [];
  // Requests held open and never answered: a tick that never finishes (a stuck read), so only a pass before it can act.
  const hang = new Set();
  const held = [];
  const passed = [];
  const attached = [];
  const unknown = [];
  const approvals = new Map();
  const autos = [];
  const created = []; // tasks the runner filed (POST …/issues), as the board key
  let n = 0;
  // Like Paperclip, a comment bumps its task's updatedAt (the runner skips a task it already handled at the same one).
  const addComment = (issueId, body) => {
    const createdAt = new Date(Date.now() + ++n).toISOString();
    comments.get(issueId).push({ id: `comment-${n}`, authorType: "user", authorUserId: USER, body, createdAt });
    const i = issues.get(issueId);
    if (i) i.updatedAt = createdAt;
  };
  const find = (ref) => issues.get(ref) ?? [...issues.values()].find((i) => i.identifier === ref);
  // The board's args schema is strict: a merge card's PR entries take these fields only, and any other is a 400 naming it.
  const strictArgs = (args) => (args?.prs ?? []).flatMap((p, i) => Object.keys(p ?? {}).filter((k) => !["repo", "number", "url", "head", "noReview"].includes(k)).map((k) => `prs.${i}: Unrecognized key: "${k}"`));
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://x");
    const send = (json, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const path = url.pathname;
    if (hang.has("issues") && req.method === "GET" && path === `/api/companies/${COMPANY}/issues`) {
      held.push(res);
      return;
    }
    const issue = /^\/api\/issues\/([^/]+)/.exec(path)?.[1];
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/labels`) return send([{ id: "label-engineer", name: "engineer" }]);
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/agents`) return send(engineers);
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/routines`) return send([]);
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/issues`) {
      const q = url.searchParams;
      let list = [...issues.values()];
      if (q.get("labelId")) list = list.filter((i) => (i.labels ?? []).some((l) => l.id === q.get("labelId")));
      if (q.get("assigneeAgentId")) list = list.filter((i) => i.assigneeAgentId === q.get("assigneeAgentId"));
      if (q.get("assigneeUserId")) list = list.filter((i) => i.assigneeUserId === q.get("assigneeUserId"));
      if (q.get("parentId")) list = list.filter((i) => i.parentId === q.get("parentId"));
      if (q.get("q")) list = list.filter((i) => `${i.title}\n${i.description}`.toLowerCase().includes(q.get("q").toLowerCase()));
      return send(list);
    }
    if (req.method === "GET" && path === "/api/cli-auth/me") return send({ userId: USER });
    if (req.method === "POST" && path === `/api/companies/${COMPANY}/issues`) {
      const b = JSON.parse(body);
      const i = { id: `made-${created.length + 1}`, identifier: `PEN-${100 + created.length}`, status: b.status, title: b.title, description: b.description, assigneeAgentId: b.assigneeAgentId, assigneeUserId: null, parentId: null, createdByUserId: USER, createdByAgentId: null, labels: [] };
      created.push({ ...b, id: i.id });
      issues.set(i.id, i);
      comments.set(i.id, []);
      return send(i, 201);
    }
    const upload = new RegExp(`^/api/companies/${COMPANY}/issues/([^/]+)/attachments$`).exec(path);
    if (req.method === "POST" && upload) {
      const name = /filename="([^"]+)"/.exec(body)?.[1];
      attached.push({ issue: upload[1], name });
      return send({ id: `file-${attached.length}`, originalFilename: name }, 201);
    }
    if (issue && find(decodeURIComponent(issue))) {
      const i = find(decodeURIComponent(issue));
      if (req.method === "GET" && path.endsWith("/comments")) return send(comments.get(i.id));
      if (req.method === "GET" && path.endsWith("/attachments")) return send([]);
      if (req.method === "POST" && path.endsWith("/comments")) {
        addComment(i.id, JSON.parse(body).body);
        return send({ ok: true }, 201);
      }
      if (req.method === "PATCH") {
        const fields = JSON.parse(body);
        patches.push({ issue: i.identifier, ...fields });
        const { comment, ...rest } = fields;
        Object.assign(i, rest, { updatedAt: new Date().toISOString() });
        if (comment) addComment(i.id, comment);
        return send(i);
      }
      if (req.method === "GET") return send(i);
    }
    // The board's approval records: filed by the runner, decided here by the test (the owner's tap), claimed once.
    if (path === "/internal/approvals" && req.method === "POST") {
      const b = JSON.parse(body);
      const extra = strictArgs(b.args);
      if (extra.length) return send({ error: extra.join(", ") }, 400);
      const digest = JSON.stringify([b.action, b.args, b.diff ?? ""]);
      const issueId = find(b.issue).id;
      const open = [...approvals.values()].filter((a) => a.issueId === issueId && a.action === b.action && a.state === "pending");
      const same = open.find((a) => a.digest === digest);
      if (same) return send(same);
      for (const a of open) a.state = "expired";
      const a = { id: `A${String(approvals.size + 1).padStart(8, "0")}`, issueId, identifier: find(b.issue).identifier, action: b.action, args: b.args, details: b.diff ?? "", digest, state: "pending", replaced: open.length > 0, baseTier: b.baseTier };
      approvals.set(a.id, a);
      return send(a);
    }
    if (path === "/internal/approvals" && req.method === "GET" && url.searchParams.get("issue")) return send({ approvals: [...approvals.values()].filter((a) => a.issueId === find(url.searchParams.get("issue"))?.id) });
    if (path === "/internal/approvals" && req.method === "GET") return send({ approvals: [...approvals.values()].filter((a) => a.state === url.searchParams.get("state")) });
    // Graded done: the board's grades contract (services/board/src/grades.ts), simplified, and a scripted grader model.
    const gradeRoute = /^\/internal\/grades\/([^/]+)\/(gate|verdict|release)$/.exec(path);
    if (gradeRoute) {
      const id = find(decodeURIComponent(gradeRoute[1]))?.id;
      const g = grades.get(id);
      if (gradeRoute[2] === "release") return send({ ok: grades.delete(id) });
      const stamp = (state) => Object.assign(g, { state, updatedAt: new Date().toISOString() });
      if (gradeRoute[2] === "gate") {
        // A board round trip takes time on a loaded runner: a flow can hold the gate open to see what the turn has recorded.
        if (gateDelayMs) await new Promise((r) => setTimeout(r, gateDelayMs));
        if (gradingOff || !g || g.state === "satisfied") return send({ pass: true });
        if (!["pending", "awaiting_evidence", "grading_failed", "escalated"].includes(g.state)) stamp("pending");
        return send({ pass: false, state: g.state, label: "grading" });
      }
      const v = JSON.parse(body);
      gradeLog.push(v);
      if (v.outcome === "awaiting_evidence") stamp("awaiting_evidence");
      else if (v.outcome === "satisfied") stamp("satisfied");
      else if (v.outcome === "needs_revision") stamp(++g.attempts >= 3 ? "escalated" : "needs_revision");
      else if (v.outcome === "grading_failed") stamp("grading_failed");
      else stamp("escalated");
      return send(g);
    }
    // The board's retry window for a failed grading pass is a minute; the fake shortens it so a flow can see the retry.
    const retryDue = (g) => (g.state === "grading_failed" ? Date.now() - Date.parse(g.updatedAt) >= 2000 : false);
    if (path === "/internal/grades" && req.method === "GET") return send({ on: grades.size > 0 && !gradingOff, grades: [...grades.values()].filter((g) => ["pending", "awaiting_evidence"].includes(g.state) || retryDue(g)), resubmitted: [] });
    if (path === "/grader" && req.method === "POST") {
      graderCalls.push(JSON.parse(body));
      const next = graderAnswers.shift();
      if (next?.abort) {
        res.writeHead(500, { "content-type": "text/plain" });
        return res.end("The operation was aborted due to timeout");
      }
      return send({ choices: [{ message: { content: JSON.stringify(next ?? { verdict: "cannot_judge", criteria: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    // A Tier 0 run's audit row: only with the runner's key.
    if (path === "/internal/approvals/auto" && req.method === "POST") {
      const b = JSON.parse(body);
      const extra = strictArgs(b.args);
      if (extra.length) return send({ error: extra.join(", ") }, 400);
      autos.push({ key: req.headers["x-reviewer-key"], ...b });
      return send({ state: "auto" });
    }
    const approval = /^\/internal\/approvals\/(A\d{8})\/(claim|outcome)$/.exec(path);
    if (approval) {
      const a = approvals.get(approval[1]);
      if (approval[2] === "claim") {
        if (a?.state !== "approved") return send({ error: "not approved" }, 409);
        a.state = "used";
        return send({ ...a, nonce: "0".repeat(32) });
      }
      a.outcome = JSON.parse(body);
      return send({ ok: true });
    }
    // The board's internal API: the runner's activity for the Crew view, and messages passed on.
    if (path.startsWith("/internal/")) {
      if (path.endsWith("/runner/activity")) activity.push(JSON.parse(body));
      if (path.endsWith("/pass")) {
        passed.push({ path, ...JSON.parse(body) });
        return send({ passed: true, to: "Alfred", part: "PEN-3" });
      }
      return send({});
    }
    unknown.push(`${req.method} ${path}`);
    send({ error: "not found" }, 404);
  });
  /** The owner's decision on the newest pending card for an action. */
  const decide = (action, state) => {
    const a = [...approvals.values()].filter((x) => x.action === action && x.state === "pending").at(-1);
    assert.ok(a, `a pending ${action} card`);
    a.state = state;
    return a;
  };
  return { server, comments, patches, activity, held, passed, attached, unknown, addComment, approvals, autos, decide, issues, grades, gradeLog, graderCalls, graderAnswers, created, hang };
}

/**
 * Call inside a describe: starts a fake Paperclip and the real runner for it, stops both after. `env`: more runner
 * environment; `runnerYaml`: more lines for config/runner.yaml.
 */
export function flow({ parent: parentOver, part: partOver, grants, grades, gradingOff, partComments: partCommentsOver = [], env = {}, runnerYaml = "" } = {}) {
  let dir, runner, runnerEnv, paperclip, output = "";
  const startRunner = () => {
    runner = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", RUNNER], { env: runnerEnv, stdio: ["ignore", "pipe", "pipe"] });
    runner.stdout.on("data", (d) => (output += d));
    runner.stderr.on("data", (d) => (output += d));
  };
  const fakeLog = () => (existsSync(join(dir, "fake.log")) ? readFileSync(join(dir, "fake.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const partComments = () => paperclip.comments.get("part").map((c) => c.body);
  const claudeRuns = () => fakeLog().filter((e) => e.kind === "claude").map((e) => e.data);
  const toolRuns = () => fakeLog().filter((e) => e.kind === "tool").map((e) => e.data);
  const step = (text) => writeFileSync(join(dir, "claude-step"), text);
  const say = (text) => paperclip.addComment("part", text);
  const context = () => `\nrunner output:\n${output.slice(-3000)}\ncomments on the part:\n${partComments().join("\n---\n")}\nunknown requests: ${paperclip.unknown.join(", ")}`;
  const waitFor = async (what, ok, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && runner.exitCode === null) {
      if (ok()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`timed out waiting for ${what}${context()}`);
  };
  const reviews = () => paperclip.patches.filter((p) => p.issue === "PEN-2" && p.status === "in_review");
  const starts = () => paperclip.patches.filter((p) => p.issue === "PEN-2" && p.status === "in_progress");
  /** One turn: the user's comment, then the agent's reply (the part back in review). */
  const turn = async (comment) => {
    const n = reviews().length;
    say(comment);
    await waitFor(`the reply to "${comment}"`, () => reviews().length > n);
    return reviews().at(-1);
  };
  const githubTip = (branch = "fix/remove-legacy") => git(dir, "--git-dir", join(dir, "github/acme/app.git"), "rev-parse", branch);

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "aidenhq-flow-"));
    const home = join(dir, "home");
    const config = join(dir, "config");
    const secrets = join(dir, "secrets");
    const bin = join(dir, "bin");
    for (const d of [home, config, secrets, bin, join(home, ".config/gcloud")]) mkdirSync(d, { recursive: true });

    // GitHub: bare repositories that git@github.com:<org>/<name>.git resolves to.
    writeFileSync(join(home, ".gitconfig"), `[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n[url "${join(dir, "github")}/"]\n\tinsteadOf = git@github.com:\n`);
    for (const slug of ["acme/app", "acme/infra"]) {
      const src = join(dir, "src", slug);
      mkdirSync(src, { recursive: true });
      git(src, "init", "-q");
      writeFileSync(join(src, "README.md"), `# ${slug}\n`);
      git(src, "add", "README.md");
      git(src, "commit", "-qm", "chore: initial commit");
      mkdirSync(dirname(join(dir, "github", slug)), { recursive: true });
      git(dir, "clone", "-q", "--bare", src, join(dir, "github", `${slug}.git`));
    }
    for (const name of ["bwrap", "codex", "claude", "gh"]) {
      writeFileSync(join(bin, name), name === "bwrap" || name === "codex" ? `#!/bin/sh\nexec "${join(FAKES, `${name}.sh`)}" "$@"\n` : `#!/bin/sh\nexec "${process.execPath}" "${join(FAKES, `${name}.mjs`)}" "$@"\n`);
      chmodSync(join(bin, name), 0o755);
    }

    writeFileSync(join(config, "system.yaml"), `paperclip:\n  company_id: "${COMPANY}"\nuser:\n  names: ["Dana"]\n`);
    writeFileSync(
      join(config, "runner.yaml"),
      `label: engineer
poll_seconds: 0.2
allowed_orgs: [acme]
work_dir: ${join(dir, "work")}
state_dir: ${join(dir, "state")}
max_concurrent: 1
timeout_minutes: 2
engines:
  claude:
    token_file: ${join(secrets, "claude_oauth_token")}
    config_dir: ${join(dir, "state/claude")}
gcp:
  credentials: ${join(secrets, "gcloud/application_default_credentials.json")}
intake:
  codex_args: []
  timeout_seconds: 30
replies:
  enabled: false
reviews:
  enabled: false
recurring:
  enabled: false
${runnerYaml}`,
    );
    if (grants) {
      mkdirSync(join(config, "grants"), { recursive: true });
      writeFileSync(join(config, "grants", "grants.json"), JSON.stringify(grants));
    }
    writeFileSync(join(secrets, "paperclip_board_key"), "board-key\n", { mode: 0o600 });
    writeFileSync(join(secrets, "claude_oauth_token"), "claude-token\n", { mode: 0o600 });
    writeFileSync(join(secrets, "board_internal_token"), "board-token\n", { mode: 0o600 });

    // PEN-2713/PEN-2714: the repositories are on the user's task; Ada's part only says go.
    const engineers = [
      { id: "engineer-claude", name: "Engineer · Claude", status: "idle", adapterType: "claude_local", adapterConfig: {}, metadata: { setupKey: "aidenhq:engineer-claude", persona: { name: "Ada" }, privateReads: true } },
      { id: "engineer-codex", name: "Engineer · Codex", status: "idle", adapterType: "codex_local", adapterConfig: {}, metadata: { setupKey: "aidenhq:engineer-codex", persona: { name: "Grace" }, privateReads: true } },
    ];
    const parent = { id: "parent", identifier: "PEN-1", title: "Drop Legacy support", status: "todo", assigneeUserId: USER, createdByUserId: USER, createdByAgentId: null, labels: [], description: "Remove Legacy from these repos:\n\n- acme/app\n- acme/infra\n" };
    const part = { id: "part", identifier: "PEN-2", title: "Drop Legacy support", status: "todo", parentId: "parent", assigneeAgentId: "engineer-claude", assigneeUserId: null, createdByUserId: USER, createdByAgentId: null, labels: [], description: "Ada, go ahead and start this on dev please" };
    // PEN-3155: Alfred's report is a comment on the user's task, and the user asks Ada to take it over.
    const alfred = { id: "assistant", name: "Researcher", status: "idle", adapterType: "codex_local", adapterConfig: {}, metadata: { setupKey: "aidenhq:assistant", persona: { name: "Alfred" } } };
    const parentComments = [{ id: "alfred-report", authorType: "agent", authorAgentId: "assistant", body: "## Legacy usage — preliminary\n\nLegacy is still read by the infra alerts.", createdAt: new Date(Date.now() - 60_000).toISOString() }];
    // Alfred's part of the same task: his chat, where the user may write to Ada from.
    const alfredPart = { id: "alfred-part", identifier: "PEN-3", title: "Drop Legacy support", status: "todo", parentId: "parent", assigneeAgentId: "assistant", assigneeUserId: null, labels: [], description: "Draft the changelog entry" };
    const alfredChat = [
      { id: "alfred-1", authorType: "user", authorUserId: USER, body: "Draft the changelog entry", createdAt: new Date(Date.now() - 50_000).toISOString() },
      { id: "alfred-2", authorType: "agent", authorAgentId: "assistant", body: "Draft: Legacy support is removed from the app and the alerts.", createdAt: new Date(Date.now() - 40_000).toISOString() },
    ];
    Object.assign(parent, parentOver);
    Object.assign(part, partOver);
    paperclip = fakePaperclip({ parent, part, engineers: [...engineers, alfred], parentComments, partComments: partCommentsOver, others: [{ issue: alfredPart, comments: alfredChat }], grades: new Map(Object.entries(grades ?? {}).map(([id, g]) => [id, { issueId: id, attempts: 0, state: "open", verdicts: [], updatedAt: new Date(0).toISOString(), ...g }])), gradingOff });
    await new Promise((r) => paperclip.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${paperclip.server.address().port}`;

    step("commit");
    runnerEnv = {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH}`,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        AIDENHQ_CONFIG_DIR: config,
        AIDENHQ_SECRETS_DIR: secrets,
        AIDENHQ_ENV_FILE: join(dir, "none.env"),
        PAPERCLIP_URL: url,
        BOARD_INTERNAL_URL: url,
        FAKE_LOG: join(dir, "fake.log"),
        FAKE_STEP: join(dir, "claude-step"),
        AIDENHQ_GRADER_URL: `${url}/grader`,
        ...env,
    };
    startRunner();
  });
  after(() => {
    runner?.kill("SIGKILL");
    paperclip?.server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  // An agent turn or publishing in progress (the merge queue runs on in the background: GitHub fails here).
  const running = () => (paperclip.activity.at(-1)?.running ?? []).some((r) => r.identifier === "PEN-2" && r.mode !== "merging PRs");
  /** The first run (the assignment's) has replied and nothing is running. */
  const settled = async () => {
    await waitFor("the first reply", () => reviews().length > 0);
    await waitFor("quiet", () => !running());
  };
  /** The exact word pr: the branch is on GitHub afterwards. */
  const publish = async () => {
    const n = partComments().length;
    say("pr");
    await waitFor("the results", () => partComments().slice(n).some((c) => c.includes("| Branch | Result |")));
  };
  /** Lets a "slow" fake turn finish (it holds until this file exists). */
  const release = () => writeFileSync(join(dir, "release"), "");
  /** Time enough for the runner (polling every 50ms) to have acted on something, for "nothing happened" checks. */
  const idle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  /** The runner logged no error and never asked for a repository. */
  const noErrors = () => {
    assert.ok(!/"msg":"error"/.test(output), `the runner logged an error${context()}`);
    assert.ok(!partComments().some((c) => /Which repository|Runner error/.test(c)));
  };
  return {
    get dir() {
      return dir;
    },
    get runner() {
      return runner;
    },
    get runnerEnv() {
      return runnerEnv;
    },
    get paperclip() {
      return paperclip;
    },
    get output() {
      return output;
    },
    startRunner, fakeLog, partComments, claudeRuns, toolRuns, step, say, context, waitFor, reviews, starts, turn, githubTip, running, settled, publish, release, idle, noErrors,
  };
}
