import { describe, expect, it } from "vitest";
import { shortModel } from "../src/activity.js";
import { checkRequest } from "../src/app.js";
import { BadRequest, UpdateSchema, assignees, buildBoard, engineOf, paperclipUpdate, replyTarget } from "../src/board.js";
import type { Agent, Issue, Label } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const agents: Agent[] = [
  { id: "00000000-0000-0000-0000-00000000000a", name: "Researcher", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:assistant" } },
  { id: "00000000-0000-0000-0000-0000000000c1", name: "Engineer · Claude", status: "idle", metadata: { model: "claude-opus-5-5", engine: "claude", setupKey: "aidenhq:engineer-claude" } },
  { id: "00000000-0000-0000-0000-0000000000c0", name: "Engineer · Codex", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:engineer" } },
  { id: "00000000-0000-0000-0000-0000000000c2", name: "Engineer · OpenRouter", status: "idle", metadata: { model: "openrouter/z-ai/glm-5.3-flash", engine: "openrouter", setupKey: "aidenhq:engineer-openrouter", models: ["openrouter/deepseek/deepseek-v4.1-flash", 7] } },
  { id: "00000000-0000-0000-0000-0000000000ee", name: "Slack Scout", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:slack-scout" } },
  { id: "00000000-0000-0000-0000-0000000000f1", name: "Fleet Engineer", status: "idle", metadata: { engine: "openrouter", setupKey: "aidenhq:fleet-engineer", runnerEngine: true } },
  { id: "00000000-0000-0000-0000-0000000000f2", name: "Old Agent", status: "terminated", metadata: { engine: "codex", setupKey: "aidenhq:old" } },
];
const list = assignees(agents);
const [CODEX, CLAUDE, OPENROUTER] = ["c0", "c1", "c2"].map((s) => `00000000-0000-0000-0000-0000000000${s}`);
const labels: Label[] = [{ id: "00000000-0000-0000-0000-00000000001a", name: "todo", color: "#0891b2" }];

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "11111111-1111-1111-1111-111111111111",
  identifier: "PEN-1",
  title: "Task",
  description: "Text\n\n<!-- source:source:slack:C1:1.2 -->",
  status: "todo",
  priority: "medium",
  assigneeUserId: "user-1",
  assigneeAgentId: null,
  assigneeAdapterOverrides: null,
  labels: [],
  createdAt: "2026-10-07T08:00:00.000Z",
  updatedAt: "2026-10-07T08:00:00.000Z",
  ...over,
});


describe("store", () => {
  it("puts new tasks at the top of Triage, newest first, and Paperclip backlog tasks in Backlog", () => {
    const s = new Store(":memory:");
    s.placeNew([
      { id: "a", createdAt: "2026-10-01", status: "todo" },
      { id: "b", createdAt: "2026-10-03", status: "todo" },
      { id: "c", createdAt: "2026-10-02", status: "backlog" },
    ]);
    s.placeNew([{ id: "d", createdAt: "2026-10-04", status: "todo" }, { id: "a", createdAt: "2026-10-01", status: "todo" }]);
    const p = s.placements();
    const triage = [...p].filter(([, v]) => v.bucket === "triage").sort((x, y) => x[1].rank - y[1].rank).map(([k]) => k);
    expect(triage).toEqual(["d", "b", "a"]);
    expect(p.get("c")?.bucket).toBe("backlog");
  });

  it("moves to the top or bottom of a bucket and stores a dragged order", () => {
    const s = new Store(":memory:");
    s.setOrder("today", ["x", "y"]);
    s.move("z", "today", "top");
    s.move("w", "today", "bottom");
    const order = () => [...s.placements()].filter(([, v]) => v.bucket === "today").sort((a, b) => a[1].rank - b[1].rank).map(([k]) => k);
    expect(order()).toEqual(["z", "x", "y", "w"]);
    s.setOrder("today", ["y", "z", "x", "w"]);
    expect(order()).toEqual(["y", "z", "x", "w"]);
  });

  it("rolls Tomorrow into Today once per new day, below what's already in Today", () => {
    const s = new Store(":memory:");
    expect(s.rollover("2026-10-07")).toBe(0); // first run only records the date
    s.setOrder("today", ["t1", "t2"]);
    s.setOrder("tomorrow", ["m1", "m2"]);
    s.setOrder("later", ["l1"]);
    expect(s.rollover("2026-10-07")).toBe(0);
    expect(s.rollover("2026-10-08")).toBe(2);
    expect(s.rollover("2026-10-08")).toBe(0);
    const p = s.placements();
    const today = [...p].filter(([, v]) => v.bucket === "today").sort((a, b) => a[1].rank - b[1].rank).map(([k]) => k);
    expect(today).toEqual(["t1", "t2", "m1", "m2"]);
    expect(p.get("l1")?.bucket).toBe("later");
  });




});

describe("board", () => {
  it("groups by bucket and rank, keeps the brief apart and lists recently closed tasks", () => {
    const brief = issue({ id: "b", identifier: "PEN-9", title: "Daily Brief", labels: [{ id: "l", name: "daily-brief", color: "#000" }], description: "# Brief\n<!-- x -->" });
    const a = issue({ id: "a", identifier: "PEN-2", lastActivityAt: "2026-10-07T12:00:00.000Z" });
    const c = issue({ id: "c", identifier: "PEN-3", assigneeUserId: null, assigneeAgentId: CLAUDE, assigneeAdapterOverrides: { adapterConfig: { effort: "high" } } });
    const done = issue({ id: "d", identifier: "PEN-4", status: "done", completedAt: "2026-10-07T11:00:00.000Z" });
    const board = buildBoard({
      open: [brief, a, c, a],
      closed: [done],
      placements: new Map([["c", { bucket: "today", rank: 0, carried: 2 }]]),
      seen: new Map([["a", "2026-10-07T11:00:00.000Z"]]),
      installedAt: "2026-10-07T09:00:00.000Z",
      assignees: list,
    });
    expect(board.buckets.today.map((x) => x.identifier)).toEqual(["PEN-3"]);
    expect(board.buckets.triage.map((x) => x.identifier)).toEqual(["PEN-2"]);
    expect(board.buckets.triage[0]!.unread).toBe(true);
    expect(board.buckets.today[0]).toMatchObject({ assignee: CLAUDE, executor: { effort: "high" }, unread: false, carried: 2 });
    expect(board.buckets.triage[0]!.carried).toBeUndefined();
    expect(board.brief).toEqual({ id: "b", identifier: "PEN-9", title: "Daily Brief", description: "# Brief" });
    expect(board.done.map((x) => x.identifier)).toEqual(["PEN-4"]);
  });
});

describe("edits", () => {
  const ctx = { me: "user-1", assignees: list, labels };


  it("assigns only to you or a listed agent, and clears the model override", () => {
    expect(paperclipUpdate(issue(), { assignee: CLAUDE }, ctx)).toEqual({ assigneeAgentId: CLAUDE, assigneeUserId: null, assigneeAdapterOverrides: null });
    expect(paperclipUpdate(issue({ assigneeAgentId: CLAUDE, assigneeUserId: null }), { assignee: "me" }, ctx)).toEqual({ assigneeUserId: "user-1", assigneeAgentId: null, assigneeAdapterOverrides: null });
    expect(paperclipUpdate(issue(), { assignee: "00000000-0000-0000-0000-0000000000ee" }, ctx).assigneeAgentId).toBe("00000000-0000-0000-0000-0000000000ee");
    expect(() => paperclipUpdate(issue(), { assignee: "00000000-0000-0000-0000-0000000000f2" }, ctx)).toThrow(BadRequest);
  });

  it("sets model and effort for Engineers only, as Paperclip's picker stores them", () => {
    const onCodex = issue({ assigneeAgentId: CODEX, assigneeUserId: null });
    expect(paperclipUpdate(onCodex, { model: "gpt-5.6-sol", effort: "xhigh" }, ctx).assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "xhigh" } });
    // Effort alone keeps the model override already there.
    const withModel = issue({ assigneeAgentId: CODEX, assigneeUserId: null, assigneeAdapterOverrides: { adapterConfig: { model: "gpt-6-astra" } } });
    expect(paperclipUpdate(withModel, { effort: "low" }, ctx).assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "low" } });
    // The Engineer's primary model is no override.
    expect(paperclipUpdate(issue({ assigneeAgentId: CLAUDE, assigneeUserId: null }), { model: "claude-opus-5-5", effort: "" }, ctx).assigneeAdapterOverrides).toBeNull();
    expect(paperclipUpdate(issue(), { assignee: OPENROUTER, model: "z-ai/glm-5.3" }, ctx).assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "openrouter/z-ai/glm-5.3" } });
    expect(() => paperclipUpdate(issue(), { model: "gpt-5.6-sol" }, ctx)).toThrow(/Engineer/);
    expect(() => paperclipUpdate(onCodex, { effort: "max" }, ctx)).toThrow(/effort/);
    expect(() => paperclipUpdate(issue(), { labelIds: ["00000000-0000-0000-0000-0000000000ff"] }, ctx)).toThrow(/label/);
  });

  it("accepts only known fields and values", () => {
    expect(UpdateSchema.safeParse({ status: "blocked" }).success).toBe(false);
    expect(UpdateSchema.safeParse({ assigneeAgentId: CODEX }).success).toBe(false);
    expect(UpdateSchema.safeParse({ model: "gpt; rm -rf" }).success).toBe(false);
    expect(UpdateSchema.safeParse({ status: "done", priority: "high" }).success).toBe(true);
  });
});


