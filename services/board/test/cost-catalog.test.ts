// The Costs page's cache-savings estimate takes the gateway's model list from a read the board already made: a cold (slow)
// catalog never holds the ledger back, and the estimate appears once the list arrives.
import { describe, expect, it } from "vitest";
import http from "node:http";
import { ledgerSummary, ledgerRange } from "../src/cost-ledger.js";
import { modelCatalogCached } from "../src/costs.js";
import { Store } from "../src/store.js";

const DELAY_MS = 400;
const row = { id: "openai/gpt-sol", name: "GPT Sol", provider: "openai", created: 0, context: 0, output: 0, in: 2, cached_in: 0.2, out: 1, tools: false, reasoning: false };

describe("the catalog behind the cache savings", () => {
  it("never waits on the gateway: a slow first read is started in the background and the next ask has it", async () => {
    const server = http.createServer((req, res) => {
      if (req.url !== "/v1/models/catalog") return res.writeHead(404).end();
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [row] })), DELAY_MS);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const gateway = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t" };
    try {
      const began = Date.now();
      expect(modelCatalogCached(gateway)).toBe(null);
      expect(Date.now() - began).toBeLessThan(DELAY_MS / 2);
      await new Promise((ok) => setTimeout(ok, DELAY_MS * 3));
      expect(modelCatalogCached(gateway)).toEqual([row]);
    } finally {
      server.close();
    }
  });

  it("the ledger's savings are null without a catalog and count cached tokens at list prices with one", async () => {
    const store = new Store(":memory:");
    const now = Date.now();
    store.addUsage({ key: "k", at: new Date(now - 3_600_000).toISOString(), agentId: "ag1", component: "Chat", model: "openrouter/openai/gpt-sol", input: 1_000_000, cached: 1_000_000, output: 0, costUsd: 1, kind: "agent", status: "ok" });
    const deps = { store, agents: async () => [], key: async () => "no key on this board", spend: async () => null };
    const range = ledgerRange(new URLSearchParams(), now);
    const without = await ledgerSummary({ ...deps, catalog: () => null }, range, now);
    expect(without.insights.cache.cached).toBe(1_000_000);
    expect(without.insights.cache.savedUsd).toBe(null);
    const withCatalog = await ledgerSummary({ ...deps, catalog: () => [row] }, range, now);
    expect(withCatalog.insights.cache.savedUsd).toBeCloseTo(1_000_000 * (2 - 0.2) / 1e6);
  });
});
