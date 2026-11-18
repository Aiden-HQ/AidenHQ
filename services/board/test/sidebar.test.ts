import { describe, expect, it } from "vitest";
import { VISIBLE, groupChats, laneOf, groupTasks, panelsOf, taskSummary } from "../web/src/sidebar.js";
import type { ChatRow } from "../web/src/types.js";

const row = (n: number, o: Partial<ChatRow> = {}): ChatRow => ({ identifier: `WOR-${n}`, title: `c${n}`, open: true, agent: { key: "a", name: "Aiden" }, state: "idle", updatedAt: `2026-11-${String(10 + (n % 15)).padStart(2, "0")}T00:00:00Z`, unread: false, ...o });
const agents = [{ key: "a", name: "Aiden", front: true }];

describe("groupChats", () => {
  it("shows at most 5 open chats, counts the rest as more, and puts finished chats under earlier", () => {
    const rows = [...Array.from({ length: 8 }, (_, i) => row(i + 1)), row(20, { open: false }), row(21, { open: false })];
    const { front } = groupChats(rows, agents);
    expect(front!.chats).toHaveLength(VISIBLE);
    expect(front!.more).toHaveLength(3);
    expect(front!.earlier.map((c) => c.identifier).sort()).toEqual(["WOR-20", "WOR-21"]);
  });
});

describe("tasks of a chat", () => {
  it("summarises handed-out work and groups it for the panel", () => {
    const kids = [{ state: "waiting for you" }, { state: "working" }, { state: "in review" }, { state: "done" }] as { state: ChatRow["state"] }[];
    expect(taskSummary(kids)).toEqual({ total: 4, needs: 1, busy: true });
    const at = "2026-11-12T00:00:00Z";
    const g = groupTasks([{ state: "failed", updatedAt: at }, { state: "queued", updatedAt: at }, { state: "in review", updatedAt: at }, { state: "done", updatedAt: at }, { state: "done", updatedAt: "2026-01-01T00:00:00Z" }], Date.parse(at));
    expect([g.needs.length, g.working.length, g.waiting.length, g.finished.length]).toEqual([1, 0, 2, 1]);
  });
});

describe("laneOf", () => {
  it("finds a lane agent by the Paperclip id the sidebar groups use, not by its lane key", () => {
    const lane = [{ key: "aria", id: "0d9c-uuid", name: "Aria" }];
    const { others } = groupChats([], [{ key: "0d9c-uuid", name: "Aria" }]);
    expect(laneOf(lane, others[0]!.agent.key)?.key).toBe("aria");
  });
});

describe("panelsOf", () => {
  it("pins only apps that set a panel and have an https URL of their own", () => {
    const apps = [
      { name: "reading", panel: "Reading list", url: "https://reading.example.com" },
      { name: "notes", url: "https://notes.example.com" },
      { name: "tailnet", panel: "Tailnet", url: "http://apps.example.ts.net:4100" },
      { name: "down", panel: "Down" },
    ];
    expect(panelsOf(apps)).toEqual([{ name: "reading", label: "Reading list", url: "https://reading.example.com" }]);
  });
  it("pins a local door only where the browser can sign in to it", () => {
    const apps = [{ name: "notes", panel: "Notes", url: "http://notes.localhost:3130" }];
    expect(panelsOf(apps)).toEqual([]);
    expect(panelsOf(apps, true)).toEqual([{ name: "notes", label: "Notes", url: "http://notes.localhost:3130" }]);
  });
});
