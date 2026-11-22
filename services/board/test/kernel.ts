// A stand-in for the kernel's accounts routes (kernel/src/auth-api.ts and the admin listener's /auth/handoff), as far as the
// board uses them: it hands out one-time codes, exchanges them for board session tokens, checks and ends those sessions.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const BOARD_KEY = "k".repeat(48);
export type FakeAccount = { id: string; email: string; name: string; role: "admin" | "user"; owner: boolean };

export async function fakeKernel(): Promise<{
  url: string;
  /** A one-time code for `origin` and `state`, as /auth/handoff mints it for a signed-in admin. */
  code: (account: FakeAccount, origin: string, state: string) => string;
  /** A board session token straight away (what an exchange returns). */
  session: (account: FakeAccount) => string;
  /** The kernel-side session ends (a sign-out, disable or reset there). */
  end: (token: string) => void;
  /** The owner's-MCP side of the kernel: bearers it minted (for a resource), revoking one, and each card's current digest. */
  mcp: { token: (account: FakeAccount, client?: string, resource?: string) => string; revoke: (token: string) => void; digests: Map<string, string> };
  calls: { path: string; body: any }[];
  /** Answers for other account ops by path (a status and a body); anything unlisted is a 404. */
  ops: Record<string, [number, unknown]>;
  /** What the next save_secret reports as restarted services: the module's own, unless a test sets it ([] after a recreate began). */
  restarted: { services: string[] | null };
  close: () => void;
  /** Drop the code exchange's socket (a transport failure, no HTTP), or answer it with a status (a kernel-side refusal). */
  refuseExchange: (on: boolean | number) => void;
}> {
  const codes = new Map<string, { account: FakeAccount; origin: string; state: string }>();
  const sessions = new Map<string, FakeAccount>();
  const accounts = new Map<string, FakeAccount>();
  const grants = new Map<string, { account: FakeAccount; client: string; resource: string; revoked: boolean }>();
  const digests = new Map<string, string>();
  const calls: { path: string; body: any }[] = [];
  const saved: Record<string, boolean> = {};
  const restarted: { services: string[] | null } = { services: null };
  const ops: Record<string, [number, unknown]> = {};
  let refuseExchange: boolean | number = false;
  const server: Server = createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    const body = text ? JSON.parse(text) : {};
    calls.push({ path: String(req.url), body });
    const send = (status: number, j: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(j));
    if (req.headers.authorization !== `Bearer ${BOARD_KEY}`) return send(401, { error: { message: "the board's key is required" } });
    switch (req.url) {
      case "/v1/auth/exchange": {
        if (typeof refuseExchange === "number") return send(refuseExchange, { error: { message: "the board's key is not valid" } });
        if (refuseExchange) return void req.socket.destroy();
        const c = codes.get(body.code);
        codes.delete(body.code);
        if (!c || c.origin !== body.origin || c.state !== body.state) return send(400, { error: { message: "invalid or expired handoff" } });
        const token = `ahqu_${randomBytes(16).toString("hex")}`;
        sessions.set(token, c.account);
        return send(200, { token, admin: c.account, expires: new Date(Date.now() + 3_600_000).toISOString() });
      }
      case "/v1/auth/session": {
        const a = sessions.get(body.token);
        // Each token is its own session (one per browser), as the kernel's are.
        return a ? send(200, { account: a, session: { id: `s-${String(body.token).slice(-8)}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }) : send(401, { error: { message: "no session" } });
      }
      case "/v1/accounts/save_secret":
      case "/v1/accounts/setup_status": {
        if (!sessions.get(body.token)) return send(401, { error: { message: "sign in" } });
        if (req.url!.endsWith("save_secret")) return body.value === "bad" ? send(400, { error: { message: "that doesn't look like a bot token" } }) : (saved[body.secret] = true, send(200, { ok: true, restarted: restarted.services ?? [body.module] }));
        return send(200, { secrets: { ...saved } });
      }
      case "/v1/auth/mcp":
      case "/v1/owner/update":
      case "/v1/owner/decide": {
        const g = grants.get(body.token);
        if (!g || g.revoked || g.resource !== body.resource) return send(401, { error: { message: "no such grant" } });
        if (req.url === "/v1/auth/mcp") return send(200, { account: g.account, client: g.client, expires: new Date(Date.now() + 3_600_000).toISOString() });
        // The updater's answer: main is verified, any sha here is refused with its reason.
        if (req.url === "/v1/owner/update") return body.to === "main" ? send(200, { said: "Verified 1111111111aa. Filing it as an apply now." }) : send(409, { error: { message: `${body.to.slice(0, 12)} isn't on Aiden-HQ/AidenHQ's main` } });
        // Each card on its own; `by` comes from the grant, never the body.
        return send(200, { outcomes: body.cards.map((c: { id: string; digest: string; decision: string }) => (digests.get(c.id) === c.digest ? { id: c.id, ok: true, state: c.decision === "approve" ? "approved" : "rejected", by: `account:${g.account.id}` } : { id: c.id, ok: false, error: `card ${c.id} changed since you read it: call approvals again` })) });
      }
      case "/v1/auth/mcp/grants": {
        const me = sessions.get(body.token);
        if (!me) return send(401, { error: { message: "no session" } });
        return send(200, { grants: [...grants.entries()].filter(([, g]) => g.account.id === me.id && !g.revoked).map(([t, g]) => ({ id: t.slice(-8), client: g.client, lastUsed: null })) });
      }
      case "/v1/auth/mcp/revoke": {
        const me = sessions.get(body.token);
        if (!me) return send(401, { error: { message: "no session" } });
        const hit = [...grants].find(([t, g]) => g.account.id === me.id && t.endsWith(body.grant));
        if (!hit) return send(404, { error: { message: "no such grant" } }); // another account's grant is not found
        hit[1].revoked = true;
        return send(200, { ok: true });
      }
      case "/v1/auth/sign_out":
        sessions.delete(body.token);
        return send(200, { ok: true });
      case "/v1/accounts/names":
        return send(200, { accounts: [...accounts.values()].map(({ id, name, email, owner }) => ({ id, name, email, owner })) });
      case "/v1/accounts/list": {
        const a = sessions.get(body.token);
        return a ? send(200, { accounts: [...accounts.values()], me: a.id }) : send(401, { error: { message: "sign in" } });
      }
    }
    if (ops[String(req.url)]) return send(ops[String(req.url)]![0], ops[String(req.url)]![0] < 400 ? ops[String(req.url)]![1] : { error: { message: "refused" } });
    send(404, { error: { message: "no such route" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    code: (account, origin, state) => {
      accounts.set(account.id, account);
      const c = randomBytes(24).toString("base64url");
      codes.set(c, { account, origin, state });
      return c;
    },
    session: (account) => {
      accounts.set(account.id, account);
      const token = `ahqu_${randomBytes(16).toString("hex")}`;
      sessions.set(token, account);
      return token;
    },
    end: (token) => void sessions.delete(token),
    mcp: {
      token: (account, client = "Claude Code", resource = "https://board.example.com/mcp") => {
        accounts.set(account.id, account);
        const t = `mcp_${randomBytes(16).toString("hex")}`;
        grants.set(t, { account, client, resource, revoked: false });
        return t;
      },
      revoke: (token) => void (grants.get(token)!.revoked = true),
      digests,
    },
    calls,
    ops,
    restarted,
    close: () => server.close(),
    refuseExchange: (on) => void (refuseExchange = on),
  };
}
