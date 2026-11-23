import { describe, expect, it } from "vitest";
import { pulledRecords } from "../src/costs.js";
import { Store } from "../src/store.js";

const at = new Date().toISOString();
const rec = (key: string, kind: string, costUsd: number) => ({ key, at, agentId: null, component: kind, model: "m", input: 1, cached: 0, output: 1, costUsd, kind, status: "ok" });

describe("the day's cost", () => {
  it("counts every kind of call the gateway files: a check job (code review) and a CI review land in the day total", () => {
    const store = new Store(":memory:");
    const body = { records: [rec("a", "agent", 1), rec("b", "check", 2), rec("c", "reviewer", 4), rec("e", "check-v2", 16), { ...rec("d", "ci-code-review", 8), subject: "acme/app#1" }] };
    for (const r of pulledRecords(body)) store.addUsage({ ...r, component: r.component ?? "agent" });
    expect(store.usageSpend(new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() + 864e5).toISOString()).usd).toBe(31);
  });
});

describe("the usage pull", () => {
  it("drains every page a full answer names before it moves its cursor", async () => {
    const http = await import("node:http");
    const asked: string[] = [];
    const pages: Record<string, unknown> = { "": { records: [rec("a", "agent", 1)], next: "2026-11-23T00:00:00.000Z" }, "2026-11-23T00:00:00.000Z": { records: [rec("b", "agent", 2)] } };
    const server = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { const since = JSON.parse(b).since as string; asked.push(since); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(pages[since])); }); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const store = new Store(":memory:");
    const { pullUsage } = await import("../src/costs.js");
    pullUsage({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t" }, store, { warn: () => {} } as never, 3600_000);
    for (let i = 0; i < 100 && !store.meta("usage_pulled_at"); i++) await new Promise((ok) => setTimeout(ok, 10));
    server.close();
    expect(asked).toEqual(["", "2026-11-23T00:00:00.000Z"]);
    expect(store.usageSpend(new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() + 864e5).toISOString()).usd).toBe(3);
  });
});
