// A crew part parked on its own trigger (`backlog`, `blocked`) is the part's own to close: its task closing must not release
// it, whichever way the task closed. The board-load sweep and the owner's close-time cascade both go through the same guard.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Paperclip, type Issue } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeGrading } from "./fake-grading.js";

const CO = "00000000-0000-4000-8000-000000000001";
const KEY = "owner-board-key";
const ME = "me";
const agents = [
  { id: "me-agent", name: "You", status: "idle", adapterType: "codex_local" },
  { id: "eng", name: "Engineer", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:engineer" } },
];
const now = Date.now();
const at = (min: number) => new Date(now - min * 60_000).toISOString();
let n = 0;
const issue = (over: Partial<Issue> & Pick<Issue, "status" | "title">): Issue => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  identifier: `WOR-${n}`,
  description: "",
  priority: "medium",
  assigneeUserId: ME,
  assigneeAgentId: null,
  assigneeAdapterOverrides: null,
  createdAt: at(120),
  updatedAt: at(60),
  lastActivityAt: at(60),
  parentId: null,
  labelIds: [],
  ...over,
});
const OPEN = ["backlog", "todo", "in_progress", "in_review", "blocked"];

/** Paperclip's reads for the board and its PATCHes, over one set of tasks. */
function fake(issues: Issue[]) {
  const patches: { id: string; body: Record<string, unknown> }[] = [];
  const find = (ref: string) => issues.find((i) => i.id === ref || i.identifier === ref);
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
  const fetchImpl = (async (url: URL, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = url.pathname.replace(/^\/v1\/cp\/(read|owner)/, ""); // the kernel's routes to Paperclip
    if (path === "/api/cli-auth/me") return json({ userId: ME });
    if (path === `/api/companies/${CO}`) return json({ issuePrefix: "WOR" });
    if (path === `/api/companies/${CO}/agents`) return json(agents);
    if (path === `/api/companies/${CO}/labels`) return json([]);
    if (path === `/api/companies/${CO}/live-runs`) return json([]);
    if (path === `/api/companies/${CO}/issues`) {
      const status = (url.searchParams.get("status") ?? "").split(",");
      const parentId = url.searchParams.get("parentId");
      return json(issues.filter((i) => status.includes(i.status) && (!parentId || i.parentId === parentId)));
    }
    const comments = /^\/api\/issues\/([^/]+)\/comments$/.exec(path);
    if (comments) return json([]);
    const one = /^\/api\/issues\/([^/]+)$/.exec(path);
    if (one) {
      const found = find(decodeURIComponent(one[1]!));
      if (!found) return json({ error: "no such task" }, 404);
      if (method === "PATCH") {
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        patches.push({ id: found.id, body });
        Object.assign(found, body);
      }
      return json(found);
    }
    return json([]);
  }) as typeof fetch;
  return { patches, paperclip: new Paperclip("http://paperclip", CO, KEY, fetchImpl), find };
}

const servers: ReturnType<typeof createApp>[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function board(issues: Issue[], grading = fakeGrading()) {
  const { patches, paperclip, find } = fake(issues);
  const app = createApp({ paperclip, store: new Store(":memory:"), grading, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
  servers.push(app);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const port = (app.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: "localhost:3120", ...(method === "GET" ? {} : { "content-type": "application/json", "x-aidenhq-board": "1" }) } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { patches, find, get: (path: string) => call("GET", path), patch: (path: string, body: unknown) => call("PATCH", path, body) };
}

describe("the board-load sweep leaves parts waiting on their own trigger", () => {
  it("keeps a backlog part open when its parent was cancelled", async () => {
    const parent = issue({ status: "cancelled", title: "Cancelled task", cancelledAt: at(30), updatedAt: at(30) });
    const monitor = issue({ status: "backlog", title: "Read the scan", parentId: parent.id, assigneeUserId: null, assigneeAgentId: "eng" });
    const ordinary = issue({ status: "todo", title: "Ship it", parentId: parent.id, assigneeUserId: null, assigneeAgentId: "eng" });
    const b = await board([parent, monitor, ordinary]);
    expect((await b.get("/api/board")).status).toBe(200);
    expect(b.find(monitor.id)!.status).toBe("backlog");
    expect(b.patches.map((p) => p.id)).not.toContain(monitor.id);
    // The ordinary part still follows its parent.
    expect(b.patches).toEqual([{ id: ordinary.id, body: { status: "cancelled" } }]);
  });

  it("keeps a blocked part open when its parent is done", async () => {
    const parent = issue({ status: "done", title: "Merged task", completedAt: at(30), updatedAt: at(30) });
    const prerequisite = issue({ status: "blocked", title: "Wait for the tag", parentId: parent.id, assigneeUserId: null, assigneeAgentId: "eng" });
    const ordinary = issue({ status: "in_review", title: "Read it", parentId: parent.id, assigneeUserId: null, assigneeAgentId: "eng" });
    const b = await board([parent, prerequisite, ordinary]);
    expect((await b.get("/api/board")).status).toBe(200);
    expect(b.find(prerequisite.id)!.status).toBe("blocked");
    expect(b.patches.map((p) => p.id)).not.toContain(prerequisite.id);
    expect(b.patches).toEqual([{ id: ordinary.id, body: { status: "done" } }]);
  });
});

describe("the grading module down", () => {
  it("leaves a part undone (fail closed) when its task is done, but still cancels with a cancelled task", async () => {
    const grading = fakeGrading();
    grading.down = true;
    const done = issue({ status: "done", title: "Merged task", completedAt: at(30), updatedAt: at(30) });
    const cancelled = issue({ status: "cancelled", title: "Dropped task", cancelledAt: at(30), updatedAt: at(30) });
    const partOfDone = issue({ status: "in_review", title: "Read it", parentId: done.id, assigneeUserId: null, assigneeAgentId: "eng" });
    const partOfCancelled = issue({ status: "todo", title: "Ship it", parentId: cancelled.id, assigneeUserId: null, assigneeAgentId: "eng" });
    const b = await board([done, cancelled, partOfDone, partOfCancelled], grading);
    expect((await b.get("/api/board")).status).toBe(200);
    expect(b.patches).toEqual([{ id: partOfCancelled.id, body: { status: "cancelled" } }]);
    expect(b.find(partOfDone.id)!.status).toBe("in_review");
  });
});

describe("the close-time cascade leaves parts waiting on their own trigger", () => {
  it("closes an ordinary part with the task, and leaves the blocked and backlog ones alone", async () => {
    const parent = issue({ status: "in_progress", title: "Closing task" });
    const blocked = issue({ status: "blocked", title: "Prerequisite", parentId: parent.id, assigneeUserId: null, assigneeAgentId: "eng" });
    const parked = issue({ status: "backlog", title: "Parking spot", parentId: parent.id, assigneeUserId: null, assigneeAgentId: "eng" });
    const ordinary = issue({ status: "todo", title: "Ship it", parentId: parent.id, assigneeUserId: null, assigneeAgentId: "eng" });
    const b = await board([parent, blocked, parked, ordinary]);
    expect((await b.patch(`/api/issues/${parent.id}`, { status: "cancelled" })).status).toBe(200);
    expect(b.find(parent.id)!.status).toBe("cancelled");
    expect(b.find(blocked.id)!.status).toBe("blocked");
    expect(b.find(parked.id)!.status).toBe("backlog");
    expect(b.find(ordinary.id)!.status).toBe("cancelled");
    expect(b.patches.map((p) => p.id)).toEqual([parent.id, ordinary.id]);
  });
});
