// The board's Approvals list is read-only: the kernel's records (GET /v1/writes, the board's key), each decided on the
// kernel's approval page.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { kernelRecords, recordApproval, shownWait } from "../src/records.js";
import { Store } from "../src/store.js";

const KEY = "k".repeat(48);
const seen: string[] = [];
const record = {
  id: "k-0123456789abcdef", kind: "apps-platform.deploy", args: { name: "crm" }, digest: "d".repeat(64), tier: 2, panel: false, task: "WOR-3", state: "owner", review: "fine",
  decided_by: null, outcome: null, created_at: "2026-11-16T10:00:00.000Z", updated_at: "2026-11-16T10:00:00.000Z",
  card: { sentence: "Deploy crm", changes: "crm", reads: "", cost: "", details: "" }, requester: { agent: "a1", key: "devops", name: "DevOps Engineer" },
};
// A claimed record in flight (the merge queue waiting on code review): its state is its own, its reason carried to the card.
const live = { ...record, id: "k-00000000000000b1", kind: "github.merge", tier: 1, state: "claimed", wait: "code review: 1 important finding open", card: { ...record.card, sentence: "Merge acme/widget#1" } };
// A Tier 0 run (a connection's write tool, made at once): only a tier0=1 list has it.
const ran = { ...record, id: "k-00000000000000aa", kind: "conn.tool", args: { connection: "slack", tool: "post_message", arguments: {} }, tier: 0, state: "done", review: null, outcome: { ok: true, text: "posted" }, card: { ...record.card, sentence: "Post in #general" } };
// A Tier 0 record still in flight: made at once, and now waiting on its executor. It is `running` with its reason, never the
// `auto` audit word a finished Tier 0 run carries.
const tier0Live = { ...record, id: "k-00000000000000b2", kind: "conn.tool", args: { connection: "slack", tool: "post_message", arguments: {} }, tier: 0, state: "claimed", wait: "waiting on slack's rate limit", review: null, card: { ...record.card, sentence: "Post in #general" } };
// A live record older than the newest 100 writes: only the live read (`state=approved`, the kernel's `approved` and `claimed`)
// carries it, so the capped history can never push a blocked merge out of the list the owner watches.
const olderLive = { ...live, id: "k-00000000000000b3", wait: "code review: 2 important findings open", card: { ...record.card, sentence: "Merge acme/older#7" } };
// A Tier 0 record in flight, old enough that the capped reads don't list it either: the live read has no tier filter, so it is
// still shown as running (its own state carries it, never the `auto` audit word).
const olderTier0Live = { ...tier0Live, id: "k-00000000000000b4", wait: "waiting on slack's rate limit (retry 2)" };
const kernel = createServer((req, res) => {
  seen.push(`${req.headers.authorization} ${req.url}`);
  const liveRead = [live, olderLive, tier0Live, olderTier0Live];
  const records = req.url!.includes("state=pending") ? [record] : req.url!.includes("state=approved") ? liveRead : req.url!.includes("tier0=1") ? [ran, tier0Live, record, live] : [record, live];
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ records }));
});
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  await new Promise<void>((r) => kernel.listen(0, "127.0.0.1", r));
  app = createApp({ paperclip: { issue: async () => ({ id: "issue-3", identifier: "WOR-3" }) } as unknown as Paperclip, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3121"], staticDir: "/nonexistent", timezone: "UTC", mode: "lan", session: () => ({ accountId: "owner", role: "admin" as const }), records: kernelRecords({ url: `http://127.0.0.1:${(kernel.address() as AddressInfo).port}`, token: KEY }) });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
});
afterAll(() => (app.close(), kernel.close()));

it("shows the kernel's records read from /v1/writes, and Tier 0 runs after the fact", async () => {
  const json = await new Promise<any>((resolve, reject) => {
    request({ host: "127.0.0.1", port: (app.address() as AddressInfo).port, path: "/api/approvals", headers: { host: "localhost:3121" } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve(JSON.parse(t)));
    }).on("error", reject).end();
  });
  expect(json.error).toBeUndefined();
  // The live read names `tier0=1`: a Tier 0 record in flight is a running card too, and no tier filter may hide it. It is also
  // paged (`live`, below): a short first page is the whole set, so no `after` follows it.
  expect(seen.sort()).toEqual([`Bearer ${KEY} /v1/writes?state=approved&limit=1000&tier0=1`, `Bearer ${KEY} /v1/writes?state=pending&limit=1000&tier0=1`, `Bearer ${KEY} /v1/writes?state=recent&limit=100`, `Bearer ${KEY} /v1/writes?state=recent&limit=100&tier0=1`]);
  expect(json.approvals).toEqual([
    expect.objectContaining({ id: record.id, action: "deploy_app", state: "pending", tier: 2, sentence: "Deploy crm", digest: record.digest }),
    // A claimed record is live, never a consumed `used` card, and carries its wait reason.
    expect.objectContaining({ id: live.id, action: "github.merge", state: "running", outcome: null, wait: "code review: 1 important finding open", sentence: "Merge acme/widget#1" }),
    // A live record the capped history doesn't list is still shown, with its current reason.
    expect.objectContaining({ id: olderLive.id, action: "github.merge", state: "running", outcome: null, wait: "code review: 2 important findings open", sentence: "Merge acme/older#7" }),
    // A Tier 0 record in flight is running with its reason too, never `auto` (the live read has no tier filter, so it carries
    // this one), and one older than every capped read is still there, with no history cap to push it out.
    expect.objectContaining({ id: tier0Live.id, action: "conn.tool", target: "slack.post_message", state: "running", tier: 0, outcome: null, wait: "waiting on slack's rate limit" }),
    expect.objectContaining({ id: olderTier0Live.id, action: "conn.tool", target: "slack.post_message", state: "running", tier: 0, outcome: null, wait: "waiting on slack's rate limit (retry 2)" }),
    // A Tier 0 run that has ended is the audit row, from the wider recent list.
    expect.objectContaining({ id: ran.id, action: "conn.tool", target: "slack.post_message", state: "auto", tier: 0, outcome: "applied", sentence: "Post in #general" }),
  ]);
});

