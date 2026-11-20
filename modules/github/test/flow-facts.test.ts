// The code host's Flow facts end to end against a fake GitHub and a fake kernel: the backfill records each PR's authors, pushes,
// CI per head and a close without a merge, and a re-run after the backfill's version changed records only what is new.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFlow } from "../service/src/flow.ts";

const run = (name, at, end, conclusion = "success") => ({ name, started_at: at, completed_at: end, conclusion });
const FIXTURE = {
  "/repos/Acme/App/issues": [
    { number: 1, created_at: "2026-11-10T08:00:00Z", user: { login: "Mudit-Owner" }, author_association: "OWNER", labels: [{ name: "agent-fix" }], state: "closed" },
    { number: 2, pull_request: {}, created_at: "2026-11-10T09:00:00Z", user: { login: "acme-agents[bot]" } },
  ],
  "/repos/Acme/App/issues/events": [{ id: 77, event: "labeled", created_at: "2026-11-10T08:05:00Z", label: { name: "agent-fix" }, actor: { login: "Mudit-Owner" }, issue: { number: 1 } }],
  "/repos/Acme/App/pulls": [
    { number: 2, title: "Fix the thing", state: "closed", merged_at: "2026-11-10T12:00:00Z", merge_commit_sha: "m".repeat(40), created_at: "2026-11-10T09:00:00Z", updated_at: "2026-11-10T12:00:00Z", user: { login: "acme-agents[bot]" }, head: { sha: "c3", ref: "fix" }, body: "" },
    { number: 3, title: "Stranger's PR", state: "closed", merged_at: null, closed_at: "2026-11-11T10:00:00Z", created_at: "2026-11-11T09:00:00Z", updated_at: "2026-11-11T10:00:00Z", user: { login: "someone" }, author_association: "FIRST_TIME_CONTRIBUTOR", head: { sha: "d1", ref: "x" }, body: "" },
    { number: 4, title: "Owner's PR", state: "open", merged_at: null, created_at: "2026-11-11T11:00:00Z", updated_at: "2026-11-11T11:00:00Z", user: { login: "Mudit-Owner" }, author_association: "CONTRIBUTOR", head: { sha: "e1", ref: "y" }, body: "" },
  ],
  "/repos/Acme/App/issues/2/timeline": [
    { event: "committed", sha: "c1", committer: { date: "2026-11-10T08:50:00Z" }, author: { name: "acme-agents[bot]" } },
    { event: "committed", sha: "c2", committer: { date: "2026-11-10T09:30:00Z" }, author: { name: "acme-agents[bot]" } },
    { event: "head_ref_force_pushed", commit_id: "c3", created_at: "2026-11-10T10:00:00Z", actor: { login: "acme-agents[bot]" } },
  ],
  "/repos/Acme/App/issues/3/timeline": [{ event: "committed", sha: "d1", committer: { date: "2026-11-11T08:50:00Z" }, author: { name: "someone" } }],
  "/repos/Acme/App/commits/c1/check-runs": { check_runs: [run("test", "2026-11-10T09:01:00Z", "2026-11-10T09:03:00Z")] },
  "/repos/Acme/App/commits/c2/check-runs": { check_runs: [run("test", "2026-11-10T09:31:00Z", "2026-11-10T09:34:00Z", "failure")] },
  "/repos/Acme/App/commits/c3/check-runs": { check_runs: [run("test", "2026-11-10T10:01:00Z", "2026-11-10T10:03:00Z")] },
  "/repos/Acme/App/commits/d1/check-runs": { check_runs: [] },
  "/repos/Acme/App/issues/4/timeline": [],
  "/repos/Acme/App/commits/e1/check-runs": { check_runs: [] },
  // A private org member: GitHub says CONTRIBUTOR, the permission read says admin.
  "/repos/Acme/App/collaborators/Mudit-Owner/permission": { permission: "admin" },
  "/repos/Acme/App/collaborators/someone/permission": { permission: "read" },
};

async function harness(t, cacheDir) {
  const facts = [];
  const kernel = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    facts.push(...JSON.parse(body).facts);
    res.writeHead(200).end("{}");
  });
  await new Promise((ok) => kernel.listen(0, "127.0.0.1", ok));
  t.after(() => kernel.close());
  const gh = async (method, path) => {
    const [p, q] = path.split("?");
    const page = Number(/(?:^|&)page=(\d+)/.exec(q ?? "")?.[1] ?? 1);
    const body = FIXTURE[p];
    return { status: body ? 200 : 404, body: page > 1 ? [] : body ?? {}, remaining: 4000 };
  };
  const flow = createFlow({
    kernelUrl: `http://127.0.0.1:${kernel.address().port}`, key: "k", cacheDir, log: () => {},
    repos: async () => ["Acme/App"], token: async () => "tok", gh,
    appLogin: async () => "acme-agents[bot]", now: () => new Date("2026-11-10T08:30:00Z"),
  });
  return { facts, flow };
}

