// A device sign-in (board.signins `mode: device`, GitHub's model): the board asks the connection's proxy for a code, shows it with
// the vendor's page, and the proxy polls for the token itself. The code is bound to the admin account that asked for it: only
// that account reads it, follows it or cancels it (from any of its browsers), a new start by it replaces its pending code, and
// another account can't start one over it until it ends or expires.
import { AccountError } from "./kernel-auth.js";
import type { McpAuth } from "./mcpauth.js";
import { vendorWords } from "./mcpauth.js";
import type { SetupRoute } from "./setup-flows.js";

export interface DeviceSignIn { id: string; label: string; mode?: "redirect" | "device"; auth: McpAuth }

export function deviceRoutes(d: { signIns: DeviceSignIn[]; onSignedIn: (id: string) => void; now?: () => number }): SetupRoute[] {
  const now = d.now ?? Date.now;
  const pending = new Map<string, { account: string; expires: number }>();
  const signIn = (id: string) => {
    const s = d.signIns.find((x) => x.id === id && x.mode === "device");
    if (!s) throw new AccountError(404, "no such device sign-in");
    return s;
  };
  /** The account's own pending sign-in; anyone else's (or none) is not found. */
  const mine = (id: string, account: string) => {
    const p = pending.get(id);
    if (!p || p.account !== account) throw new AccountError(404, "no sign-in in progress");
    return p;
  };
  const routes: SetupRoute[] = [
    {
      method: "POST",
      path: /^\/api\/sign-ins\/([a-z0-9-]{1,63})\/device$/,
      handle: async (m, _b, who) => {
        const s = signIn(m[1]!);
        const p = pending.get(s.id);
        if (p && p.account !== who.account.id && p.expires > now()) throw new AccountError(409, `Another admin is signing in to ${s.label} right now. Try again when they finish, or in a few minutes.`);
        // The same admin again (another browser, or after signing in afresh): its old code is cancelled and replaced.
        if (p) {
          pending.delete(s.id);
          await s.auth.deviceCancel().catch(() => {});
        }
        let code;
        try {
          code = await s.auth.deviceStart();
        } catch (e) {
          throw new AccountError(502, `Couldn't start the ${s.label} sign-in: ${String((e as Error).message).slice(0, 300)}`);
        }
        // The page the person types the code on is the vendor's: an https link, nothing else.
        if (!/^https:\/\/[^\s]+$/.test(code.verification_uri)) throw new AccountError(502, `${s.label} answered with a sign-in page that isn't https`);
        pending.set(s.id, { account: who.account.id, expires: now() + code.expires_in * 1000 });
        return {
          user_code: code.user_code,
          verification_uri: code.verification_uri,
          ...(code.verification_uri_complete?.startsWith("https://") ? { verification_uri_complete: code.verification_uri_complete } : {}),
          expires_in: code.expires_in,
          interval: code.interval,
        };
      },
    },
    {
      method: "GET",
      path: /^\/api\/sign-ins\/([a-z0-9-]{1,63})\/device$/,
      handle: async (m, _b, who) => {
        const s = signIn(m[1]!);
        mine(s.id, who.account.id);
        const st = await s.auth.deviceState();
        if (st.state !== "pending") pending.delete(s.id);
        if (st.state === "ok") d.onSignedIn(s.id);
        const detail = st.state === "denied" ? vendorWords("access_denied") : st.detail;
        return { state: st.state, ...(detail ? { detail } : {}) };
      },
    },
    {
      method: "POST",
      path: /^\/api\/sign-ins\/([a-z0-9-]{1,63})\/device\/cancel$/,
      handle: async (m, _b, who) => {
        const s = signIn(m[1]!);
        mine(s.id, who.account.id);
        pending.delete(s.id);
        await s.auth.deviceCancel();
        return { ok: true };
      },
    },
  ];
  return routes.map((r) => ({
    ...r,
    handle: async (m, b, who, host) => {
      if (!who.ready || who.account.role !== "admin") throw new AccountError(403, "totp");
      return r.handle(m, b, who, host);
    },
  }));
}
