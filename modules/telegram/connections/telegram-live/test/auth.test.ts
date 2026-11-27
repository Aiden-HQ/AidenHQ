import { describe, expect, it } from "bun:test";
import { createAuth } from "../src/auth.js";
import { TdError } from "../src/td.js";
import { FakeTd } from "./fake-td.js";
import { fakeKernel, openStore, tmpDb } from "./helpers.js";

const auth = (td: FakeTd) => {
  const lines: string[] = [];
  const rec = (...a: unknown[]) => void lines.push(JSON.stringify(a));
  const kernel = fakeKernel();
  const exits: number[] = [];
  const a = createAuth({ configured: () => true, open: () => td, store: openStore(tmpDb()), dataDir: "/nonexistent", kernel, log: { info: rec, warn: rec, error: rec }, exit: (c) => void exits.push(c) });
  return { a, kernel, lines, exits };
};
const state = (s: Record<string, unknown>) => ({ _: "updateAuthorizationState", authorization_state: s });
const user = { _: "user", id: 42, first_name: "Owner", last_name: "", usernames: { active_usernames: ["owner"] }, type: { _: "userTypeRegular" } };

describe("auth", () => {
  it("cancelling a QR attempt closes its client in process: the old code never signs in, and an immediate start gives a fresh code", async () => {
    const tds = [new FakeTd(), new FakeTd()];
    tds.forEach((td, i) => td.on("requestQrCodeAuthentication", () => (td.emit(state({ _: "authorizationStateWaitOtherDeviceConfirmation", link: `tg://login?token=L${i + 1}` })), { _: "ok" })));
    const exits: number[] = [];
    let opened = 0;
    const a = createAuth({ configured: () => true, open: () => { const t = tds[opened++]!; queueMicrotask(() => t.emit(state({ _: "authorizationStateWaitPhoneNumber" }))); return t; }, store: openStore(tmpDb()), dataDir: "/nonexistent", kernel: fakeKernel(), log: { info() {}, warn() {}, error() {} }, exit: (c) => void exits.push(c) });
    expect((await a.deviceStart()).qr).toBe("tg://login?token=L1");
    a.cancel();
    expect(a.deviceState()).toEqual({ state: "cancelled" });
    const next = await a.deviceStart(); // at once, with no wait after the cancel
    expect(next.qr).toBe("tg://login?token=L2");
    expect(tds[0]!.closed).toBe(true);
    tds[0]!.emit(state({ _: "authorizationStateReady" })); // the old attempt cannot complete
    expect(a.deviceState()).toMatchObject({ state: "pending", qr: "tg://login?token=L2" });
    expect(exits).toEqual([]);
  });

  it("disconnect clears every per-account table, the outbox included", async () => {
    const td = new FakeTd();
    td.on("logOut", () => (td.emit(state({ _: "authorizationStateClosed" })), { _: "ok" }));
    const store = openStore(tmpDb());
    const exits: number[] = [];
    const a = createAuth({ configured: () => true, open: () => td, store, dataDir: "/nonexistent", kernel: fakeKernel(), log: { info() {}, warn() {}, error() {} }, exit: (c) => void exits.push(c) });
    td.emit(state({ _: "authorizationStateReady" }));
    store.db.prepare(`INSERT INTO outbox (target, payload, created_at) VALUES ('kernel', '{}', 1), ('warehouse', '{}', 1)`).run();
    store.db.prepare(`INSERT INTO writes (id, state, at) VALUES ('w', 'done', 1)`).run();
    store.db.prepare(`INSERT INTO send_log (at, chat_id) VALUES (1, 2)`).run();
    store.db.prepare(`INSERT INTO agent_sent (chat_id, message_id) VALUES (1, 2)`).run();
    await a.disconnect();
    for (const t of ["outbox", "writes", "send_log", "agent_sent", "checkpoint", "ingested"])
      expect(store.db.prepare(`SELECT count(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 });
  });

  it("qr then password then ready", async () => {
    const td = new FakeTd();
    td.on("requestQrCodeAuthentication", () => (td.emit(state({ _: "authorizationStateWaitOtherDeviceConfirmation", link: "tg://login?token=L1" })), { _: "ok" }));
    td.on("checkAuthenticationPassword", (r: any) => {
      if (r.password !== "right horse") throw new TdError(400, "PASSWORD_HASH_INVALID");
      td.emit(state({ _: "authorizationStateReady" }));
      return { _: "ok" };
    });
    td.on("getMe", user);
    const { a, lines } = auth(td);
    const ready: unknown[] = [];
    a.onReady((t) => ready.push(t));
    expect(a.status()).toMatchObject({ state: "missing", configured: true });
    td.emit(state({ _: "authorizationStateWaitPhoneNumber" }));

    expect(await a.deviceStart()).toEqual({ qr: "tg://login?token=L1", expires_in: 300, interval: 2 });
    expect(td.calls.map((c) => c._)).toContain("requestQrCodeAuthentication");
    td.emit(state({ _: "authorizationStateWaitOtherDeviceConfirmation", link: "tg://login?token=L2" })); // TDLib refreshes the link
    expect(a.deviceState()).toEqual({ state: "pending", qr: "tg://login?token=L2" });

    td.emit(state({ _: "authorizationStateWaitPassword", password_hint: "pet" }));
    expect(a.deviceState()).toEqual({ state: "secret", secret: { label: "Two-step verification password", hint: "pet" } });
    await expect(a.deviceSecret("wrong guess")).rejects.toMatchObject({ status: 400, message: "PASSWORD_HASH_INVALID" });
    expect(a.deviceState()).toMatchObject({ state: "secret", detail: "PASSWORD_HASH_INVALID" });

    await a.deviceSecret("right horse");
    await new Promise((r) => setImmediate(r));
    expect(a.deviceState()).toEqual({ state: "ok" });
    expect(a.status()).toMatchObject({ state: "ok", login: "@owner" });
    expect(a.me()).toEqual({ user_id: 42, usernames: ["owner"], name: "Owner" });
    expect(a.td()).toBeDefined();
    expect(ready).toHaveLength(1);
    // The password reached TDLib and nothing else: not a log line.
    expect(lines.join("\n")).not.toMatch(/wrong guess|right horse/);
  });

  it("revoked session notifies once; our own close is no revoke", async () => {
    const td = new FakeTd();
    td.on("getMe", user);
    td.on("getChats", () => {
      throw new TdError(401, "SESSION_REVOKED");
    });
    const { a, kernel } = auth(td);
    td.emit(state({ _: "authorizationStateReady" }));
    td.emit({ _: "error", code: 401, message: "AUTH_KEY_UNREGISTERED" });
    td.emit({ _: "error", code: 401, message: "AUTH_KEY_UNREGISTERED" });
    await expect(a.td()!.invoke({ _: "getChats" })).rejects.toThrow("SESSION_REVOKED");
    expect(kernel.notices).toEqual([{ text: expect.stringContaining("Telegram signed AidenHQ out"), key: "telegram:session" }]);
    expect(kernel.needs).toEqual([{ cause: "expired", detail: expect.any(String) }]);
    expect(a.status().state).toBe("expired");

    // Telegram ends the session (Closed, not ours): the owner hears of it, then the service restarts idle.
    const td3 = new FakeTd();
    td3.on("getMe", user);
    const c = auth(td3);
    td3.emit(state({ _: "authorizationStateReady" }));
    td3.emit(state({ _: "authorizationStateClosed" }));
    await new Promise((r) => setImmediate(r));
    expect(c.kernel.notices.map((n) => n.key)).toEqual(["telegram:session"]);
    expect(c.exits).toEqual([0]);

    // A deploy's SIGTERM closes TDLib too: never a notice, never a restart.
    const td2 = new FakeTd();
    td2.on("getMe", user);
    const b = auth(td2);
    td2.emit(state({ _: "authorizationStateReady" }));
    await b.a.close();
    td2.emit(state({ _: "authorizationStateClosed" }));
    expect(b.kernel.notices).toEqual([]);
    expect(b.exits).toEqual([]);
  });

  it("LoggingOut then Closed waits for the in-flight reports; the notified marker is set only after they land", async () => {
    const td = new FakeTd();
    td.on("getMe", user);
    const kernel = fakeKernel();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = kernel.notify;
    kernel.notify = async (t: string, k: string) => {
      await gate;
      await send(t, k);
    };
    const store = openStore(tmpDb());
    const exits: number[] = [];
    const mk = (k: typeof kernel, t: FakeTd) => createAuth({ configured: () => true, open: () => t, store, dataDir: "/nonexistent", kernel: k, log: { info: () => {}, warn: () => {}, error: () => {} }, exit: (c) => void exits.push(c) });
    mk(kernel, td);
    td.emit(state({ _: "authorizationStateReady" }));
    td.emit(state({ _: "authorizationStateLoggingOut" }));
    td.emit(state({ _: "authorizationStateClosed" }));
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([]);
    expect(store.getKv("revoke_notified")).toBeFalsy();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual([0]);
    expect(kernel.notices).toHaveLength(1);
    expect(store.getKv("revoke_notified")).toBeTruthy();

    // reports that fail leave the marker unset, and the next start sends them again
    store.setKv("revoke_notified", "");
    const bad = fakeKernel();
    bad.notify = async () => {
      throw new Error("down");
    };
    mk(bad, new FakeTd());
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getKv("revoke_notified")).toBeFalsy();
    const good = fakeKernel();
    mk(good, new FakeTd());
    await new Promise((r) => setTimeout(r, 10));
    expect(good.notices).toHaveLength(1);
    expect(store.getKv("revoke_notified")).toBeTruthy();
  });
});
