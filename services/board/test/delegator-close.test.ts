// A delegator's close of an escalated grade, end to end: the real tasks bridge is spawned, its own `task_set_status done`
// asks the real board, and the patch it sends is what moves the task. The bridge is the path every agent takes, so this
// covers the close as a delegator makes it, rather than the board's gate route on its own.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "../../paperclip-tasks-mcp/paperclip-tasks-mcp.mjs");
const TOKEN = "t".repeat(64);
const RUNNER_KEY = "r".repeat(48);
const COMPANY = "co";
const REFUSED = "this task is graded: the grader closes it once its rubric is met (only its assignee finishes it)";

interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByAgentId: string | null;
  parentId: string | null;
  labelIds: string[];
  labels: { id: string; name: string }[];
}

const agents = [
  { id: "eng", name: "Engineer", companyId: COMPANY },
  { id: "cos", name: "Aiden", companyId: COMPANY },
  { id: "ra", name: "Alfred", companyId: COMPANY },
];
const task = (over: Partial<FakeIssue> & Pick<FakeIssue, "id" | "identifier">): FakeIssue => ({
  title: over.identifier,
  status: "in_progress",
  priority: "medium",
  assigneeAgentId: "eng",
  assigneeUserId: null,
  createdByAgentId: "ra",
  parentId: null,
  labelIds: [],
  labels: [],
  ...over,
});
// A graded sub-task of the delegator's own task: Aiden (cos) owns the parent, the Researcher (ra) filed this one, so the
// escalation's delegators are both of them, saved when the grade escalated.
const parent = task({ id: "55555555-5555-5555-5555-555555555555", identifier: "WOR-9", title: "Digest", assigneeAgentId: "cos", createdByAgentId: null });
const escalated = task({ id: "66666666-6666-6666-6666-666666666666", identifier: "WOR-10", title: "Weekly report", parentId: parent.id });
// The same shape, but its grade is still being graded: only the assignee may close it.
const held = task({ id: "77777777-7777-7777-7777-777777777777", identifier: "WOR-11", title: "Held report", parentId: parent.id, status: "in_review" });

/** Paperclip, for the board and the spawned bridge alike: one set of tasks, and every PATCH either of them sends. */
function fakePaperclip(initial: FakeIssue[]) {
  const issues = new Map<string, FakeIssue>(initial.flatMap((i) => [[i.id, i], [i.identifier, i]] as [string, FakeIssue][]));
  const patches: { task: string; body: Record<string, unknown> }[] = [];
  let comments = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://paperclip");
      const send = (x: unknown, code = 200) => (res.statusCode = code, res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      const me = agents.find((a) => a.id === String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
      if (url.pathname === "/api/agents/me") return me ? send(me) : send({ error: "unauthorized" }, 401);
      if (url.pathname === `/api/companies/${COMPANY}/labels`) return send([{ id: "lbl-grading", name: "grading", color: "#888" }]);
      if (url.pathname === `/api/companies/${COMPANY}/agents`) return send(agents);
      if (url.pathname === `/api/companies/${COMPANY}`) return send({ issuePrefix: "WOR", name: COMPANY });
      const m = /^\/api\/issues\/([^/]+?)(\/comments)?$/.exec(url.pathname);
      const issue = m ? issues.get(decodeURIComponent(m[1]!)) : undefined;
      if (!m || !issue) return send({ error: "no such task" }, 404);
      if (m[2]) return req.method === "POST" ? send({ id: `c${++comments}`, body: String((JSON.parse(body) as { body?: string }).body ?? ""), authorType: "agent", createdAt: new Date().toISOString() }) : send([]);
      if (req.method === "PATCH") {
        const patch = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        patches.push({ task: issue.identifier, body: patch });
        Object.assign(issue, patch);
      }
      return send(issue);
    });
  });
  return new Promise<{ url: string; patches: typeof patches; issue: (ref: string) => FakeIssue | undefined; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, patches, issue: (ref) => issues.get(ref), close: () => server.close() }),
    );
  });
}

/** The grants table both the board and the bridge read: what each agent may do (never Paperclip metadata). */
function grantsFile() {
  const tools = { paperclip_tasks: ["task_set_status", "task_finish", "task_delegate"] };
  const file = join(mkdtempSync(join(tmpdir(), "delegator-close-")), "grants.json");
  writeFileSync(file, JSON.stringify({ agents_org: "acme", product_repo: "own/aidenhq", agents: { eng: { key: "engineer-openrouter", roles: [], tools }, cos: { key: "chief-of-staff", roles: [], tools }, ra: { key: "research-assistant", roles: [], tools } } }));
  return file;
}

