// The self-hosted Primer's token: primer_pat_<the generated vault secret primer_connector_token>, which the module's own
// Primer seeds for its agent user at every start (modules/primer/server/start.ts). The connector's sign-in to the local
// Primer, in place of OAuth to a hosted one; nothing for the owner to paste. Its status is checked against Primer
// (GET /api/me, kept 30 seconds per token).
import { existsSync, readFileSync } from "node:fs";
import { AuthError, type Auth } from "./vendor/oauth.js";

export const connectorToken = (file: string | undefined) => () => {
  const secret = file && existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  return secret ? `primer_pat_${secret}` : undefined;
};

export function tokenAuth(token: () => string | undefined, primer: string, fetchImpl: typeof fetch = fetch): Auth {
  let since = new Date().toISOString(), expired: string | undefined, checked: { token: string; at: number } | undefined;
  const mark: Auth["mark"] = (s, detail) => { expired = s === "expired" ? (detail ?? "Primer refused the connector's token") : undefined; since = new Date().toISOString(); };
  return {
    headers: async () => {
      const t = token();
      if (!t) throw new AuthError("The connector's Primer token (the generated secret primer_connector_token) is missing: run an apply.");
      return { authorization: `Bearer ${t}` };
    },
    refresh: async () => {},
    signedIn: () => Boolean(token()),
    // Primer refusing the token (401) is expired; no answer (Primer still starting) says nothing about it, so the last state stands.
    check: async () => {
      const t = token();
      if (!t || (checked?.token === t && Date.now() - checked.at < 30_000)) return;
      const res = await fetchImpl(`${primer}/api/me`, { headers: { authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(5000) });
      checked = { token: t, at: Date.now() };
      if (res.status === 401) mark("expired", "Primer refused the connector's token: it is seeded when primer-server starts, so restart primer-server");
      else if (res.ok) mark("ok");
    },
    mark,
    status: () => (!token() ? { state: "missing", since } : expired ? { state: "expired", since, detail: expired } : { state: "ok", since }),
  };
}
