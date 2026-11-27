// The owner's GitHub client (src/client.ts) over a fake GitHub: the real limiter, typed needs and footer-free transport, with
// a fixed sign-in. A fake may answer a real Response or a bare { status, json } (turned into one here).
import { createAccess, type AppSource, type GitHubAccess } from "../src/client.js";
import type { Auth } from "../src/vendor/oauth.js";

export const ownerAuth = (token = "gho_owner"): Auth => {
  let state: "ok" | "expired" = "ok";
  return { headers: async () => ({ authorization: `Bearer ${token}` }), refresh: async () => {}, status: () => ({ state, since: "" }), mark: (s) => void (state = s), signedIn: () => true };
};

type Loose = Response | { status: number; json: () => Promise<unknown>; headers?: Record<string, string> };
export function accessFor(fake: (url: string, init: RequestInit) => Promise<Loose> | Loose, token = "gho_owner", app?: AppSource): GitHubAccess {
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const r = await fake(String(url), init);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(await r.json()), { status: r.status, headers: r.headers ?? {} });
  }) as typeof fetch;
  // A virtual clock: the write queue's pacing and waits cost no real time.
  let clock = Date.now();
  return createAccess({ auth: ownerAuth(token), fetchImpl, now: () => clock, sleep: async (ms) => void (clock += ms), ...(app ? { app } : {}) });
}
