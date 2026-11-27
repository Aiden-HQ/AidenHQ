// The board on its own origin (lean 3g): it opens no accounts file; the kernel hands it a session through a one-time code,
// bound to the browser that started it, and every request is checked with the kernel, so a sign-out or disable there ends
// it here. The kernel's own session cookie, which reaches this origin too, is never a board session.
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createApp } from "../src/app.js";
import { createKernelAuth } from "../src/kernel-auth.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { BOARD_KEY, fakeKernel } from "./kernel.js";

const HOST = "board.example:3121";
const ORIGIN = `http://${HOST}`;
const ANN = { id: "u-ann", email: "ann@example.com", name: "Ann", role: "admin" as const, owner: false };

describe("the board's sign-in through the kernel's handoff", () => {
  let kernel: Awaited<ReturnType<typeof fakeKernel>>;
  let app: Server;
  let port = 0;
  let clock = 1_000_000;
  /** What the board logged at error level (the handoff's own failures). */
  const errors: Record<string, unknown>[] = [];
  beforeAll(async () => {
    kernel = await fakeKernel();
    const accounts = createKernelAuth({ kernel: { url: kernel.url, token: BOARD_KEY }, adminUrl: "https://admin.example:8444", now: () => clock, log: { error: (...args: unknown[]) => void errors.push({ ...(args[0] as Record<string, unknown>), msg: args[1] }) } });
    app = createApp({ paperclip: {} as Paperclip, store: new Store(":memory:"), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: [HOST], mode: "lan" });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.close();
    kernel.close();
  });

  const get = (path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown) =>
    new Promise<{ status: number; location: string; cookies: string[]; text: string; json: any }>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, method, path, headers: { host: HOST, ...headers } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode!, location: String(res.headers.location ?? ""), cookies: res.headers["set-cookie"] ?? [], text: t, json: t && /json/.test(String(res.headers["content-type"])) ? JSON.parse(t) : undefined }));
      });
      r.on("error", reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const cookie = (set: string[], name: string) => set.map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${name}=`)) ?? "";

  it("hands off once, only in the browser that started it, and checks every request with the kernel", async () => {
    // Start: a state nonce in this origin's cookie, then the kernel's handoff for exactly this origin.
    const start = await get("/auth/start");
    expect(start.status).toBe(303);
    const to = new URL(start.location);
    expect(`${to.origin}${to.pathname}`).toBe("https://admin.example:8444/auth/handoff");
    expect(to.searchParams.get("to")).toBe(ORIGIN);
    const state = to.searchParams.get("state")!;
    const stateCookie = cookie(start.cookies, "aidenhq-board-state");
    expect(stateCookie).toBe(`aidenhq-board-state=${state}`);
    expect(start.cookies[0]).toMatch(/HttpOnly/);

    // Another browser (no state cookie, or another's) gets nothing for a code it carries: login CSRF.
    const stolen = kernel.code(ANN, ORIGIN, state);
    const noCookie = await get(`/auth/handoff?code=${stolen}&state=${state}`);
    expect(cookie(noCookie.cookies, "aidenhq-board")).toBe("");
    const other = await get(`/auth/handoff?code=${kernel.code(ANN, ORIGIN, state)}&state=${state}`, { cookie: "aidenhq-board-state=someone-elses-nonce-000" });
    expect(cookie(other.cookies, "aidenhq-board")).toBe("");

    // The browser that started it: the code becomes this origin's own session cookie; the state cookie is cleared.
    const code = kernel.code(ANN, ORIGIN, state);
    const done = await get(`/auth/handoff?code=${code}&state=${state}`, { cookie: stateCookie });
    expect([done.status, done.location]).toEqual([303, "/"]);
    const session = cookie(done.cookies, "aidenhq-board");
    expect(session).toMatch(/^aidenhq-board=ahqu_/);
    expect(done.cookies.find((c) => c.startsWith("aidenhq-board-state="))).toMatch(/Max-Age=0/);
    // A code spends once.
    const again = await get(`/auth/handoff?code=${code}&state=${state}`, { cookie: stateCookie });
    expect(cookie(again.cookies, "aidenhq-board")).toBe("");

    const me = await get("/api/session", { cookie: session });
    expect(me.json.account).toMatchObject({ id: "u-ann", email: "ann@example.com" });

    // The kernel's own session cookie (cookies ignore ports) is never a board session.
    expect((await get("/api/session", { cookie: "better-auth.session_token=abc.def" })).json.account).toBeNull();
    expect((await get("/api/accounts", { cookie: "better-auth.session_token=abc.def" })).status).toBe(401);
    // Two board cookies (one planted beside the real one): neither counts.
    expect((await get("/api/session", { cookie: `${session}; aidenhq-board=ahqu_planted` })).json.account).toBeNull();

    // Ended on the kernel (sign-out, disable, reset): refused here once the few-second check runs out.
    kernel.end(session.split("=")[1]!);
    expect((await get("/api/session", { cookie: session })).json.account).not.toBeNull(); // still within the check window
    clock += 6_000;
    expect((await get("/api/session", { cookie: session })).json.account).toBeNull();
    expect((await get("/api/accounts", { cookie: session })).status).toBe(401);
  });

  it("uses __Host- cookies on https", async () => {
    const start = await get("/auth/start", { "x-forwarded-proto": "https" });
    expect(start.cookies[0]).toMatch(/^__Host-aidenhq-board-state=.*; Path=\/; HttpOnly; SameSite=Lax; Secure/);
    expect(new URL(start.location).searchParams.get("to")).toBe(`https://${HOST}`);
  });

  it("a kernel it can't reach is logged and shown to the user, not a silent loop", async () => {
    const start = await get("/auth/start");
    const state = new URL(start.location).searchParams.get("state")!;
    const stateCookie = cookie(start.cookies, "aidenhq-board-state");
    const code = kernel.code(ANN, ORIGIN, state);
    // A host firewall dropping the board's traffic to the kernel: the connection dies mid-exchange (a fetch rejection, no HTTP).
    kernel.refuseExchange(true);
    try {
      const r = await get(`/auth/handoff?code=${code}&state=${state}`, { cookie: stateCookie });
      expect(r.status).toBe(502);
      expect(r.location).toBe("");
      expect(r.text).toMatch(/can't reach the AidenHQ kernel/);
      expect(r.text).toMatch(/firewall/);
      expect(cookie(r.cookies, "aidenhq-board")).toBe("");
      expect(r.cookies.find((c) => c.startsWith("aidenhq-board-state="))).toMatch(/Max-Age=0/);
      expect(errors.at(-1)).toMatchObject({ kernel: kernel.url, msg: "sign-in: the board can't reach the kernel" });
    } finally {
      kernel.refuseExchange(false);
    }
  });

  it("a code the kernel rejects still goes quietly back to the sign-in screen", async () => {
    const start = await get("/auth/start");
    const state = new URL(start.location).searchParams.get("state")!;
    const stateCookie = cookie(start.cookies, "aidenhq-board-state");
    const before = errors.length;
    const r = await get(`/auth/handoff?code=not-a-real-code&state=${state}`, { cookie: stateCookie });
    expect([r.status, r.location]).toEqual([303, "/"]);
    expect(cookie(r.cookies, "aidenhq-board")).toBe("");
    expect(errors.length).toBe(before);
  });

  it("a kernel that answers with an error, not a stale code, is shown too", async () => {
    const start = await get("/auth/start");
    const state = new URL(start.location).searchParams.get("state")!;
    const stateCookie = cookie(start.cookies, "aidenhq-board-state");
    const code = kernel.code(ANN, ORIGIN, state);
    // The kernel is reachable but refuses the board's key: signing in again won't fix that, so don't loop on it.
    kernel.refuseExchange(401);
    try {
      const r = await get(`/auth/handoff?code=${code}&state=${state}`, { cookie: stateCookie });
      expect(r.status).toBe(502);
      expect(r.location).toBe("");
      expect(r.text).toMatch(/refused the board's key/);
      expect(errors.at(-1)).toMatchObject({ status: 401, msg: "sign-in: the kernel refused the exchange" });
    } finally {
      kernel.refuseExchange(false);
    }
  });
});
