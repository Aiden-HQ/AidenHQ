import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const TOKEN = "t".repeat(64);
const RUNNER_KEY = "r".repeat(48);
// The Engineer (the assignee) and Aiden (its delegator), by their own credentials; both may finish or close tasks.
const tools = { paperclip_tasks: ["task_finish", "task_set_status", "task_delegate"] };
const agents = [
  { id: "eng", name: "Engineer", companyId: "co" },
  { id: "cos", name: "Aiden", companyId: "co" },
];
const grantsFile = join(mkdtempSync(join(tmpdir(), "grades-")), "grants.json");
const grantsTable = { agents_org: "acme", product_repo: "own/aidenhq", agents: { eng: { key: "engineer-openrouter", roles: [], tools }, cos: { key: "chief-of-staff", roles: [], tools } } };
writeFileSync(grantsFile, JSON.stringify(grantsTable));
process.env.AIDENHQ_GRANTS_FILE = grantsFile;

const task = { id: "33333333-3333-3333-3333-333333333333", identifier: "WOR-7", title: "T", status: "in_progress", assigneeAgentId: "eng", createdByAgentId: "cos", labels: [] as { id: string }[] };
const patches: Record<string, unknown>[] = [];
const pc = {
  companyId: "co",
  agentMe: async (key: string) => agents.find((a) => a.id === key) ?? Promise.reject(new Error("401")),
  issue: async () => task,
  labels: async () => [{ id: "lbl-grading", name: "grading" }],
  updateIssue: async (_id: string, body: Record<string, unknown>) => (patches.push(body), Object.assign(task, body)),
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
});
