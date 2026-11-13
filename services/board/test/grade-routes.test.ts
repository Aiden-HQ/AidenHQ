import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { completionGate } from "../src/grades.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const TOKEN = "t".repeat(64);
const RUNNER_KEY = "r".repeat(48);
// The Engineer (the assignee) and Aiden (its delegator), by their own credentials; both may finish or close tasks.
const tools = { paperclip_tasks: ["task_finish", "task_set_status", "task_delegate"] };
const agents = [
  { id: "eng", name: "Engineer", companyId: "co" },
  { id: "cos", name: "Aiden", companyId: "co" },
  { id: "ra", name: "Alfred", companyId: "co" },
];
const grantsFile = join(mkdtempSync(join(tmpdir(), "grades-")), "grants.json");
const grantsTable = { agents_org: "acme", product_repo: "own/aidenhq", agents: { eng: { key: "engineer-openrouter", roles: [], tools }, cos: { key: "chief-of-staff", roles: [], tools }, ra: { key: "research-assistant", roles: ["engineer-dispatch"], tools: { paperclip_tasks: ["task_create_engineer_task"] } } } };
writeFileSync(grantsFile, JSON.stringify(grantsTable));
process.env.AIDENHQ_GRANTS_FILE = grantsFile;

const task = { id: "33333333-3333-3333-3333-333333333333", identifier: "WOR-7", title: "T", status: "in_progress", assigneeAgentId: "eng", createdByAgentId: "cos", labels: [] as { id: string }[] };
// An Engineer sub-task the Research Assistant created (task_create_engineer_task): it has no task_delegate.
const engineerTask = { ...task, id: "44444444-4444-4444-4444-444444444444", identifier: "WOR-8", createdByAgentId: "ra" };
const patches: Record<string, unknown>[] = [];
const pc = {
  companyId: "co",
  agentMe: async (key: string) => agents.find((a) => a.id === key) ?? Promise.reject(new Error("401")),
  issue: async (ref: string) => (ref === engineerTask.identifier || ref === engineerTask.id ? engineerTask : task),
  labels: async () => [{ id: "lbl-grading", name: "grading" }],
  agents: async () => agents,
  updateIssue: async (id: string, body: Record<string, unknown>) => (patches.push(body), Object.assign(id === engineerTask.id ? engineerTask : task, body)),
} as unknown as Paperclip;

