// The self-hosted Primer's service token (a primer_pat_... the owner mints in Primer and saves as the vault secret
// primer_service_token): the connector's sign-in to the local Primer, in place of OAuth to a hosted one. Re-read on every
// use, so saving it takes effect without a restart. Its status is checked against Primer (GET /api/me, kept 30 seconds per token).
import { existsSync, readFileSync } from "node:fs";
import { AuthError, type Auth } from "./vendor/oauth.js";

export const fileToken = (file: string | undefined) => () => (file && existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined);

export function tokenAuth(token: () => string | undefined, primer: string, fetchImpl: typeof fetch = fetch): Auth {
  let since = new Date().toISOString(), expired: string | undefined, checked: { token: string; at: number } | undefined;
  const mark: Auth["mark"] = (s, detail) => { expired = s === "expired" ? (detail ?? "Primer refused the service token") : undefined; since = new Date().toISOString(); };
  return {
    headers: async () => {
      const t = token();
      if (!t) throw new AuthError("Primer's service token isn't saved yet: mint one in Primer (Settings, API tokens) and save it as the primer_service_token secret.");
      return { authorization: `Bearer ${t}` };
    },
    refresh: async () => {},
    signedIn: () => Boolean(token()),
    // Primer refusing the token (401) is expired; no answer says nothing about the token, so the last state stands.
    check: async () => {
      const t = token();
      if (!t || (checked?.token === t && Date.now() - checked.at < 30_000)) return;
      const res = await fetchImpl(`${primer}/api/me`, { headers: { authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(5000) });
      checked = { token: t, at: Date.now() };
      if (res.status === 401) mark("expired", "Primer refused the service token: mint a new one in Primer (Settings, API tokens) and paste it on Connect");
      else if (res.ok) mark("ok");
    },
    mark,
    status: () => (!token() ? { state: "missing", since, paste: true } : expired ? { state: "expired", since, detail: expired, paste: true } : { state: "ok", since, paste: true }),
  };
}
