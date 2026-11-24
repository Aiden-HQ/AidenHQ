import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Flow, Waterfall } from "../src/flow.js";
import type { Grade, Grading, GradesView } from "../src/grading.js";
import type { Comment, Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";
import { fakeStates } from "./fake-states.js";

const base = { priority: "medium", assigneeUserId: "me-1", assigneeAdapterOverrides: null, createdAt: "2026-11-10T10:00:00.000Z", updatedAt: "2026-11-10T10:05:00.000Z", assigneeAgentId: null };
const issue = (n: number, status = "in_progress"): Issue => ({ ...base, id: `0000000${n}-0000-0000-0000-000000000000`, identifier: `WOR-${n}`, title: `Task ${n}`, description: "x", status });
const [graded, ungraded, down, closed, bare, gaveUp] = [issue(1), issue(2), issue(3), issue(4, "done"), issue(5), issue(6, "done")];
const all = [graded, ungraded, down, closed, bare, gaveUp];
const verdict = { at: "2026-11-10T11:00:00.000Z", version: "abc123", model: "m", verdict: "needs_revision" as const, criteria: [{ id: "1", met: "yes" as const, evidence: "tests pass" }, { id: "2", met: "no" as const, evidence: "no docs" }] };
const row = (id: string, o: Partial<Grade>): Grade => ({ issueId: id, rubric: [], deliverable: { kind: "pr", ref: "Aiden-HQ/AidenHQ#12" }, attempts: 1, state: "needs_revision", verdicts: [], failures: 0, failedAt: null, delegators: null, closedReason: null, createdAt: "", updatedAt: "", ...o });
const rows: Record<string, Grade | null> = {
  [graded.id]: row(graded.id, { rubric: ["Tests pass", "Docs updated", "Reviewed"], verdicts: [verdict] }),
  [ungraded.id]: null,
  [closed.id]: row(closed.id, { rubric: ["a", "b", "c"], state: "satisfied", deliverable: { kind: "pr", ref: "" } }),
  [gaveUp.id]: row(gaveUp.id, { rubric: ["a", "b", "c"], state: "satisfied", verdicts: [verdict] }),
  [bare.id]: row(bare.id, { state: "open", deliverable: { kind: "report", ref: "" } }),
};
let gradingUp = true;
const grading: Grading = {
  grades: async (ids): Promise<GradesView> => {
    if (!gradingUp || ids.includes(down.id)) throw new Error("down");
    return { grades: Object.fromEntries(ids.map((i) => [i, rows[i] ?? null])), templates: { report: ["Says what was found", "Cites sources", "Answers the ask"] } };
  },
  settle: async () => null,
};
const fact = (type: string, subject: string, at: string, data: Record<string, unknown> = {}) => ({ type, subject, at, actor: "kernel", data });
const flow = {
  task: async (id: string): Promise<Waterfall> => ({
    task: id, root: id, stages: [], idle: [],
    facts: [
      fact("grade.verdict", "grade:x:1", "2026-11-10T10:55:00.000Z", { pass: false }),
      fact("task.created", `task:${id}`, "2026-11-10T10:00:00.000Z"),
      fact("job.started", "job:j-1111111111111111", "2026-11-10T10:01:00.000Z"),
      fact("job.ended", "job:j-1111111111111111", "2026-11-10T10:10:00.000Z", { state: "failed", why: "timeout" }),
      fact("work.waiting", `wait:${id}`, "2026-11-10T10:20:00.000Z", { reason: "owner_wait", question: "Ship it?" }),
      fact("record.decided", "record:R1", "2026-11-10T10:30:00.000Z", { decision: "approved", decider: "owner" }),
      fact("pr.deployed", "pr:Aiden-HQ/AidenHQ#12", "2026-11-10T10:40:00.000Z", { pr: "Aiden-HQ/AidenHQ#12", generation: 7 }),
    ],
  }),
} as unknown as Flow;
const pc = {
  me: async () => "me-1",
  agents: async () => [],
  labels: async () => [],
  company: async () => ({ issuePrefix: "WOR" }),
  openIssues: async () => all,
  issue: async (ref: string) => all.find((i) => i.id === ref || i.identifier === ref) ?? Promise.reject(new Error("404")),
  issueSummary: async (id: string) => all.find((i) => i.id === id),
  comments: async () => [] as Comment[],
  attachments: async () => [],
  children: async () => [],
} as unknown as Paperclip;

describe("task truth", () => {
  const app = createApp({ taskStates: fakeStates([]), paperclip: pc, store: new Store(":memory:"), records: fakeRecords([]), grading, flow, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const get = (i: Issue) =>
    new Promise<any>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path: `/api/issues/${i.identifier}`, headers: { host: "localhost:3120" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${res.statusCode} ${text}`))));
      });
      req.on("error", reject);
      req.end();
    });

  it("done means: the latest verdict's criteria with a PR link; unjudged criteria are unknown", async () => {
    const g = (await get(graded)).grade;
    expect(g).toMatchObject({ state: "needs_revision", version: "abc123", deliverable: { kind: "pr", href: "https://github.com/Aiden-HQ/AidenHQ/pull/12" } });
    expect(g.rubric).toEqual([{ text: "Tests pass", met: "yes", evidence: "tests pass" }, { text: "Docs updated", met: "no", evidence: "no docs" }, { text: "Reviewed", met: "unknown" }]);
  });

  it("no row shows nothing; a close without a verdict says so; an empty rubric uses the module's template; an empty ref has no link", async () => {
    expect((await get(ungraded)).grade.state).toBe("none");
    expect((await get(closed)).grade).toMatchObject({ state: "ungraded_close", deliverable: { ref: "" } });
    // The module closes a row satisfied when it gives up on unmet work: never shown as Met.
    expect((await get(gaveUp)).grade.state).toBe("ungraded_close");
    const b = (await get(bare)).grade;
    expect(b.rubric.map((r: { text: string }) => r.text)).toEqual(["Says what was found", "Cites sources", "Answers the ask"]);
    expect(b.deliverable.href).toBeUndefined();
  });

  it("an unreadable grading module is Grade unavailable, never passed", async () => {
    expect((await get(down)).grade.state).toBe("unavailable");
  });

  it("milestones: this task's facts in time order, a failed run with its reason, each source linked", async () => {
    const m = (await get(graded)).milestones;
    expect(m.map((x: { kind: string }) => x.kind)).toEqual(["created", "run_started", "run_ended", "asked_you", "approved", "deployed", "graded"]);
    expect(m.find((x: { kind: string }) => x.kind === "run_ended")).toMatchObject({ text: "Run failed: timeout", runId: "j-1111111111111111" });
    expect(m.find((x: { kind: string }) => x.kind === "approved")).toMatchObject({ href: "#/approvals/R1" });
    expect(m.find((x: { kind: string }) => x.kind === "deployed").href).toContain("/pull/12");
  });
});

describe("chat run line", () => {
  const chat: Issue = { ...issue(9), assigneeAgentId: "cos", labels: [{ id: "L", name: "chat", color: "#000" }], description: "hi\n\n<!-- aidenhq-chat-agent:cos -->" };
  const tag = (j: string) => `Done.\n\n<!-- aidenhq:job=${j} kind=reply -->`;
  const comments: Comment[] = [
    { id: "c1", body: tag("j-2222222222222222"), authorType: "agent", authorAgentId: "cos", createdAt: "2026-11-10T10:10:00.000Z" },
    { id: "c2", body: "Typed by hand.\n\n<!-- aidenhq-reply -->", authorType: "agent", authorAgentId: "cos", createdAt: "2026-11-10T10:20:00.000Z" },
  ];
  const chatPc = { ...pc, labelled: async () => [chat], openIssues: async () => [chat], issue: async () => chat, issueSummary: async () => chat, comments: async () => comments, labels: async () => chat.labels, agents: async () => [{ id: "cos", name: "Aiden", status: "idle", metadata: { setupKey: "aidenhq:chief-of-staff" } }] } as unknown as Paperclip;
  const chatFlow = { task: async () => ({ task: chat.id, root: chat.id, stages: [], idle: [], facts: [fact("wake.opened", "wake:w1", "2026-11-10T10:00:00.000Z", { cause: "routine:daily-brief", author: "kernel" }), fact("wake.bound", "wake:w1", "2026-11-10T10:00:05.000Z", { job: "j-2222222222222222" }), fact("job.started", "job:j-2222222222222222", "2026-11-10T10:00:00.000Z"), fact("job.ended", "job:j-2222222222222222", "2026-11-10T10:06:12.000Z", { state: "done" })] }) } as unknown as Flow;
  const work = { job: async () => null, task: async () => [{ id: "j-2222222222222222", started_at: "2026-11-10T10:00:00.000Z", ended_at: "2026-11-10T10:06:12.000Z" }], agent: async () => [], activity: async () => ({ running: [], recent: [], queued: [], parked: [], failing: [] }), stop: async () => [] };
  const app = createApp({ taskStates: fakeStates([]), paperclip: chatPc, store: new Store(":memory:"), records: fakeRecords([]), grading, flow: chatFlow, work: work as never, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());

  it("a reply carrying a job tag gets its run (seconds, what woke it); one without gets none", async () => {
    const r = await new Promise<any>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path: `/api/chats/${chat.identifier}`, headers: { host: "localhost:3120" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${res.statusCode} ${text}`))));
      });
      req.on("error", reject);
      req.end();
    });
    const replies = r.messages.filter((m: { kind: string }) => m.kind === "reply");
    expect(replies[0].run).toMatchObject({ id: "j-2222222222222222", seconds: 372 });
    expect(replies[0].run.trigger).toContain("Schedule");
    expect(replies[1].run).toBeUndefined();
  });
});
