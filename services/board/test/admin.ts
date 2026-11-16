import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { EDGE_HEADER, authCore, authSecret, inboundCookies, openAuthDb, readBody, secretIs } from "../src/auth-rules.js";

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * The kernel's admin listener as far as accounts go (kernel/src/accounts.ts): the shared auth-rules on the same file and secret,
 * listener "admin", Better Auth's endpoints under /api/auth. Admins sign in here; the board takes the same session.
 */
export async function adminListener(dbPath: string, hosts: string[], o: { edgeSecret?: string; notify?: (line: string) => void } = {}): Promise<{ base: string; close: () => void }> {
  const secret = authSecret(dbPath);
  const db = openAuthDb(dbPath);
  const core = authCore({ db, secret, hosts, linkTtlMs: 72 * 3_600_000, notify: o.notify, log: quiet });
  await (await getMigrations(core.options)).runMigrations();
  const auth = betterAuth(core.options);
  const server: Server = createServer(async (req, res) => {
    const sub = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/api\/auth/, "");
    const body = req.method === "POST" ? await readBody(req, 64_000) : undefined;
    const r = await core.call(auth, req, sub, "admin", { ...(body ? { body } : {}), host: String(req.headers.host ?? ""), trusted: secretIs(req.headers[EDGE_HEADER], o.edgeSecret), cookie: inboundCookies(req.headers.cookie, false) });
    await core.write(r, res, false, "admin");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => (server.close(), db.close()) };
}
