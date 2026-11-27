import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { createApp } from "../src/app.js";
import { McpAuth } from "../src/mcpauth.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";

// One Connect per connection (owner, 2026-11-18): a sign-in with nothing to ask goes straight to the vendor (no setup page); one
// whose vendor offers scopes, or that needs a per-install value, opens its Connect dialog on Settings > Connections first, which
// reads the offer from the API and comes back with a plain navigation (no form: the CSP allows none).
let signedIn = false;
const seen: { path: string; body: unknown }[] = [];
let finished = false;
const proxy = (offer: boolean, configured = true) =>
  new McpAuth("Acme", "http://acme", "t", undefined, (async (u: string | URL, init?: RequestInit) => {
    const path = new URL(String(u)).pathname;
    seen.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/auth/status") return Response.json({ state: signedIn || finished ? "ok" : "missing", configured, since: "2026-11-18T00:00:00Z", ...(signedIn ? { scope: "read:things write:things offline_access" } : {}) });
    if (path === "/auth/finish") {
      const { state } = JSON.parse(String(init!.body)) as { state: string };
      if (state !== "s") return Response.json({ error: "this sign-in link expired or was already used; start again from the board" }, { status: 400 });
      finished = true;
      return Response.json({ ok: true });
    }
    if (path === "/auth/scopes") return offer ? Response.json({ supported: ["read:things", "write:things"], recommended: ["read:things"] }) : Response.json({}, { status: 404 });
    if (path === "/auth/start") return Response.json({ url: "https://auth.example.com/authorize?state=s" });
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
const signIn = (id: string, auth: McpAuth, fields: { secret: string; label: string; pattern: string }[] = []) => ({ id, label: "Acme", connect: `/${id}/connect`, callback: `/${id}/callback`, missing: "m", stopped: "s", fields, auth });
const kernelOk: string[] = [];
const records = { ...fakeRecords(), connectionOk: async (m: string) => void kernelOk.push(m) };
const app = createApp({
  records,
  paperclip: {} as Paperclip,
  store: new Store(":memory:"),
  log: pino({ level: "silent" }),
  staticDir: "/nonexistent",
  timezone: "UTC",
  signIns: [signIn("acme", proxy(true)), signIn("plain", proxy(false)), signIn("site", proxy(false, false), [{ secret: "site_url", label: "Site address", pattern: "^https://.+$" }])],
  session: () => ({ accountId: "owner", role: "admin" as const }),
  allowedHosts: ["localhost:3121", "board.example.ts.net"],
  mode: "lan",
  lan: { url: "https://board.example.ts.net" },
  setupFlows: { flows: [{ module: "google", title: "Google", connect_url: "/google/connect" } as never, { module: "acme", title: "Acme" } as never] },
});
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => void app.close());
const get = (path: string, host = "localhost:3121") =>
  new Promise<{ status: number; location?: string; csp?: string; body: string }>((resolve, reject) => {
    const r = request(`${base}${path}`, { headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, csp: String(res.headers["content-security-policy"] ?? ""), body }));
    });
    r.on("error", reject);
    r.end();
  });
const post = (path: string, body: unknown, host = "board.example.ts.net") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = request(`${base}${path}`, { method: "POST", headers: { host, "content-type": "application/json", "x-aidenhq-board": "1", "x-forwarded-proto": "https", origin: `https://${host}` } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: b }));
    });
    r.on("error", reject);
    r.end(JSON.stringify(body));
  });

it("connects in one click when there is nothing to ask: no setup page, no input (ClickHouse)", async () => {
  expect(await get("/plain/connect", "board.example.ts.net")).toMatchObject({ status: 302, location: "https://auth.example.com/authorize?state=s" });
  expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "http://localhost:3121/plain/callback" } });
});

it("asks for a per-install value in the Connect dialog first, never a setup page", async () => {
  expect(await get("/site/connect")).toMatchObject({ status: 302, location: "/#/settings/connections?connect=site" });
  expect(JSON.parse((await get("/api/sign-ins/site")).body)).toMatchObject({ configured: false, fields: [{ secret: "site_url", label: "Site address" }], scopes: null });
});

it("offers the vendor's scopes in the Connect dialog, then starts the sign-in with the owner's pick", async () => {
  const first = await get("/acme/connect");
  expect(first).toMatchObject({ status: 302, location: "/#/settings/connections?connect=acme" });
  expect(first.csp).toContain("form-action 'none'");
  expect(JSON.parse((await get("/api/sign-ins/acme")).body)).toMatchObject({ id: "acme", label: "Acme", connect: "/acme/connect", configured: true, fields: [], scopes: { supported: ["read:things", "write:things"], recommended: ["read:things"] } });
  const go = await get("/acme/connect?picked=1&scope=read%3Athings&scope=write%3Athings");
  expect(go).toMatchObject({ status: 302, location: "https://auth.example.com/authorize?state=s" });
  expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "http://localhost:3121/acme/callback", scopes: ["read:things", "write:things"] } });
});

