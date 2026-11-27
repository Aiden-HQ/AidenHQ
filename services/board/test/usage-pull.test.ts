import { describe, expect, it } from "vitest";
import { pulledRecords } from "../src/costs.js";
import { Store } from "../src/store.js";

const at = new Date().toISOString();
const rec = (key: string, kind: string, costUsd: number) => ({ key, at, agentId: null, component: kind, model: "m", input: 1, cached: 0, output: 1, costUsd, kind, status: "ok" });
// A check job's call as the gateway files it: kind `check`, no agent, component `Check jobs`. `subject` is optional here: the
// gateway sends it only for a CI review today, but it is a label the board must tolerate rather than refuse a call over.
const check = (key: string, costUsd: number, at = new Date().toISOString(), subject = `code-review:${"a".repeat(40)}`) => ({ key, at, agentId: null, component: "Check jobs", model: "m", input: 1, cached: 0, output: 1, costUsd, runKey: "f".repeat(64), runId: null, issueId: null, rev: null, kind: "check", ms: 5, status: "ok", subject });

describe("the day's cost", () => {
  it("counts every kind of call the gateway files: a check job (code review) and a CI review land in the day total", () => {
    const store = new Store(":memory:");
    const body = { records: [rec("a", "agent", 1), rec("b", "check", 2), rec("c", "reviewer", 4), rec("e", "check-v2", 16), { ...rec("d", "ci-code-review", 8), subject: "acme/app#1" }] };
    for (const r of pulledRecords(body)) store.addUsage({ ...r, component: r.component ?? "agent" });
    expect(store.usageSpend(new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() + 864e5).toISOString()).usd).toBe(31);
  });
});

describe("a check job's call", () => {
  it("lands with its dollars: a null agent and a label the old schema refused are never a reason to drop it", () => {
    const store = new Store(":memory:");
    const sent = [check("c1", 2.5), check("c2", 3.25, new Date().toISOString(), "eval:" + "b".repeat(64)), { ...rec("a", "agent", 1), agentId: "ag1" }];
    for (const r of pulledRecords({ records: sent })) store.addUsage({ ...r, component: r.component ?? "agent" });
    const day = store.usageDaily(new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() + 864e5).toISOString());
    expect(day.reduce((n, r) => n + r.costUsd, 0)).toBe(6.75);
    // The check calls keep their own row each, with no agent, so `top` never invents one.
    expect(day.filter((r) => r.agentId === null).map((r) => r.rows)).toEqual([2]);
  });

  it("keeps the call when a label is malformed, and only refuses one whose dollars are unreadable", () => {
    const body = { records: [{ ...check("bad", 1), status: "not a status!" }, { ...check("nokey", 1), key: "" }] };
    expect(pulledRecords(body).map((r) => r.key)).toEqual(["bad"]);
  });
});

describe("the usage pull", () => {
  it("drains every page a full answer names before it moves its cursor", async () => {
    const http = await import("node:http");
    const asked: string[] = [];
    const pages: Record<string, unknown> = { "": { records: [rec("a", "agent", 1)], next: { since: "2026-11-23T00:00:00.000Z", after: "a" } }, "2026-11-23T00:00:00.000Z a": { records: [rec("b", "agent", 2)] } };
    const server = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { const { since, after } = JSON.parse(b) as { since: string; after?: string }; const k = after ? `${since} ${after}` : since; asked.push(k); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(pages[k])); }); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const store = new Store(":memory:");
    const { pullUsage } = await import("../src/costs.js");
    pullUsage({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t" }, store, { warn: () => {} } as never, 3600_000);
    for (let i = 0; i < 100 && !store.meta("usage_pulled_at"); i++) await new Promise((ok) => setTimeout(ok, 10));
    server.close();
    expect(asked).toEqual(["", "2026-11-23T00:00:00.000Z a"]);
    expect(store.usageSpend(new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() + 864e5).toISOString()).usd).toBe(3);
  });

  it("re-reads the ledger a board's earlier pull skipped: a stale cursor still brings a day's check calls in", async () => {
    const http = await import("node:http");
    const day = "2026-11-25";
    // What the gateway still keeps: a day of check calls the board's table never got (a closed kind enum dropped them, or a
    // pre-paging /usage answer cut them off at 20,000 rows and the pull moved its cursor past them anyway).
    const sent = [check("d1", 40, `${day}T02:00:00.000Z`), check("d2", 60, `${day}T09:30:00.000Z`)];
    const asked: string[] = [];
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        const { since } = JSON.parse(b) as { since: string };
        asked.push(since);
        // The gateway's own rule: every row at or after `since`.
        const records = sent.filter((r) => !since || r.at >= since);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ records }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { pullUsage } = await import("../src/costs.js");
    const settle = async (n: number) => { for (let i = 0; i < 200 && asked.length < n; i++) await new Promise((ok) => setTimeout(ok, 10)); };
    const window = [`${day}T00:00:00.000Z`, "2026-11-26T00:00:00.000Z"] as const;
    const dayTotal = (store: Store) => store.usageDaily(...window).reduce((n, r) => n + r.costUsd, 0);

    // The cursor alone cannot recover it: a board that has already re-read once pulls from its cursor and gets nothing for that day.
    const caughtUp = new Store(":memory:");
    caughtUp.setMeta("usage_pulled_at", "2026-11-27T00:00:00.000Z");
    caughtUp.setMeta("usage_pulled_at_backfilled", "2026-11-27T00:00:00.000Z");
    pullUsage({ url, token: "t" }, caughtUp, { warn: () => {} } as never, 3600_000);
    await settle(1);
    expect(asked[0]).toMatch(/^2026-11-26T23:50:00\.000Z$/); // the cursor less the 10-minute margin, past the missing day
    expect(dayTotal(caughtUp)).toBe(0);

    // A board that has not re-read yet does: the first pull is the whole kept ledger, and the day's check calls land.
    const fresh = new Store(":memory:");
    fresh.setMeta("usage_pulled_at", "2026-11-27T00:00:00.000Z");
    pullUsage({ url, token: "t" }, fresh, { warn: () => {} } as never, 3600_000);
    await settle(2);
    expect(asked[1]).toBe("");
    expect(dayTotal(fresh)).toBe(100);

    // And the next pull is incremental again.
    pullUsage({ url, token: "t" }, fresh, { warn: () => {} } as never, 3600_000);
    await settle(3);
    server.close();
    expect(asked[2]).toMatch(/^20\d\d-\d\d-\d\dT/);
  });
});
