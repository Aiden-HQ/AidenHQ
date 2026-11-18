import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  let lanBase = "";
  let httpsBase = "";
  beforeAll(async () => {
    for (const s of [local, lan, https]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
    lanBase = `http://127.0.0.1:${(lan.address() as AddressInfo).port}`;
    httpsBase = `http://127.0.0.1:${(https.address() as AddressInfo).port}`;
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

  it("sends the laptop to Glean with a callback on the address it came from", async () => {
    const r = await get(`${localBase}/glean/connect`, "localhost:3121");
    expect(r.status).toBe(302);
    expect(r.location).toMatch(/^https:\/\/acme\.glean\.com\//);
    expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "http://localhost:3121/callback" } });
  });

  it("returns to loopback by default from any of the board's names (the owner pastes it back)", async () => {
    expect((await get(`${httpsBase}/glean/connect`, "board.example.ts.net")).status).toBe(302);
    expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "http://localhost:3121/callback" } });
    expect((await get(`${lanBase}/glean/connect`, "aidenhq.local")).status).toBe(302);
    expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "http://localhost:3121/callback" } });
    expect((await get(`${localBase}/glean/connect`, "evil.example")).status).toBe(403);
  });

  it("connects in one click from the board's https address and finishes there; plain http off loopback can't", async () => {
    const r = await get(`${httpsBase}/glean/connect?oneclick=1`, "board.example.ts.net");
    expect(r.status).toBe(302);
    expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "https://board.example.ts.net/callback" } });
    expect(await get(`${httpsBase}/callback?state=s&code=good`, "board.example.ts.net")).toMatchObject({ status: 302, location: "/#/settings/connections?connected=glean" });
    const refused = await get(`${httpsBase}/glean/connect?oneclick=1`, "aidenhq.local");
    expect(refused.status).toBe(302);
    expect(decodeURIComponent(refused.location!)).toContain("sign in from https://board.example.ts.net");
  });

  it("finishes the sign-in and returns to the board, or to its page with why not", async () => {
    expect(await get(`${localBase}/callback?state=s&code=good`, "127.0.0.1:3121")).toMatchObject({ status: 302, location: "/#/settings/connections?connected=glean" });
    const bad = await get(`${localBase}/callback?state=s&code=bad`, "127.0.0.1:3121");
    expect(bad).toMatchObject({ status: 302, location: expect.stringMatching(/^\/#\/settings\/connections\?connect=glean&error=/) });
    expect(decodeURIComponent(bad.location!)).toContain("invalid_grant");
    const denied = await get(`${localBase}/callback?state=s&error=access_denied`, "127.0.0.1:3121");
    expect(denied).toMatchObject({ status: 302, location: expect.stringContaining("access_denied") });
  });
});

describe("Grafana sign-in routes", () => {
  const seen: { path: string; body: unknown }[] = [];
  const grafana = new McpAuth("Grafana", "http://grafana", "t", undefined, (async (u: string | URL, init?: RequestInit) => {
    const path = new URL(String(u)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ path, body });
    if (path === "/auth/start") return json({ url: "https://mcp.grafana.com/mcp/oauth/authorize?grafana_url=x&state=s" });
    if (path === "/auth/finish") return body.code === "good" ? json({ ok: true }) : json({ error: "Grafana refused the sign-in: invalid_grant" }, 400);
    return json({}, 404);
  }) as typeof fetch);
  // No Glean: its bare /callback must not reach Grafana.
  const app = createApp({ paperclip: {} as Paperclip, store: new Store(":memory:"), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", signIns: [{ id: "grafana", label: "Grafana", connect: "/grafana/connect", callback: "/grafana/callback", missing: "m", stopped: "s", fields: [], auth: grafana }], session: () => ({ accountId: "owner", role: "admin" as const }), allowedHosts: ["localhost:3121", "127.0.0.1:3121"], mode: "lan" });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });
  afterAll(() => void app.close());
  const get = async (path: string) => {
    const { request } = await import("node:http");
    return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
      const r = request(`${base}${path}`, { method: "GET", headers: { host: "localhost:3121" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, body: data }));
      });
      r.on("error", reject);
      r.end();
    });
  };

  it("sends the laptop to Grafana with its own callback, and finishes there", async () => {
    const r = await get("/grafana/connect");
    expect(r).toMatchObject({ status: 302, location: expect.stringMatching(/^https:\/\/mcp\.grafana\.com\//) });
    expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "http://localhost:3121/grafana/callback" } });
    expect(await get("/grafana/callback?state=s&code=good")).toMatchObject({ status: 302, location: "/#/settings/connections?connected=grafana" });
    expect(seen.at(-1)).toEqual({ path: "/auth/finish", body: { state: "s", code: "good" } });
    const bad = await get("/grafana/callback?state=s&code=bad");
    expect(bad).toMatchObject({ status: 302, location: expect.stringMatching(/^\/#\/settings\/connections\?connect=grafana&error=/) });
    expect(decodeURIComponent(bad.location!)).toContain("connect Grafana: Grafana refused the sign-in");
  });

  it("leaves Glean's /callback alone when Glean isn't set up", async () => {
    const before = seen.length;
    expect((await get("/callback?state=s&code=good")).status).toBe(404);
    expect(seen.length).toBe(before);
  });
});

// board.signins (lean 4c): the compiled contributions, each on only when its <id>_auth_token is mounted, on its own paths.
describe("board.signins from the compiled point", () => {
  const dir = mkdtempSync(join(tmpdir(), "signins-"));
  const point = (signins: unknown[]) => (writeFileSync(join(dir, "board.json"), JSON.stringify({ signins })), join(dir, "board.json"));
  const glean = { id: "glean", module: "glean", label: "Glean", status_url: "http://glean-mcp:8085/auth/status", connect_url: "/glean/connect", callback: "/callback", missing: "m", stopped: "s" };
  it("takes a mounted one with its proxy's base URL, and leaves one without a token off", () => {
    writeFileSync(join(dir, "glean_auth_token"), "tok\n");
    const jira = { ...glean, id: "jira", module: "jira", label: "Jira", status_url: "http://jira-mcp:8091/auth/status", connect_url: "/jira/connect", callback: "/jira/callback" };
    expect(signInPoints(point([glean, jira]), dir)).toEqual([{ id: "glean", label: "Glean", connect: "/glean/connect", callback: "/callback", httpsOnly: false, missing: "m", stopped: "s", fields: [], url: "http://glean-mcp:8085", token: "tok" }]);
  });
  it("refuses another module's paths, Google's, or a second bare /callback", () => {
    expect(() => signInPoints(point([{ ...glean, callback: "/google/callback" }]), dir)).toThrow(/its paths/);
    expect(() => signInPoints(point([{ ...glean, id: "google", module: "google", connect_url: "/google/connect" }]), dir)).toThrow(/its paths/);
    expect(() => signInPoints(point([glean, { ...glean, id: "acme", module: "acme", connect_url: "/acme/connect" }]), dir)).toThrow(/its paths/);
    expect(() => signInPoints(point([{ ...glean, module: "acme" }]), dir)).toThrow(/its own name/);
  });
});
