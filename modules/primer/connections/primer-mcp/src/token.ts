// The self-hosted Primer's service token (a primer_pat_... the owner mints in Primer and saves as the vault secret
// primer_service_token): the connector's sign-in to the local Primer, in place of OAuth to a hosted one. Re-read on every
// use, so saving it takes effect without a restart.
import { existsSync, readFileSync } from "node:fs";
import { AuthError, type Auth } from "./vendor/oauth.js";

export const fileToken = (file: string | undefined) => () => (file && existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined);

export function tokenAuth(token: () => string | undefined): Auth {
  let since = new Date().toISOString(), expired: string | undefined;
  return {
    headers: async () => {
      const t = token();
      if (!t) throw new AuthError("Primer's service token isn't saved yet: mint one in Primer (Settings, Tokens) and save it as the primer_service_token secret.");
      return { authorization: `Bearer ${t}` };
    },
    refresh: async () => {},
    signedIn: () => Boolean(token()),
    mark: (s, detail) => { expired = s === "expired" ? (detail ?? "Primer refused the service token") : undefined; since = new Date().toISOString(); },
    status: () => (!token() ? { state: "missing", since } : expired ? { state: "expired", since, detail: expired } : { state: "ok", since }),
  };
}
