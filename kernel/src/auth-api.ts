// The accounts' backplane routes (lean 3g): what modules ask of the one opener of the accounts file.
//   POST /v1/auth/{exchange,session,sign_out}  (the board's key) a module UI's one-time code → its session token; that
//              token → its ready admin (or 401); that session ends. The board checks its session here on every request.
//   POST /v1/auth/mcp, /v1/auth/mcp/{grants,revoke}  (the board's key) an MCP client's bearer for {resource} (the board's
//              /mcp) → its ready admin, client and expiry (or 401); with {token} (a live board session's ready admin) that
//              admin's own MCP clients, and revoking one of them.
//   POST /v1/owner/decide    (the board's key + an MCP client's bearer, or {board}: a signed-in admin's board session) cards
//              decided as that account, via "mcp" or "board", each against the digest that was read, each on its own.
//   POST /v1/owner/update    (the board's key + an MCP client's bearer) {to: "main" | sha}: the release updater moves this
//              release install to that main commit once it verified it (updates.ts requestMain), as the bearer's account.
//   POST /v1/accounts/<op>   (the board's key + {token}: a live module UI session's admin acts) account admin: list, sessions,
//              revoke_session, invite, role, disable, enable, link, app_admins, app_admin_set, recovery_key_waiting, model_ready (a model key is in the vault), save_secret (with `key`: one key of a JSON-map secret), secret_keys
//              (the owner's) and setup_status (a module's declared `setup:` secrets: module-secrets.ts); `names` and `owner_request` (the
//              owner's chat words Aiden relays as his in-app request) with the key alone.
//   POST /v1/apps/<op>       (the apps-platform module's own token) in-app requests and roles for agents: requests, reply,
//              roles, role_set (apps-mcp checked the calling agent may, and names it).
//   POST /v1/operator/<op>   (x-operator-key: kernel_operator_key) ops/setup.sh's owner setup link, first-run
//              /setup link (setup_token) and account resets, each answering a one-time link. The key is read by the kernel and
//              by root's ops/setup.sh on the host, and mounted into no container (compose.yaml), so no container, the board
//              included, can mint a link: a board compromise isn't an account takeover.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AccountError, type Accounts, type Role } from "./accounts.ts";
import { AccessError, assertNamesApp } from "../../modules/apps-platform/src/app-access.ts";
import type { Whoami } from "./identity.ts";
import { entryMax, type ModuleSecrets } from "./module-secrets.ts";
import type { ModuleValidate } from "./module-validate.ts";
import { fail } from "./proxy.ts";

/** The vault secret the operator routes check: the host's only (never in compose.yaml). */
export const OPERATOR_KEY = "kernel_operator_key";
/** The request body's cap: one map entry with every field at pages.json's 65536 ceiling, each JSON-escaped, fits (2 MB holds 8 of them). */
const MAX_BODY = 2 * 1024 * 1024;

const EMAIL = (v: unknown) => typeof v === "string" && v.length <= 200;
const APP = (v: unknown) => typeof v === "string" && /^[a-z][a-z0-9-]{1,30}$/.test(v);
const ID = (v: unknown) => typeof v === "string" && /^[\w-]{1,64}$/.test(v);
const ROLE = (v: unknown) => v === "admin" || v === "user";
const MODULE = (v: unknown) => typeof v === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(v);
const SECRET = (v: unknown) => typeof v === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(v);

/** One card an MCP client decides: approve or reject, against the digest it read; `stale` closes a dead or duplicate card (a reject, never a veto). */
type McpCard = { id: string; digest: string; decision: "approve" | "reject"; reason?: string; stale?: boolean };
type Decide = (id: string, digest: string, decision: "approve" | "reject", by: string, via: string, reason?: string) => Promise<{ identifier: string; state: string }>;
type Update = (to: string, by: string) => Promise<string>;

