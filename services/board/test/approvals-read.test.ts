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
  const records = req.url!.includes("state=approved") ? liveRead : req.url!.includes("tier0=1") ? [ran, tier0Live, record, live] : [record, live];
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
  // The live read names `tier0=1`: a Tier 0 record in flight is a running card too, and no tier filter may hide it.
  expect(seen.sort()).toEqual([`Bearer ${KEY} /v1/writes?state=approved&limit=1000&tier0=1`, `Bearer ${KEY} /v1/writes?state=recent&limit=100`, `Bearer ${KEY} /v1/writes?state=recent&limit=100&tier0=1`]);
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
