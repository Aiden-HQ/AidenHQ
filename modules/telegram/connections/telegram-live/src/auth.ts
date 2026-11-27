// Sign-in: the board's QR device sign-in (services/board/src/device-signin.ts, mode qr) over TDLib's authorization states,
// plus session health. The 2FA password passes straight through to TDLib and is never stored or logged. A session Telegram
// revoked tells the owner once (a connection need plus one deduplicated notice) and restarts the service idle; our own
// close (SIGTERM) and Disconnect are never a revoke.
import { rmSync } from "node:fs";
import type { Logger } from "pino";
import type { Kernel } from "./kernel.js";
import type { Store } from "./store.js";
import { TdError, type Me, type TdClient, type TdUpdate } from "./td.js";
import type * as Td from "./tdlib-types.js";

/** A row the board shows on the sign-in's card (services/board/src/mcpauth.ts McpAuthStatus.lines). */
export type Line = { label: string; value: string; state: "ok" | "warn" | "error" };
/** The board's McpAuthStatus, as this service answers it. */
export type AuthStatus = { state: "missing" | "ok" | "expired"; configured: boolean; since: string; detail?: string; login?: string; lines?: Line[] };
export type DeviceView = {
  state: "idle" | "pending" | "secret" | "ok" | "expired" | "denied" | "cancelled" | "failed";
  detail?: string; qr?: string; secret?: { label: string; hint?: string };
};

/** A refusal the board shows as given (400): TDLib's words for a wrong password, or a step out of order. */
export class AuthInputError extends Error {
  status = 400;
}

export interface Auth {
  status(): AuthStatus;
  deviceStart(): Promise<{ qr: string; expires_in: number; interval: number }>;
  deviceState(): DeviceView;
  deviceSecret(value: string): Promise<void>;
  cancel(): void;
  /** logOut (revokes the session at Telegram), deletes TDLib's folder and the sync state, then exits for a fresh start. */
  disconnect(): Promise<void>;
  /** Our own close (SIGTERM): resolves on authorizationStateClosed. */
  close(): Promise<void>;
  /** Set while signed in. Every TdError it throws is checked for a revoked session. */
  td(): TdClient | undefined;
  me(): Me | undefined;
  /** Called synchronously on authorizationStateReady, before TDLib's next update is dispatched. */
  onReady(fn: (td: TdClient) => void): void;
  setProgress(fn: () => Line | undefined): void;
}

export const REVOKED = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/;
const ATTEMPT_MS = 300_000;
const NOTICE = "Telegram signed AidenHQ out (the session was ended in Telegram, or the account was deactivated). Reconnect it on the board: Connections, Telegram.";

export const toMe = (u: Td.user): Me => ({ user_id: u.id, usernames: u.usernames?.active_usernames ?? [], name: [u.first_name, u.last_name].filter(Boolean).join(" ") });

