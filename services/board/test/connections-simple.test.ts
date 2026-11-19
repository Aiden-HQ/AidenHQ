// Simple connections through the board (docs/design/connections-simple.md): an organisation's public client values written
// from the compiled catalog only, a device sign-in bound to the admin session that started it, and a module's advanced flow.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createKernelAuth } from "../src/kernel-auth.js";
import { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";
import { BOARD_KEY, fakeKernel, type FakeAccount } from "./kernel.js";

const organisations = [{ id: "acme", name: "Acme", domains: ["acme.example.com"], clients: [{ module: "chat", secret: "chat_client_id", value: "1234.5678" }, { module: "docs", secret: "docs_client_id", value: "99-acme.apps.example.com" }] }];
const flows = [{ module: "chat", order: 10, title: "Chat", why: "Read your chats.", effort: "about a minute", steps: "Sign in.", signin: "chat", advanced: { title: "Chat bot", why: "A bot.", effort: "about 2 minutes", steps: "Make a bot.", capabilities: ["a bot people can DM"], secrets: ["chat_bot_token"], fields: [], pair_url: "http://chat:8090/pair" } }];
let device = { state: "pending" } as { state: string; detail?: string };
const deviceCalls: string[] = [];
const chat = {
  status: async () => ({ state: device.state === "ok" ? "ok" : "missing", configured: true }),
  scopes: async () => undefined,
  offers: async () => false,
  deviceStart: async () => (deviceCalls.push("start"), { user_code: "ABCD-1234", verification_uri: "https://vendor.example.com/device", expires_in: 900, interval: 5 }),
  deviceState: async () => device,
  deviceCancel: async () => void deviceCalls.push("cancel"),
};

describe("simple connections", () => {
  const store = new Store(":memory:");
  let app: ReturnType<typeof createApp>;
  let port = 0;
  let kernel: Awaited<ReturnType<typeof fakeKernel>>;
  beforeAll(async () => {
    kernel = await fakeKernel();
    const accounts = createKernelAuth({ kernel: { url: kernel.url, token: BOARD_KEY }, adminUrl: "http://localhost:3120" });
    const paperclip = new Paperclip("http://paperclip", "00000000-0000-4000-8000-000000000001", "k", (async () => new Response("[]")) as unknown as typeof fetch);
    const pair = (async () => Response.json({ paired: false })) as unknown as typeof fetch;
    app = createApp({ paperclip, store, records: fakeRecords(), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: ["localhost:3121", "lan.example.com:3121"], mode: "lan", lan: { url: "https://aiden.example.com", googleConnect: false },
      signIns: [
        { id: "chat", label: "Chat", connect: "/chat/connect", callback: "/chat/callback", mode: "device", missing: "m", stopped: "s", fields: [], auth: chat as never },
        { id: "team", label: "Team", connect: "/team/connect", callback: "/team/callback", httpsOnly: true, missing: "m", stopped: "s", fields: [], auth: { ...chat, status: async () => ({ state: "missing", configured: true }) } as never },
      ],
      setupFlows: { flows: flows.map((f) => ({ ...f, token: "pair-secret" })), fetchImpl: pair }, organisations });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.close();
    kernel.close();
  });

  function as(account: FakeAccount, host = "localhost:3121") {
    let cookie = "";
    return (method: string, path: string, body?: unknown) =>
      new Promise<{ status: number; json: any; location?: string }>((resolve, reject) => {
        cookie ||= `aidenhq-board=${kernel.session(account)}`;
        const headers: Record<string, string> = { host, cookie, ...(method !== "GET" ? { "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3121" } : {}) };
        const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined, location: res.headers.location }));
        });
        req.on("error", reject);
        req.end(body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body));
      });
  }
  const owner = as({ id: "u-1", email: "sam@acme.example.com", name: "Sam", role: "admin", owner: true });
  const second = as({ id: "u-3", email: "kim@example.com", name: "Kim", role: "admin", owner: false });
  const user = as({ id: "u-2", email: "u@acme.example.com", name: "U", role: "user", owner: false });

  it("lists organisations with the one the admin's email domain suggests, and applies only the catalog's values", async () => {
    expect((await owner("GET", "/api/organisations")).json).toEqual({ organisations: [{ id: "acme", name: "Acme", domains: ["acme.example.com"], connections: ["chat", "docs"] }], suggested: "acme", chosen: null });
    expect((await second("GET", "/api/organisations")).json.suggested).toBeNull();
    expect((await user("POST", "/api/organisations/acme/apply")).status).toBe(403);
    expect((await owner("POST", "/api/organisations/other/apply")).status).toBe(404);
    // A body is never read: only the compiled catalog's values reach the vault.
    expect((await owner("POST", "/api/organisations/acme/apply", { clients: { chat_bot_token: "xoxb-planted" } })).json).toMatchObject({ ok: true, results: [{ secret: "chat_client_id", ok: true }, { secret: "docs_client_id", ok: true }] });
    const saves = kernel.calls.filter((c) => c.path === "/v1/accounts/save_secret").map((c) => c.body);
    expect(saves.map((b) => [b.module, b.secret, b.value])).toEqual([["chat", "chat_client_id", "1234.5678"], ["docs", "docs_client_id", "99-acme.apps.example.com"]]);
    expect((await owner("GET", "/api/organisations")).json.chosen).toBe("acme");
  });

  it("a device sign-in's code is the starting session's: others can't read, follow, cancel or restart it", async () => {
    expect(await owner("GET", "/chat/connect")).toMatchObject({ status: 302, location: "/#/settings/connections?connect=chat" });
    expect((await user("POST", "/api/sign-ins/chat/device")).status).toBe(403);
    expect((await owner("POST", "/api/sign-ins/chat/device")).json).toEqual({ user_code: "ABCD-1234", verification_uri: "https://vendor.example.com/device", expires_in: 900, interval: 5 });
    expect((await second("GET", "/api/sign-ins/chat/device")).status).toBe(404);
    expect((await second("POST", "/api/sign-ins/chat/device/cancel")).status).toBe(404);
    expect((await second("POST", "/api/sign-ins/chat/device")).status).toBe(409);
    expect((await owner("GET", "/api/sign-ins/chat/device")).json).toEqual({ state: "pending" });
    expect((await owner("POST", "/api/sign-ins/chat/device/cancel")).json).toEqual({ ok: true });
    expect(deviceCalls).toEqual(["start", "cancel"]);
    expect((await owner("GET", "/api/sign-ins/chat/device")).status).toBe(404);
    await owner("POST", "/api/sign-ins/chat/device");
    device = { state: "ok" };
    expect((await owner("GET", "/api/sign-ins/chat/device")).json).toEqual({ state: "ok" });
    expect((await owner("GET", "/api/sign-ins/chat")).json).toMatchObject({ mode: "device", redirect: null });
  });

  it("basic is done once signed in; the advanced flow takes its own secrets and is done once they exist and it is paired", async () => {
    const view = async () => (await owner("GET", "/api/setup-flows")).json.flows[0];
    const f = await view();
    expect(f).toMatchObject({ done: true, advanced: { capabilities: ["a bot people can DM"], done: false } });
    expect(JSON.stringify(f)).not.toMatch(/pair-secret|pair_token/);
    expect((await owner("POST", "/api/setup-flows/chat/secret", { secret: "chat_bot_token", value: "123:abc" })).json).toMatchObject({ ok: true });
  });

  it("preflight says, before Connect, when the vendor can't send this address back", async () => {
    expect((await owner("GET", "/api/sign-ins/team")).json.preflight).toBeNull();
    const elsewhere = as({ id: "u-1", email: "sam@acme.example.com", name: "Sam", role: "admin", owner: true }, "lan.example.com:3121");
    expect((await elsewhere("GET", "/api/sign-ins/team")).json.preflight).toMatch(/only to https:\/\/aiden\.example\.com/);
  });
});
