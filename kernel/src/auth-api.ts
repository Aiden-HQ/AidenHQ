// The accounts' backplane routes (lean 3g): what modules ask of the one opener of the accounts file.
//   POST /v1/auth/{exchange,session,sign_out}  (the board's key) a module UI's one-time code → its session token; that
//              token → its ready admin (or 401); that session ends. The board checks its session here on every request.
//   POST /v1/accounts/<op>   (the board's key + {token}: a live module UI session's admin acts) account admin: list, sessions,
//              revoke_session, invite, role, disable, enable, link, app_admins, app_admin_set; `names` and `owner_request` (the
//              owner's chat words Aiden relays as his in-app request) with the key alone.
//   POST /v1/apps/<op>       (the apps-platform module's own token) in-app requests and roles for agents: requests, reply,
//              roles, role_set (apps-mcp checked the calling agent may, and names it).
//   POST /v1/operator/<op>   (x-operator-key: board_operator_key) ops/setup.sh's owner setup link, first-run
//              /setup link (setup_token) and account resets.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AccountError, type Accounts, type Role } from "./accounts.ts";
import { AccessError, assertNamesApp } from "./app-access.ts";
import type { Whoami } from "./identity.ts";
import { fail } from "./proxy.ts";

const EMAIL = (v: unknown) => typeof v === "string" && v.length <= 200;
const APP = (v: unknown) => typeof v === "string" && /^[a-z][a-z0-9-]{1,30}$/.test(v);
const ID = (v: unknown) => typeof v === "string" && /^[\w-]{1,64}$/.test(v);
const ROLE = (v: unknown) => v === "admin" || v === "user";

