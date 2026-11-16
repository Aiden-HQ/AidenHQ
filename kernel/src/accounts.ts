// K3 accounts (spec §2.1, §2.6; lean 3a): Better Auth on data/kernel/auth/auth.db, for the admin listener. Admins sign
// in here with email, password and TOTP; a session counts only when it is a ready admin's (TOTP enrolled, not disabled).
// Until 3g the board's gate-facing sign-in listener opens the same file with the same options (auth-rules.ts), so accounts
// are created, invited and reset there and sign in here.
import type { IncomingMessage } from "node:http";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { authCore, authSecret, forwardedProto, inboundCookies, openAuthDb, outboundCookie, secretIs, EDGE_HEADER, type Log } from "./auth-rules.ts";
import { accountsFile } from "./auth-move.ts";

export type Step = { ok: boolean; status: number; retryAfter?: string; json: Record<string, any>; cookies: string[]; error: string };
export type AdminSession = { account: { id: string; email: string; name: string; role: string; owner: boolean; twoFactorEnabled: boolean }; session: { id: string }; ready: boolean };

/** `origins`: the front door's origin, which a proxy may not pass on as the Host (Better Auth checks each POST's Origin). */
export async function openAccounts(o: { dataDir: string; hosts: string[]; origins?: string[]; edgeSecret: () => string; notify: (line: string) => void; log: Log; now?: () => number }) {
  const dbPath = o.dataDir === ":memory:" ? ":memory:" : accountsFile(o.dataDir);
  const secret = authSecret(dbPath); // before the file exists: a fresh install makes both, an old file without its secret refuses
  const db = openAuthDb(dbPath);
  const rules = authCore({ db, secret, hosts: o.hosts, trustedOrigins: () => o.origins ?? [], linkTtlMs: 72 * 3_600_000, notify: o.notify, log: o.log, ...(o.now ? { now: o.now } : {}) });
  await (await getMigrations(rules.options)).runMigrations();
  const auth = betterAuth(rules.options);
  const https = (req: Pick<IncomingMessage, "headers">) => forwardedProto(req) === "https";
  /** The session cookie's token, so an app host's handed-off session (the gate's) never counts here. */
  const cookieOf = (req: Pick<IncomingMessage, "headers">) => {
    const cookie = inboundCookies(req.headers.cookie, https(req));
    const token = decodeURIComponent(cookie.split("; ").find((c) => c.startsWith("better-auth.session_token="))?.slice("better-auth.session_token=".length) ?? "").split(".")[0];
    return token && db.prepare("SELECT 1 FROM handoff_session WHERE token = ?").get(token) ? "" : cookie;
  };

  return {
    db,
    secret,
    /** The admin behind a request's cookie, or null (no, expired or revoked session; a user; a disabled account). */
    async sessionOf(req: Pick<IncomingMessage, "headers">): Promise<AdminSession | null> {
      const cookie = cookieOf(req);
      if (!cookie) return null;
      const s = await auth.api.getSession({ headers: new Headers({ cookie, host: String(req.headers.host ?? "") }) }).catch(() => null);
      if (!s) return null;
      const u = s.user as Record<string, unknown>;
      const banExpires = u.banExpires ? new Date(u.banExpires as string).getTime() : 0;
      if (u.banned && (!banExpires || banExpires > Date.now())) return null;
      const account = { id: String(u.id), email: String(u.email), name: String(u.name ?? ""), role: String(u.role), owner: Boolean(u.owner), twoFactorEnabled: Boolean(u.twoFactorEnabled) };
      return { account, session: { id: s.session.id }, ready: account.role === "admin" && account.twoFactorEnabled };
    },
    /**
     * One Better Auth step for a kernel page: the form's fields as JSON, with the browser's own headers and cookies. Its
     * cookies come back host-only for this listener, its refusal as text.
     */
    async step(req: IncomingMessage, sub: string, body: Record<string, unknown>): Promise<Step> {
      const r = await rules.call(auth, req, sub, "admin", { body: Buffer.from(JSON.stringify(body)), host: String(req.headers.host ?? ""), trusted: secretIs(req.headers[EDGE_HEADER], o.edgeSecret()), cookie: cookieOf(req) });
      const json = (await r.json().catch(() => ({}))) as Record<string, any>;
      const cookies = r.headers.getSetCookie().map((c) => outboundCookie(c, https(req), "admin"));
      return { ok: r.ok, status: r.status, ...(r.headers.get("retry-after") ? { retryAfter: r.headers.get("retry-after")! } : {}), json, cookies, error: r.ok ? "" : String(json.message ?? json.error ?? json.code ?? `refused (${r.status})`) };
    },
    close: () => db.close(),
  };
}
export type Accounts = Awaited<ReturnType<typeof openAccounts>>;
