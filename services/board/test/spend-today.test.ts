import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spendToday } from "../src/costs.js";

describe("spendToday", () => {
  it("shows the gateway's spend against the install cap, and nothing without one", async () => {
    let body: unknown = { day: "2026-11-18", spent: 3.2, cap: 10 };
    const s = http.createServer((req, res) => res.writeHead(req.headers.authorization === "Bearer k" ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(body)));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const gateway = { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, token: "k" };
    try {
      expect(await spendToday(gateway)).toEqual({ spent: 3.2, cap: 10 });
      body = { day: "2026-11-18", spent: 3.2, cap: null };
      expect(await spendToday(gateway)).toBeNull();
      expect(await spendToday({ ...gateway, token: "wrong" })).toBeNull();
      expect(await spendToday(undefined)).toBeNull();
    } finally {
      s.close();
    }
  });
});