test("the backfill records authors, pushes, CI per head and a close without a merge; it runs once per version", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "flow-facts-"));
  // A backfill an older version finished: it starts over.
  writeFileSync(join(cacheDir, "backfill.json"), JSON.stringify({ done: {}, status: { state: "done", emitted: 9 } }));
  const { facts, flow } = await harness(t, cacheDir);
  await flow.backfill();
  const of = (type, subject) => facts.filter((f) => f.type === type && f.subject.startsWith(subject));

  const issue = of("issue.opened", "issue:acme/app#1")[0];
  assert.deepEqual([issue.data.author, issue.data.author_kind], ["Mudit-Owner", "owner"]);
  assert.deepEqual(of("issue.labeled", "issue:acme/app#1").map((f) => f.data), [{ label: "agent-fix", by: "Mudit-Owner" }]);

  const opened = of("pr.opened", "pr:acme/app#2")[0];
  assert.deepEqual([opened.data.title, opened.data.author_kind, opened.data.head], ["Fix the thing", "agent", "c1"]);
  assert.deepEqual(of("pr.opened", "pr:acme/app#3")[0].data.author_kind, "outside");
  assert.deepEqual(of("pr.opened", "pr:acme/app#4")[0].data.author_kind, "owner", "write on the repo is the owner's, whatever the association");

  const pushes = of("pr.pushed", "pr:acme/app#2");
  assert.deepEqual(pushes.map((f) => [f.version, f.data.before, f.data.forced]), [["c2", "c1", false], ["c3", "c2", true]]);
  assert.ok(pushes.every((f) => f.at.endsWith("Z")));
  assert.deepEqual(of("pr.checks_completed", "pr:acme/app#2@").map((f) => [f.subject, f.data.conclusion]),
    [["pr:acme/app#2@c1", "success"], ["pr:acme/app#2@c2", "failure"], ["pr:acme/app#2@c3", "success"]], "CI for every head, not only the current one");

  assert.equal(of("pr.merged", "pr:acme/app#2").length, 1);
  const closed = of("pr.closed", "pr:acme/app#3");
  assert.deepEqual(closed.map((f) => [f.data.merged, f.at]), [[false, "2026-11-11T10:00:00.000Z"]]);
  assert.equal(of("pr.closed", "pr:acme/app#2").length, 0, "a merged PR is not closed");

  const again = await harness(t, cacheDir);
  await again.flow.backfill();
  assert.equal(again.facts.length, 0, "recorded as done for this version: it doesn't run again");

  // Live: the issue pass records what changed since its cursor, with the same ids as the backfill.
  await again.flow.issuesRepo("Acme/App");
  await again.flow.flush();
  assert.deepEqual(again.facts.map((f) => [f.type, f.version, f.data.author_kind ?? f.data.by]), [["issue.opened", "2", "owner"], ["issue.labeled", "2:77", "Mudit-Owner"]]);
});

test("a cursor moves only once the kernel took the facts, a refused fact is dropped alone, a failed App lookup is retried", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "flow-cursor-"));
  const got = [];
  let down = true;
  const kernel = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const facts = JSON.parse(body).facts;
    if (down) return res.writeHead(503).end("{}");
    if (facts.some((f) => f.type === "issue.labeled")) return res.writeHead(400).end("{}"); // the bad one
    got.push(...facts);
    res.writeHead(200).end("{}");
  });
  await new Promise((ok) => kernel.listen(0, "127.0.0.1", ok));
  t.after(() => kernel.close());
  const gh = async (_m, path) => {
    const [p, q] = path.split("?");
    const page = Number(/(?:^|&)page=(\d+)/.exec(q ?? "")?.[1] ?? 1);
    return { status: FIXTURE[p] ? 200 : 404, body: page > 1 ? [] : FIXTURE[p] ?? {}, remaining: 4000 };
  };
  let lookups = 0;
  const flow = createFlow({
    kernelUrl: `http://127.0.0.1:${kernel.address().port}`, key: "k", cacheDir, log: () => {}, repos: async () => ["Acme/App"], token: async () => "tok", gh,
    appLogin: async () => { if (!lookups++) throw new Error("503"); return "acme-agents[bot]"; }, now: () => new Date("2026-11-10T08:30:00Z"),
  });
  await assert.rejects(flow.issuesRepo("Acme/App"));
  assert.equal(existsSync(join(cacheDir, "issues.json")), false, "the kernel was down: the cursor stays");
  down = false;
  await flow.issuesRepo("Acme/App");
  assert.equal(existsSync(join(cacheDir, "issues.json")), true);
  assert.deepEqual(got.map((f) => f.type), ["issue.opened"], "the refused label fact is dropped, the rest went");
  assert.equal(await flow.kindOf("acme-agents[bot]"), "agent", "the failed first lookup wasn't remembered as no App");
});
