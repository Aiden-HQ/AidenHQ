import { describe, expect, it } from "vitest";
import { checkRequest } from "../src/app.js";
import { assignees, buildBoard, keepMarkers } from "../src/board.js";
import { mergedDescription } from "../src/merge.js";
import type { Agent, Issue } from "../src/paperclip.js";

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
const CLAUDE = "00000000-0000-0000-0000-0000000000c1";

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