it("sends a failed sign-in back to its Connect dialog, the reason in the address", async () => {
  const denied = await get("/acme/callback?state=s&error=access_denied");
  expect(denied.status).toBe(302);
  expect(denied.location).toMatch(/^\/#\/settings\/connections\?connect=acme&error=/);
  expect(new URLSearchParams(denied.location!.split("?")[1]).get("error")).toBe("Couldn't connect Acme: Acme didn't grant access: access was declined on the sign-in page; press Connect and choose Allow");
});

it("offers the scopes a signed-in connection already grants, so the picker opens on them", async () => {
  signedIn = true;
  const view = JSON.parse((await get("/api/sign-ins/acme")).body);
  signedIn = false;
  expect(view.scopes).toEqual({ supported: ["read:things", "write:things"], recommended: ["read:things"], granted: ["read:things", "write:things"] });
});

// Loopback + paste (owner, 2026-11-18): a sign-in returns to http://localhost:3121 by default, which a company's domain allowlist
// doesn't cover (Atlassian blocked the board's https name); the owner pastes the address it ended on, and the board finishes it.
it("finishes a loopback sign-in from the pasted address, refusing any other address", async () => {
  await get("/plain/connect", "board.example.ts.net");
  expect(seen.at(-1)?.body).toEqual({ redirect_uri: "http://localhost:3121/plain/callback" });
  expect(JSON.parse((await get("/api/sign-ins/plain", "board.example.ts.net")).body)).toMatchObject({ redirect: "http://localhost:3121/plain/callback", oneClick: "board.example.ts.net", state: "missing" });
  for (const url of [
    "https://localhost:3121/plain/callback?state=s&code=c",
    "http://evil.example.com:3121/plain/callback?state=s&code=c",
    "http://localhost:8080/plain/callback?state=s&code=c",
    "http://localhost:3121/acme/callback?state=s&code=c",
    "http://localhost:3121/plain/callback?code=c",
    "not a url",
  ]) {
    const r = await post("/api/sign-ins/plain/finish", { url });
    expect(r.status).toBe(400);
    expect(r.body).not.toContain("code=c");
  }
  expect(seen.some((x) => x.path === "/auth/finish")).toBe(false);
  expect(JSON.parse((await post("/api/sign-ins/plain/finish", { url: "http://localhost:3121/plain/callback?state=s&error=access_denied" })).body).error).toBe("Couldn't connect Acme: Acme didn't grant access: access was declined on the sign-in page; press Connect and choose Allow");
  expect(await post("/api/sign-ins/plain/finish", { url: " http://127.0.0.1:3121/plain/callback?code=c0de&state=s " })).toEqual({ status: 200, body: '{"ok":true}' });
  expect(seen.at(-1)).toEqual({ path: "/auth/finish", body: { state: "s", code: "c0de" } });
  expect(JSON.parse((await get("/api/sign-ins/plain", "board.example.ts.net")).body).state).toBe("ok");
});

it("keeps one click to the board's https address as the other way", async () => {
  expect(await get("/plain/connect?oneclick=1", "board.example.ts.net")).toMatchObject({ status: 302, location: "https://auth.example.com/authorize?state=s" });
  expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "https://board.example.ts.net/plain/callback" } });
});

// The one link the kernel gives the owner (connection-state.ts): the same path in every exposure mode, redirecting to what that
// module's Connect is.
it("/connect/<module> goes to a sign-in's Connect, a flow's own connect path, else its setup page", async () => {
  for (const host of ["localhost:3121", "board.example.ts.net"]) {
    expect(await get("/connect/plain", host)).toMatchObject({ status: 302, location: "/plain/connect" });
    expect(await get("/connect/google", host)).toMatchObject({ status: 302, location: "/google/connect" });
    expect(await get("/connect/telegram", host)).toMatchObject({ status: 302, location: "/#/setup/telegram" });
  }
});

it("a finished sign-in tells the kernel once", async () => {
  kernelOk.length = 0;
  await post("/api/sign-ins/plain/finish", { url: "http://localhost:3121/plain/callback?state=s&code=c0de" });
  expect(kernelOk).toEqual(["plain"]);
});
