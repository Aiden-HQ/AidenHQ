import { describe, expect, it } from "vitest";
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
  it("cancelling a QR attempt ends it in TDLib: the shown code never signs in, and the service restarts idle", async () => {
    const td = new FakeTd();
    td.on("requestQrCodeAuthentication", () => (td.emit(state({ _: "authorizationStateWaitOtherDeviceConfirmation", link: "tg://login?token=L1" })), { _: "ok" }));
    const { a, exits } = auth(td);
    td.emit(state({ _: "authorizationStateWaitPhoneNumber" }));
    await a.deviceStart();
    a.cancel();
    expect(a.deviceState()).toEqual({ state: "cancelled" });
    await new Promise((r) => setTimeout(r, 300));
    expect(td.closed).toBe(true);
    expect(exits).toEqual([0]);
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
});
