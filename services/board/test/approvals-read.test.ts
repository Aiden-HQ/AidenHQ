// The board's Approvals list is read-only: its own cards and the kernel's records (GET /v1/writes, the board's key), each
// decided on the kernel's approval page.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const KEY = "k".repeat(48);
const seen: string[] = [];
const record = {
  id: "k-0123456789abcdef", kind: "apps-platform.deploy", args: { name: "crm" }, digest: "d".repeat(64), tier: 2, panel: false, task: "WOR-3", state: "owner", review: "fine",
  decided_by: null, outcome: null, created_at: "2026-11-16T10:00:00.000Z", updated_at: "2026-11-16T10:00:00.000Z",
  card: { sentence: "Deploy crm", changes: "crm", reads: "", cost: "", details: "" }, requester: { agent: "a1", key: "devops", name: "DevOps Engineer" },
};
const kernel = createServer((req, res) => {
  seen.push(`${req.headers.authorization} ${req.url}`);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ records: [record] }));
});
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  await new Promise<void>((r) => kernel.listen(0, "127.0.0.1", r));
  app = createApp({ paperclip: { issue: async () => ({ id: "issue-3", identifier: "WOR-3" }) } as unknown as Paperclip, store: new Store(":memory:"), log: pino({ level: "silent" }), allowedHosts: ["localhost:3121"], staticDir: "/nonexistent", timezone: "UTC", mode: "lan", session: () => ({ accountId: "owner", role: "admin" as const }), kernel: { url: `http://127.0.0.1:${(kernel.address() as AddressInfo).port}`, token: KEY } });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
});
afterAll(() => (app.close(), kernel.close()));

it("shows the kernel's records read from /v1/writes", async () => {
  const json = await new Promise<any>((resolve, reject) => {
    request({ host: "127.0.0.1", port: (app.address() as AddressInfo).port, path: "/api/approvals", headers: { host: "localhost:3121" } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve(JSON.parse(t)));
    }).on("error", reject).end();
  });
  expect(json.error).toBeUndefined();
  expect(seen).toEqual([`Bearer ${KEY} /v1/writes?state=recent`]);
  expect(json.approvals).toEqual([expect.objectContaining({ id: record.id, action: "deploy_app", state: "pending", tier: 2, sentence: "Deploy crm", digest: record.digest })]);
});
