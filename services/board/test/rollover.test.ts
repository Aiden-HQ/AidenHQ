import { describe, expect, it } from "vitest";
import { continuedIn } from "../src/chats.js";
import { latest, rolloverTick } from "../src/rollover.js";
import { Store } from "../src/store.js";

const t0 = Date.parse("2026-11-15T08:00:00Z");
type T = { id: string; identifier: string; title: string; description: string | null; status: string; priority: string; assigneeAgentId: string | null; assigneeUserId: string | null; parentId?: string | null; labelIds?: string[]; createdByAgentId?: string | null; createdByUserId?: string | null; updatedAt: string };
type C = { id: string; body: string; authorType: string; authorAgentId?: string | null; authorUserId?: string | null; createdByRunId?: string | null; createdAt: string };

/** A Paperclip with Aiden ("a"), an Engineer the runner runs ("e"), tasks, comments and runs set by the test. */
function fake() {
  const tasks = new Map<string, T>();
  const comments = new Map<string, C[]>();
  const runs: { id: string; status: string; agentId: string; issueId: string; startedAt: string; finishedAt: string | null; error: string | null }[] = [];
  let n = 0;
  const put = (t: Partial<T> & { id: string }) => tasks.set(t.id, { identifier: `WOR-${t.id}`, title: t.id, description: null, status: "todo", priority: "medium", assigneeAgentId: null, assigneeUserId: null, createdByUserId: "me", ...tasks.get(t.id), ...t, updatedAt: new Date(t0 + ++n).toISOString() });
  const say = (issue: string, body: string, by: "owner" | "agent" = "owner") => {
    const list = comments.get(issue) ?? [];
    list.push({ id: `c${++n}`, body, authorType: by === "agent" ? "agent" : "user", authorAgentId: by === "agent" ? "a" : null, authorUserId: by === "agent" ? null : "me", createdByRunId: by === "agent" ? "run" : null, createdAt: new Date(t0 + n).toISOString() });
    comments.set(issue, list);
  };
  const pc = {
    me: async () => "me",
    agents: async () => [{ id: "a", status: "idle", metadata: {} }, { id: "e", status: "idle", metadata: { runnerEngine: "codex" } }],
    openIssues: async () => [...tasks.values()].filter((t) => !["done", "cancelled"].includes(t.status)),
    liveRuns: async () => runs.filter((r) => !r.finishedAt),
    recentRuns: async () => runs,
    issue: async (id: string) => ({ ...tasks.get(id)! }),
    children: async (id: string) => [...tasks.values()].filter((t) => t.parentId === id),
    commentPage: async (id: string, o: { after?: string; newest?: boolean } = {}) => {
      const list = comments.get(id) ?? [];
      if (o.newest) return [...list].reverse().slice(0, 500);
      const from = o.after ? list.findIndex((c) => c.id === o.after) + 1 : 0;
      return list.slice(from, from + 500);
    },
    createIssue: async (body: Partial<T>) => {
      const id = `s${++n}`;
      put({ ...body, id, identifier: `WOR-${1000 + n}`, createdByAgentId: null, createdByUserId: "me" });
      return tasks.get(id)!;
    },
    updateIssue: async (id: string, body: Partial<T>) => {
      put({ ...body, id });
      return tasks.get(id)!;
    },
    addComment: async (id: string, body: string) => {
      say(id, body);
      return comments.get(id)!.at(-1)!;
    },
  };
  return { pc, tasks, comments, runs, put, say };
}

const deps = (f: ReturnType<typeof fake>, store: Store) => ({ pc: f.pc as never, store, log: { info() {}, warn() {} } });