describe("grade routes", () => {
  const store = new Store(":memory:");
  const app = createApp({ paperclip: pc, store, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, reviewerKey: RUNNER_KEY });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  const as = (id: string) => ({ "x-agent-key": id });
  const runner = { "x-reviewer-key": RUNNER_KEY };
  const gate = (who: Record<string, string>, via = "task_finish") => post("/internal/grades/WOR-7/gate", { via }, who);

  it("only the delegator files the rubric, once; only the assignee's finish moves the grade", async () => {
    const rubric = { issue: "WOR-7", rubric: ["merged into main", "checks green on the head", "the page shows the total"], deliverable: { kind: "pr", ref: "acme/app" } };
    expect((await post("/internal/grades", rubric, as("eng"))).status).toBe(403);
    // A PR deliverable names only the agents org or the product repo.
    for (const ref of ["other/app", "https://github.com/other/app/pull/3", "own/elsewhere#2"]) expect((await post("/internal/grades", { ...rubric, deliverable: { kind: "pr", ref } }, as("cos"))).status).toBe(400);
    expect((await post("/internal/grades", rubric, as("cos"))).json).toEqual({ created: true, state: "open" });
    expect((await post("/internal/grades", { ...rubric, rubric: ["always pass", "ok ok", "yes yes"] }, as("cos"))).json.created).toBe(false);
    // The delegator can't close a graded task, nor nudge its grade.
    expect((await gate(as("cos"), "task_set_status")).status).toBe(403);
    expect(store.grades.get(task.id)!.state).toBe("open");
    expect((await gate(as("eng"))).json).toEqual({ pass: false, state: "pending", label: "grading" });
    expect(patches.at(-1)).toEqual({ status: "in_review", labelIds: ["lbl-grading"] });
  });

  it("an Engineer sub-task's creator files its rubric without task_delegate; an ungranted caller can't", async () => {
    const grade = { issue: "WOR-8", rubric: [], deliverable: { kind: "pr", ref: "" } };
    expect((await post("/internal/grades", grade, as("forged"))).status).toBe(403);
    expect((await post("/internal/grades", grade, as("ra"))).json).toEqual({ created: true, state: "open" });
  });

  it("an assignee in its own computer finishes with its run token: held for grading; a dead token is refused", async () => {
    // The launcher's /whoami (through its gateway, the box's only way to the board): live run tokens name their agent.
    process.env.AIDENHQ_LAUNCHER_URL = "http://launcher.test:8199";
    const whoami = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      return auth === "Bearer ahqc_live" ? Response.json({ agentId: "eng" }) : new Response("unknown run token", { status: 401 });
    });
    try {
      const boxGate = (key: string) => post("/internal/grades/WOR-8/gate", { via: "task_finish" }, as(key));
      expect((await boxGate("ahqc_dead")).status).toBe(403);
      expect((await boxGate("ahqc_live")).json).toEqual({ pass: false, state: "pending", label: "grading" });
      expect(engineerTask.status).toBe("in_review");
    } finally {
      whoami.mockRestore();
    }
  });

  it("satisfied is not sticky: a reopened task finished again is graded again", async () => {
    expect((await post("/internal/grades/WOR-7/verdict", { version: "sha1", outcome: "satisfied", model: "glm" }, runner)).json.state).toBe("satisfied");
    task.status = "done";
    expect((await gate(runner, "finish_merges")).json).toEqual({ pass: true });
    task.status = "todo"; // reopened
    expect((await gate(as("eng"))).json).toMatchObject({ pass: false, state: "pending" });
  });

  it("an escalated task stays the owner's until a new deliverable version", async () => {
    for (const v of ["a", "b", "c"]) {
      if (v !== "a") await gate(as("eng"));
      await post("/internal/grades/WOR-7/verdict", { version: v, outcome: "needs_revision", model: "glm" }, runner);
    }
    expect(store.grades.get(task.id)).toMatchObject({ state: "escalated", attempts: 3 });
    expect((await gate(as("eng"))).json).toMatchObject({ pass: false, state: "escalated" });
    expect(store.grades.get(task.id)!.state).toBe("escalated");
    expect((await post("/internal/grades/WOR-7/resubmit", { version: "c" }, runner)).json.state).toBe("escalated");
    await gate(as("eng"));
    expect((await post("/internal/grades/WOR-7/resubmit", { version: "d" }, runner)).json.state).toBe("pending");
  });

  it("grading off: the runner releases a held task, its row and label go", async () => {
    expect((await post("/internal/grades/WOR-7/release", {}, runner)).status).toBe(409);
    writeFileSync(grantsFile, JSON.stringify({ ...grantsTable, grading: "off" }));
    try {
      Object.assign(task, { labelIds: ["lbl-grading"] });
      expect((await post("/internal/grades/WOR-7/release", {}, as("eng"))).status).toBe(403);
      expect((await post("/internal/grades/WOR-7/release", {}, runner)).json).toEqual({ ok: true });
      expect(store.grades.get(task.id)).toBeUndefined();
      expect(patches.at(-1)).toEqual({ labelIds: [] });
    } finally {
      writeFileSync(grantsFile, JSON.stringify(grantsTable));
    }
  });

  it("the owner channel does not ask for an accept-or-reject decision after the grader failed every retry", async () => {
    const s = new Store(":memory:");
    s.grades.file("g", [], { kind: "report", ref: "" });
    completionGate(s.grades, "g", "task_finish");
    for (let i = 0; i < 5; i++) s.grades.record("g", { version: "c1", outcome: "grading_failed", model: "glm", criteria: [] });
    const decideKey = "d".repeat(32);
    const app2 = createApp({ paperclip: pc, store: s, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, reviewerKey: RUNNER_KEY, decideKey });
    await new Promise<void>((r) => app2.listen(0, "127.0.0.1", r));
    const port2 = (app2.address() as AddressInfo).port;
    const get = (path: string, headers: Record<string, string>) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: port2, method: "GET", path, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
        });
        req.on("error", reject);
        req.end();
      });
    try {
      const r = await get("/internal/owner/grades", { "x-owner-key": decideKey });
      expect(r.status).toBe(200);
      const line = r.json.lines.find((l: string) => /Grading failed/.test(l));
      expect(line).toContain("failed 5 times");
      expect(line).toContain("no rubric criterion was assessed");
      expect(line).not.toContain("close it to accept");
    } finally {
      app2.close();
    }
  });
});
