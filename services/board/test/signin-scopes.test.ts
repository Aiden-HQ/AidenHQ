import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { McpAuth } from "../src/mcpauth.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

// The owner picks what a vendor sign-in grants (owner, 2026-11-18): a proxy offering scopes sends the browser to the board's
// picker (#/connect/<id>), which reads the offer from the API and comes back with a plain navigation (no form: the CSP
// allows none, and a form posting to a path that redirects off-site is blocked by form-action).
const seen: { path: string; body: unknown }[] = [];
const acme = new McpAuth("Acme", "http://acme", "t", undefined, (async (u: string | URL, init?: RequestInit) => {
  const path = new URL(String(u)).pathname;
  seen.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (path === "/auth/scopes") return Response.json({ supported: ["read:things", "write:things"], recommended: ["read:things"] });
  if (path === "/auth/start") return Response.json({ url: "https://auth.example.com/authorize?state=s" });
  return Response.json({}, { status: 404 });
}) as typeof fetch);
const app = createApp({ paperclip: {} as Paperclip, store: new Store(":memory:"), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", signIns: [{ id: "acme", label: "Acme", connect: "/acme/connect", callback: "/acme/callback", missing: "m", stopped: "s", auth: acme }], session: () => ({ accountId: "owner", role: "admin" as const }), allowedHosts: ["localhost:3121"], mode: "lan" });
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

it("asks which scopes to grant on the board's picker, then starts the sign-in with the owner's pick", async () => {
  const first = await get("/acme/connect");
  expect(first).toMatchObject({ status: 302, location: "/#/connect/acme" });
  expect(first.csp).toContain("form-action 'none'");
  expect(JSON.parse((await get("/api/sign-ins/acme")).body)).toEqual({ id: "acme", label: "Acme", connect: "/acme/connect", setup: null, scopes: { supported: ["read:things", "write:things"], recommended: ["read:things"] } });
  expect(seen.some((s) => s.path === "/auth/start")).toBe(false);
  const go = await get("/acme/connect?picked=1&scope=read%3Athings&scope=write%3Athings");
  expect(go).toMatchObject({ status: 302, location: "https://auth.example.com/authorize?state=s" });
  expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "http://localhost:3121/acme/callback", scopes: ["read:things", "write:things"] } });
});

it("sends a failed sign-in back to the board's page for it, the reason in the address", async () => {
  const denied = await get("/acme/callback?state=s&error=access_denied");
  expect(denied.status).toBe(302);
  expect(denied.location).toMatch(/^\/#\/connect\/acme\?error=/);
  expect(new URLSearchParams(denied.location!.split("?")[1]).get("error")).toBe("Couldn't connect Acme: Acme didn't grant access (access_denied)");
});
