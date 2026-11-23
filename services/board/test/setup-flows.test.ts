// Setup flows through the board: the kernel's save_secret and setup_status stood in for (kernel.ts), the module's pairing
// endpoint a fake fetch. Admins only; the pair token never reaches the browser.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { setupFlowRoutes } from "../src/setup-flows.js";
import type { GoogleAuth } from "../src/google.js";
import { createKernelAuth } from "../src/kernel-auth.js";
import { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";
import { BOARD_KEY, fakeKernel, type FakeAccount } from "./kernel.js";

const flows = [
  { module: "phone", order: 10, title: "Phone", why: "Aiden on your phone.", effort: "about 2 minutes", steps: "1. Paste the token.", secrets: ["phone_bot_token"], pair_url: "http://phone:8090/pair", pair_token: "phone_pair_token", token: "pair-secret" },
  { module: "plain", order: 20, title: "Plain", why: "Nothing to pair.", effort: "a minute", steps: "Nothing.", signin: "plain" },
  { module: "vaultless", order: 40, title: "Vaultless", why: "Works from old settings.", effort: "a minute", steps: "Nothing.", secrets: ["vaultless_url"], signin: "working" },
  { module: "secrets", order: 50, title: "Secrets", why: "Only secrets.", effort: "a minute", steps: "Nothing.", secrets: ["secrets_key"] },
  { module: "docs", order: 30, title: "Docs", why: "Your documents.", effort: "a minute", steps: "Add `{board_url}/google/callback`.", connect_url: "/google/connect" },
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
let pairRefusal: { status: number; error: string } | null = null;
let pairUnreachable: boolean | "timeout" = false;
// The pairing endpoint answers 200 but with no `paired` field: no answer at all, not an unpaired one.
let pairBodyEmpty = false;
// The module's headers arrive but its body is cut off (it restarted while answering): the read itself times out.
let pairBodyTimeout = false;
const pairCalls: { method: string; auth: string }[] = [];
const fakePair = (async (_url: string, init: RequestInit) => {
  pairCalls.push({ method: String(init.method), auth: String((init.headers as Record<string, string>).authorization) });
  if (pairUnreachable === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  if (pairUnreachable) throw new TypeError("fetch failed");
  if (pairBodyTimeout) {
    return {
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      },
    } as unknown as Response;
  }
  if (init.method === "POST" && pairRefusal) return new Response(JSON.stringify({ error: pairRefusal.error }), { status: pairRefusal.status });
  if (init.method === "GET" && pairBodyEmpty) return new Response(JSON.stringify({}), { status: 200 });
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
    app = createApp({ paperclip, store, records: fakeRecords(), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: ["localhost:3121"], mode: "lan", lan: { url: "https://192.0.2.10" }, google, signIns: [
        { id: "working", label: "Working", connect: "/working/connect", callback: "/working/callback", missing: "m", stopped: "s", fields: [], auth: { status: async () => ({ state: "ok" }), scopes: async () => undefined, offers: async () => false } as never },
        { id: "site", label: "Site", connect: "/site/connect", callback: "/site/callback", missing: "m", stopped: "s", fields: [{ secret: "site_url", label: "Site address", pattern: "^https://.+$" }], auth: { status: async () => ({ state: "missing", configured: false }), scopes: async () => undefined, offers: async () => false } as never },
        ...["plain", "hub"].map((id) => ({ id, label: id, connect: `/${id}/connect`, callback: `/${id}/callback`, missing: "m", stopped: "s", fields: [], auth: { status: async () => ({ state: "missing" }), scopes: async () => null, offers: async () => false, start: async () => ({ url: `https://${id}.example.com/authorize` }), finish: async () => {} } as never })),
      ], setupFlows: { flows, fetchImpl: fakePair } });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.close();
    kernel.close();
  });
  afterEach(() => {
    pairRefusal = null;
    pairUnreachable = false;
    pairBodyEmpty = false;
    paired = false;
    googleOk = false;
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

  it("a sign-in's own value saves through the kernel as a ready admin, and only a value it declares", async () => {
    expect((await admin("POST", "/api/sign-ins/site/secret", { secret: "site_url", value: "https://site.example.com" })).json).toMatchObject({ ok: true });
    expect(kernel.calls.filter((c) => c.path === "/v1/accounts/save_secret").at(-1)!.body).toMatchObject({ module: "site", secret: "site_url", value: "https://site.example.com" });
    expect((await admin("POST", "/api/sign-ins/site/secret", { secret: "phone_bot_token", value: "123:abc" })).status).toBe(400);
    expect((await user("POST", "/api/sign-ins/site/secret", { secret: "site_url", value: "https://site.example.com" })).status).toBe(403);
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

  it("{board_url} is the board's own address, and a bare-IP board still shows Google's steps and Connect", async () => {
    const r = (await admin("GET", "/api/setup-flows")).json;
    expect(r.board_url).toBe("https://192.0.2.10");
    expect(r.named).toBeUndefined();
    const docs = r.flows.find((f: { module: string }) => f.module === "docs");
    expect(docs).toMatchObject({ connect_url: "/google/connect", steps: expect.stringContaining("callback") });
    expect(docs.needs_name).toBeUndefined();
    expect((await admin("GET", "/google/connect")).status).toBe(302);
    expect(googleStarts.at(-1)).toBe("http://localhost:3121/google/callback"); // a Desktop client returns to loopback, never the board's address
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

  it("a pairing read that fails is not broadcast as a revocation", async () => {
    const emit = vi.spyOn(store.events, "emit");
    // Paired, seen by a read: the board learns it, once.
    paired = true;
    await admin("GET", "/api/setup-flows");
    expect(emit.mock.calls.filter((c) => c[0] === "setup")).toHaveLength(1);
    emit.mockClear();
    // The module stops answering: a failed read says nothing about pairing, so nothing is announced and the confirmed
    // pairing still stands rather than the flow flipping back to Needs setup.
    pairUnreachable = true;
    const down = (await admin("GET", "/api/setup-flows")).json.flows.find((f: { module: string }) => f.module === "phone");
    expect(down).toMatchObject({ paired: true, done: true });
    expect((await admin("GET", "/api/setup-flows/phone/pair")).status).toBe(503);
    expect(emit.mock.calls.filter((c) => c[0] === "setup")).toHaveLength(0);
    pairUnreachable = false;
    // It answers again, paired: still no change to announce.
    await admin("GET", "/api/setup-flows");
    expect(emit.mock.calls.filter((c) => c[0] === "setup")).toHaveLength(0);
    paired = false;
    emit.mockRestore();
  });

  it("a first read that agrees with the stored pairing announces nothing after a restart", async () => {
    const emit = vi.spyOn(store.events, "emit");
    store.setMeta("setup_paired:phone", "true");
    paired = true;
    try {
      // A fresh route set (a restart: its in-memory map is empty) reads the same state the store remembers: no change.
      const routes = setupFlowRoutes({
        flows: [flows[0]!], accounts: {} as never, store, signedIn: async () => true, scopeChoice: async () => false,
        connected: async () => undefined, boardUrl: () => "http://localhost:3121", redirectUrl: () => undefined,
        settings: () => undefined, file: async () => ({ identifier: "t-1" }), onSetupChange: () => store.events.emit("setup"), fetchImpl: fakePair,
      });
      expect(await routes.states()).toEqual([expect.objectContaining({ module: "phone", done: true })]);
      expect(emit.mock.calls.filter((c) => c[0] === "setup")).toHaveLength(0);
    } finally {
      store.delMeta("setup_paired:phone");
      emit.mockRestore();
    }
  });

  it("a pairing answer without a paired field says nothing and leaves the confirmed state", async () => {
    const emit = vi.spyOn(store.events, "emit");
    paired = true;
    const flow = async () => (await admin("GET", "/api/setup-flows")).json.flows.find((f: { module: string }) => f.module === "phone");
    expect(await flow()).toMatchObject({ paired: true, done: true }); // the confirmed state, stored
    emit.mockClear();
    // 200 with an empty body: not an answer, so it neither persists "unpaired" nor announces a revocation.
    pairBodyEmpty = true;
    expect(await flow()).toMatchObject({ paired: true, done: true });
    expect(await admin("GET", "/api/setup-flows/phone/pair")).toMatchObject({ status: 200, json: { paired: true } });
    expect(emit.mock.calls.filter((c) => c[0] === "setup")).toHaveLength(0);
    // Still unavailable after a restart: the stored pairing stands.
    const routes = setupFlowRoutes({
      flows: [flows[0]!], accounts: {} as never, store, signedIn: async () => true, scopeChoice: async () => false,
      connected: async () => undefined, boardUrl: () => "http://localhost:3121", redirectUrl: () => undefined,
      settings: () => undefined, file: async () => ({ identifier: "t-1" }), onSetupChange: () => store.events.emit("setup"), fetchImpl: fakePair,
    });
    expect(await routes.states()).toEqual([expect.objectContaining({ module: "phone", done: true })]);
    pairBodyEmpty = false;
    paired = false;
    emit.mockRestore();
  });

  it("pair mint is for the owner's authenticator session only, sent with the module's token", async () => {
    expect((await user("POST", "/api/setup-flows/phone/pair")).status).toBe(403);
    expect((await other("POST", "/api/setup-flows/phone/pair")).status).toBe(403);
    expect(pairCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    const r = await admin("POST", "/api/setup-flows/phone/pair");
    // The channel says how long its code lives; without that, the board's 15 minutes.
    expect(r.json).toEqual({ code: "ABCD-1234", link: "https://t.me/bot?start=ABCD", minted_at: expect.any(Number), expires_in: 900 });
    expect(pairCalls.at(-1)).toEqual({ method: "POST", auth: "Bearer pair-secret" });
    expect((await admin("GET", "/api/setup-flows/phone/pair")).json).toEqual({ paired: false });
  });

  it("a module still restarting answers 409, and any other refusal is a 502", async () => {
    pairRefusal = { status: 409, error: "Save the bot token first." };
    expect(await admin("POST", "/api/setup-flows/phone/pair")).toMatchObject({ status: 409, json: { error: "Save the bot token first." } });
    pairRefusal = { status: 500, error: "the bot is broken" };
    expect(await admin("POST", "/api/setup-flows/phone/pair")).toMatchObject({ status: 502, json: { error: "the bot is broken" } });
  });

  it("a module between containers is 503, not a 500 or a 502", async () => {
    pairUnreachable = true;
    expect(await admin("GET", "/api/setup-flows/phone/pair")).toMatchObject({ status: 503, json: { error: "phone isn't reachable yet" } });
    expect(await admin("POST", "/api/setup-flows/phone/pair")).toMatchObject({ status: 503, json: { error: "phone isn't reachable yet" } });
    pairUnreachable = false;
  });

  it("a module whose answer is cut off mid-body is a 504 too, not an empty 200", async () => {
    pairBodyTimeout = true;
    try {
      expect(await admin("POST", "/api/setup-flows/phone/pair")).toMatchObject({ status: 504, json: { error: "phone didn't answer in time" } });
    } finally {
      pairBodyTimeout = false;
    }
  });

  it("a module that doesn't answer in time is a 504, not a 503 the page could repeat as a second mint", async () => {
    pairUnreachable = "timeout";
    expect(await admin("POST", "/api/setup-flows/phone/pair")).toMatchObject({ status: 504, json: { error: "phone didn't answer in time" } });
    pairUnreachable = false;
  });

  it("a save that restarted the service marks the flow as restarting, also after a reload", async () => {
    store.delMeta("setup_restarting:phone");
    const flow = async () => (await admin("GET", "/api/setup-flows")).json.flows.find((f: { module: string }) => f.module === "phone");
    expect((await flow()).restarting).toBeUndefined();
    const saved = (await admin("POST", "/api/setup-flows/phone/secret", { secret: "phone_bot_token", value: "123:abc" })).json;
    // The answer says how long the wait has left, not when it ends: the page counts it down on its own clock.
    expect(saved).toMatchObject({ ok: true, restarted: ["phone"], restarting_for: expect.any(Number) });
    expect(saved.restarting_for).toBeGreaterThan(4 * 60_000);
    expect(saved.restarting_for).toBeLessThanOrEqual(5 * 60_000);
    expect(await flow()).toMatchObject({ restarting: true, present: { phone_bot_token: true } });
  });

  it("a save that restarted nothing does not clear another save's live restart marker", async () => {
    store.delMeta("setup_restarting:phone");
    // One field's paste restarts the service; another save for the same module (the kernel already started the recreate) reports none.
    const first = (await admin("POST", "/api/setup-flows/phone/secret", { secret: "phone_bot_token", value: "123:abc" })).json;
    expect(first.restarting_for).toEqual(expect.any(Number));
    kernel.restarted.services = [];
    try {
      // Still the first save's window: the second reports no restart and must not cut the wait short.
      expect((await admin("POST", "/api/setup-flows/phone/secret", { secret: "phone_bot_token", value: "123:abc" })).json.restarting_for).toBeGreaterThan(4 * 60_000);
      const flow = (await admin("GET", "/api/setup-flows")).json.flows.find((f: { module: string }) => f.module === "phone");
      expect(flow).toMatchObject({ restarting: true, restarting_for: expect.any(Number) });
    } finally {
      kernel.restarted.services = null;
    }
  });

  it("an expired restart marker goes on the next save, and a pairing clears it", async () => {
    store.setMeta("setup_restarting:phone", String(Date.now() - 1));
    kernel.restarted.services = [];
    try {
      expect((await admin("POST", "/api/setup-flows/phone/secret", { secret: "phone_bot_token", value: "123:abc" })).json.restarting_for).toBeUndefined();
      expect(store.meta("setup_restarting:phone")).toBeUndefined();
      // A pairing means the restart is over: a later 409 is a real conflict, not another five minutes of waiting.
      store.setMeta("setup_restarting:phone", String(Date.now() + 300_000));
      expect((await admin("POST", "/api/setup-flows/phone/pair")).json).toMatchObject({ code: "ABCD-1234" });
      expect(store.meta("setup_restarting:phone")).toBeUndefined();
    } finally {
      kernel.restarted.services = null;
      store.delMeta("setup_restarting:phone");
    }
  });

});

describe("setup flows, MCP status", () => {

  it("a read that starts while one is out waits for it, so an early read that saw the pairing is not lost", async () => {
    const store = new Store(":memory:");
    const emit = vi.spyOn(store.events, "emit");
    // Each GET is held until the test answers it, so two reads never overlap: the second starts only after the first lands.
    const held: { answer: (paired: boolean, paired_at?: string) => void }[] = [];
    const started: { siblings: number }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (init.method !== "GET") return new Response(JSON.stringify({ code: "ABCD-1234" }), { status: 200 });
      const here = { siblings: held.length };
      started.push(here);
      return new Promise<Response>((resolve) => held.push({ answer: (p, at) => resolve(new Response(JSON.stringify({ paired: p, ...(at ? { paired_at: at } : {}) }), { status: 200 })) }));
    }) as unknown as typeof fetch;
    const routes = setupFlowRoutes({
      flows: [flows[0]!], accounts: {} as never, store, signedIn: async () => true, scopeChoice: async () => false,
      connected: async () => undefined, boardUrl: () => "http://localhost:3121", redirectUrl: () => undefined,
      settings: () => undefined, file: async () => ({ identifier: "t-1" }), onSetupChange: () => store.events.emit("setup"), fetchImpl,
    });
    try {
      // The pairing is redeemed while the first read is out, so that read is the one that sees it.
      const first = routes.states();
      // A second read arrives while the first is out: it waits rather than racing it, so only one is in flight.
      const second = routes.states();
      expect(held).toHaveLength(1);
      expect(started).toHaveLength(1);
      held[0]!.answer(true, "2026-11-17T10:00:00.000Z");
      expect(await first).toEqual([expect.objectContaining({ module: "phone", done: true })]);

      // The read that waited starts now and sees the same state; it cannot discard the earlier read's confirmation.
      await new Promise((r) => setTimeout(r, 0));
      expect(held).toHaveLength(2);
      held[1]!.answer(true, "2026-11-17T10:00:00.000Z");
      expect(await second).toEqual([expect.objectContaining({ module: "phone", done: true })]);
      expect(store.meta("setup_paired:phone")).toBe("true");
      // The first-ever confirmation announced once; the read that repeated it announced nothing.
      expect(emit.mock.calls.filter((c) => c[0] === "setup")).toHaveLength(1);
    } finally {
      store.delMeta("setup_paired:phone");
      emit.mockRestore();
    }
  });

  it("a pairing read started while one is out shares the one waiting behind it, so a slow module is not piled on", async () => {
    const store = new Store(":memory:");
    const held: { answer: (paired: boolean) => void }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (init.method !== "GET") return new Response(JSON.stringify({ code: "ABCD-1234" }), { status: 200 });
      return new Promise<Response>((resolve) => held.push({ answer: (p) => resolve(new Response(JSON.stringify({ paired: p }), { status: 200 })) }));
    }) as unknown as typeof fetch;
    const routes = setupFlowRoutes({
      flows: [flows[0]!], accounts: {} as never, store, signedIn: async () => true, scopeChoice: async () => false,
      connected: async () => undefined, boardUrl: () => "http://localhost:3121", redirectUrl: () => undefined,
      settings: () => undefined, file: async () => ({ identifier: "t-1" }), fetchImpl,
    });
    try {
      // One read is out and one waits; two more polls arriving now join the waiting one instead of stacking up behind it.
      const reads = [routes.states(), routes.states(), routes.states(), routes.states()];
      expect(held).toHaveLength(1);
      held[0]!.answer(false);
      await new Promise((r) => setTimeout(r, 0));
      expect(held).toHaveLength(2);
      held[1]!.answer(true);
      const done = await Promise.all(reads);
      // The first caller had the read already out (unpaired); the one that waited and the two that joined it see the pairing.
      expect(done.map((r) => r[0]!.done)).toEqual([false, true, true, true]);
      // Four callers, two module reads: nothing stacked behind them.
      expect(held).toHaveLength(2);
    } finally {
      store.delMeta("setup_paired:phone");
    }
  });

  it("reports a pairing's own time next to its state, never a stale or missing one", async () => {
    // The pairing was accepted with a time; a later read that says nothing about pairing keeps it, and /pair answers with the
    // confirmed state and that answer's own time together. A fresh `true` with no time reads on the page as an expired code.
    const store = new Store(":memory:");
    let call = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (init.method !== "GET") return new Response(JSON.stringify({ code: "ABCD-1234" }), { status: 200 });
      call++;
      // The pairing, with its time; then a body that says nothing about pairing at all.
      return new Response(JSON.stringify(call === 1 ? { paired: true, paired_at: "2026-11-17T10:00:00.000Z" } : {}), { status: 200 });
    }) as unknown as typeof fetch;
    const routes = setupFlowRoutes({
      flows: [flows[0]!], accounts: {} as never, store, signedIn: async () => true, scopeChoice: async () => false,
      connected: async () => undefined, boardUrl: () => "http://localhost:3121", redirectUrl: () => undefined,
      settings: () => undefined, file: async () => ({ identifier: "t-1" }), fetchImpl,
    });
    const pair = () => routes.routes.find((r) => r.method === "GET" && r.path.test("/api/setup-flows/phone/pair"))!.handle(["/api/setup-flows/phone/pair", "phone"] as unknown as RegExpMatchArray, undefined, { ready: true, account: { role: "admin" } } as never, "localhost:3121");
    try {
      expect(await pair()).toEqual({ paired: true, paired_at: "2026-11-17T10:00:00.000Z" });
      // This read says nothing: the confirmed answer stands, and it still carries the time it was accepted with.
      expect(await pair()).toEqual({ paired: true, paired_at: "2026-11-17T10:00:00.000Z" });
    } finally {
      store.delMeta("setup_paired:phone");
    }
  });

  it("a pairing read that isn't an answer leaves the restart marker for the next one", async () => {
    // Only the answer that is recorded says the restart is over. A read that fails, or a 200 that says nothing about pairing,
    // must not cut short the wait a save set (the module may still be coming back).
    const store = new Store(":memory:");
    let mode: "empty" | "unpaired" | "unreachable" | "paired" = "empty";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (init.method !== "GET") return new Response(JSON.stringify({ code: "ABCD-1234" }), { status: 200 });
      if (mode === "unreachable") throw new TypeError("fetch failed");
      if (mode === "empty") return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify(mode === "unpaired" ? { paired: false } : { paired: true, paired_at: "2026-11-17T10:00:00.000Z" }), { status: 200 });
    }) as unknown as typeof fetch;
    const routes = setupFlowRoutes({
      flows: [flows[0]!], accounts: {} as never, store, signedIn: async () => true, scopeChoice: async () => false,
      connected: async () => undefined, boardUrl: () => "http://localhost:3121", redirectUrl: () => undefined,
      settings: () => undefined, file: async () => ({ identifier: "t-1" }), fetchImpl,
    });
    const pair = () => routes.routes.find((r) => r.method === "GET" && r.path.test("/api/setup-flows/phone/pair"))!.handle(["/api/setup-flows/phone/pair", "phone"] as unknown as RegExpMatchArray, undefined, { ready: true, account: { role: "admin" } } as never, "localhost:3121");
    try {
      store.setMeta("setup_restarting:phone", String(Date.now() + 300_000));
      expect(await pair()).toMatchObject({ paired: false });
      expect(store.meta("setup_restarting:phone")).toBeDefined();
      // An answer that says "not paired yet" does not end the wait either: the module may still be coming back.
      mode = "unpaired";
      expect(await pair()).toMatchObject({ paired: false });
      expect(store.meta("setup_restarting:phone")).toBeDefined();
      mode = "unreachable";
      await expect(pair()).rejects.toMatchObject({ status: 503 });
      expect(store.meta("setup_restarting:phone")).toBeDefined();
      // The answer that is one: the module is back, so the wait is over.
      mode = "paired";
      expect(await pair()).toMatchObject({ paired: true });
      expect(store.meta("setup_restarting:phone")).toBeUndefined();
    } finally {
      store.delMeta("setup_restarting:phone");
      store.delMeta("setup_paired:phone");
    }
  });

  it("a module's first confirmed pairing announces it once", async () => {
    const store = new Store(":memory:");
    const emit = vi.spyOn(store.events, "emit");
    paired = true;
    const routes = setupFlowRoutes({
      flows: [flows[0]!], accounts: {} as never, store, signedIn: async () => true, scopeChoice: async () => false,
      connected: async () => undefined, boardUrl: () => "http://localhost:3121", redirectUrl: () => undefined,
      settings: () => undefined, file: async () => ({ identifier: "t-1" }), onSetupChange: () => store.events.emit("setup"), fetchImpl: fakePair,
    });
    try {
      // Nothing known before (no map entry, no stored value): boards that did not make the request learn it happened.
      expect(await routes.states()).toEqual([expect.objectContaining({ module: "phone", done: true })]);
      expect(emit.mock.calls.filter((c) => c[0] === "setup")).toHaveLength(1);
      // Reading the same state again is not a change.
      await routes.states();
      expect(emit.mock.calls.filter((c) => c[0] === "setup")).toHaveLength(1);
    } finally {
      store.delMeta("setup_paired:phone");
      paired = false;
      emit.mockRestore();
    }
  });

  it("records a pairing status confirms, so a later failed read keeps it", async () => {
    const store = new Store(":memory:");
    const emit = vi.spyOn(store.events, "emit");
    const routes = setupFlowRoutes({
      flows: [flows[0]!],
      accounts: {} as never,
      store,
      signedIn: async () => true,
      scopeChoice: async () => false,
      connected: async () => undefined,
      boardUrl: () => "http://localhost:3121",
      redirectUrl: () => undefined,
      settings: () => undefined,
      file: async () => ({ identifier: "t-1" }),
      onSetupChange: () => store.events.emit("setup"),
      fetchImpl: fakePair,
    });
    // Status is the first to see the pairing: it is remembered, not just used for this one answer.
    paired = true;
    expect(await routes.states()).toEqual([expect.objectContaining({ module: "phone", done: true })]);
    emit.mockClear();
    // The module stops answering: status keeps the confirmed pairing rather than listing it as needing setup again.
    pairUnreachable = true;
    expect(await routes.states()).toEqual([expect.objectContaining({ module: "phone", done: true })]);
    expect(emit.mock.calls.filter((c) => c[0] === "setup")).toHaveLength(0);
    pairUnreachable = false;
    paired = false;
    emit.mockRestore();
  });
});
