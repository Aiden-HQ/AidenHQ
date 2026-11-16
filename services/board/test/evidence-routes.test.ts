import type { AddressInfo } from "node:net";
import { request } from "node:http";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeGrading } from "./fake-grading.js";

const TOKEN = "t".repeat(64);
const RUNNER_KEY = "r".repeat(48);
const DECIDE_KEY = "d".repeat(32);

// The grade-state routes live in the grading module; the board keeps the evidence routes its grader reads and the owner's notice line.
describe("grader evidence routes", () => {
  const app = createApp({ paperclip: {} as Paperclip, store: new Store(":memory:"), grading: fakeGrading(), log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, reviewerKey: RUNNER_KEY, gatewayKey: DECIDE_KEY });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const runner = { "x-reviewer-key": RUNNER_KEY };
  const get = (path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end();
    });

  it("the grade-state routes are gone (the grading module owns them)", async () => {
    expect((await get("/internal/grades", runner)).status).toBe(404);
  });

  it("owner notices are the kernel's to collect, and escalated grades are never among them", async () => {
    expect((await get("/internal/owner/grades", {})).status).toBe(403);
    expect((await get("/internal/owner/grades", { "x-gateway-key": DECIDE_KEY })).json).toEqual({ lines: [] });
  });

  // The app's status row keeps a bounded deploy list, so a merge it has moved past is looked up by exact commit instead;
  // the board forwards that to apps-mcp with the apps token and the runner's own key.
  it("the grader reads one commit's deploys from apps-mcp, with the runner's key and the apps token", async () => {
    const sha = "a".repeat(40);
    const calls: { url: string; init: RequestInit }[] = [];
    const prev = process.env.APPS_INTERNAL_TOKEN_FILE;
    process.env.APPS_INTERNAL_TOKEN_FILE = `${import.meta.dirname}/fixtures/apps_token`;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ deploys: [{ sha, at: 1_700_000_000_000, by: "auto-deploy", status: "healthy" }] }));
    });
    try {
      // Only the runner's own key opens it: the internal token alone is readable by agents.
      expect((await get(`/internal/grades/deploys/keeper/${sha}`, {})).status).toBe(403);
      // Only a full sha: a short one could match nothing and read as never deployed.
      expect((await get("/internal/grades/deploys/keeper/aaaaaaaa", runner)).status).toBe(404);
      const r = await get(`/internal/grades/deploys/keeper/${sha}`, runner);
      expect(r.json).toEqual({ deploys: [{ sha, at: 1_700_000_000_000, by: "auto-deploy", status: "healthy" }] });
      expect(calls.map((c) => c.url)).toEqual([`http://apps-mcp:8090/internal/deploys/keeper/${sha}`]);
      expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer apps-token");
      expect((calls[0]!.init.headers as Record<string, string>)["x-reviewer-key"]).toBeUndefined(); // the board's own call, not relayed
    } finally {
      vi.unstubAllGlobals();
      if (prev === undefined) delete process.env.APPS_INTERNAL_TOKEN_FILE;
      else process.env.APPS_INTERNAL_TOKEN_FILE = prev;
    }
  });
});
