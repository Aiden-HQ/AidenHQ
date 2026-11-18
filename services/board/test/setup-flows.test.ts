// Setup flows through the board: the kernel's save_secret and setup_status stood in for (kernel.ts), the module's pairing
// endpoint a fake fetch. Admins only; the pair token never reaches the browser.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { GoogleAuth } from "../src/google.js";
import { createKernelAuth } from "../src/kernel-auth.js";
import { Paperclip } from "../src/paperclip.js";
import { namedHost } from "../src/setup-flows.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";
import { BOARD_KEY, fakeKernel, type FakeAccount } from "./kernel.js";

const flows = [
  { module: "phone", order: 10, title: "Phone", why: "Aiden on your phone.", effort: "about 2 minutes", steps: "1. Paste the token.", secrets: ["phone_bot_token"], pair_url: "http://phone:8090/pair", pair_token: "phone_pair_token", token: "pair-secret" },
  { module: "plain", order: 20, title: "Plain", why: "Nothing to pair.", effort: "a minute", steps: "Nothing.", signin: "plain" },
  { module: "vaultless", order: 40, title: "Vaultless", why: "Works from old settings.", effort: "a minute", steps: "Nothing.", secrets: ["vaultless_url"], signin: "working" },
  { module: "secrets", order: 50, title: "Secrets", why: "Only secrets.", effort: "a minute", steps: "Nothing.", secrets: ["secrets_key"] },
  { module: "docs", order: 30, title: "Docs", why: "Your documents.", effort: "a minute", steps: "Add `{board_url}/google/callback`.", connect_url: "/google/connect", needs_name: "Needs a named address." },
  { module: "hub", order: 60, title: "Hub", why: "A CRM.", effort: "a minute", steps: "Make a client.", secrets: ["hub_client_id"], signin: "hub" },
];
// The board's own connection behind /google/connect: its accounts, and the redirect it was asked to send Google back to.
let googleOk = false;
const googleStarts: string[] = [];
const google = {
  status: async () => ({ accounts: googleOk ? [{ email: "a@example.com", primary: true, state: "ok", since: "" }] : [] }),
  start: async (_account: string | undefined, redirectUri: string) => (googleStarts.push(redirectUri), { url: "https://accounts.example.com/o/oauth2" }),
} as unknown as GoogleAuth;
let paired = false;
const pairCalls: { method: string; auth: string }[] = [];
const fakePair = (async (_url: string, init: RequestInit) => {
  pairCalls.push({ method: String(init.method), auth: String((init.headers as Record<string, string>).authorization) });
  return new Response(JSON.stringify(init.method === "POST" ? { code: "ABCD-1234", link: "https://t.me/bot?start=ABCD" } : { paired, ...(paired ? { paired_at: "2026-11-17T10:00:00.000Z" } : {}) }), { status: 200 });
}) as unknown as typeof fetch;

