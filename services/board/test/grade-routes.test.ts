import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { asAgent } from "./caller.js";
import { checks } from "../src/fleet-ops.js";
import { backfillEscalatedDelegators, completionGate } from "../src/grades.js";
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
  { id: "other", name: "Someone else", companyId: "co" },
];
const grantsFile = join(mkdtempSync(join(tmpdir(), "grades-")), "grants.json");
const grantsTable = { agents_org: "acme", product_repo: "own/aidenhq", agents: { eng: { key: "engineer-openrouter", roles: [], tools }, cos: { key: "chief-of-staff", roles: [], tools }, ra: { key: "research-assistant", roles: ["engineer-dispatch"], tools: { paperclip_tasks: ["task_create_engineer_task", "task_set_status", "task_finish"] } }, other: { key: "someone", roles: [], tools } } };
writeFileSync(grantsFile, JSON.stringify(grantsTable));
process.env.AIDENHQ_GRANTS_FILE = grantsFile;

const task = { id: "33333333-3333-3333-3333-333333333333", identifier: "WOR-7", title: "T", status: "in_progress", assigneeAgentId: "eng", createdByAgentId: "cos", labels: [] as { id: string }[] };
// An Engineer sub-task the Researcher created (task_create_engineer_task): it has no task_delegate.
const engineerTask = { ...task, id: "44444444-4444-4444-4444-444444444444", identifier: "WOR-8", createdByAgentId: "ra" };
// A graded sub-task of Alfred's own task: Aiden (cos) owns the parent, so the escalation is addressed to it, while the task
// itself was filed by the Researcher (ra). The two are different agents, which is the case the close has to allow.
const parentTask = { ...task, id: "55555555-5555-5555-5555-555555555555", identifier: "WOR-9", assigneeAgentId: "cos", createdByAgentId: null };
const childTask = { ...task, id: "66666666-6666-6666-6666-666666666666", identifier: "WOR-10", parentId: parentTask.id, createdByAgentId: "ra" };
// A task filed by no agent at all: an escalated grade on it has no delegator to fall back to.
const orphanTask = { ...task, id: "77777777-7777-7777-7777-777777777777", identifier: "WOR-11", createdByAgentId: null };
const patches: Record<string, unknown>[] = [];
/** A comment on the task that reads like an escalation note, written by an agent the grade was never addressed to. */
const lookalike = { id: "c1", body: "Escalation: this grade is now other's call, so other may close it.", authorAgentId: "other", createdAt: "2026-11-14T09:00:00.000Z" };
const comments = vi.fn(async () => [lookalike]);
/** The task's saved Paperclip review path: its scheduled check, as a time. */
const reviewCheck = (patch: Record<string, unknown>) => Date.parse((patch.executionPolicy as { monitor?: { nextCheckAt?: string } }).monitor?.nextCheckAt ?? "");
const pc = {
  companyId: "co",
  issue: async (ref: string) => ({ [engineerTask.identifier]: engineerTask, [engineerTask.id]: engineerTask, [parentTask.identifier]: parentTask, [parentTask.id]: parentTask, [childTask.identifier]: childTask, [childTask.id]: childTask, [orphanTask.identifier]: orphanTask, [orphanTask.id]: orphanTask })[ref] ?? task,
  comments,
  labels: async () => [{ id: "lbl-grading", name: "grading" }],
  agents: async () => agents,
  updateIssue: async (id: string, body: Record<string, unknown>) => (patches.push(body), Object.assign({ [engineerTask.id]: engineerTask, [childTask.id]: childTask }[id] ?? task, body)),
} as unknown as Paperclip;

