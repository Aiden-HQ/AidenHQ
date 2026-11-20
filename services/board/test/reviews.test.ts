// The Reviews page's routes: the code-review service's reads passed through, and the owner's whole settings.code_review
// filed as an ordinary settings change (a module-declared `type: object` setting), refused when its shape is wrong.
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import type { Reviews } from "../src/reviews-client.js";
import { insightsOf, type Run } from "../src/reviews.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";

const COMBO = { engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "medium", run_usd: 1 };
const CONFIG = {
  repos: [] as unknown[],
  month_usd: 200,
};
const dir = mkdtempSync(join(tmpdir(), "reviews-"));
writeFileSync(join(dir, "paperclip.yaml"), stringify({ settings: { code_review: { value: CONFIG, set: false } }, agents: {} }));
writeFileSync(join(dir, "modules.json"), JSON.stringify([{ name: "code-review", enabled: true, settings: { code_review: { default: CONFIG, type: "object" } } }, { name: "github", enabled: true, settings: {} }]));
process.env.BOARD_PAPERCLIP_CONFIG = join(dir, "paperclip.yaml");
process.env.BOARD_MODULES_FILE = join(dir, "modules.json");

const run: Run = { id: "r1", repo: "acme/payments", number: 42, head: "a".repeat(40), engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "medium", kind: "auto", status: "done", why: null, cost_usd: 0.4, tokens_in: 10, tokens_out: 5, duration_ms: 1000, full: false, incremental_from: null, posted: true, important: 1, nit: 2, pre_existing: 0, started: new Date().toISOString(), ended: new Date().toISOString(), resolved: 1 };
const asked: unknown[] = [];
const reviews = {
  list: async (q: unknown) => (asked.push(q), { runs: [run] }),
  run: async (b: unknown) => (asked.push(b), { runs: [run] }),
} as unknown as Reviews;
const created: Record<string, any>[] = [];
const pc = {
  me: async () => "owner-user",
  agents: async () => [],
  labels: async () => [{ id: "l1", name: "settings-change", color: "#000" }],
  company: async () => ({ issuePrefix: "WOR" }),
  createIssue: async (b: Record<string, any>) => (created.push(b), { id: "i1", identifier: "WOR-9", ...b }),
} as unknown as Paperclip;

describe("the Reviews page's routes", () => {
  const records = fakeRecords();
  const app = createApp({ paperclip: pc, store: new Store(":memory:"), records, reviews, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" }) });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1" } }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out ? JSON.parse(out) : null }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });

  it("reads the runs and starts a one-off review of a PR link only", async () => {
    expect((await call("GET", "/api/reviews?repo=acme/payments")).body.runs).toHaveLength(1);
    expect((await call("POST", "/api/reviews", { pr_url: "https://evil.example.com/acme/x/pull/1" })).status).toBe(400);
    expect((await call("POST", "/api/reviews", { pr_url: "https://github.com/acme/payments/pull/42", combos: [COMBO] })).status).toBe(200);
    expect(asked).toEqual([{ repo: "acme/payments", status: undefined, limit: 100 }, { pr_url: "https://github.com/acme/payments/pull/42", combos: [COMBO] }]);
  });

  it("files a watched repo as one settings change, and refuses the old reviewers and string-trigger shape", async () => {
    const value = { ...CONFIG, repos: [{ repo: "acme/payments", on_open: [COMBO], on_push: [{ ...COMBO, effort: "low" }], month_usd: 50 }] };
    expect((await call("POST", "/api/reviews/config", { value: { ...value, repos: [{ repo: "acme/payments", on_open: "standard", on_push: [] }] } })).status).toBe(400);
    expect((await call("POST", "/api/reviews/config", { value: { ...value, reviewers: {} } })).status).toBe(400);
    expect((await call("POST", "/api/reviews/config", { value: { ...value, repos: [{ ...value.repos[0], on_open: [{ ...COMBO, effort: "max" }] }] } })).status).toBe(400);
    expect(await call("POST", "/api/reviews/config", { value })).toMatchObject({ status: 200, body: { identifier: "WOR-9" } });
    expect(records.settings).toEqual([{ task: "i1", changes: [{ kind: "setting", key: "code_review", value }] }]);
    expect(created[0]!.title).toBe("Settings: code_review updated");
  });

  it("counts the period's reviews, spend and auto-resolved findings", () => {
    const i = insightsOf([run, { ...run, id: "r2", status: "skipped", why: "draft", cost_usd: 0, important: 0, nit: 0 }], 7);
    expect(i.total).toMatchObject({ reviews: 1, prs: 1 });
    expect(i.severity).toEqual({ important: 1, nit: 2, pre_existing: 0 });
    expect(i.resolved_rate).toBeCloseTo(1 / 3);
    expect(i.skips).toEqual([{ why: "draft", n: 1 }]);
  });
});