describe("setup flows", () => {
  const store = new Store(":memory:");
  let app: ReturnType<typeof createApp>;
  let port = 0;
  let kernel: Awaited<ReturnType<typeof fakeKernel>>;
  beforeAll(async () => {
    kernel = await fakeKernel();
    const accounts = createKernelAuth({ kernel: { url: kernel.url, token: BOARD_KEY }, adminUrl: "http://localhost:3120" });
    const paperclip = new Paperclip("http://paperclip", "00000000-0000-4000-8000-000000000001", "k", (async () => new Response("[]")) as unknown as typeof fetch);
    app = createApp({ paperclip, store, records: fakeRecords(), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: ["localhost:3121"], mode: "lan", lan: { url: "https://aiden.example.com", googleConnect: true }, google, signIns: [
        { id: "working", label: "Working", connect: "/working/connect", callback: "/working/callback", missing: "m", stopped: "s", fields: [], auth: { status: async () => ({ state: "ok" }), scopes: async () => undefined, offers: async () => false } as never },
        ...["plain", "hub"].map((id) => ({ id, label: id, connect: `/${id}/connect`, callback: `/${id}/callback`, missing: "m", stopped: "s", fields: [], auth: { status: async () => ({ state: "missing" }), scopes: async () => null, offers: async () => false, start: async () => ({ url: `https://${id}.example.com/authorize` }), finish: async () => {} } as never })),
      ], setupFlows: { flows, fetchImpl: fakePair } });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.close();
    kernel.close();
  });

  function as(account: FakeAccount) {
    let cookie = "";
    return (method: string, path: string, body?: unknown) =>
      new Promise<{ status: number; json: any; location?: string }>((resolve, reject) => {
        cookie ||= `aidenhq-board=${kernel.session(account)}`;
        const headers: Record<string, string> = { host: "localhost:3121", cookie, ...(method !== "GET" ? { "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3121" } : {}) };
        const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined, location: res.headers.location }));
        });
        req.on("error", reject);
        req.end(body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body));
      });
  }
  const admin = as({ id: "u-1", email: "a@example.com", name: "A", role: "admin", owner: true });
  const other = as({ id: "u-3", email: "o@example.com", name: "O", role: "admin", owner: false });
  const user = as({ id: "u-2", email: "u@example.com", name: "U", role: "user", owner: false });

  it("lists the flows in order and never the pair token", async () => {
    const r = await admin("GET", "/api/setup-flows");
    expect(r.json.flows.map((f: { module: string }) => f.module)).toEqual(["phone", "plain", "vaultless", "secrets", "docs", "hub"]);
    expect(JSON.stringify(r.json)).not.toMatch(/pair-secret|phone_pair_token/);
  });

  it("a secret saves as the signed-in admin, and the kernel's refusal comes back inline", async () => {
    expect((await admin("POST", "/api/setup-flows/phone/secret", { secret: "other", value: "x" })).status).toBe(400);
    const bad = await admin("POST", "/api/setup-flows/phone/secret", { secret: "phone_bot_token", value: "bad" });
    expect(bad).toMatchObject({ status: 400, json: { error: "that doesn't look like a bot token" } });
    expect((await admin("POST", "/api/setup-flows/phone/secret", { secret: "phone_bot_token", value: "123:abc" })).json).toMatchObject({ ok: true });
    const save = kernel.calls.filter((c) => c.path === "/v1/accounts/save_secret").at(-1)!;
    expect(save.body).toMatchObject({ module: "phone", secret: "phone_bot_token", value: "123:abc", token: expect.stringMatching(/^ahqu_/) });
  });

  it("done needs the secrets, the sign-in and the pairing", async () => {
    const get = async () => Object.fromEntries((await admin("GET", "/api/setup-flows")).json.flows.map((f: { module: string; done: boolean }) => [f.module, f.done]));
    expect(await get()).toEqual({ phone: false, plain: false, vaultless: true, secrets: false, docs: false, hub: false }); // phone: secret saved but not paired; plain: no sign-in; vaultless: signed in with empty vault; secrets: secret missing
    paired = true;
    googleOk = true;
    expect(await get()).toEqual({ phone: true, plain: false, vaultless: true, secrets: false, docs: true, hub: false });
    expect((await admin("GET", "/api/setup-flows/phone/pair")).json).toEqual({ paired: true, paired_at: "2026-11-17T10:00:00.000Z" });
    paired = false;
    googleOk = false;
  });

  it("{board_url} is where the connect path sends the sign-in back, and a bare IP has no name", async () => {
    const r = (await admin("GET", "/api/setup-flows")).json;
    expect(r).toMatchObject({ board_url: "https://aiden.example.com", named: true });
    expect(r.flows.find((f: { module: string }) => f.module === "docs")).toMatchObject({ connect_url: "/google/connect", needs_name: "Needs a named address." });
    expect((await admin("GET", "/google/connect")).status).toBe(302);
    expect(googleStarts.at(-1)).toBe(`${r.board_url}/google/callback`);
    expect([namedHost("192.0.2.10:3121"), namedHost("[2001:db8::1]:3121"), namedHost("127.0.0.1:3121"), namedHost("aiden.example.com")]).toEqual([false, false, true, true]);
  });

  it("Connect opens the setup flow while its secrets are missing, then signs in", async () => {
    expect(await admin("GET", "/hub/connect")).toMatchObject({ status: 302, location: "/#/setup/hub" });
    expect(await admin("GET", "/plain/connect")).toMatchObject({ status: 302, location: "https://plain.example.com/authorize" }); // no secrets to ask for
    await admin("POST", "/api/setup-flows/hub/secret", { secret: "hub_client_id", value: "client-1" });
    expect(await admin("GET", "/hub/connect")).toMatchObject({ status: 302, location: "https://hub.example.com/authorize" });
    expect(await admin("GET", "/hub/callback?state=s&code=c")).toMatchObject({ status: 302, location: "/#/settings/connections?connected=hub" }); // the tab Connect opened
  });

  it("dismissing is remembered", async () => {
    await admin("POST", "/api/setup-flows/plain/dismiss");
    const f = (await admin("GET", "/api/setup-flows")).json.flows;
    expect(f.map((x: { dismissed: boolean }) => x.dismissed)).toEqual([false, true, false, false, false, false]);
  });

  it("pair mint is for the owner's authenticator session only, sent with the module's token", async () => {
    expect((await user("POST", "/api/setup-flows/phone/pair")).status).toBe(403);
    expect((await other("POST", "/api/setup-flows/phone/pair")).status).toBe(403);
    expect(pairCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    const r = await admin("POST", "/api/setup-flows/phone/pair");
    expect(r.json).toEqual({ code: "ABCD-1234", link: "https://t.me/bot?start=ABCD", minted_at: expect.any(Number) });
    expect(pairCalls.at(-1)).toEqual({ method: "POST", auth: "Bearer pair-secret" });
    expect((await admin("GET", "/api/setup-flows/phone/pair")).json).toEqual({ paired: false });
  });
});