it("a claimed record renders as running with its reason; a done one still renders applied", () => {
  const claimed = recordApproval(live as never);
  expect(claimed).toMatchObject({ state: "running", outcome: null, outcomeText: null, wait: "code review: 1 important finding open" });
  expect(claimed.state).not.toBe("used");
  // Once it ends, `used` and its outcome; the live reason is gone.
  const done = recordApproval({ ...live, state: "done", wait: null, outcome: { ok: true, text: "merged" } } as never);
  expect(done).toMatchObject({ state: "used", outcome: "applied", outcomeText: "merged", wait: null });
  // A failed run is still `used` + failed, as before.
  expect(recordApproval({ ...live, state: "failed", wait: null, outcome: { ok: false, text: "nope" } } as never)).toMatchObject({ state: "used", outcome: "failed" });
  // A Tier 0 record in flight is running with its reason; once it ends it is the `auto` audit row again.
  const tier0 = recordApproval(tier0Live as never);
  expect(tier0).toMatchObject({ state: "running", outcome: null, wait: "waiting on slack's rate limit" });
  expect(tier0.state).not.toBe("auto");
  expect(recordApproval({ ...tier0Live, state: "done", wait: null, outcome: { ok: true, text: "posted" } } as never)).toMatchObject({ state: "auto", outcome: "applied" });
});

it("a claimed record is in flight, not used: no usedAt, while every ended record keeps one", () => {
  // `usedAt` is read as when a record ran (fleet stats, feature cost, grading): a live one is not that, or it counts as
  // recent activity and as finished while it is still holding.
  expect(recordApproval({ ...live, state: "claimed" } as never).usedAt).toBeNull();
  expect(recordApproval({ ...live, state: "approved" } as never).usedAt).toBeNull();
  expect(recordApproval({ ...live, state: "done", outcome: { ok: true, text: "merged" } } as never).usedAt).toBe(record.updated_at);
  expect(recordApproval({ ...live, state: "failed", outcome: { ok: false, text: "no" } } as never).usedAt).toBe(record.updated_at);
});

it("a long wait is kept whole for change detection, and clipped on the wire the card reads", () => {
  // The kernel keeps up to 200_000 characters, and a change anywhere in it is a change of the wait: the record the board
  // compares keeps the whole reason (`shownWait` only clips what it answers).
  const long = "the reviewer is still checking this change: ".repeat(200);
  const kept = recordApproval({ ...live, wait: long } as never);
  expect(kept.state).toBe("running");
  expect(kept.wait).toBe(long);
  // What the board answers (approvalView) is clipped, and the whole approve response stays bounded.
  const shown = shownWait(kept.wait);
  expect(shown!.length).toBeLessThanOrEqual(3000);
  expect(shown!.endsWith("…")).toBe(true);
  expect(shown!.startsWith("the reviewer is still checking this change:")).toBe(true);
  // A short reason is untouched.
  expect(shownWait(recordApproval({ ...live, wait: "code review: 1 important finding open" } as never).wait)).toBe("code review: 1 important finding open");
});

it("pages the live read: the kernel's page limit is not the whole set, so an old claimed record is still listed", async () => {
  // A kernel that honours at most PAGE records per read, as the real one does (backplane.ts caps `limit` at 1000), with the
  // oldest live record only on a later page: reading one page would lose it, and with it the card the owner watches.
  const PAGE = 1000;
  const total = PAGE + 5;
  const many = Array.from({ length: total }, (_, i) => ({ ...live, id: `k-${String(i).padStart(16, "0")}`, card: { ...live.card, sentence: `Merge acme/widget#${i}` } }));
  const asked: string[] = [];
  const at = (n: number) => new Date(Date.parse("2026-11-20T00:00:00.000Z") + n * 1000).toISOString();
  many.forEach((r, i) => { (r as { created_at: string }).created_at = at(total - i); });
  const paging = createServer((req, res) => {
    const url = new URL(req.url!, "http://kernel");
    asked.push(url.search);
    const after = url.searchParams.get("after");
    const from = after ? many.findIndex((r) => r.id === after) + 1 : 0;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ records: many.slice(from, from + PAGE) }));
  });
  await new Promise<void>((r) => paging.listen(0, "127.0.0.1", r));
  try {
    const records = kernelRecords({ url: `http://127.0.0.1:${(paging.address() as AddressInfo).port}`, token: KEY });
    const all = await records.live();
    expect(all).toHaveLength(total);
    // The oldest one (only on the second page) is there, and the walk stopped at the short page.
    expect(all.at(-1)!.id).toBe(many.at(-1)!.id);
    expect(asked.filter((q) => q.includes("state=approved"))).toHaveLength(2);
    expect(asked.some((q) => q.includes(`after=${many[PAGE - 1]!.id}`))).toBe(true);
  } finally {
    paging.close();
  }
});

