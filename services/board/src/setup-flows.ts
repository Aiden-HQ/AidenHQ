// Module setup flows (board.setup_flows, compiled into the points file): the board renders each at #/setup/<module>. Secrets are
// saved by the kernel (account ops save_secret and setup_status, as the signed-in admin); pairing is the module service's own
// endpoint, reached with the module's pair token (read from the vault by name, never sent to the browser).
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { AccountError, type AccountSession, type KernelAuth } from "./kernel-auth.js";
import type { Store } from "./store.js";

/** One compiled flow (modules/board/schemas/setup_flows.json) plus the module's name; `pair_token` names a secret. */
export interface SetupFlowPoint {
  module: string;
  order: number;
  title: string;
  why: string;
  effort: string;
  wizard?: boolean;
  steps: string;
  secrets?: string[];
  signin?: string;
  pair_url?: string;
  pair_token?: string;
}

/** The compiled board.setup_flows, ordered; the pair token's value is read once from `<secrets>/<pair_token>`. */
export function setupFlowPoints(file: string, secrets: string): (SetupFlowPoint & { token?: string })[] {
  const list: SetupFlowPoint[] = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).setup_flows ?? []) : [];
  return list
    .map((f) => {
      const path = f.pair_token ? `${secrets}/${f.pair_token}` : "";
      return { ...f, ...(path && existsSync(path) ? { token: readFileSync(path, "utf8").trim() } : {}) };
    })
    .sort((a, b) => a.order - b.order);
}

export interface SetupFlowDeps {
  flows: (SetupFlowPoint & { token?: string })[];
  accounts: KernelAuth;
  store: Store;
  /** The sign-in state of a flow's `signin` id: true when connected. */
  signedIn: (id: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

export type SetupRoute = { method: string; path: RegExp; handle: (m: RegExpMatchArray, body: unknown, who: AccountSession) => Promise<unknown> };

const DISMISSED = "setup_dismissed";

export function setupFlowRoutes(d: SetupFlowDeps): SetupRoute[] {
  const doFetch = d.fetchImpl ?? fetch;
  const dismissed = (): string[] => {
    try {
      return JSON.parse(d.store.meta(DISMISSED) ?? "[]");
    } catch {
      return [];
    }
  };
  const flow = (module: string) => {
    const f = d.flows.find((x) => x.module === module);
    if (!f) throw new AccountError(404, "no such setup flow");
    return f;
  };
  /** Every route is for a ready admin (password and authenticator): a board session exists only for one, and a user's is refused. */
  const ready = (who: AccountSession) => {
    if (!who.ready || who.account.role !== "admin") throw new AccountError(403, "totp");
  };
  const pairCall = async (f: SetupFlowPoint & { token?: string }, method: "GET" | "POST") => {
    if (!f.pair_url || !f.token) throw new AccountError(404, "this module has no pairing");
    const res = await doFetch(f.pair_url, { method, headers: { authorization: `Bearer ${f.token}` }, signal: AbortSignal.timeout(15_000) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new AccountError(502, String(data.error ?? `${f.module} answered ${res.status}`));
    return data;
  };
  const pairedOf = async (f: SetupFlowPoint & { token?: string }) => (f.pair_url ? Boolean((await pairCall(f, "GET").catch(() => ({ paired: false }))).paired) : true);

  const routes: SetupRoute[] = [
    {
      method: "GET",
      path: /^\/api\/setup-flows$/,
      handle: async (_m, _b, who) => {
        const gone = new Set(dismissed());
        const flows = await Promise.all(
          d.flows.map(async ({ token: _t, pair_token: _p, ...f }) => {
            const full = d.flows.find((x) => x.module === f.module)!;
            const present = f.secrets?.length ? (await d.accounts.call<{ secrets: Record<string, boolean> }>("setup_status", who, { module: f.module })).secrets : {};
            const signedIn = f.signin ? await d.signedIn(f.signin) : true;
            const paired = await pairedOf(full);
            const done = (f.secrets ?? []).every((s) => present[s]) && signedIn && paired;
            return { ...f, present, signedIn, paired, done, dismissed: gone.has(f.module) };
          }),
        );
        return { flows };
      },
    },
    {
      method: "POST",
      path: /^\/api\/setup-flows\/([a-z0-9-]{1,63})\/secret$/,
      handle: async (m, body, who) => {
        const f = flow(m[1]!);
        const parsed = z.object({ secret: z.string().max(64), value: z.string().min(1).max(4000) }).strict().safeParse(body);
        if (!parsed.success) throw new AccountError(400, "secret and value are required");
        const { secret, value } = parsed.data;
        if (!f.secrets?.includes(secret)) throw new AccountError(400, "not one of this flow's secrets");
        return d.accounts.call("save_secret", who, { module: f.module, secret, value });
      },
    },
    {
      method: "POST",
      path: /^\/api\/setup-flows\/([a-z0-9-]{1,63})\/dismiss$/,
      handle: async (m) => {
        const f = flow(m[1]!);
        d.store.setMeta(DISMISSED, JSON.stringify([...new Set([...dismissed(), f.module])]));
        return { ok: true };
      },
    },
    {
      method: "POST",
      path: /^\/api\/setup-flows\/([a-z0-9-]{1,63})\/pair$/,
      handle: async (m, _b, who) => {
        // Like the kernel's save_secret: only the owner pairs a channel.
        if (!who.account.owner) throw new AccountError(403, "only the owner can pair a channel");
        const { code, link } = (await pairCall(flow(m[1]!), "POST")) as { code?: string; link?: string };
        return { code, ...(link ? { link } : {}) };
      },
    },
    {
      method: "GET",
      path: /^\/api\/setup-flows\/([a-z0-9-]{1,63})\/pair$/,
      handle: async (m) => ({ paired: Boolean((await pairCall(flow(m[1]!), "GET")).paired) }),
    },
  ];
  return routes.map((r) => ({ ...r, handle: async (m, b, who) => (ready(who), r.handle(m, b, who)) }));
}
