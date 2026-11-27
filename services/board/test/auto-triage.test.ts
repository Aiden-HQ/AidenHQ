// First-pass triage on the board (owner, 2026-11-27): an agent's placement carries its reason until the owner moves the task;
// agents' own tasks, reports and the chaser's handed-back parts get no column; a stale New task moves to Later only after a
// brief that mentioned it is out.
import { describe, expect, it } from "vitest";
import { assignees, buildBoard } from "../src/board.js";
import { crewOf, foldedChildren } from "../src/crew.js";
import type { Agent, Issue } from "../src/paperclip.js";
import { scheduleMove } from "../src/scheduled-moves.js";
import { moveStale, staleTasks } from "../src/stale.js";
import { Store } from "../src/store.js";

const TESS = "00000000-0000-0000-0000-0000000000a1";
const list = assignees([{ id: TESS, name: "Tess", status: "idle", metadata: { engine: "codex", setupKey: "aidenhq:open-loops" } } as Agent]);
const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "i1", identifier: "WOR-1", title: "Task", description: "", status: "todo", priority: "medium", assigneeUserId: "me", assigneeAgentId: null,
  assigneeAdapterOverrides: null, labels: [], createdAt: "2026-11-01T08:00:00.000Z", updatedAt: "2026-11-01T08:00:00.000Z", ...over,
});

describe("first-pass triage", () => {
  it("keeps an agent's reason until the owner moves the task", () => {
    const store = new Store(":memory:");
    const t = issue();
    store.placeNew([{ id: t.id, createdAt: t.createdAt, status: "todo" }]);
    scheduleMove(store, t, { bucket: "tomorrow", position: "top", reason: "Dana waits on a reply" }, "UTC", "Intake");
    expect(store.placements().get(t.id)).toMatchObject({ bucket: "tomorrow", reason: "Dana waits on a reply", by: "Intake" });
    store.move(t.id, "today");
    expect(store.placements().get(t.id)?.reason).toBeUndefined();
  });

  it("gives agents' own tasks, reports and handed-back chaser parts no column", () => {
    const parent = issue({ id: "p", identifier: "WOR-2", createdByAgentId: "intake" });
    const part = issue({ id: "c", identifier: "WOR-3", parentId: "p", createdByAgentId: TESS });
    const agentOwn = issue({ id: "a", identifier: "WOR-4", assigneeUserId: null, assigneeAgentId: TESS, createdByAgentId: TESS });
    const report = issue({ id: "r", identifier: "WOR-5", labels: [{ id: "l", name: "report", color: "#000" }] });
    expect(foldedChildren([parent, part], list).get("c")).toBe("p");
    // Still shown under the chaser on the parent's card.
    expect(crewOf(parent, [part], { assignees: list, working: new Map() }).map((m) => [m.agent, m.issues.map((x) => x.identifier)])).toEqual([[TESS, ["WOR-3"]]]);
    const board = buildBoard({ open: [parent, part, agentOwn, report], closed: [], placements: new Map(), seen: new Map(), installedAt: parent.createdAt, assignees: list });
    expect(Object.values(board.buckets).flat().map((x) => x.identifier)).toEqual(["WOR-2"]);
  });

  it("moves a stale New task to Later only after a brief that mentioned it", () => {
    const store = new Store(":memory:");
    const now = Date.parse("2026-11-27T08:00:00.000Z");
    const old = issue({ lastActivityAt: "2026-11-10T08:00:00.000Z" });
    const fresh = issue({ id: "i2", identifier: "WOR-2", lastActivityAt: "2026-11-25T08:00:00.000Z" });
    expect(staleTasks([old, fresh], store, "me", now).map((x) => x.issue.id)).toEqual(["i1"]);
    // Not mentioned yet: nothing moves, whatever briefs exist.
    const brief = (at: string, line = "Moving to Later: WOR-1") => issue({ id: `b${at}`, createdAt: at, updatedAt: at, description: line, labels: [{ id: "l", name: "daily-brief", color: "#000" }] });
    expect(moveStale([old], [brief("2026-11-27T09:00:00.000Z")], store, "me", now)).toEqual([]);
    store.mentionStale(["i1"], "2026-11-27T04:00:00.000Z");
    expect(moveStale([old], [brief("2026-11-26T04:00:00.000Z")], store, "me", now)).toEqual([]);
    expect(moveStale([old], [brief("2026-11-27T04:47:00.000Z")], store, "me", now)).toEqual(["i1"]);
    expect(store.placements().get("i1")).toMatchObject({ bucket: "backlog", reason: "No activity for 14 days" });
    // Only an exact identifier on the Moving to Later line counts: WOR-12 is not WOR-1, another section is not it, and a
    // cut brief names nothing it cannot show.
    const exact = new Store(":memory:");
    exact.placeNew([{ id: old.id, createdAt: old.createdAt, status: "todo" }]);
    exact.mentionStale(["i1"], "2026-11-27T04:48:00.000Z");
    expect(moveStale([old], [brief("2026-11-27T04:49:00.000Z", "Moving to Later: WOR-12")], exact, "me", now)).toEqual([]);
    expect(moveStale([old], [brief("2026-11-27T04:49:00.000Z", "**Needs you:** WOR-1")], exact, "me", now)).toEqual([]);
    expect(moveStale([old], [issue({ id: "cut", createdAt: "2026-11-27T04:49:00.000Z", updatedAt: "2026-11-27T04:49:00.000Z", descriptionTruncated: true, description: "**Needs you:** WOR-1", labels: [{ id: "l", name: "daily-brief", color: "#000" }] })], exact, "me", now)).toEqual([]);
    expect(moveStale([old], [brief("2026-11-27T04:49:00.000Z", "**Moving to Later:** WOR-1 — unsorted for 14 days")], exact, "me", now)).toEqual(["i1"]);
    // Activity after a mention drops it.
    store.mentionStale(["i2"], "2026-11-27T04:00:00.000Z");
    expect(moveStale([fresh], [brief("2026-11-27T05:00:00.000Z")], store, "me", now)).toEqual([]);
    expect(store.staleMentions().size).toBe(0);
  });

  it("drops a pending stale mention when the owner moves the task", () => {
    const store = new Store(":memory:");
    const t = issue();
    store.placeNew([{ id: t.id, createdAt: t.createdAt, status: "todo" }]);
    store.mentionStale([t.id], "2026-11-27T04:00:00.000Z");
    store.move(t.id, "today");
    expect(store.staleMentions().size).toBe(0);
    store.mentionStale([t.id], "2026-11-27T04:00:00.000Z");
    store.setOrder("triage", [t.id]);
    expect(store.staleMentions().size).toBe(0);
  });
});
