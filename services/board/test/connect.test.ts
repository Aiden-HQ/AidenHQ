import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { McpAuth } from "../src/mcpauth.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

// One Connect per connection (owner, 2026-11-18): a sign-in with nothing to ask goes straight to the vendor (no setup page); one
// whose vendor offers scopes, or that needs a per-install value, opens its Connect dialog on Settings > Connections first, which
// reads the offer from the API and comes back with a plain navigation (no form: the CSP allows none).
let signedIn = false;
const seen: { path: string; body: unknown }[] = [];
const proxy = (offer: boolean, configured = true) =>
  new McpAuth("Acme", "http://acme", "t", undefined, (async (u: string | URL, init?: RequestInit) => {
    const path = new URL(String(u)).pathname;
    seen.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/auth/status") return Response.json({ state: signedIn ? "ok" : "missing", configured, since: "2026-11-18T00:00:00Z", ...(signedIn ? { scope: "read:things write:things offline_access" } : {}) });
    if (path === "/auth/scopes") return offer ? Response.json({ supported: ["read:things", "write:things"], recommended: ["read:things"] }) : Response.json({}, { status: 404 });
    if (path === "/auth/start") return Response.json({ url: "https://auth.example.com/authorize?state=s" });
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
const signIn = (id: string, auth: McpAuth, fields: { secret: string; label: string; pattern: string }[] = []) => ({ id, label: "Acme", connect: `/${id}/connect`, callback: `/${id}/callback`, missing: "m", stopped: "s", fields, auth });
const app = createApp({
  paperclip: {} as Paperclip,
  store: new Store(":memory:"),
  log: pino({ level: "silent" }),
  staticDir: "/nonexistent",
  timezone: "UTC",
  signIns: [signIn("acme", proxy(true)), signIn("plain", proxy(false)), signIn("site", proxy(false, false), [{ secret: "site_url", label: "Site address", pattern: "^https://.+$" }])],
  session: () => ({ accountId: "owner", role: "admin" as const }),
  allowedHosts: ["localhost:3121"],
  mode: "lan",
});
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => void app.close());
const get = (path: string) =>
  new Promise<{ status: number; location?: string; csp?: string; body: string }>((resolve, reject) => {
    const r = request(`${base}${path}`, { headers: { host: "localhost:3121" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, csp: String(res.headers["content-security-policy"] ?? ""), body }));
    });
    r.on("error", reject);
    r.end();
  });

it("connects in one click when there is nothing to ask: no setup page, no input (ClickHouse)", async () => {
  expect(await get("/plain/connect")).toMatchObject({ status: 302, location: "https://auth.example.com/authorize?state=s" });
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
  expect(JSON.parse((await get("/api/sign-ins/acme")).body)).toEqual({ id: "acme", label: "Acme", connect: "/acme/connect", configured: true, fields: [], scopes: { supported: ["read:things", "write:things"], recommended: ["read:things"] } });
  const go = await get("/acme/connect?picked=1&scope=read%3Athings&scope=write%3Athings");
  expect(go).toMatchObject({ status: 302, location: "https://auth.example.com/authorize?state=s" });
  expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "http://localhost:3121/acme/callback", scopes: ["read:things", "write:things"] } });
});

it("sends a failed sign-in back to its Connect dialog, the reason in the address", async () => {
  const denied = await get("/acme/callback?state=s&error=access_denied");
  expect(denied.status).toBe(302);
  expect(denied.location).toMatch(/^\/#\/settings\/connections\?connect=acme&error=/);
  expect(new URLSearchParams(denied.location!.split("?")[1]).get("error")).toBe("Couldn't connect Acme: Acme didn't grant access (access_denied)");
});

it("offers the scopes a signed-in connection already grants, so the picker opens on them", async () => {
  signedIn = true;
  const view = JSON.parse((await get("/api/sign-ins/acme")).body);
  signedIn = false;
  expect(view.scopes).toEqual({ supported: ["read:things", "write:things"], recommended: ["read:things"], granted: ["read:things", "write:things"] });
});