describe("the hint under the reply box", () => {
  it("says no agent is assigned on an owner task with none, and does not promise a reader", () => {
    const text = replyTarget(issue({ assigneeAgentId: null }), list);
    expect(text).toBe("No agent is assigned; this message stays on the task. @name brings an agent in.");
    expect(text).not.toMatch(/Researcher/i);
    expect(text).not.toMatch(/repl(y|ies)/i);
  });

  it("still names the reader on a task an agent holds", () => {
    expect(replyTarget(issue({ assigneeAgentId: CODEX, assigneeUserId: null }), list)).toBe("The Engineer reads replies here and continues the coding job.");
    expect(replyTarget(issue({ assigneeAgentId: "00000000-0000-0000-0000-00000000000a", assigneeUserId: null }), list)).toBe("The Researcher is working on this and reads replies.");
    expect(replyTarget(issue({ assigneeAgentId: "00000000-0000-0000-0000-0000000000ee", assigneeUserId: null }), list)).toBe("Slack Scout reads replies here.");
    expect(replyTarget(issue({ assigneeAgentId: null, labels: [{ id: "l", name: "needs-review", color: "#000" }] }), list)).toBe("AidenHQ applies review replies here (pick N, ignore).");
  });

  it("does not read a code label as an Engineer who is there", () => {
    const text = replyTarget(issue({ assigneeAgentId: null, labels: [{ id: "l", name: "engineer", color: "#000" }] }), list);
    expect(text).toBe("No agent is assigned; this message stays on the task. @name brings an agent in.");
  });

  it("says the message stays on the task when agents work in its parts but none is assigned to it", () => {
    const text = replyTarget(issue({ assigneeAgentId: null }), list, true);
    expect(text).toBe("This message stays on the task; @name sends it to an agent.");
    expect(text).not.toMatch(/Researcher/i);
  });
});


