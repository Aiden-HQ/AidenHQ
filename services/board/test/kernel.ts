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
  calls: { path: string; body: any }[];
  /** Answers for other account ops by path (a status and a body); anything unlisted is a 404. */
  ops: Record<string, [number, unknown]>;
  close: () => void;
}> {
  const codes = new Map<string, { account: FakeAccount; origin: string; state: string }>();
  const sessions = new Map<string, FakeAccount>();
  const accounts = new Map<string, FakeAccount>();
  const calls: { path: string; body: any }[] = [];
  const saved: Record<string, boolean> = {};
  const ops: Record<string, [number, unknown]> = {};
  const server: Server = createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    const body = text ? JSON.parse(text) : {};
    calls.push({ path: String(req.url), body });
    const send = (status: number, j: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(j));
    if (req.headers.authorization !== `Bearer ${BOARD_KEY}`) return send(401, { error: { message: "the board's key is required" } });
    switch (req.url) {
      case "/v1/auth/exchange": {
        const c = codes.get(body.code);
        codes.delete(body.code);
        if (!c || c.origin !== body.origin || c.state !== body.state) return send(400, { error: { message: "invalid or expired handoff" } });
        const token = `ahqu_${randomBytes(16).toString("hex")}`;
        sessions.set(token, c.account);
        return send(200, { token, admin: c.account, expires: new Date(Date.now() + 3_600_000).toISOString() });
      }
      case "/v1/auth/session": {
        const a = sessions.get(body.token);
        return a ? send(200, { account: a, session: { id: `s-${a.id}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }) : send(401, { error: { message: "no session" } });
      }
      case "/v1/accounts/save_secret":
      case "/v1/accounts/setup_status": {
        if (!sessions.get(body.token)) return send(401, { error: { message: "sign in" } });
        if (req.url!.endsWith("save_secret")) return body.value === "bad" ? send(400, { error: { message: "that doesn't look like a bot token" } }) : (saved[body.secret] = true, send(200, { ok: true, restarted: [body.module] }));
        return send(200, { secrets: { ...saved } });
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
    calls,
    ops,
    close: () => server.close(),
  };
}
