import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createApp } from "../src/app.js";
import { GoogleAuth } from "../src/google.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("reconnect routes", () => {
  const seen: { path: string; body: unknown }[] = [];
  const google = new GoogleAuth("http://google", "t", undefined, (async (u: string | URL, init?: RequestInit) => {
    const path = new URL(String(u)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ path, body });
    if (path === "/auth/start") return json({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=s" });
    if (path === "/auth/finish") return body.error ? json({ error: `Google: ${body.error}` }, 400) : body.code === "good" ? json({ email: "me@work.com" }) : json({ error: "you signed in as <b>x@y.z</b>, not me@work.com; nothing changed" }, 400);
    return json({}, 404);
  }) as typeof fetch);
  const store = new Store(":memory:");
  // Starting a sign-in takes the owner's session (a stub here: a header says the owner is signed in).
  const session = (req: { headers: Record<string, unknown> }) => (req.headers["x-test-owner"] ? { accountId: "acct-owner", role: "admin" as const } : null);
  const base = { paperclip: {} as Paperclip, store, log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", google, session };
  const local = createApp({ ...base, allowedHosts: ["localhost:3121", "127.0.0.1:3121", "board.example.ts.net"], mode: "lan" });
  const lan = createApp({ ...base, allowedHosts: ["aidenhq.local"], mode: "lan", lan: { url: "http://aidenhq.local" } });
  let localBase = "";
  let lanBase = "";
  beforeAll(async () => {
    for (const s of [local, lan]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
    lanBase = `http://127.0.0.1:${(lan.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    for (const s of [local, lan]) s.close();
  });
  const get = async (url: string, host: string, owner = true) => {
    const { request } = await import("node:http");
    return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
      const r = request(url, { method: "GET", headers: { host, ...(owner ? { "x-test-owner": "1" } : {}) } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, body: data }));
      });
      r.on("error", reject);
      r.end();
    });
  };

  it("away from the laptop's loopback address, Connect opens the dialog that takes the pasted address; with go it starts at Google", async () => {
    const away = await get(`${lanBase}/google/connect?account=me%40work.com`, "aidenhq.local");
    expect(away).toMatchObject({ status: 302, location: "/#/settings/connections?connect=google_workspace&account=me%40work.com" });
    const go = await get(`${lanBase}/google/connect?go=1`, "aidenhq.local");
    expect(go.location).toContain("accounts.google.com");
    expect(seen.at(-1)).toMatchObject({ path: "/auth/start", body: { redirect_uri: "http://localhost:3121/google/callback" } });
    expect((await get(`${localBase}/google/connect`, "evil.example")).status).toBe(403);
  });

  it("finishes the sign-in and returns to the board, or to its page with why not", async () => {
    const ok = await get(`${localBase}/google/callback?state=s&code=good`, "127.0.0.1:3121");
    expect(ok).toMatchObject({ status: 302, location: "/" });
    const bad = await get(`${localBase}/google/callback?state=s&code=bad`, "127.0.0.1:3121");
    expect(bad.status).toBe(302);
    expect(bad.location).toMatch(/^\/#\/settings\/connections\?connect=google&error=/);
    expect(new URLSearchParams(bad.location!.split("?")[1]).get("error")).toContain("signed in as <b>x@y.z</b>"); // the page shows it as text
    const denied = await get(`${localBase}/google/callback?state=s&error=access_denied`, "127.0.0.1:3121");
    expect(denied).toMatchObject({ status: 302, location: expect.stringContaining("access_denied") });
  });

});
