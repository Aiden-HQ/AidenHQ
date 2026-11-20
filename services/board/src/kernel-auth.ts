// The board's sign-in (lean 3g; docs/design/access.md): the board opens no accounts file. Admins sign in on the kernel's admin
// listener; the board, on its own origin, gets its own session through a one-time handoff:
//   GET /auth/start      sets a state nonce in this origin's cookie and sends the browser to the kernel's
//                        /auth/handoff?to=<this origin>&state=<nonce> (a ready admin there, an allowed module origin);
//   GET /auth/handoff    ?code&state from the kernel: only in the browser that started it (its state cookie), the code is
//                        exchanged on the backplane (POST /v1/auth/exchange, the board's key) for the board's session token,
//                        kept in this origin's own host-only cookie;
//   every API request    the token is checked with the kernel (POST /v1/auth/session; cached a few seconds), so a sign-out,
//                        a disable, a role change or a reset there ends it here too.
// The kernel's own session cookie reaches this origin too (cookies ignore ports) and is never read here.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Role = "admin" | "user";
/** The signed-in admin behind a board request, and the board session token it presents. */
export interface AccountSession {
  account: { id: string; email: string; name: string; role: Role; owner: boolean };
  session: { id: string; expiresAt: string };
  ready: boolean;
  token: string;
}
/** The kernel's refusal of an account call, with its status. */
export class AccountError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const COOKIE = "aidenhq-board";
const STATE = "aidenhq-board-state";
/** How long a checked session is believed without asking the kernel again. */
const CHECK_MS = 5_000;

/** The scheme the browser used: the front door says so in X-Forwarded-Proto; direct requests are plain http. */
export function forwardedProto(req: Pick<IncomingMessage, "headers">): "https" | "http" {
  return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim().toLowerCase() === "https" ? "https" : "http";
}
const https = (req: Pick<IncomingMessage, "headers">) => forwardedProto(req) === "https";
/** The cookie's name on this request's scheme: `__Host-` (host-only, Secure, Path=/) on https. */
const named = (req: Pick<IncomingMessage, "headers">, n: string) => (https(req) ? `__Host-${n}` : n);
function cookie(req: Pick<IncomingMessage, "headers">, n: string): string | undefined {
  const want = named(req, n);
  const hits = String(req.headers.cookie ?? "").split(";").map((c) => c.trim()).filter((c) => c.startsWith(`${want}=`));
  // Two of one name (one planted beside the real one): neither counts.
  return hits.length === 1 ? decodeURIComponent(hits[0]!.slice(want.length + 1)) : undefined;
}
const setCookie = (req: Pick<IncomingMessage, "headers">, n: string, v: string, maxAge?: number) =>
  `${named(req, n)}=${encodeURIComponent(v)}; Path=/; HttpOnly; SameSite=Lax${https(req) ? "; Secure" : ""}${maxAge !== undefined ? `; Max-Age=${maxAge}` : ""}`;
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface KernelAuthOptions {
  /** The kernel's backplane (AIDENHQ_KERNEL_URL) and the board's key there (gateway_board_key). */
  kernel: { url: string; token: string };
  /** The kernel's admin listener at its front door (AIDENHQ_ADMIN_URL). */
  adminUrl: string;
  now?: () => number;
}

export type KernelAuth = ReturnType<typeof createKernelAuth>;