describe("task rollover", () => {
  it("moves a chat nearing the input limit to a successor: its open sub-tasks follow, the old one is parked, messages to it go on", async () => {
    const f = fake();
    const store = new Store(":memory:");
    f.put({ id: "1", title: "Chat with Aiden", description: "Operator chat.\n\n<!-- aidenhq-chat-agent:a -->", assigneeAgentId: "a", labelIds: ["chat"] });
    f.put({ id: "2", parentId: "1", assigneeAgentId: "e", status: "in_progress" });
    f.put({ id: "3", parentId: "1", assigneeAgentId: "e", status: "done" });
    f.say("1", "Please look into the deploy.");
    for (let i = 0; i < 200; i++) f.say("1", "x".repeat(2000), "agent");
    expect(await rolloverTick(deps(f, store), t0)).toEqual([]); // ~480K with the envelope: under the limit
    for (let i = 0; i < 60; i++) f.say("1", "x".repeat(2000), "agent");
    f.say("1", "And the logs too?"); // not answered yet
    f.put({ id: "1" }); // its times change, so it is counted again (only the new comments are fetched)
    expect(await rolloverTick(deps(f, store), t0 + 10 * 60_000)).toEqual(["1"]);

    const next = [...f.tasks.values()].find((t) => t.id.startsWith("s"))!;
    expect(next).toMatchObject({ title: "Chat with Aiden (continued from WOR-1)", assigneeAgentId: "a", labelIds: ["chat"], status: "todo" });
    expect(next.description).toMatch(/^Continues WOR-1 /);
    expect(next.description).not.toContain("Operator chat."); // linked, never copied
    expect(next.description).toMatch(/<!-- aidenhq-continues:1 -->\n\n<!-- aidenhq-chat-agent:a -->$/);
    // The owner's unanswered message is re-posted there; the answered one isn't.
    expect(f.comments.get(next.id)!.map((c) => c.body)).toEqual(["And the logs too?"]);
    expect(f.tasks.get("2")!.parentId).toBe(next.id); // open sub-task moved
    expect(f.tasks.get("3")!.parentId).toBe("1"); // finished one stays with its history
    const old = f.tasks.get("1")!;
    expect(old).toMatchObject({ status: "done", assigneeAgentId: null });
    expect(continuedIn(old.description)).toBe(next.id);
    expect(f.comments.get("1")!.at(-1)!.body).toContain(`Continued in ${next.identifier}`);
    // A message written to the old chat goes to the successor (the board's and the bridge's write paths follow this).
    expect((await latest(f.pc as never, store, old as never)).id).toBe(next.id);
    expect(await rolloverTick(deps(f, store), t0 + 20 * 60_000)).toEqual([]); // once
  });

  it("moves a task as soon as a run on it fails over the input limit, but never while a run is on it or for the runner's Engineer", async () => {
    const f = fake();
    const store = new Store(":memory:");
    f.put({ id: "1", assigneeAgentId: "a" });
    f.put({ id: "2", assigneeAgentId: "e" });
    // Made by an agent, or carrying a source: a board-made successor would become the owner's, so these never move.
    f.put({ id: "4", assigneeAgentId: "a", createdByUserId: null, createdByAgentId: "a" });
    f.put({ id: "5", assigneeAgentId: "a", description: "From Slack.\n\n<!-- source:slack:C1/1 -->" });
    const err = "Error: turn/start: turn/start failed: Input exceeds the maximum length of 1048576 characters. (code -32602)";
    f.runs.push({ id: "r1", status: "failed", agentId: "a", issueId: "1", startedAt: "2026-11-15T07:00:00Z", finishedAt: "2026-11-15T07:00:05Z", error: err });
    f.runs.push({ id: "r2", status: "failed", agentId: "e", issueId: "2", startedAt: "2026-11-15T07:00:00Z", finishedAt: "2026-11-15T07:00:05Z", error: err });
    for (const id of ["4", "5"]) f.runs.push({ id: `r${id}`, status: "failed", agentId: "a", issueId: id, startedAt: "2026-11-15T07:00:00Z", finishedAt: "2026-11-15T07:00:05Z", error: err });
    f.runs.push({ id: "r3", status: "queued", agentId: "a", issueId: "1", startedAt: "2026-11-15T07:01:00Z", finishedAt: null, error: null });
    expect(await rolloverTick(deps(f, store), t0)).toEqual([]); // a wake is queued on it: unassigning would cancel it
    Object.assign(f.runs.find((r) => r.id === "r3")!, { status: "failed", finishedAt: "2026-11-15T07:01:05Z", error: err });
    expect(await rolloverTick(deps(f, store), t0 + 10 * 60_000)).toEqual(["1"]);
    for (const id of ["2", "4", "5"]) expect(f.tasks.get(id)!.status).toBe("todo");
  });
});
