import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createApp } from "../src/app.js";
import { McpAuth } from "../src/mcpauth.js";
import { signInPoints } from "../src/config.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Glean sign-in routes", () => {
  const seen: { path: string; body: unknown }[] = [];
  const glean = new McpAuth("Glean", "http://glean", "t", undefined, (async (u: string | URL, init?: RequestInit) => {
    const path = new URL(String(u)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ path, body });
    if (path === "/auth/start") return json({ url: "https://acme.glean.com/oauth/authorize?state=s" });
    if (path === "/auth/finish") return body.code === "good" ? json({ ok: true }) : json({ error: "Glean refused the sign-in: <i>invalid_grant</i>" }, 400);
    return json({}, 404);
  }) as typeof fetch);
  const store = new Store(":memory:");
  const base = { paperclip: {} as Paperclip, store, log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", signIns: [{ id: "glean", label: "Glean", connect: "/glean/connect", callback: "/callback", missing: "m", stopped: "s", fields: [], auth: glean }], session: () => ({ accountId: "owner", role: "admin" as const }) };
  const local = createApp({ ...base, allowedHosts: ["localhost:3121", "127.0.0.1:3121", "board.example.ts.net"], mode: "lan" });
  const lan = createApp({ ...base, allowedHosts: ["aidenhq.local"], mode: "lan", lan: { url: "http://aidenhq.local" } });
  // A board with an https address (tailscale serve or Caddy in front of 3121): Connect works there, one click.
  const https = createApp({ ...base, allowedHosts: ["board.example.ts.net", "aidenhq.local"], mode: "lan", lan: { url: "https://board.example.ts.net" } });
  let localBase = "";
  beforeAll(async () => {
    for (const s of [local, lan, https]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    for (const s of [local, lan, https]) s.close();
  });
  const get = async (url: string, host: string) => {
    const { request } = await import("node:http");
    return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
      const r = request(url, { method: "GET", headers: { host } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, body: data }));
      });
      r.on("error", reject);
      r.end();
    });
  };

  it("finishes the sign-in and returns to the board, or to its page with why not", async () => {
    expect(await get(`${localBase}/callback?state=s&code=good`, "127.0.0.1:3121")).toMatchObject({ status: 302, location: "/#/settings/connections?connected=glean" });
    const bad = await get(`${localBase}/callback?state=s&code=bad`, "127.0.0.1:3121");
    expect(bad.status).toBe(302);
    expect(bad.location).toMatch(/^\/#\/settings\/connections\?connect=glean&error=/);
    expect(decodeURIComponent(bad.location!)).toContain("invalid_grant");
    const denied = await get(`${localBase}/callback?state=s&error=access_denied`, "127.0.0.1:3121");
    expect(denied).toMatchObject({ status: 302, location: expect.stringContaining("declined") });
  });
});

// board.signins (lean 4c): the compiled contributions, each on only when its <id>_auth_token is mounted, on its own paths.
describe("board.signins from the compiled point", () => {
  const dir = mkdtempSync(join(tmpdir(), "signins-"));
  const point = (signins: unknown[]) => (writeFileSync(join(dir, "board.json"), JSON.stringify({ signins })), join(dir, "board.json"));
  const glean = { id: "glean", module: "glean", label: "Glean", status_url: "http://glean-mcp:8085/auth/status", connect_url: "/glean/connect", callback: "/callback", missing: "m", stopped: "s" };
  it("refuses another module's paths, Google's, or a second bare /callback", () => {
    expect(() => signInPoints(point([{ ...glean, callback: "/google/callback" }]), dir)).toThrow(/its paths/);
    expect(() => signInPoints(point([{ ...glean, id: "google", module: "google", connect_url: "/google/connect" }]), dir)).toThrow(/its paths/);
    expect(() => signInPoints(point([glean, { ...glean, id: "acme", module: "acme", connect_url: "/acme/connect" }]), dir)).toThrow(/its paths/);
    expect(() => signInPoints(point([{ ...glean, module: "acme" }]), dir)).toThrow(/its own name/);
  });
});