export function createKernelAuth(o: KernelAuthOptions) {
  const now = o.now ?? Date.now;
  const checked = new Map<string, { at: number; who: AccountSession | null }>();

  async function post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`${o.kernel.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${o.kernel.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } } & T;
    if (!r.ok) throw new AccountError(r.status, j.error?.message ?? `the kernel answered ${r.status}`);
    return j;
  }
  const origin = (req: Pick<IncomingMessage, "headers">) => `${forwardedProto(req)}://${String(req.headers.host ?? "").toLowerCase()}`;
  const redirect = (res: ServerResponse, to: string, cookies: string[] = []) => void res.writeHead(303, { location: to, "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) }).end();

  const auth = {
    /** The signed-in admin behind the request's board cookie, or null (none, ended, or not a ready admin any more). */
    async sessionOf(req: Pick<IncomingMessage, "headers">): Promise<AccountSession | null> {
      const token = cookie(req, COOKIE);
      if (!token || !token.startsWith("ahqu_") || token.length > 200) return null;
      const hit = checked.get(token);
      if (hit && now() - hit.at < CHECK_MS) return hit.who;
      const who = await post<{ account: AccountSession["account"]; session: AccountSession["session"] }>("/v1/auth/session", { token }).then(
        (j) => ({ account: j.account, session: j.session, ready: true, token }),
        (e: AccountError) => { if (e.status === 401) return null; throw e; },
      );
      if (checked.size > 1000) for (const [k, v] of checked) if (now() - v.at >= CHECK_MS) checked.delete(k);
      checked.set(token, { at: now(), who });
      return who;
    },

    /** GET /auth/start: a fresh state nonce in this origin's cookie, then the kernel's handoff for this origin. */
    start(req: IncomingMessage, res: ServerResponse): void {
      const state = randomBytes(24).toString("base64url");
      redirect(res, `${o.adminUrl}/auth/handoff?${new URLSearchParams({ to: origin(req), state })}`, [setCookie(req, STATE, state, 300)]);
    },

    /** GET /auth/handoff?code&state: in the browser that started it, the code → the board's session cookie; then the board. */
    async finish(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
      const mine = cookie(req, STATE);
      const clear = setCookie(req, STATE, "", 0);
      if (!mine || !state || !same(mine, state) || !code) return redirect(res, "/", [clear]);
      const r = await post<{ token: string; expires: string }>("/v1/auth/exchange", { code, origin: origin(req), state }).catch(() => undefined);
      if (!r) return redirect(res, "/", [clear]);
      const maxAge = Math.max(0, Math.floor((new Date(r.expires).getTime() - now()) / 1000));
      redirect(res, "/", [clear, setCookie(req, COOKIE, r.token, maxAge)]);
    },

    /** POST /api/sign-out: the board's session ends (the kernel's own stays: sign out there for that). */
    async signOut(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): Promise<void> {
      const token = cookie(req, COOKIE);
      if (token) {
        checked.delete(token);
        await post("/v1/auth/sign_out", { token }).catch(() => {});
      }
      res.writeHead(200, { ...headers, "content-type": "application/json", "set-cookie": setCookie(req, COOKIE, "", 0) }).end('{"ok":true}');
    },

    /** An account admin call as the signed-in admin (the kernel checks the session again and acts as that admin). */
    call: <T = unknown>(op: string, who: AccountSession, body: Record<string, unknown> = {}) => post<T>(`/v1/accounts/${op}`, { ...body, token: who.token }),
    /** Every account's id, name, email and whether it is the owner's (labels; no session needed). */
    names: () => post<{ accounts: { id: string; name: string; email: string; owner: boolean }[] }>("/v1/accounts/names", {}).then((j) => j.accounts),
    /** An MCP client's bearer, checked by the kernel for this resource: the account behind it, or null (expired, revoked, another audience, no longer a ready admin). */
    mcpGrant: (token: string, resource: string, refused?: (why: string) => void) =>
      post<{ account: AccountSession["account"]; client: string; expires: string }>("/v1/auth/mcp", { token, resource }).catch((e: AccountError) => (e.status === 401 ? (refused?.(String(e.message).slice(0, 100)), null) : Promise.reject(e))),
    /** Cards decided as the bearer's account (the kernel derives who from the grant; each card stands alone). */
    mcpDecide: (token: string, resource: string, cards: { id: string; digest: string; decision: "approve" | "reject"; reason?: string; stale?: boolean }[]) =>
      post<{ outcomes: { id: string; ok: boolean; state?: string; identifier?: string; error?: string }[] }>("/v1/owner/decide", { token, resource, cards }),
    /** The MCP clients an admin has signed in, and ending one. */
    mcpGrants: (who: AccountSession) => post<{ grants: { id: string; client: string; lastUsed: string | null }[] }>("/v1/auth/mcp/grants", { token: who.token }),
    mcpRevoke: (who: AccountSession, grant: string) => post<{ ok: true }>("/v1/auth/mcp/revoke", { token: who.token, grant }),
    /** The owner's own chat words, filed as his in-app request on an app (the kernel checks they name it). */
    ownerRequest: (app: string, words: string) => post<{ id: string; status: string }>("/v1/accounts/owner_request", { app, words }),
  };
  return auth;
}