describe("request guard", () => {
  const hosts = ["localhost:3120", "127.0.0.1:3120"];
  const req = (method: string, headers: Record<string, string>) => ({ method, url: "/api/x", headers: { host: "localhost:3120", ...headers } });
  const ok = { "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3120", "sec-fetch-site": "same-origin" };

  it("answers only to its own host names (DNS rebinding)", () => {
    expect(checkRequest(req("GET", { host: "evil.example:3120" }), hosts)).toBe("unknown host");
    expect(checkRequest(req("GET", {}), hosts)).toBeUndefined();
  });

  it("takes writes only as same-origin JSON with the board header", () => {
    expect(checkRequest(req("POST", ok), hosts)).toBeUndefined();
    expect(checkRequest(req("POST", { ...ok, "content-type": "text/plain" }), hosts)).toBe("JSON only");
    expect(checkRequest(req("POST", { ...ok, "x-aidenhq-board": "" }), hosts)).toBe("missing board header");
    expect(checkRequest(req("POST", { ...ok, origin: "http://evil.example" }), hosts)).toBe("cross-origin");
    expect(checkRequest(req("POST", { ...ok, origin: "null" }), hosts)).toBe("opaque origin");
    expect(checkRequest(req("POST", { ...ok, "sec-fetch-site": "cross-site" }), hosts)).toBe("cross-site");
  });
});


describe("an agent's engine is the one setup recorded", () => {
  it("labels the engine from metadata.engine, whatever the Paperclip adapter is", () => {
    const record = { id: "x", name: "E", status: "idle", metadata: { engine: "claude", runnerEngine: true, setupKey: "aidenhq:engineer-claude" } } as never;
    expect(engineOf(record)).toBe("claude");
    expect(shortModel(record)).toBe("Claude Code");
  });
});
