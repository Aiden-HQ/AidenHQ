import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { McpAuth } from "../src/mcpauth.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

// The owner picks what a vendor sign-in grants (owner, 2026-11-18): a proxy offering scopes gets a form first.
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

it("asks which scopes to grant, the recommended ones ticked, then starts the sign-in with the owner's pick", async () => {
  const form = await get("/acme/connect");
  expect(form.status).toBe(200);
  expect(form.csp).toContain("form-action 'self'");
  expect(form.body).toContain('value="read:things" checked');
  expect(form.body).toMatch(/value="write:things">/);
  expect(seen.some((s) => s.path === "/auth/start")).toBe(false);
  const go = await get("/acme/connect?picked=1&scope=read%3Athings&scope=write%3Athings");
  expect(go).toMatchObject({ status: 302, location: "https://auth.example.com/authorize?state=s" });
  expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "http://localhost:3121/acme/callback", scopes: ["read:things", "write:things"] } });
});
