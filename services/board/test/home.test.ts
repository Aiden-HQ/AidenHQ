// Home end to end (GET /api/home, POST /api/home/seen and /snooze): needs with cards deduped onto their tasks,
// since items one per task under their teammate, the world blocks absent without failing, the since cursor and snoozes.
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { aboutTask } from "../src/home.js";
import { mergedDescription } from "../src/merge.js";
import { ViewError, type ViewHost } from "../src/module-views.js";
import type { Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { card, fakeRecords } from "./fake-records.js";
import { fakeStates, row } from "./fake-states.js";

// Teammates (compiled config, keyed by the grants table): Aiden with the hidden Intake on his staff, and Tess.
const cfg = mkdtempSync(join(tmpdir(), "home-"));
const tm = (job: string, staff: string[] = []) => ({ job, sample: "Ask me", staff, controls: [], face: null });
writeFileSync(join(cfg, "paperclip.yaml"), JSON.stringify({ agents: { "chief-of-staff": { name: "Aiden", teammate: tm("Chief of staff", ["inbox-agent"]) }, "open-loops": { name: "Tess", teammate: tm("Follow-ups") }, "inbox-agent": { name: "Intake" } } }));
writeFileSync(join(cfg, "grants.json"), JSON.stringify({ agents: { cos: { key: "chief-of-staff" }, tess: { key: "open-loops" }, intake: { key: "inbox-agent" } } }));
process.env.BOARD_PAPERCLIP_CONFIG = join(cfg, "paperclip.yaml");
process.env.AIDENHQ_GRANTS_FILE = join(cfg, "grants.json");

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const H = 3_600_000;
const label = (name: string) => ({ id: `l-${name}`, name, color: "#000000" });
const base = { priority: "medium", assigneeUserId: null, assigneeAdapterOverrides: null, description: "", createdAt: ago(48 * H), updatedAt: ago(H), status: "todo" };
const issue = (n: number, o: Partial<Issue>): Issue => ({ ...base, id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, identifier: `WOR-${n}`, title: `Task ${n}`, assigneeAgentId: "tess", ...o });
const carded = issue(1, { title: "Deploy the app" });
const asking = issue(2, { title: "Chase Sam" });
// Intake's person waiting on a reply: older than every ask, yet listed after them.
const reply = issue(6, { title: "Reply to Priya Nair: can you sign off the hiring plan?", assigneeAgentId: "intake", createdAt: ago(80 * H), description: "## Source\n\nType: Slack\nChannel: DM with Priya Nair\nFrom: Priya Nair\nPermalink: https://acme.slack.com/archives/C1/p1700\n\n## Reason\n\nShe asks for a sign-off.\n\n<!-- source:slack:C1:1700.1 -->", labels: [label("needs-response")] });
const done = issue(5, { title: "Chase the vendor", status: "done", completedAt: ago(H / 2) });
const agents = [
  { id: "cos", name: "Aiden", status: "idle", metadata: { setupKey: "aidenhq:chief-of-staff", teammate: tm("Chief of staff", ["inbox-agent"]) } },
  { id: "tess", name: "Tess", status: "idle", metadata: { setupKey: "aidenhq:open-loops", teammate: tm("Follow-ups") } },
  { id: "intake", name: "Intake", status: "idle", metadata: { setupKey: "aidenhq:inbox-agent" } },
];
const pc = {
  me: async () => "me-1",
  agents: async () => agents,
  routines: async () => [],
  labels: async () => [],
  company: async () => ({ issuePrefix: "WOR" }),
  openIssues: async () => [carded, asking, reply],
  closedSince: async () => [done],
  comments: async () => [],
} as unknown as Paperclip;
const states = fakeStates([
  row(carded.id, { identifier: "WOR-1", kind: "waiting", reason: "card_owner", ref: "record:k-a1", attention: [{ who: "owner", why: "card", ref: "record:k-a1", since: ago(5 * H) }] }),
  row(asking.id, { identifier: "WOR-2", kind: "waiting", reason: "owner_wait", question: "Chase Sam again tomorrow?", detail: "Draft: Hi Sam…", wait_since: ago(3 * H), attention: [{ who: "owner", why: "owner_wait", ref: `task:${asking.id}`, since: ago(3 * H) }] }),
]);
const records = fakeRecords([
  card({ id: "k-a1", issueId: carded.id, identifier: "WOR-1", sentence: "Deploy the app", requesterId: "tess", createdAt: ago(5 * H) }),
  card({ id: "k-b2", issueId: "gone", identifier: "WOR-99", sentence: "Rotate the key", requesterId: "intake", createdAt: ago(6 * H) }),
]);
// owner-channel's ledger (fenced texts, newest first) and a calendar read that fails.
const told = [
  { source: "open-loops", task: "WOR-5", kind: "done", state: "delivered", at: ago(H), cursor: `${ago(H)}#2`, text: "```\nChased the vendor, they replied\n```" },
  { source: "inbox-agent", task: null, kind: "fyi", state: "delivered", at: ago(2 * H), cursor: `${ago(2 * H)}#1`, text: "```\n**Triaged** 4 emails\n```" },
];
const views = {
  read: async (id: string) => {
    if (id === "told") return told;
    throw new ViewError(502, "google refused calendar_today");
  },
} as unknown as ViewHost;

describe("home", () => {
  const app = createApp({ taskStates: states, paperclip: pc, store: new Store(":memory:"), records, views, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3120" } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${res.statusCode} ${text}`))));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  let first: any;

  it("needs: a card on a task is that task's one approval row, a card on no task its own", async () => {
    first = await call("GET", "/api/home");
    expect(first.needs.map((n: { id: string; kind: string }) => [n.id, n.kind])).toEqual([["k-b2", "approval"], ["k-a1", "approval"], [asking.id, "answer"], [reply.id, "open"]]);
    expect(first.needs[1]).toMatchObject({ task: { identifier: "WOR-1" }, teammate: { key: "open-loops", name: "Tess", state: "needs" }, card: { id: "k-a1" } });
    expect(first.needs[0]).toMatchObject({ task: null, teammate: { key: "chief-of-staff" } }); // Intake's card is Aiden's
    expect(first.needs[2]).toMatchObject({ question: "Chase Sam again tomorrow?", detail: "Draft: Hi Sam…", waitSince: ago(3 * H) });
    expect(first.needs[3]).toMatchObject({ question: "can you sign off the hiring plan?", since: reply.createdAt, task: { identifier: "WOR-6" }, reply: { person: "Priya Nair", source: "slack" } });
    // The drawer's details: the Source block's lines (the link apart), the Reason, the labels.
    expect(first.needs[3].about).toMatchObject({ created: reply.createdAt, labels: ["needs-response"], source: { type: "Slack", url: "https://acme.slack.com/archives/C1/p1700", fields: [["Channel", "DM with Priya Nair"], ["From", "Priya Nair"]] }, reason: "She asks for a sign-off." });
    expect(first.greeting).toEqual({ needs: 4 });
  });

  it("since: one item per task (the ledger's done and the closed task are one), a hidden agent's under its teammate", async () => {
    expect(first.since.items.map((x: { task: string | null; kind: string }) => [x.task, x.kind])).toEqual([["WOR-5", "closed"], [null, "fyi"]]);
    expect(first.since.items[1]).toMatchObject({ text: "Triaged 4 emails", teammate: { key: "chief-of-staff", name: "Aiden" } });
    expect(first.since.groups.map((g: { teammate: { key: string }; count: number }) => [g.teammate.key, g.count])).toEqual([["open-loops", 1], ["chief-of-staff", 1]]);
    expect(first.team.map((t: { line: string }) => t.line)).toEqual(["Done: Chase the vendor", "Triaged 4 emails"]);
  });

  it("world: a failed calendar read and no waiting-on label are null, and the page still answers", () => {
    expect(first.world).toEqual({ waiting_on: null, today: null });
  });

  it("seen moves the since window forward only; a pinned `from` keeps this visit's items", async () => {
    expect((await call("POST", "/api/home/seen", { as_of: first.as_of })).seen).toBe(first.as_of);
    expect((await call("GET", "/api/home")).since).toBeNull();
    expect((await call("GET", `/api/home?from=${encodeURIComponent(first.since_from)}`)).since.total).toBe(2);
    expect((await call("POST", "/api/home/seen", { as_of: ago(10 * H) })).seen).toBe(first.as_of);
    expect((await call("GET", "/api/home")).since).toBeNull();
  });

  it("a snoozed row is gone until the next 08:00, and Undo brings it back", async () => {
    // An answer row is snoozed by its task and wait (a new question on the task is a new row).
    const { until } = await call("POST", "/api/home/snooze", { id: `${asking.id}:${first.needs[2].waitSince}`, on: true });
    expect(new Date(until).getUTCHours()).toBe(8);
    expect((await call("GET", "/api/home")).needs.map((n: { id: string }) => n.id)).toEqual(["k-b2", "k-a1", reply.id]);
    await call("POST", "/api/home/snooze", { id: `${asking.id}:${first.needs[2].waitSince}`, on: false });
    expect((await call("GET", "/api/home")).needs.map((n: { id: string }) => n.id)).toEqual(["k-b2", "k-a1", asking.id, reply.id]);
  });
});

describe("aboutTask", () => {
  it("reads only the task's own Source block, never a merged task's", () => {
    const own = { description: "Chase the signed contract." };
    const merged = { identifier: "WOR-9", title: "Reply to Priya", description: "## Source\n\nType: Slack\nPermalink: https://acme.slack.com/archives/C1/p1\n\n## Reason\n\nShe asks." };
    const a = aboutTask({ id: "i1", identifier: "WOR-1", title: "Contract", description: mergedDescription(own, merged), createdAt: "2026-11-26T00:00:00Z" } as Issue, undefined, null);
    expect(a.source).toBeNull();
    expect(a.reason).toBeUndefined();
    expect(a.body).toBe("Chase the signed contract.");
  });
});
