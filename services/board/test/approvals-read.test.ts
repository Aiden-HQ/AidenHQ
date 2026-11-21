// The board's Approvals list is read-only: the kernel's records (GET /v1/writes, the board's key), each decided on the
// kernel's approval page.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { kernelRecords, recordApproval } from "../src/records.js";
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
const kernel = createServer((req, res) => {
  seen.push(`${req.headers.authorization} ${req.url}`);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ records: req.url!.includes("tier0=1") ? [ran, tier0Live, record, live] : [record, live] }));
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
  expect(seen.sort()).toEqual([`Bearer ${KEY} /v1/writes?state=recent&limit=100`, `Bearer ${KEY} /v1/writes?state=recent&limit=100&tier0=1`]);
  expect(json.approvals).toEqual([
    expect.objectContaining({ id: record.id, action: "deploy_app", state: "pending", tier: 2, sentence: "Deploy crm", digest: record.digest }),
    // A claimed record is live, never a consumed `used` card, and carries its wait reason.
    expect.objectContaining({ id: live.id, action: "github.merge", state: "running", outcome: null, wait: "code review: 1 important finding open", sentence: "Merge acme/widget#1" }),
    expect.objectContaining({ id: ran.id, action: "conn.tool", target: "slack.post_message", state: "auto", tier: 0, outcome: "applied", sentence: "Post in #general" }),
    // A Tier 0 record in flight is running with its reason too, never `auto` (and only the wider list has it).
    expect.objectContaining({ id: tier0Live.id, action: "conn.tool", target: "slack.post_message", state: "running", tier: 0, outcome: null, wait: "waiting on slack's rate limit" }),
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