it("a strict read with no kernel configured fails, instead of reporting that a task has no cards", async () => {
  // The approvals check a run makes before it waits or files a merge is `strict`: a board with no kernel records client must not
  // answer "no cards", which the rule would read as "nothing will wake the task".
  const records = kernelRecords(undefined);
  await expect(records.list("recent", { tier0: true, strict: true })).rejects.toThrow(/not configured/);
  await expect(records.allOf("live", undefined, "issue-3")).rejects.toThrow(/not configured/);
  // An ordinary board view keeps its empty answer: a page never fails on a missing kernel.
  expect(await records.list("recent")).toEqual([]);
});

it("a failed live page is not the end of pagination: it throws, and the Approvals list keeps its last complete read", async () => {
  // `list()` answers [] for a timeout or an HTTP error. If `live()` took that as a short last page it would return the records
  // read so far, dropping an old blocked merge off Approvals with no sign anything went wrong. A failing page must throw instead.
  const PAGE = 1000;
  const total = PAGE + 5;
  const many = Array.from({ length: total }, (_, i) => ({ ...live, id: `k-${String(i).padStart(16, "0")}`, card: { ...live.card, sentence: `Merge acme/c${i}` } }));
  let fail = "";
  const paging = createServer((req, res) => {
    const url = new URL(req.url!, "http://kernel");
    const after = url.searchParams.get("after");
    if (fail && url.searchParams.get("state") === "approved" && after === fail) {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "kernel restarting" } }));
      return;
    }
    const from = after ? many.findIndex((r) => r.id === after) + 1 : 0;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ records: many.slice(from, from + PAGE) }));
  });
  await new Promise<void>((r) => paging.listen(0, "127.0.0.1", r));
  try {
    const records = kernelRecords({ url: `http://127.0.0.1:${(paging.address() as AddressInfo).port}`, token: KEY });
    // The first page is complete and the second fails: a failed page is a failure, never a 1,000-record answer.
    fail = many[PAGE - 1]!.id;
    await expect(records.live()).rejects.toThrow(/503/);
    // Nothing fails: every record comes back, so the throw above is the failure and not the page size.
    fail = "";
    expect(await records.live()).toHaveLength(total);
  } finally {
    paging.close();
  }
});

it("the Approvals list keeps its last complete live read when a later one fails, instead of dropping blocked cards", async () => {
  // A kernel restart mid-walk must not publish a short live list: an old blocked merge would vanish from Approvals with no sign
  // anything failed. The route answers the last complete read instead.
  let broken = false;
  const flaky = createServer((req, res) => {
    const url = new URL(req.url!, "http://kernel");
    if (broken && url.searchParams.get("state") === "approved") {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "kernel restarting" } }));
      return;
    }
    const liveRead = [live, olderLive, tier0Live, olderTier0Live];
    const records = url.searchParams.get("state") === "approved" ? liveRead : url.searchParams.get("tier0") === "1" ? [ran, tier0Live, record, live] : [record, live];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ records }));
  });
  await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", r));
  const a = createApp({ paperclip: { issue: async () => ({ id: "issue-3", identifier: "WOR-3" }) } as unknown as Paperclip, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3121"], staticDir: "/nonexistent", timezone: "UTC", mode: "lan", session: () => ({ accountId: "owner", role: "admin" as const }), records: kernelRecords({ url: `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`, token: KEY }) });
  await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
  const read = () => new Promise<any>((resolve, reject) => {
    request({ host: "127.0.0.1", port: (a.address() as AddressInfo).port, path: "/api/approvals", headers: { host: "localhost:3121" } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve(JSON.parse(t)));
    }).on("error", reject).end();
  });
  try {
    const good = await read();
    const goodIds = good.approvals.map((x: { id: string }) => x.id);
    expect(goodIds).toContain(olderLive.id);
    broken = true;
    const failed = await read();
    expect(failed.error).toBeUndefined();
    // The same live cards as the good read, not a short list missing the old blocked ones.
    const failedIds = failed.approvals.map((x: { id: string }) => x.id);
    expect(failedIds).toContain(olderLive.id);
    expect(failedIds).toContain(olderTier0Live.id);
    expect(new Set(goodIds)).toEqual(new Set(failedIds));
  } finally {
    a.close();
    flaky.close();
  }
});
