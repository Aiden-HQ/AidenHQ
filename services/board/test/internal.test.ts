import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { asAgent } from "./caller.js";
import { card, fakeRecords } from "./fake-records.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

// The grants table setup writes: the Researcher may change the board; the Scout holds the tool but not the role.
const grantsFile = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
writeFileSync(grantsFile, JSON.stringify({ agents: { ra: { key: "assistant", roles: ["board-writer", "fleet-read"], tools: { paperclip_tasks: ["task_schedule", "task_file_upload"] } }, engy: { key: "engineer", roles: [], tools: { paperclip_tasks: ["task_approvals"] } }, engy2: { key: "engineer-2", profile: "engineer", roles: [], tools: { paperclip_tasks: ["task_approvals"] } }, scout: { key: "scout", roles: [], tools: { paperclip_tasks: ["task_schedule", "task_file_upload"] } }, beta: { key: "beta", roles: [], tools: { paperclip_tasks: ["task_file_upload"] } } } }));
process.env.AIDENHQ_GRANTS_FILE = grantsFile;

describe("internal listener", () => {
  const TOKEN = "t".repeat(64);
  const store = new Store(":memory:");
  const issue = { id: "11111111-1111-1111-1111-111111111111", identifier: "PEN-1", title: "T", description: "", status: "todo", priority: "medium", assigneeUserId: "me-1", assigneeAgentId: null, assigneeAdapterOverrides: null, createdAt: "", updatedAt: "" };
  const pc = {
    me: async () => "me-1",
    agents: async () => ["ra", "scout", "beta", "engy", "engy2", "engy3"].map((id) => ({ id, name: id })),
    labels: async () => [],
    company: async () => ({ issuePrefix: "PEN" }),
    issue: async () => issue,
    companyId: "co",
  } as unknown as Paperclip;
  const app = createApp({ paperclip: pc, store, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40) });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  // fetch() always sends its own Host header; the guard is tested with the names the bridge uses.
  const call = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: async () => JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  afterAll(() => app.close());

  // The tasks bridge: the internal token plus the kernel's caller assertion.
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call("POST", path, body, { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...asAgent("ra"), ...headers });


  it("needs the token and an allowed host", async () => {
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { authorization: "" })).status).toBe(401);
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { host: "evil:3122" })).status).toBe(403);
  });

  it("the token alone changes nothing: the caller must be an agent granted the tool, and without board-writer it places only an owner task it filed", async () => {
    const refused = async (path: string, body: unknown, headers: Record<string, string>) => (await (await post(path, body, headers)).json()) as { error: string };
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, { "x-aidenhq-caller": "" })).error).toBe("missing caller assertion");
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, asAgent("forged"))).error).toMatch(/^only an agent granted task_schedule/);
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, asAgent("scout"))).error).toMatch(/places only an owner task you filed/);
    expect((await refused("/internal/issues/PEN-1/recurring", { action: "stop" }, {})).error).toMatch(/^only an agent granted task_recurring/); // not granted
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, asAgent("ra", { aud: "ops" }))).error).toMatch(/^refused: the caller assertion is for ops/);
    expect((await refused("/internal/issues/PEN-1/schedule", { clear: true }, asAgent("ra", { exp: 1 }))).error).toMatch(/expired/);
  });

  it("a task's approval read includes the Tier 0 merge card the publish rule waits on", async () => {
    // A merge the fleet files for a green PR in the agents org is Tier 0: a read that drops it would tell the run no merge
    // card exists, and nothing would wake the task.
    // The merge card is older than 60 newer routine cards on the same task: the read still returns it.
    const inner = fakeRecords([
      card({ id: "k-0000000000000001", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 0, state: "running", live: true, wait: "code review: 1 important finding open", createdAt: "2026-11-10T10:00:00.000Z", args: { prs: [{ repo: "a/b", number: 1, head: "a".repeat(40) }] } }),
      card({ id: "k-0000000000000002", issueId: "another-task", identifier: "PEN-9", action: "merge", tier: 0, state: "pending" }),
      // One still waiting on the reviewer or owner, also older than the newer routine cards: it is a card to wait on too.
      card({ id: "k-0000000000000003", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "pending", createdAt: "2026-11-10T09:00:00.000Z" }),
      ...Array.from({ length: 60 }, (_, i) => card({ id: `k-00000000000002${String(i).padStart(2, "0")}`, issueId: issue.id, identifier: issue.identifier, action: "conn.tool", tier: 0, state: "used", outcome: "applied", createdAt: `2026-11-2${i % 4}T10:00:00.000Z` })),
    ]);
    // The kernel's read is newest first and capped: 60 newer routine cards sit ahead of this task's merge card.
    const seen: { tier0?: boolean; strict?: boolean; kinds?: string[] }[] = [];
    const records: typeof inner = {
      ...inner,
      list: async (state, o = {}) => {
        seen.push(o);
        const all = await inner.list(state, { ...o, limit: 1000 });
        return all.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, o.limit ?? 100);
      },
      allOf: async (state, k, t) => (seen.push({ tier0: true, strict: true, kinds: k }), inner.allOf(state, k, t)),
    };
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const port2 = (board.address() as AddressInfo).port;
    const get = (issueParam: string) =>
      new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: port2, method: "GET", path: `/internal/approvals?issue=${issueParam}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: async () => JSON.parse(text) }));
        });
        req.on("error", reject);
        req.end();
      });
    const other9 = { ...issue, id: "another-task", identifier: "PEN-9", title: "Other" };
    const resolve = (pc as any).issue;
    (pc as any).issue = async (ref: string) => (ref === other9.identifier || ref === other9.id ? other9 : issue);
    try {
      const mine = (await (await get(issue.identifier)).json()) as { approvals: { id: string }[] };
      expect(mine.approvals.map((a) => a.id)).toEqual(expect.arrayContaining(["k-0000000000000001", "k-0000000000000003"]));
      expect(mine.approvals.find((a) => a.id === "k-0000000000000001")).toMatchObject({ live: true, prs: [{ repo: "a/b", number: 1, head: "a".repeat(40) }] });
      expect(seen.some((o) => o.tier0 === true && o.strict === true && o.kinds?.includes("github.merge"))).toBe(true);
      // Another task's card is never in this task's read, whatever its tier.
      const other = (await (await get("PEN-9")).json()) as { approvals: { id: string }[] };
      expect(other.approvals.map((a) => a.id)).toEqual(["k-0000000000000002"]);
    } finally {
      (pc as any).issue = resolve;
      board.close();
    }
  });

  it("a burst of Tier 0 writes never pushes a decision that still blocks the task out of its approval read", async () => {
    // The general read stays the reviewed cards alone: 60 newer Tier 0 writes behind a pending deploy card must not fill it.
    // A merge card the fleet filed at Tier 0 is still read, through the merge-specific read the publish rule needs.
    const inner = fakeRecords([
      card({ id: "k-0000000000000041", issueId: issue.id, identifier: issue.identifier, action: "deploy", tier: 2, state: "pending", createdAt: "2026-11-01T10:00:00.000Z" }),
      card({ id: "k-0000000000000042", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 0, state: "running", live: true, createdAt: "2026-11-02T10:00:00.000Z", args: { prs: [{ repo: "a/b", number: 7, head: "a".repeat(40) }] } }),
      ...Array.from({ length: 60 }, (_, i) => card({ id: `k-00000000000005${String(i).padStart(2, "0")}`, issueId: issue.id, identifier: issue.identifier, action: "conn.tool", tier: 0, state: "used", outcome: "applied", createdAt: `2026-11-2${i % 4}T10:00:00.000Z` })),
    ]);
    const seen: { tier0?: boolean }[] = [];
    const liveKinds: (string[] | undefined)[] = [];
    const records: typeof inner = {
      ...inner,
      list: async (state, o = {}) => {
        seen.push({ tier0: o.tier0 });
        const all = await inner.list(state, { ...o, limit: 1000 });
        return all.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, o.limit ?? 100);
      },
      allOf: async (state, k, t, m) => {
        if (state === "live") liveKinds.push(k);
        return inner.allOf(state, k, t, m);
      },
    };
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const port6 = (board.address() as AddressInfo).port;
    try {
      const res = await new Promise<{ status: number; json: () => Promise<{ approvals: { id: string }[] }> }>((resolve, reject) => {
        request({ host: "127.0.0.1", port: port6, method: "GET", path: `/internal/approvals?issue=${issue.identifier}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (r) => {
          let text = "";
          r.on("data", (c) => (text += c));
          r.on("end", () => resolve({ status: r.statusCode!, json: async () => JSON.parse(text) }));
        }).on("error", reject).end();
      });
      const ids = (await res.json()).approvals.map((a) => a.id);
      expect(ids).toContain("k-0000000000000041");
      expect(ids).toContain("k-0000000000000042");
      // The newest page is the reviewed cards alone; the Tier 0 merge arrives through the merge read, and the live read is
      // every kind so a pending deploy can never be crowded out either.
      expect(seen.every((o) => o.tier0 !== true)).toBe(true);
      expect(liveKinds.length).toBeGreaterThan(0);
      expect(liveKinds.every((k) => k === undefined)).toBe(true);
    } finally {
      board.close();
    }
  });

  it("an Engineer reads the cards of the task it names, as it reads any task (no private-reads split)", async () => {
    const other9 = { ...issue, id: "another-task", identifier: "PEN-9", title: "Other" };
    const records = fakeRecords([card({ id: "k-0000000000000030", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "running", live: true }), card({ id: "k-0000000000000031", issueId: other9.id, identifier: other9.identifier, action: "merge", tier: 1, state: "running", live: true })]);
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const port5 = (board.address() as AddressInfo).port;
    const read = (id: string, claims: Record<string, unknown>) =>
      new Promise<{ status: number; json: () => Promise<{ approvals?: { id: string }[]; error?: string }> }>((resolve, reject) => {
        request({ host: "127.0.0.1", port: port5, method: "GET", path: `/internal/approvals?issue=${id}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent(claims.agent as string, { task: issue.id, ...claims }) } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: async () => JSON.parse(text) }));
        }).on("error", reject).end();
      });
    const resolve = (pc as any).issue;
    (pc as any).issue = async (ref: string) => (ref === other9.identifier || ref === other9.id ? other9 : issue);
    try {
      // Another task's cards and its own run's task alike: served.
      expect((await read(other9.identifier, { agent: "engy2" })).status).toBe(200);
      expect((await read(other9.identifier, { agent: "engy2", task: other9.id })).status).toBe(200);
    } finally {
      (pc as any).issue = resolve;
      board.close();
    }
  });

  it("an older ended merge is still found behind more than a page of newer merges, and an owner's reason reaches the read", async () => {
    // 2,000 newer merge cards, so the newest merge-kind page cannot hold the one that landed this PR.
    const landed = card({ id: "k-0000000000000090", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "used", live: false, wakes: true, outcome: "applied", outcomeText: `merged-prs: [{"repo":"a/b","number":6,"head":"${"9".repeat(40)}"}]`, ownerReason: "merge it only after the release", createdAt: "2026-01-01T10:00:00.000Z" });
    const newer = Array.from({ length: 2000 }, (_, i) => card({ id: `k-0000000000000${String(1000 + i)}`, issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "used", outcome: "applied", createdAt: `2026-11-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z` }));
    const records = fakeRecords([landed, ...newer]);
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const portB = (board.address() as AddressInfo).port;
    try {
      const out = await new Promise<{ approvals: { id: string; ownerReason?: string | null }[] }>((resolve, reject) => {
        request({ host: "127.0.0.1", port: portB, method: "GET", path: `/internal/approvals?issue=${issue.identifier}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve(JSON.parse(text)));
        }).on("error", reject).end();
      });
      expect(out.approvals.find((a) => a.id === "k-0000000000000090")).toMatchObject({ ownerReason: "merge it only after the release" });
    } finally {
      board.close();
    }
  });

  it("an ended merge behind 50 newer cards is still read, by its kind, from the task's history", async () => {
    // The merge ended long ago; 60 newer apply cards follow it, so the newest-50 read cannot hold it. The kind-filtered
    // history read must, or a run's check for the merge that landed its PR would find nothing.
    const ended = card({ id: "k-0000000000000070", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "used", live: false, wakes: true, outcome: "applied", outcomeText: `merged-prs: [{"repo":"a/b","number":5,"head":"${"f".repeat(40)}","sha":"${"1".repeat(40)}"}]`, createdAt: "2026-11-01T10:00:00.000Z", args: { prs: [{ repo: "a/b", number: 5, head: "f".repeat(40) }] } });
    const newer = Array.from({ length: 60 }, (_, i) => card({ id: `k-00000000000001${String(i).padStart(2, "0")}`, issueId: issue.id, identifier: issue.identifier, action: "apply", tier: 1, state: "used", outcome: "applied", createdAt: `2026-11-2${i % 4}T10:00:00.000Z` }));
    const records = fakeRecords([ended, ...newer]);
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const port9 = (board.address() as AddressInfo).port;
    try {
      const out = await new Promise<{ approvals: { id: string; outcomeText?: string }[] }>((resolve, reject) => {
        request({ host: "127.0.0.1", port: port9, method: "GET", path: `/internal/approvals?issue=${issue.identifier}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve(JSON.parse(text)));
        }).on("error", reject).end();
      });
      const mine = out.approvals.find((a) => a.id === "k-0000000000000070")!;
      expect(mine).toMatchObject({ id: "k-0000000000000070" });
      expect(mine.outcomeText).toMatch(/^merged-prs: /);
    } finally {
      board.close();
    }
  });

  it("a card the code closed says it wakes nobody: recovered as unknown, expired, or replaced", async () => {
    const records = fakeRecords([
      card({ id: "k-0000000000000080", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "used", live: false, wakes: false, outcome: "failed", outcomeText: "unknown: it was claimed and its outcome never came back", createdAt: "2026-11-10T09:00:00.000Z" }),
      // The kernel's own shown state for a card past its cutoff, and the just-approved card that stays eligible even when old.
      card({ id: "k-0000000000000081", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "expired", live: false, wakes: false, outcome: "failed", outcomeText: "expired: not decided in 7 days", createdAt: "2026-11-01T09:00:00.000Z" }),
      card({ id: "k-0000000000000082", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "expired", live: false, wakes: false, outcome: "failed", outcomeText: "replaced by a newer request", replaced: true, createdAt: "2026-11-10T09:00:00.000Z" }),
    ]);
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const portA = (board.address() as AddressInfo).port;
    try {
      const out = await new Promise<{ approvals: { id: string; wakes: boolean }[] }>((resolve, reject) => {
        request({ host: "127.0.0.1", port: portA, method: "GET", path: `/internal/approvals?issue=${issue.identifier}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve(JSON.parse(text)));
        }).on("error", reject).end();
      });
      for (const id of ["k-0000000000000080", "k-0000000000000081", "k-0000000000000082"]) expect(out.approvals.find((a) => a.id === id)?.wakes).toBe(false);
    } finally {
      board.close();
    }
  });

  it("a card filed under the task's identifier is found and returned", async () => {
    // The kernel's local merge is filed under a run's workspace identifier, not the task id.
    const records = fakeRecords([card({ id: "k-00000000000000a0", issueId: issue.identifier, identifier: issue.identifier, action: "merge", tier: 1, state: "used", live: false, wakes: true, outcome: "applied", outcomeText: `merged-prs: [{"repo":"a/b","number":7,"head":"${"7".repeat(40)}"}]`, createdAt: "2026-11-10T10:00:00.000Z", args: { prs: [{ repo: "a/b", number: 7, head: "7".repeat(40) }] } })]);
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const portC = (board.address() as AddressInfo).port;
    try {
      const out = await new Promise<{ approvals: { id: string; outcomeText?: string }[] }>((resolve, reject) => {
        request({ host: "127.0.0.1", port: portC, method: "GET", path: `/internal/approvals?issue=${issue.identifier}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve(JSON.parse(text)));
        }).on("error", reject).end();
      });
      expect(out.approvals.find((a) => a.id === "k-00000000000000a0")).toMatchObject({ id: "k-00000000000000a0" });
    } finally {
      board.close();
    }
  });

  it("the later snapshot of a card wins: an approval made between the reads is not reported as pending", async () => {
    const pending = card({ id: "k-0000000000000050", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "pending", live: true, wakes: false, createdAt: "2026-11-10T09:00:00.000Z", updatedAt: "2026-11-10T09:00:00.000Z", args: { prs: [{ repo: "a/b", number: 3, head: "c".repeat(40) }] } });
    const approved = card({ id: "k-0000000000000050", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "approved", live: true, wakes: true, createdAt: "2026-11-10T09:00:00.000Z", updatedAt: "2026-11-10T09:05:00.000Z", args: { prs: [{ repo: "a/b", number: 3, head: "c".repeat(40) }] } });
    const inner = fakeRecords([pending]);
    // The reviewer approved it after the newest-cards read, which still returns the pending snapshot.
    const records: typeof inner = { ...inner, allOf: async (state, kinds, task) => (state === "live" ? [approved] : inner.allOf(state, kinds, task)) };
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const port7 = (board.address() as AddressInfo).port;
    try {
      const out = await new Promise<{ approvals: { id: string; state: string; wakes: boolean }[] }>((resolve, reject) => {
        request({ host: "127.0.0.1", port: port7, method: "GET", path: `/internal/approvals?issue=${issue.identifier}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve(JSON.parse(text)));
        }).on("error", reject).end();
      });
      expect(out.approvals.find((a) => a.id === "k-0000000000000050")).toMatchObject({ state: "approved", wakes: true });
    } finally {
      board.close();
    }
  });

  it("a Tier 0 merge that finished between the reads reports its end, not the running snapshot", async () => {
    const running = card({ id: "k-0000000000000060", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 0, state: "running", live: true, wakes: false, createdAt: "2026-11-10T09:00:00.000Z", updatedAt: "2026-11-10T09:00:00.000Z", args: { prs: [{ repo: "a/b", number: 4, head: "d".repeat(40) }] } });
    const ended = card({ id: "k-0000000000000060", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 0, state: "auto", live: false, wakes: false, outcome: "applied", outcomeText: `merged-prs: [{"repo":"a/b","number":4,"head":"${"d".repeat(40)}","sha":"${"e".repeat(40)}"}]`, createdAt: "2026-11-10T09:00:00.000Z", updatedAt: "2026-11-10T09:05:00.000Z", args: { prs: [{ repo: "a/b", number: 4, head: "d".repeat(40) }] } });
    const inner = fakeRecords([ended]);
    const records: typeof inner = { ...inner, allOf: async (state, kinds, task) => (state === "live" ? [running] : inner.allOf(state, kinds, task)) };
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const port8 = (board.address() as AddressInfo).port;
    try {
      const out = await new Promise<{ approvals: { id: string; state: string; outcomeText?: string }[] }>((resolve, reject) => {
        request({ host: "127.0.0.1", port: port8, method: "GET", path: `/internal/approvals?issue=${issue.identifier}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve(JSON.parse(text)));
        }).on("error", reject).end();
      });
      const mine = out.approvals.find((a) => a.id === "k-0000000000000060")!;
      expect(mine.state).toBe("auto");
      expect(mine.outcomeText).toMatch(/^merged-prs: /);
    } finally {
      board.close();
    }
  });

  it("only a merge card's view decodes `prs`: another kind's args cannot break the read", async () => {
    const records = fakeRecords([
      card({ id: "k-0000000000000040", issueId: issue.id, identifier: issue.identifier, action: "apply", tier: 1, state: "used", outcome: "applied", args: { prs: "not-an-array" } }),
      card({ id: "k-0000000000000041", issueId: issue.id, identifier: issue.identifier, action: "github.merge", tier: 1, state: "running", live: true, args: { prs: { repo: "a/b" } } }),
      card({ id: "k-0000000000000042", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "running", live: true, args: { prs: [{ repo: "a/b", number: 2, head: "b".repeat(40) }] } }),
    ]);
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const port6 = (board.address() as AddressInfo).port;
    try {
      const out = await new Promise<{ approvals: { id: string; prs?: unknown }[] }>((resolve, reject) => {
        request({ host: "127.0.0.1", port: port6, method: "GET", path: `/internal/approvals?issue=${issue.identifier}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve(JSON.parse(text)));
        }).on("error", reject).end();
      });
      const byId = (id: string) => out.approvals.find((a) => a.id === id)!;
      // A string or an object where a merge's args should hold a list: neither is a binding, and neither fails the read.
      expect(byId("k-0000000000000040").prs).toBeUndefined();
      expect(byId("k-0000000000000041").prs).toBeUndefined();
      expect(byId("k-0000000000000042").prs).toEqual([{ repo: "a/b", number: 2, head: "b".repeat(40) }]);
    } finally {
      board.close();
    }
  });

  it("a failed task or records lookup is an error, never an empty card list", async () => {
    const failing = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records: { ...fakeRecords([]), list: async () => { throw new Error("the kernel answered 503"); } } });
    await new Promise<void>((r) => failing.listen(0, "127.0.0.1", r));
    const port3 = (failing.address() as AddressInfo).port;
    const get = (path: string) =>
      new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: port3, method: "GET", path, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: async () => JSON.parse(text) }));
        });
        req.on("error", reject);
        req.end();
      });
    const resolve = (pc as any).issue;
    try {
      // The kernel's records endpoint is down: not a task with no cards.
      (pc as any).issue = async () => issue;
      expect((await get(`/internal/approvals?issue=${issue.identifier}`)).status).toBeGreaterThanOrEqual(500);
      // The task lookup itself failed: the same, rather than an empty list.
      (pc as any).issue = async () => { throw new Error("the control plane answered 502"); };
      expect((await get("/internal/approvals?issue=PEN-1")).status).toBeGreaterThanOrEqual(500);
    } finally {
      (pc as any).issue = resolve;
      failing.close();
    }
  });

  it("an ended merge card's outcome wins over a live snapshot of the same card", async () => {
    const liveCard = card({ id: "k-0000000000000010", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "running", live: true, wakes: true, createdAt: "2026-11-10T10:00:00.000Z", updatedAt: "2026-11-10T10:00:00.000Z", args: { prs: [{ repo: "a/b", number: 1, head: "a".repeat(40) }] } });
    const ended = card({ id: "k-0000000000000010", issueId: issue.id, identifier: issue.identifier, action: "merge", tier: 1, state: "used", live: false, wakes: true, outcome: "applied", outcomeText: `merged-prs: [{"repo":"a/b","number":1,"head":"${"a".repeat(40)}","sha":"${"b".repeat(40)}"}]`, createdAt: "2026-11-10T10:00:00.000Z", updatedAt: "2026-11-10T10:05:00.000Z", args: { prs: [{ repo: "a/b", number: 1, head: "a".repeat(40) }] } });
    const inner = fakeRecords([ended]);
    // The live read ran a moment before the merge finished and still returns the live snapshot of the same card.
    const records: typeof inner = { ...inner, allOf: async (state, kinds, task) => (state === "live" ? [liveCard] : inner.allOf(state, kinds, task)) };
    const board = createApp({ paperclip: pc, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, gatewayKey: "d".repeat(40), records });
    await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
    const port4 = (board.address() as AddressInfo).port;
    try {
      const out = await new Promise<{ approvals: { id: string; state: string; outcomeText?: string }[] }>((resolve, reject) => {
        request({ host: "127.0.0.1", port: port4, method: "GET", path: `/internal/approvals?issue=${issue.identifier}`, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...asAgent("engy") } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve(JSON.parse(text)));
        }).on("error", reject).end();
      });
      const mine = out.approvals.find((a) => a.id === "k-0000000000000010")!;
      expect(mine.state).toBe("used");
      expect(mine.outcomeText).toMatch(/^merged-prs: /);
    } finally {
      board.close();
    }
  });

  it("serves only /internal/ routes: not the user's API or the page", async () => {
    expect((await post("/api/issues", { title: "x" })).status).toBe(404);
    expect((await call("GET", "/", undefined, { host: "board:3122", authorization: `Bearer ${TOKEN}` })).status).toBe(404);
  });

  it("attaches a file to the caller's own task only, and lists it back", async () => {
    const mine = { ...issue, id: "33333333-3333-3333-3333-333333333333", identifier: "PEN-3", assigneeUserId: null, assigneeAgentId: "ra" };
    (pc as any).issue = async (ref: string) => (ref === mine.identifier || ref === mine.id ? mine : issue);
    const files: any[] = [];
    (pc as any).attachments = async (id: string) => files.filter((f) => f.issueId === id);
    (pc as any).addAttachment = async (issueId: string, name: string, type: string, data: Buffer) => {
      const a = { id: "aaaaaaaa-aaaa-aaaa-aaaa-000000000001", issueId, originalFilename: name, contentType: type, byteSize: data.length, createdAt: "2026-11-19T00:00:00Z" };
      files.push(a);
      return a;
    };
    try {
      const body = { name: "../report.md", type: "text/markdown", data: Buffer.from("# Report\n").toString("base64") };
      const ok = await post("/internal/issues/PEN-3/files", body, asAgent("ra"));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ file: { name: "report.md", type: "text/markdown", size: 9, textOf: null } });
      expect(files.map((f) => f.originalFilename)).toEqual(["report.md"]);
      // Another agent's task, and one with no agent on it: refused, and no bytes are stored.
      expect((await post("/internal/issues/PEN-3/files", body, asAgent("beta"))).status).toBe(403);
      expect((await post("/internal/issues/PEN-1/files", body, asAgent("beta"))).status).toBe(403);
      expect((await post("/internal/issues/PEN-3/files", { ...body, name: "big.bin", data: Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64") }, asAgent("ra"))).status).toBe(400);
      expect(files).toHaveLength(1);
    } finally {
      (pc as any).issue = async () => issue;
      delete (pc as any).attachments;
      delete (pc as any).addAttachment;
    }
  });

});
