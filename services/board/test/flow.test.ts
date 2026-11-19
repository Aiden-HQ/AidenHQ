// The board's read of the kernel's /v1/flow (src/flow.ts).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { kernelFlow } from "../src/flow.js";

const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A stand-in kernel: records each request's query and answers from `routes` by its first parameter. */
async function kernel(answers: Record<string, unknown>) {
  const seen: { url: string; auth?: string }[] = [];
  const s = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    seen.push({ url: `${u.pathname}?${u.searchParams}`, auth: req.headers.authorization });
    const key = u.searchParams.has("idle") ? "idle" : u.searchParams.has("item") ? `item:${u.searchParams.get("item")}` : u.searchParams.has("journeys") ? "journeys" : u.searchParams.has("journey") ? "journey" : "summary";
    if (!(key in answers)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answers[key]));
  }).listen(0);
  servers.push(s);
  await new Promise((r) => s.once("listening", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
}

describe("flow reads", () => {
  it("asks the kernel for the period's summary, the idle list and an item, with the board's key", async () => {
    const summary = { stages: [{ name: "grade", label: "Grade", n: 12, work_p50: 600, work_p75: 900, wait_p50: 7200, wait_p75: 9000, waits: { grader_retry: 62, checks: 38 } }], dora: null, churn: null, fleet: {} };
    const k = await kernel({
      summary,
      idle: { items: [{ task: "t1", identifier: "WOR-1", since: "2026-11-19T10:00:00Z", reason: "orphaned", holder: null }] },
      "item:t1": { task: "t1", root: "WOR-1", facts: [], stages: [], idle: [] },
    });
    const flow = kernelFlow({ url: k.url, token: "board-key" });
    expect(await flow.summary({ since: "2026-11-12T00:00:00Z", to: "2026-11-19T00:00:00Z", scope: "all" })).toEqual(summary);
    expect((await flow.idle())[0]!.identifier).toBe("WOR-1");
    expect((await flow.item("t1"))!.root).toBe("WOR-1");
    expect(await flow.item("nope")).toBeNull();
    expect(k.seen[0]).toEqual({ url: "/v1/flow?since=2026-11-12T00%3A00%3A00Z&to=2026-11-19T00%3A00%3A00Z&by=stage", auth: "Bearer board-key" });
  });

  it("lists the journeys and asks for one's items with the author filter and sort", async () => {
    const phases = [{ name: "open", label: "PR open" }];
    const k = await kernel({ journeys: { journeys: [{ name: "pr", label: "Pull requests", phases }] }, journey: { journey: "pr", label: "Pull requests", phases, items: [], truncated: false } });
    const flow = kernelFlow({ url: k.url, token: "board-key" });
    expect((await flow.journeys())[0]!.name).toBe("pr");
    expect((await flow.journey({ journey: "pr", since: "2026-11-12T00:00:00Z", to: "2026-11-19T00:00:00Z", author: ["agent", "owner"], sort: "slowest", limit: 500 }))!.truncated).toBe(false);
    expect(k.seen[1]!.url).toBe("/v1/flow?journey=pr&since=2026-11-12T00%3A00%3A00Z&to=2026-11-19T00%3A00%3A00Z&author=agent%2Cowner&sort=slowest&limit=500");
  });
});