export function createAuthApi({ accounts, whoami, boardKey, operatorKey }: { accounts: () => Accounts | undefined; whoami: Whoami; boardKey: () => string; operatorKey: () => string }) {
  const bearer = (req: IncomingMessage) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const is = (given: string, key: string) => { const a = Buffer.from(given), b = Buffer.from(key); return b.length > 0 && a.length === b.length && timingSafeEqual(a, b); };
  const send = (res: ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > 64_000) throw fail(413, "too_large", "too large"); chunks.push(c); }
    let b: unknown;
    try { b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw fail(400, "bad_request", "the body must be JSON"); }
    if (!b || typeof b !== "object" || Array.isArray(b)) throw fail(400, "bad_request", "the body must be an object");
    return b as Record<string, unknown>;
  }
  const need = (b: Record<string, unknown>, k: string, ok: (v: unknown) => boolean) => { if (!ok(b[k])) throw fail(400, "bad_request", `bad ${k}`); return b[k] as any; };

  return async function handle(req: IncomingMessage, res: ServerResponse, group: string, op: string): Promise<void> {
    const a = accounts();
    if (!a) throw fail(503, "unavailable", "accounts are off: see the kernel's log");
    try {
      if (group === "operator") {
        if (!is(String(req.headers["x-operator-key"] ?? ""), operatorKey())) throw fail(401, "unauthorized", "the operator's key is required");
        const b = await json(req);
        if (op === "setup") return send(res, 200, await a.setup(need(b, "email", EMAIL), typeof b.name === "string" ? b.name.slice(0, 100) : ""));
        if (op === "reset") { await a.reset(need(b, "email", EMAIL)); return send(res, 200, { ok: true }); }
        if (op === "setup_token") return send(res, 200, a.mintSetup());
        throw fail(404, "not_found", "no such operator call");
      }
      if (group === "apps") {
        const w = await whoami(bearer(req)).catch(() => undefined);
        if (w?.kind !== "module" || w.module !== "apps-platform") throw fail(401, "unauthorized", "the apps-platform module's own token is required");
        const b = await json(req);
        const app = need(b, "app", APP);
        switch (op) {
          case "requests": return send(res, 200, { requests: a.apps.open(app) });
          case "reply": return send(res, 200, a.apps.reply(app, need(b, "id", (v) => typeof v === "string" && v.length <= 40), need(b, "status", (v) => ["done", "declined", "answered"].includes(v as string)), need(b, "reply", (v) => typeof v === "string" && v.length >= 1 && v.length <= 1000)));
          case "roles": return send(res, 200, a.apps.view(app));
          case "role_set": return send(res, 200, await a.apps.agentAssign(need(b, "agent", (v) => typeof v === "string" && v.length >= 1 && v.length <= 100), app, need(b, "request_id", (v) => typeof v === "string" && v.length <= 40), need(b, "email", EMAIL), need(b, "role", (v) => v === null || APP(v))));
        }
        throw fail(404, "not_found", "no such apps call");
      }
      // The board's key from here on.
      if (!is(bearer(req), boardKey())) throw fail(401, "unauthorized", "the board's key is required");
      const b = await json(req);
      if (group === "auth") {
        if (op === "exchange") return send(res, 200, await a.exchangeUi("board", need(b, "code", (v) => typeof v === "string" && v.length >= 16 && v.length <= 100), need(b, "origin", (v) => typeof v === "string" && v.length <= 300), need(b, "state", (v) => typeof v === "string" && v.length <= 256)));
        const token = need(b, "token", (v) => typeof v === "string" && v.length <= 200);
        if (op === "session") {
          const who = await a.uiSession("board", token);
          if (!who) throw fail(401, "unauthorized", "no session");
          const { id, email, name, role, owner } = who.account;
          return send(res, 200, { account: { id, email, name, role, owner }, session: who.session });
        }
        if (op === "sign_out") { a.endUiSession("board", token); return send(res, 200, { ok: true }); }
        throw fail(404, "not_found", "no such auth call");
      }
      if (group === "accounts") {
        if (op === "names") return send(res, 200, { accounts: (await a.list()).map(({ id, name, email, owner }) => ({ id, name, email, owner })) });
        // The owner's own chat words, relayed by Aiden (the board checked the comment is his), filed as his in-app request.
        if (op === "owner_request") {
          const app = need(b, "app", APP), words = need(b, "words", (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 8000);
          const owner = (await a.list()).find((x) => x.owner);
          if (!owner) throw fail(409, "conflict", "refused: the owner has no account");
          assertNamesApp(words, app, a.apps.view(app).host);
          return send(res, 200, a.apps.ownerRequest(app, owner.email, words));
        }
        const who = await a.uiSession("board", need(b, "token", (v) => typeof v === "string" && v.length <= 200));
        if (!who?.ready) throw fail(401, "unauthorized", "sign in");
        const by = who.account;
        switch (op) {
          case "list": return send(res, 200, { accounts: await a.list(), me: by.id });
          case "sessions": return send(res, 200, { sessions: await a.sessionsOf(by.id, who.session.id) });
          case "revoke_session": return send(res, 200, await a.revokeSession(by.id, need(b, "id", ID)));
          case "invite": return send(res, 200, await a.invite(by, { email: need(b, "email", (v) => typeof v === "string" && /^[^@\s]+@[^@\s]+$/.test(v) && v.length <= 200), name: typeof b.name === "string" ? b.name.slice(0, 100) : "", role: need(b, "role", ROLE) as Role }));
          case "role": return send(res, 200, await a.setRole(by, need(b, "id", ID), need(b, "role", ROLE) as Role));
          case "disable": case "enable": return send(res, 200, await a.setDisabled(by, need(b, "id", ID), op === "disable"));
          case "link": return send(res, 200, await a.newLink(by, need(b, "id", ID)));
          case "app_admins": return send(res, 200, { apps: a.apps.adminsByApp() });
          case "app_admin_set": return send(res, 200, await a.apps.assign(by.email, need(b, "app", APP), need(b, "email", EMAIL), need(b, "admin", (v) => typeof v === "boolean") ? "admin" : null));
        }
        throw fail(404, "not_found", "no such accounts call");
      }
      throw fail(404, "not_found", "no such route");
    } catch (err) {
      if (err instanceof AccountError || err instanceof AccessError) throw fail(err.status, err.status === 401 ? "unauthorized" : err.status === 403 ? "forbidden" : err.status === 404 ? "not_found" : err.status === 409 ? "conflict" : "bad_request", err.message);
      throw err;
    }
  };
}
export type AuthApi = ReturnType<typeof createAuthApi>;