/** A real board on its own store, behind the fake Paperclip. Its allowed hosts grow once it is listening. */
async function board(pcUrl: string) {
  const allowedHosts = ["board:3122"];
  const store = new Store(":memory:");
  const app = createApp({ paperclip: new Paperclip(pcUrl, COMPANY, "board"), store, log: pino({ level: "silent" }), allowedHosts, staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, reviewerKey: RUNNER_KEY });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const port = (app.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`);
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    post: async (path: string, body: unknown, headers: Record<string, string>) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    },
    close: () => app.close(),
  };
}

/** One real `tools/call` through the spawned bridge, authenticated as the agent whose run key it is given. */
function callBridge(name: string, args: Record<string, unknown>, env: { agent: string; paperclip: string; board: string; grants: string }) {
  return new Promise<{ isError: boolean; text: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], {
      // Only what the bridge reads: never the whole environment, so no other credential reaches the child.
      env: {
        PAPERCLIP_API_URL: env.paperclip,
        PAPERCLIP_API_KEY: env.agent,
        PAPERCLIP_COMPANY_ID: COMPANY,
        PAPERCLIP_TASK_ID: "",
        AIDENHQ_GRANTS_FILE: env.grants,
        AIDENHQ_BOARD_URL: env.board,
        AIDENHQ_BOARD_TOKEN: TOKEN,
      },
    });
    let out = "";
    const timer = setTimeout(() => (child.kill(), reject(new Error(`the bridge did not answer: ${out}`))), 20_000);
    child.stdout.on("data", (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.includes('"id":1'));
      if (!line) return;
      clearTimeout(timer);
      child.kill();
      const result = JSON.parse(line).result ?? {};
      resolve({ isError: result.isError === true, text: result.content?.[0]?.text ?? "" });
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}

const opened: (() => void)[] = [];
afterEach(() => {
  while (opened.length) opened.pop()!();
});

/** A board with a filed rubric on `issue`, and the verdicts that escalate it (each a distinct rejected version). */
async function escalatedBoard(issue: FakeIssue, versions: string[]) {
  const grants = grantsFile();
  process.env.AIDENHQ_GRANTS_FILE = grants;
  const pc = await fakePaperclip([parent, escalated, held]);
  const b = await board(pc.url);
  opened.push(pc.close, b.close);
  const filed = await b.post("/internal/grades", { issue: issue.identifier, rubric: ["names the three failures", "each has a source link", "the summary fits one screen"], deliverable: { kind: "report", ref: "" } }, { "x-agent-key": "ra" });
  expect(filed.status).toBe(200);
  const reject = (version: string) =>
    b.post(`/internal/grades/${issue.identifier}/verdict`, { version, outcome: "needs_revision", model: "glm", criteria: [{ id: "1", met: "no", evidence: "missing" }] }, { "x-reviewer-key": RUNNER_KEY });
  for (const version of versions) expect((await reject(version)).status).toBe(200);
  return { pc, b, grants, bridge: { paperclip: pc.url, board: b.url, grants } };
}

describe("a delegator closes an escalated grade through the tasks bridge", () => {
  it("spawns the bridge, sends {status: done}, and the board settles the grade accepted by the delegator", async () => {
    const { pc, b, bridge } = await escalatedBoard(escalated, ["v1", "v2", "v3"]);
    expect(b.store.grades.get(escalated.id)).toMatchObject({ state: "escalated", delegators: ["ra", "cos"] });
    expect(pc.issue(escalated.identifier)!.status).toBe("in_progress");

    const closing = await callBridge("task_set_status", { issue: escalated.identifier, status: "done" }, { agent: "cos", ...bridge });
    expect(closing.isError, closing.text).toBe(false);
    expect(closing.text).toContain('"status": "done"');
    // The patch the bridge sends is the status alone, and it is what closes the task.
    expect(pc.patches.map((p) => p.body)).toEqual([{ status: "done" }]);
    expect(pc.issue(escalated.identifier)!.status).toBe("done");
    // The delegator's close accepted the work in place of a verdict.
    expect(b.store.grades.get(escalated.id)).toMatchObject({ state: "satisfied", attempts: 3, verdicts: [{ verdict: "needs_revision" }, { verdict: "needs_revision" }, { verdict: "needs_revision" }, { verdict: "accepted", by: "cos" }] });
  });

  it("refuses a graded task that is not escalated to anyone but its assignee, and sends no patch", async () => {
    const { pc, b, bridge } = await escalatedBoard(held, ["v1"]);
    expect(b.store.grades.get(held.id)).toMatchObject({ state: "needs_revision" });

    // The delegator's close is refused, and nothing is written: the task stays where the grader left it.
    const closing = await callBridge("task_set_status", { issue: held.identifier, status: "done" }, { agent: "cos", ...bridge });
    expect(closing.isError).toBe(true);
    expect(closing.text).toContain(REFUSED);
    expect(pc.patches).toEqual([]);
    expect(pc.issue(held.identifier)!.status).toBe("in_review");
    expect(b.store.grades.get(held.id)).toMatchObject({ state: "needs_revision" });

    // Its assignee may close it, which hands it back to the grader instead of finishing it.
    const finishing = await callBridge("task_set_status", { issue: held.identifier, status: "done" }, { agent: "eng", ...bridge });
    expect(finishing.isError, finishing.text).toBe(false);
    expect(b.store.grades.get(held.id)).toMatchObject({ state: "pending" });
    expect(pc.issue(held.identifier)!.status).toBe("in_review");
  });
});