/** A board on its own store, and the escalated-or-not gate call one agent makes on a task there. */
async function gateApp(store: Store, paperclip: Paperclip = pc): Promise<{ gateFor: (task: string, who: string) => Promise<{ status: number; json: any }>; close: () => void }> {
  const app = createApp({ paperclip, store, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, reviewerKey: RUNNER_KEY });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const port = (app.address() as AddressInfo).port;
  return {
    gateFor: (task, who) =>
      new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", path: `/internal/grades/${task}/gate`, headers: { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...asAgent(who) } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
        });
        req.on("error", reject);
        req.end(JSON.stringify({ via: "task_set_status" }));
      }),
    close: () => app.close(),
  };
}

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
  const as = (id: string) => asAgent(id);
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
    expect(patches.at(-1)).toMatchObject({ status: "in_review", labelIds: ["lbl-grading"] });
    expect(reviewCheck(patches.at(-1)!)).toBeGreaterThan(Date.now());
  });

  it("an Engineer sub-task's creator files its rubric without task_delegate; an ungranted caller can't", async () => {
    const grade = { issue: "WOR-8", rubric: [], deliverable: { kind: "pr", ref: "" } };
    expect((await post("/internal/grades", grade, as("forged"))).status).toBe(403);
    expect((await post("/internal/grades", grade, as("ra"))).json).toEqual({ created: true, state: "open" });
  });

  it("satisfied is not sticky: a reopened task finished again is graded again, with a saved review path", async () => {
    expect((await post("/internal/grades/WOR-7/verdict", { version: "sha1", outcome: "satisfied", model: "glm" }, runner)).json.state).toBe("satisfied");
    task.status = "done";
    expect((await gate(runner, "finish_merges")).json).toEqual({ pass: true });
    task.status = "todo"; // reopened
    expect((await gate(as("eng"))).json).toMatchObject({ pass: false, state: "pending" });
    // The re-finished task is held for grading with the scheduled check that keeps Paperclip from repairing a lost review path.
    expect(reviewCheck(patches.at(-1)!)).toBeGreaterThan(Date.now());
  });

  it("an escalated task stays escalated until a new deliverable version", async () => {
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

  // The app's status row keeps a bounded deploy list, so a merge it has moved past is looked up by exact commit instead;
  // the board forwards that to apps-mcp with the apps token and the runner's own key.
  it("the grader reads one commit's deploys from apps-mcp, with the runner's key and the apps token", async () => {
    const sha = "a".repeat(40);
    const calls: { url: string; init: RequestInit }[] = [];
    const prev = process.env.APPS_INTERNAL_TOKEN_FILE;
    process.env.APPS_INTERNAL_TOKEN_FILE = `${import.meta.dirname}/fixtures/apps_token`;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ deploys: [{ sha, at: 1_700_000_000_000, by: "auto-deploy", status: "healthy" }] }));
    });
    const get = (path: string, headers: Record<string, string>) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
        });
        req.on("error", reject);
        req.end();
      });
    try {
      // Only the runner's own key opens it: the internal token alone is readable by agents.
      expect((await get(`/internal/grades/deploys/keeper/${sha}`, {})).status).toBe(403);
      // Only a full sha: a short one could match nothing and read as never deployed.
      expect((await get("/internal/grades/deploys/keeper/aaaaaaaa", runner)).status).toBe(404);
      const r = await get(`/internal/grades/deploys/keeper/${sha}`, runner);
      expect(r.json).toEqual({ deploys: [{ sha, at: 1_700_000_000_000, by: "auto-deploy", status: "healthy" }] });
      expect(calls.map((c) => c.url)).toEqual([`http://apps-mcp:8090/internal/deploys/keeper/${sha}`]);
      expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer apps-token");
      expect((calls[0]!.init.headers as Record<string, string>)["x-reviewer-key"]).toBeUndefined(); // the board's own call, not relayed
    } finally {
      vi.unstubAllGlobals();
      if (prev === undefined) delete process.env.APPS_INTERNAL_TOKEN_FILE;
      else process.env.APPS_INTERNAL_TOKEN_FILE = prev;
    }
  });

  it("an escalated grade is its delegator's to accept, never a line on the owner's channel", async () => {
    const s = new Store(":memory:");
    s.grades.file(task.id, [], { kind: "report", ref: "" });
    completionGate(s.grades, task.id, "task_finish");
    for (let i = 0; i < 5; i++) s.grades.record(task.id, { version: "c1", outcome: "grading_failed", model: "glm", criteria: [] }, Date.now(), ["cos"]);
    expect(s.grades.get(task.id)!.state).toBe("escalated");
    const decideKey = "d".repeat(32);
    const app2 = createApp({ paperclip: pc, store: s, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, reviewerKey: RUNNER_KEY, gatewayKey: decideKey });
    await new Promise<void>((r) => app2.listen(0, "127.0.0.1", r));
    const port2 = (app2.address() as AddressInfo).port;
    const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: port2, method, path, headers: { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    try {
      expect((await call("GET", "/internal/owner/grades", { "x-gateway-key": decideKey })).json).toEqual({ lines: [] });
      // Its delegator's close accepts the work.
      expect((await call("POST", "/internal/grades/WOR-7/gate", asAgent("cos"), { via: "task_set_status" })).json).toEqual({ pass: true });
      const accepted = s.grades.get(task.id)!;
      expect(accepted.state).toBe("satisfied");
      expect(accepted.verdicts.at(-1)).toMatchObject({ verdict: "accepted", by: "cos" });
    } finally {
      app2.close();
    }
  });

  it("the delegator the escalation was addressed to closes it: the agent on the parent task, not only the task's creator", async () => {
    const s = new Store(":memory:");
    // Alfred's sub-task of Aiden's task, graded, and escalated: the runner's note lands on the parent, so Aiden is woken.
    s.grades.file(childTask.id, [], { kind: "report", ref: "" });
    completionGate(s.grades, childTask.id, "task_finish");
    for (let i = 0; i < 5; i++) s.grades.record(childTask.id, { version: "c1", outcome: "grading_failed", model: "glm", criteria: [] }, Date.now(), ["ra", "cos"]);
    expect(s.grades.get(childTask.id)!.state).toBe("escalated");
    const { gateFor, close } = await gateApp(s);
    try {
      // An agent that is neither the assignee, the task's creator nor the parent's agent still can't close it.
      expect((await gateFor("WOR-10", "other")).status).toBe(403);
      expect(s.grades.get(childTask.id)!.state).toBe("escalated");
      expect((await gateFor("WOR-10", "cos")).json).toEqual({ pass: true });
      const accepted = s.grades.get(childTask.id)!;
      expect(accepted.state).toBe("satisfied");
      expect(accepted.verdicts.at(-1)).toMatchObject({ verdict: "accepted", by: "cos" });
    } finally {
      close();
    }
  });

  it("re-parenting after the escalation does not grant the close: the delegator is the one saved when it escalated", async () => {
    const s = new Store(":memory:");
    s.grades.file(childTask.id, [], { kind: "report", ref: "" });
    completionGate(s.grades, childTask.id, "task_finish");
    for (let i = 0; i < 5; i++) s.grades.record(childTask.id, { version: "c1", outcome: "grading_failed", model: "glm", criteria: [] }, Date.now(), ["ra", "cos"]);
    // Afterwards the task moves under a parent that "other" is assigned to.
    Object.assign(parentTask, { assigneeAgentId: "other" });
    const { gateFor, close } = await gateApp(s);
    try {
      expect((await gateFor("WOR-10", "other")).status).toBe(403);
      expect(s.grades.get(childTask.id)!.state).toBe("escalated");
    } finally {
      Object.assign(parentTask, { assigneeAgentId: "cos" });
      close();
    }
  });

  it("an escalated row that saved no delegators falls back to its creator, and one with no creator fails closed", async () => {
    const s = new Store(":memory:");
    s.grades.file(task.id, [], { kind: "report", ref: "" });
    completionGate(s.grades, task.id, "task_finish");
    // Escalated before the delegators column was populated: the row has none saved.
    s.grades.record(task.id, { version: "c1", outcome: "cannot_judge", model: "glm", criteria: [] });
    expect(s.grades.get(task.id)).toMatchObject({ state: "escalated", delegators: null });
    const { gateFor, close } = await gateApp(s);
    try {
      expect((await gateFor("WOR-7", "cos")).json).toEqual({ pass: true });
      expect(s.grades.get(task.id)!.verdicts.at(-1)).toMatchObject({ verdict: "accepted", by: "cos" });
    } finally {
      close();
    }
    // The same row on a task no agent filed: no fallback exists, so nobody but its assignee closes it.
    const noCreator = new Store(":memory:");
    noCreator.grades.file(orphanTask.id, [], { kind: "report", ref: "" });
    completionGate(noCreator.grades, orphanTask.id, "task_finish");
    noCreator.grades.record(orphanTask.id, { version: "c1", outcome: "cannot_judge", model: "glm", criteria: [] });
    expect(noCreator.grades.get(orphanTask.id)).toMatchObject({ state: "escalated", delegators: null });
    const o = await gateApp(noCreator);
    try {
      for (const who of ["cos", "ra", "other"]) {
        expect((await o.gateFor("WOR-11", who)).status).toBe(403);
      }
      expect(noCreator.grades.get(orphanTask.id)!.state).toBe("escalated");
    } finally {
      o.close();
    }
  });

  it("an empty delegators list falls back to the creator; a non-empty list decides alone", async () => {
    const s = new Store(":memory:");
    s.grades.file(task.id, [], { kind: "report", ref: "" });
    completionGate(s.grades, task.id, "task_finish");
    s.grades.record(task.id, { version: "c1", outcome: "cannot_judge", model: "glm", criteria: [] }, Date.now(), []);
    expect(s.grades.get(task.id)).toMatchObject({ state: "escalated", delegators: [] });
    const { gateFor, close } = await gateApp(s);
    try {
      expect((await gateFor("WOR-7", "cos")).json).toEqual({ pass: true });
    } finally {
      close();
    }
    // A saved list without the caller refuses it, whatever the task's creator is.
    const saved = new Store(":memory:");
    saved.grades.file(task.id, [], { kind: "report", ref: "" });
    completionGate(saved.grades, task.id, "task_finish");
    saved.grades.record(task.id, { version: "c1", outcome: "cannot_judge", model: "glm", criteria: [] }, Date.now(), ["ra"]);
    const g = await gateApp(saved);
    try {
      expect((await g.gateFor("WOR-7", "cos")).status).toBe(403);
      expect((await g.gateFor("WOR-7", "other")).status).toBe(403);
      expect(saved.grades.get(task.id)!.state).toBe("escalated");
      expect((await g.gateFor("WOR-7", "ra")).json).toEqual({ pass: true });
    } finally {
      g.close();
    }
  });

  it("an escalation-lookalike comment grants nothing: its author is refused like any other outsider", async () => {
    const s = new Store(":memory:");
    s.grades.file(task.id, [], { kind: "report", ref: "" });
    completionGate(s.grades, task.id, "task_finish");
    s.grades.record(task.id, { version: "c1", outcome: "cannot_judge", model: "glm", criteria: [] }, Date.now(), ["ra"]);
    comments.mockClear();
    const { gateFor, close } = await gateApp(s);
    try {
      expect((await gateFor("WOR-7", "other")).status).toBe(403);
      expect(s.grades.get(task.id)!.state).toBe("escalated");
      expect(comments).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it("the backfill saves the creator on an escalated row that has no delegators, once, and leaves a row without one alone", async () => {
    const s = new Store(":memory:");
    for (const t of [task, orphanTask]) {
      s.grades.file(t.id, [], { kind: "report", ref: "" });
      completionGate(s.grades, t.id, "task_finish");
      s.grades.record(t.id, { version: "c1", outcome: "cannot_judge", model: "glm", criteria: [] });
    }
    const before = s.grades.get(task.id)!;
    const filled = await backfillEscalatedDelegators(s.grades, (id) => pc.issue(id));
    expect(filled.map((g) => g.issueId)).toEqual([task.id]);
    expect(s.grades.get(task.id)).toMatchObject({ delegators: ["cos"], state: "escalated", updatedAt: before.updatedAt });
    // A task with no creator is not filled: that row keeps failing closed.
    expect(s.grades.get(orphanTask.id)!.delegators).toBeNull();
    // Idempotent: a second run writes nothing and moves no timestamp.
    expect(await backfillEscalatedDelegators(s.grades, (id) => pc.issue(id))).toEqual([]);
    expect(s.grades.get(task.id)!.updatedAt).toBe(before.updatedAt);
    // The saved creator is the one that can now close it.
    const { gateFor, close } = await gateApp(s);
    try {
      expect((await gateFor("WOR-7", "cos")).json).toEqual({ pass: true });
    } finally {
      close();
    }
  });

  it("a graded task still being graded is refused to everyone but its assignee, escalation or not", async () => {
    const s = new Store(":memory:");
    s.grades.file(childTask.id, [], { kind: "report", ref: "" });
    completionGate(s.grades, childTask.id, "task_finish");
    expect(s.grades.get(childTask.id)!.state).toBe("pending");
    const { gateFor, close } = await gateApp(s);
    try {
      // Its delegator (the parent's agent) and the task's creator are both refused while it is still being graded.
      for (const who of ["cos", "ra"]) {
        const r = await gateFor("WOR-10", who);
        expect(r.status).toBe(403);
        expect(r.json.error).toMatch(/only its assignee finishes it/);
      }
      expect(s.grades.get(childTask.id)!.state).toBe("pending");
    } finally {
      close();
    }
  });

  it("cancelling a task while its evidence is awaited settles the row and refuses the late close, and the detector raises no grade: key", async () => {
    const s = new Store(":memory:");
    const cancelled = { ...task, id: "55555555-5555-5555-5555-555555555555", identifier: "WOR-9", status: "cancelled", cancelledAt: "2026-11-14T09:00:00.000Z" } as unknown as typeof task;
    const wrote: Record<string, unknown>[] = [];
    const own = {
      companyId: "co",
      issue: async () => cancelled,
      labels: async () => [{ id: "lbl-grading", name: "grading" }],
      updateIssue: async (_id: string, body: Record<string, unknown>) => void wrote.push(body),
    } as unknown as Paperclip;
    const app3 = createApp({ paperclip: own, store: s, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, reviewerKey: RUNNER_KEY });
    await new Promise<void>((r) => app3.listen(0, "127.0.0.1", r));
    const port3 = (app3.address() as AddressInfo).port;
    const post3 = (path: string, body: unknown) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: port3, method: "POST", path, headers: { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-reviewer-key": RUNNER_KEY } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
        });
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    try {
      s.grades.file(cancelled.id, [], { kind: "report", ref: "" });
      completionGate(s.grades, cancelled.id, "task_finish");
      s.grades.record(cancelled.id, { version: "", outcome: "awaiting_evidence", model: "", criteria: [] }, Date.now() - 2 * 86_400_000);
      // The runner's next look at the task: cancelled, so the close is refused (and with it the in_review patch that
      // would reopen it) while the row still ends settled, never stuck work.
      expect(await post3(`/internal/grades/${cancelled.id}/gate`, { via: "finish_turn" })).toEqual({ status: 409, json: { error: "the task is cancelled" } });
      expect(s.grades.get(cancelled.id)).toMatchObject({ state: "not_graded", closedReason: "the task was cancelled before the grader settled it" });
      expect(wrote).toEqual([]); // no status, label or review-path write
      expect(cancelled.status).toBe("cancelled");
      expect(await checks({ companyId: "co", issue: async () => cancelled } as never, s as never, () => Date.now(), {}).grade!()).toEqual([]);
    } finally {
      app3.close();
    }
  });
});
