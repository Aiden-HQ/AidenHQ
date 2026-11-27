import { request, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { createApp } from "../src/app.js";
import type { Issue, Paperclip } from "../src/paperclip.js";
import type { LiveRun } from "../src/runs.js";
import { Store } from "../src/store.js";
import { startWatch } from "../src/watch.js";
import { card, fakeRecords } from "./fake-records.js";
import { fakeStates, row } from "./fake-states.js";

const label = { id: "33333333-3333-3333-3333-333333333333", name: "chat", color: "#0ea5e9" };
const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const base = { priority: "medium", assigneeUserId: null, assigneeAdapterOverrides: null, createdAt: at(-600), description: null };
const chat: Issue = { ...base, id: "11111111-1111-1111-1111-111111111111", identifier: "WOR-10", title: "A chat", status: "in_progress", assigneeAgentId: "cos", labels: [label], updatedAt: at(-600) };
const kid: Issue = { ...base, id: "22222222-2222-2222-2222-222222222222", identifier: "WOR-11", title: "Handed out", status: "todo", assigneeAgentId: "fe", parentId: chat.id, updatedAt: at(-600) };
const other: Issue = { ...base, id: "44444444-4444-4444-4444-444444444444", identifier: "WOR-12", title: "Not a chat", status: "todo", assigneeAgentId: "fe", updatedAt: at(-600) };
let live: LiveRun[] = [];
let saidAt = at(0);
let issues = [chat, kid, other];
const pc = {
  openIssues: async () => issues,
  labels: async () => [label],
  changedSince: async (since: string) => issues.filter((i) => i.updatedAt > since),
} as unknown as Paperclip;

const store = new Store(":memory:");
const log = pino({ level: "silent" });
const app = createApp({ paperclip: pc, store, log, allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) });
const records = fakeRecords();
const states = fakeStates([row(chat.id, { kind: "waiting", reason: "chat_turn" }), row(kid.id, { kind: "waiting", reason: "job_queued" }), row(other.id, { kind: "waiting", reason: "job_queued" })]);
const stop = startWatch({ pc, states, liveRuns: async () => live, session: async () => ({ saidAt, steps: [] }) as never, events: store.events, records, log, everyMs: 20 });
let port = 0;
beforeAll(async () => {
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  port = (app.address() as AddressInfo).port;
});
afterAll(() => (stop(), app.close()));

it("tells open boards what agents change: each task by its id, and the chat it belongs to", async () => {
  let text = "";
  const until = (s: string, times = 1) => new Promise<void>((resolve) => {
    const check = setInterval(() => text.split(s).length - 1 >= times && (clearInterval(check), resolve()), 10);
  });
  const req: ClientRequest = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: "localhost:3120" } }, (res) => res.on("data", (c) => (text += c)));
  req.on("error", () => {});
  req.end();
  await until("event: ping");
  await new Promise((r) => setTimeout(r, 100)); // the watch has taken its first look
  // A task that isn't a chat changes: only its own conversation hears it. Then the agent replies in the chat.
  issues = [chat, kid, { ...other, updatedAt: at(0) }];
  await until(`event: tasks\ndata: {"issue":"${other.id}"}`);
  issues = [{ ...chat, updatedAt: at(1) }, kid, issues[2]!];
  await until(`event: chat\ndata: {"issue":"${chat.id}"}`);
  // The agent on the handed-out task starts, then says more: that task and its chat hear both.
  live = [{ id: "r1", status: "running", agentId: "fe", issueId: kid.id, startedAt: at(0) }];
  await until(`event: tasks\ndata: {"issue":"${kid.id}"}`);
  saidAt = at(5);
  await until(`event: progress\ndata: {"issue":"${chat.id}"}`);
  // A card the kernel files is announced as `approvals`.
  records.cards.push(card({ id: "A9" }));
  await until("event: approvals");
  // A live card's wait reason changes and nothing else about it: the open Approvals views still hear it (no minute-long wait
  // for the fallback poll, which would show an obsolete reason).
  const held = records.cards.find((c) => c.id === "A9")!;
  held.state = "running";
  held.wait = "code review: 1 important finding open";
  await until("event: approvals", 2);
  held.wait = "code review: 2 important findings open";
  await until("event: approvals", 3);
  // A Tier 0 record in flight is a running card on Approvals too (its own uncapped live read carries it), so a change in its
  // wait is announced as well, though the capped recent read never lists it.
  records.cards.push(card({ id: "A10", tier: 0, state: "running", wait: "waiting on slack's rate limit" }));
  await until("event: approvals", 4);
  const tier0 = records.cards.find((c) => c.id === "A10")!;
  tier0.wait = "waiting on slack's rate limit (retry 2)";
  await until("event: approvals", 5);
  req.destroy();
  const frames = (name: string): string[] => text.match(new RegExp(`event: ${name}\\ndata: .*`, "g")) ?? [];
  expect(frames("chat")).toEqual(Array(2).fill(`event: chat\ndata: {"issue":"${chat.id}"}`));
  expect(frames("progress")).toEqual([`event: progress\ndata: {"issue":"${kid.id}"}`, `event: progress\ndata: {"issue":"${chat.id}"}`]);
});