export function createAuthApi({ accounts, whoami, boardKey, operatorKey, recoveryKeyWaiting = () => false, modelReady = () => true, secrets, decide, update, validate }: { accounts: () => Accounts | undefined; whoami: Whoami; boardKey: () => string; operatorKey: () => string; recoveryKeyWaiting?: () => boolean; modelReady?: () => boolean; secrets?: ModuleSecrets; decide?: Decide; update?: Update; validate?: ModuleValidate }) {
  const bearer = (req: IncomingMessage) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const is = (given: string, key: string) => { const a = Buffer.from(given), b = Buffer.from(key); return b.length > 0 && a.length === b.length && timingSafeEqual(a, b); };
  const send = (res: ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let n = 0;
    // A saved secret can be an entry with every field at its declared ceiling, JSON-escaped (kernel/src/module-secrets.ts
    // entryMax): the body is larger than every other call's.
    for await (const c of req) { n += c.length; if (n > MAX_BODY) throw fail(413, "too_large", "too large"); chunks.push(c); }
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
        if (op === "reset") { const { url } = await a.reset(need(b, "email", EMAIL)); return send(res, 200, { ok: true, url }); }
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
      // An MCP client's bearer, for the resource it must name (the board's /mcp): checked afresh on every call.
      const grant = async () => {
        const g = await a.mcpGrant(need(b, "token", (v) => typeof v === "string" && v.length >= 16 && v.length <= 200), need(b, "resource", (v) => typeof v === "string" && v.length <= 300));
        if (!g) throw fail(401, "unauthorized", "this MCP sign-in has expired or was revoked: sign in again from your client");
        return g;
      };
      if (group === "auth" && op.startsWith("mcp")) {
        if (op === "mcp") {
          const g = await grant();
          const { id, email, name, role, owner } = g.account;
          return send(res, 200, { account: { id, email, name, role, owner }, client: g.client, expires: g.expires });
        }
        const who = await a.uiSession("board", need(b, "token", (v) => typeof v === "string" && v.length <= 200));
        if (!who?.ready) throw fail(401, "unauthorized", "sign in");
        const account = who.account.id;
        if (op === "mcp/grants") return send(res, 200, { grants: a.mcpGrants(account) });
        if (op === "mcp/revoke") { a.revokeMcpGrant(account, need(b, "grant", ID)); return send(res, 200, { ok: true }); }
        throw fail(404, "not_found", "no such auth call");
      }
      if (group === "owner" && op === "decide") {
        if (!decide) throw fail(503, "unavailable", "deciding cards is off");
        // The board's own Approve and Reject forward the admin's board session (as a settings save does); an MCP client its bearer.
        const session = b.board !== undefined ? await a.uiSession("board", need(b, "board", (v) => typeof v === "string" && v.length >= 16 && v.length <= 200)) : undefined;
        if (b.board !== undefined && !(session?.ready && session.account.role === "admin")) throw fail(401, "unauthorized", "that sign-in has ended: sign in again");
        const g = session ? { account: session.account } : await grant();
        const via = session ? "board" : "mcp";
        const cards = need(b, "cards", (v) => Array.isArray(v) && v.length >= 1 && v.length <= 20) as unknown[];
        const outcomes = [];
        // Each card on its own: one that changed since it was read fails alone.
        for (const raw of cards) {
          const c = (raw && typeof raw === "object" ? raw : {}) as Partial<McpCard>;
          const id = typeof c.id === "string" ? c.id.slice(0, 40) : "";
          const bad = !id ? "send each card's id" : typeof c.digest !== "string" || c.digest.length > 200 ? "send the digest you read (call approvals)" : c.decision !== "approve" && c.decision !== "reject" ? "decision is approve or reject"
            : c.reason !== undefined && (typeof c.reason !== "string" || c.reason.length > 500) ? "reason is text, at most 500 characters" : c.stale !== undefined && typeof c.stale !== "boolean" ? "stale is true or false"
            : c.stale && c.decision !== "reject" ? "stale closes a dead or duplicate card: only with decision reject" : "";
          if (bad) { outcomes.push({ id, ok: false, error: bad }); continue; }
          const by = `${c.stale ? "stale:" : ""}account:${g.account.id}`;
          outcomes.push(await decide(id, c.digest!, c.decision!, by, via, c.reason ?? "").then(
            (r) => ({ id, ok: true, state: r.state, identifier: r.identifier }),
            (e: Error) => ({ id, ok: false, error: /digest|changed meanwhile/.test(e.message) ? `card ${id} changed since you read it: call approvals again` : e.message }),
          ));
        }
        return send(res, 200, { outcomes });
      }
      if (group === "owner" && op === "update") {
        if (!update) throw fail(503, "unavailable", "release updates are off");
        const g = await grant();
        const to = need(b, "to", (v) => v === "main" || (typeof v === "string" && /^[0-9a-f]{40}$/.test(v))) as string;
        try { return send(res, 200, { said: await update(to, `account:${g.account.id}`) }); } catch (e) { throw fail(409, "refused", (e as Error).message.slice(0, 500)); }
      }
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
          case "recovery_key_waiting": if (!by.owner) throw fail(403, "forbidden", "only the owner"); return send(res, 200, { waiting: recoveryKeyWaiting() });
          case "model_ready": return send(res, 200, { ready: modelReady() });
          case "app_admins": return send(res, 200, { apps: a.apps.adminsByApp() });
          case "app_admin_set": return send(res, 200, await a.apps.assign(by.email, need(b, "app", APP), need(b, "email", EMAIL), need(b, "admin", (v) => typeof v === "boolean") ? "admin" : null));
          // A module's declared secrets: any ready admin sees which are set; only the owner replaces one (a channel's token
          // decides approvals). The kernel picks the file and the services.
          case "save_secret": case "setup_status": case "secret_keys": {
            if (!secrets) throw fail(503, "unavailable", "module secrets are off");
            const module = need(b, "module", MODULE);
            if (op === "setup_status") return send(res, 200, { secrets: secrets.status(module) });
            if (op === "secret_keys") return send(res, 200, { keys: secrets.keys(module, need(b, "secret", SECRET)) });
            if (!by.owner) throw fail(403, "forbidden", "only the owner");
            const name = need(b, "secret", SECRET);
            // A whole-map paste is capped at 1000, 4000 with a key. A secret whose page declares its fields takes its own bound
            // (kernel/src/module-secrets.ts): an entry at its fields' ceilings, JSON-escaped; a whole map, 64 KB, so a 4 KB SSH
            // key fits where 1000 never could.
            const declared = secrets.fields(module, name);
            const cap = declared ? (b.key !== undefined ? entryMax(declared) : secrets.cap(module, name)) : b.key !== undefined ? 4000 : 1000;
            const value = need(b, "value", (v) => typeof v === "string" && v.length <= cap);
            // One key of a JSON-map secret (a module page's secret_maps): `value` is that key's entry as JSON, or "" to clear it.
            // The module's own check sees the entry alone, never the other keys.
            if (b.key !== undefined) {
              let entry: Record<string, string> | null = null;
              if (value !== "") {
                try { entry = JSON.parse(value); } catch {}
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw fail(400, "bad_request", "an entry is a JSON object of texts");
              }
              let unchecked: unknown;
              // A clear (entry null) is checked too, as { secret: { name }, key } with no value (module-validate.ts forwards the
              // key beside the value): the module may refuse it.
              const key = need(b, "key", (v) => typeof v === "string");
              await secrets.saveKey(module, name, key, entry, async (only, sent) => {
                const checked = await validate?.(module, sent ? { secret: { name, value: JSON.stringify({ [only]: sent }) } } : { secret: { name }, key });
                if (checked && !checked.ok) throw fail(400, "bad_request", checked.errors.map((e) => e.message).join(" "));
                if (checked?.ok && checked.unchecked) unchecked = checked.unchecked;
              });
              return send(res, 200, { ok: true, ...(unchecked ? { unchecked } : {}) });
            }
            // The module's own check, before the value is written (module-validate.ts): its refusal is the field's error.
            const checked = await validate?.(module, { secret: { name, value: value.trim() } });
            if (checked && !checked.ok) throw fail(400, "bad_request", checked.errors.map((e) => e.message).join(" "));
            return send(res, 200, { ok: true, ...(await secrets.save(module, name, value)), ...(checked?.ok && checked.unchecked ? { unchecked: checked.unchecked } : {}) });
          }
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