export function createAuth(o: {
  /** Whether api_id and api_hash are set (read on each call: the board writes them while the service runs). */
  configured: () => boolean;
  open: () => TdClient;
  store: Store;
  dataDir: string;
  kernel: Pick<Kernel, "notify" | "need">;
  log: Pick<Logger, "info" | "warn" | "error">;
  now?: () => number;
  exit?: (code: number) => void;
}): Auth {
  const { store, log, kernel } = o;
  const now = o.now ?? Date.now;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  let client: TdClient | undefined;
  let state: string | undefined;
  let since = new Date(now()).toISOString();
  let link: string | undefined;
  let hint: string | undefined;
  let attempt: { started: number; cancelled?: boolean; detail?: string } | undefined;
  let me: Me | undefined;
  let ours = false;
  let progress: () => Line | undefined = () => undefined;
  const readyFns: ((td: TdClient) => void)[] = [];
  const waiters = new Set<() => void>();

  const revokedReason = () => store.getKv("revoked") || undefined;
  // `revoked` (kv) is the status; `revoke_notified` is set only after both reports landed, so a crash before then retries them
  // at the next start. `reporting` is the reports in flight: a Closed that follows LoggingOut waits on the same ones.
  let reporting: Promise<unknown> | undefined;
  /** Tells the owner once per revoke; resolves once both reports are sent (or failed, to be retried). */
  function revoked(why: string): Promise<unknown> {
    if (ours) return Promise.resolve();
    if (!revokedReason()) {
      store.setKv("revoked", why);
      since = new Date(now()).toISOString();
      log.warn({ why }, "telegram session revoked");
    }
    if (store.getKv("revoke_notified")) return Promise.resolve();
    reporting ??= Promise.all([kernel.need("expired", "Telegram signed AidenHQ out: reconnect on the board"), kernel.notify(NOTICE, "telegram:session")])
      .then(() => store.setKv("revoke_notified", "1"))
      .catch((err) => {
        log.warn({ err: String(err).slice(0, 200) }, "revocation reports not delivered; retrying in a minute");
        // Until the owner has been told (or signed in again), a minute later, and at every start.
        setTimeout(() => void (revokedReason() && void revoked(revokedReason()!)), 60_000).unref?.();
      })
      .finally(() => void (reporting = undefined));
    return reporting;
  }

  const wrapped: TdClient = {
    async invoke(req) {
      try {
        return await client!.invoke(req);
      } catch (err) {
        if (err instanceof TdError && REVOKED.test(err.message)) void revoked(err.message);
        throw err;
      }
    },
    onUpdate: (fn) => client!.onUpdate(fn),
    close: () => client!.close(),
  };

  function onState(s: Td.AuthorizationState): void {
    state = s._;
    since = new Date(now()).toISOString();
    if (s._ === "authorizationStateWaitOtherDeviceConfirmation") link = s.link;
    if (s._ === "authorizationStateWaitPassword") hint = s.password_hint || undefined;
    if (s._ === "authorizationStateReady") {
      attempt = undefined;
      store.setKv("revoked", "");
      store.setKv("revoke_notified", "");
      for (const fn of readyFns) fn(wrapped);
      void wrapped.invoke<Td.user>({ _: "getMe" }).then((u) => void (me = toMe(u)), (err) => log.warn({ err: String(err).slice(0, 200) }, "getMe failed"));
    }
    if (s._ === "authorizationStateLoggingOut" && !ours) void revoked("logged out by Telegram");
    if (s._ === "authorizationStateClosed") {
      client = undefined;
      if (!ours) {
        // The owner hears of it before the restart (a fresh client waits for a new sign-in); at most a few seconds' wait.
        log.warn("TDLib closed; restarting idle for a fresh sign-in");
        void Promise.race([revoked("session closed by Telegram"), new Promise((r) => setTimeout(r, 5_000).unref?.())]).finally(() => exit(0));
      }
    }
    for (const w of waiters) w();
  }

  function onUpdate(u: TdUpdate): void {
    if (u._ === "updateAuthorizationState") onState((u as unknown as Td.updateAuthorizationState).authorization_state);
    else if (u._ === "error" && typeof u.message === "string" && REVOKED.test(u.message)) void revoked(u.message);
  }

  function ensureClient(): void {
    if (client || !o.configured()) return;
    client = o.open();
    client.onUpdate(onUpdate);
  }

  /** Resolves once the state is one of `states` (now, or within `ms`), else rejects. */
  function waitFor(states: string[], ms: number): Promise<void> {
    if (state && states.includes(state)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!state || !states.includes(state)) return;
        clearTimeout(t);
        waiters.delete(check);
        resolve();
      };
      const t = setTimeout(() => {
        waiters.delete(check);
        reject(new AuthInputError(`Telegram didn't answer in time (${state ?? "starting"}); try again`));
      }, ms);
      waiters.add(check);
    });
  }

  ensureClient(); // a session that exists already goes straight to Ready
  if (revokedReason()) void revoked(revokedReason()!); // a revoke whose reports didn't land before the last exit

  const READY = "authorizationStateReady";
  return {
    status() {
      if (!o.configured()) return { state: "missing", configured: false, since };
      const why = revokedReason();
      if (why) return { state: "expired", configured: true, since, detail: "Telegram signed AidenHQ out: reconnect it." };
      if (state === READY) {
        const line = progress();
        const login = me ? (me.usernames[0] ? `@${me.usernames[0]}` : me.name) : undefined;
        return { state: "ok", configured: true, since, ...(login ? { login } : {}), ...(line ? { lines: [line] } : {}) };
      }
      return { state: "missing", configured: true, since, detail: "Not signed in: Connect, then scan the QR code in Telegram." };
    },

    async deviceStart() {
      if (!o.configured()) throw new AuthInputError("Paste the api_id and api_hash from my.telegram.org first.");
      ensureClient();
      if (state === READY) throw new AuthInputError("Telegram is signed in already.");
      attempt = { started: now() };
      await waitFor(["authorizationStateWaitPhoneNumber", "authorizationStateWaitOtherDeviceConfirmation", "authorizationStateWaitPassword", READY], 20_000);
      if (state === "authorizationStateWaitPhoneNumber") {
        await wrapped.invoke({ _: "requestQrCodeAuthentication", other_user_ids: [] });
        await waitFor(["authorizationStateWaitOtherDeviceConfirmation", "authorizationStateWaitPassword", READY], 20_000);
      }
      return { qr: link ?? "", expires_in: ATTEMPT_MS / 1000, interval: 2 };
    },

    deviceState() {
      if (state === READY && !revokedReason()) return { state: "ok" };
      if (!attempt) return { state: "idle" };
      if (attempt.cancelled) return { state: "cancelled" };
      if (now() - attempt.started > ATTEMPT_MS) return { state: "expired", detail: "The sign-in took too long: press Connect again." };
      if (state === "authorizationStateWaitPassword")
        return { state: "secret", secret: { label: "Two-step verification password", ...(hint ? { hint } : {}) }, ...(attempt.detail ? { detail: attempt.detail } : {}) };
      if (state === "authorizationStateClosed" || state === "authorizationStateLoggingOut") return { state: "failed", detail: "Telegram closed the sign-in: press Connect again." };
      return { state: "pending", ...(link ? { qr: link } : {}) };
    },

    async deviceSecret(value) {
      if (state !== "authorizationStateWaitPassword") throw new AuthInputError("Telegram isn't asking for a password now.");
      try {
        await wrapped.invoke({ _: "checkAuthenticationPassword", password: value });
        if (attempt) delete attempt.detail;
      } catch (err) {
        // TDLib's words only (PASSWORD_HASH_INVALID): never the value.
        const words = err instanceof TdError ? err.message : "Telegram couldn't check the password; try again.";
        if (attempt) attempt.detail = words;
        throw new AuthInputError(words);
      }
    },

    cancel() {
      if (!attempt) return;
      attempt.cancelled = true;
      // A QR already shown stays scannable in TDLib (and a password step stays open): end the attempt by restarting idle, as Disconnect does.
      if (client && state !== READY) {
        ours = true;
        void client.close().finally(() => setTimeout(() => exit(0), 200).unref?.());
      }
    },

    async disconnect() {
      ours = true;
      if (client) {
        await client.invoke({ _: "logOut" });
        await waitFor(["authorizationStateClosed"], 30_000);
      }
      rmSync(`${o.dataDir}/tdlib`, { recursive: true, force: true });
      store.tx(() => {
        for (const t of ["checkpoint", "backfill", "ingested", "msg_root", "agent_pending"]) store.db.exec(`DELETE FROM ${t}`);
        store.db.prepare(`DELETE FROM kv WHERE k IN ('backfill_started', 'revoked', 'revoke_notified')`).run();
      });
      log.info("telegram disconnected; restarting idle");
      setTimeout(() => exit(0), 200).unref?.(); // after the board has its answer
    },

    async close() {
      ours = true;
      if (client) await client.close();
    },

    td: () => (state === READY && client ? wrapped : undefined),
    me: () => me,
    onReady(fn) {
      readyFns.push(fn);
      if (state === READY && client) fn(wrapped);
    },
    setProgress(fn) {
      progress = fn;
    },
  };
}
