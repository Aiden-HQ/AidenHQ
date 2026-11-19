// Module setup flows (board.setup_flows, compiled into the points file): the board renders each at #/setup/<module>. Secrets are
// saved by the kernel (account ops save_secret and setup_status, as the signed-in admin); pairing is the module service's own
// endpoint, reached with the module's pair token (read from the vault by name, never sent to the browser).
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
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
  /** Each secret's paste field (compile fills it from the secret's `setup:`): the board shows the label and help and checks the pattern. */
  fields?: { secret: string; label: string; pattern: string; help?: string }[];
  signin?: string;
  /** A connect path the board serves for a connection that isn't a board.signins entry. */
  connect_url?: string;
  /** Shown instead of the steps and fields when the board's address is a bare IP. */
  needs_name?: string;
  /** The vendor's page where the owner makes the client the flow's fields ask for (an https link). */
  console_url?: string;
  pair_url?: string;
  pair_token?: string;
  /** A module with modes: the owner picks one first (a module setting), then Connect (modules/board/schemas/setup_flows.json). */
  choose?: ChooseSpec;
}

export interface ChooseSpec {
  setting: string;
  options: {
    value: string;
    label: string;
    detail: string;
    requires?: { setting: string; otherwise: string };
    inputs?: { setting: string; label: string; help?: string; pattern: string; when?: Record<string, string | string[]> }[];
  }[];
}

/** What the board reads of the compiled config for a choice: a setting's effective value, and whether the instance sets it. */
export type SettingsView = Record<string, { value: unknown; set: boolean }> | undefined;

/** The one change type a choice files (the board's typed settings change). */
export type SettingChangeInput = { kind: "setting"; key: string; value: string };

/** Whether a host has a name: not an IP literal, loopback excepted (OAuth providers accept http://127.0.0.1 redirects). */
export function namedHost(host: string): boolean {
  const h = host.replace(/^\[(.*)\](:\d+)?$/, "$1").replace(/^([^:]+):\d+$/, "$1");
  return !isIP(h) || h === "::1" || h.startsWith("127.");
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
  /** Whether the sign-in `id` offers a choice of scopes: its Connect opens the picker, and its Reconnect reads "Change access". */
  scopeChoice: (id: string) => Promise<boolean>;
  /** A connect path's connection: true when signed in, undefined when the board serves no such path. */
  connected: (path: string) => Promise<boolean | undefined>;
  /** The board's own address, where its sign-ins return (the flows' {board_url}). */
  boardUrl: (host: string) => string;
  /** The exact redirect the sign-in `signin` sends for a request to `host` (the flows' {redirect_url}). */
  redirectUrl: (signin: string, host: string) => string | undefined;
  /** The compiled config's settings (what is live now). */
  settings: () => SettingsView;
  /** Files settings changes as the owner's own task (the board's settings change path); resolves to its task. */
  file: (changes: SettingChangeInput[]) => Promise<{ identifier: string }>;
  fetchImpl?: typeof fetch;
}

export type SetupRoute = { method: string; path: RegExp; handle: (m: RegExpMatchArray, body: unknown, who: AccountSession, host: string) => Promise<unknown> };

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
  const chosenOf = (module: string): string | null => d.store.meta(`setup_choice:${module}`) ?? null;
  const holds = (when: Record<string, string | string[]> | undefined, settings: SettingsView) =>
    Object.entries(when ?? {}).every(([k, v]) => [v].flat().map(String).includes(String(settings?.[k]?.value)));
  /** The flow's choice as the page shows it: what is live, what the owner picked, each option's availability and inputs. */
  const chooseView = (c: ChooseSpec, module: string) => {
    const settings = d.settings();
    return {
      setting: c.setting,
      value: settings?.[c.setting]?.value ?? null,
      chosen: chosenOf(module),
      options: c.options.map(({ requires, inputs, ...o }) => ({
        ...o,
        ...(requires && !settings?.[requires.setting]?.set ? { unavailable: requires.otherwise } : {}),
        ...(inputs ? { inputs: inputs.filter((i) => holds(i.when, settings)).map(({ when: _w, ...i }) => ({ ...i, value: String(settings?.[i.setting]?.value ?? "") })) } : {}),
      })),
    };
  };
  const pairedOf = async (f: SetupFlowPoint & { token?: string }) => (f.pair_url ? Boolean((await pairCall(f, "GET").catch(() => ({ paired: false }))).paired) : true);

  const routes: SetupRoute[] = [
    {
      method: "GET",
      path: /^\/api\/setup-flows$/,
      handle: async (_m, _b, who, host) => {
        const gone = new Set(dismissed());
        const flows = await Promise.all(
          d.flows.map(async ({ token: _t, pair_token: _p, connect_url, ...f }) => {
            const full = d.flows.find((x) => x.module === f.module)!;
            const present = f.secrets?.length ? (await d.accounts.call<{ secrets: Record<string, boolean> }>("setup_status", who, { module: f.module })).secrets : {};
            // A connect path counts only if the board serves it; then its connection's state is the sign-in's.
            const connected = connect_url ? await d.connected(connect_url) : undefined;
            const signedIn = f.signin ? await d.signedIn(f.signin) : connect_url ? connected === true : true;
            const paired = await pairedOf(full);
            const scopes = f.signin ? await d.scopeChoice(f.signin) : false;
            // A connection's real state decides when it has one (an upgraded instance keeps values outside the vault and works);
            // only a flow with no sign-in, connect path or pairing is done by its secrets.
            const done = f.signin || connect_url || f.pair_url ? signedIn && paired : (f.secrets ?? []).every((s) => present[s]);
            const redirect_url = f.signin ? d.redirectUrl(f.signin, host) : undefined;
            const choose = full.choose ? { choose: chooseView(full.choose, f.module) } : {};
            return { ...f, ...choose, ...(connected !== undefined ? { connect_url } : {}), ...(redirect_url ? { redirect_url } : {}), present, signedIn, scopes, paired, done, dismissed: gone.has(f.module) };
          }),
        );
        const boardUrl = d.boardUrl(host);
        return { flows, board_url: boardUrl, named: namedHost(new URL(boardUrl).host) };
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
      // The owner's pick (a module with modes): sets the mode and what that mode needs as a settings change, filed only when
      // something differs from what is live; the page follows it and opens Connect once the setting holds the pick.
      method: "POST",
      path: /^\/api\/setup-flows\/([a-z0-9-]{1,63})\/choose$/,
      handle: async (m, body) => {
        const f = flow(m[1]!);
        if (!f.choose) throw new AccountError(404, "this module has no choice");
        const parsed = z.object({ value: z.string().max(60), inputs: z.record(z.string().max(60), z.string().max(300)).default({}) }).strict().safeParse(body);
        if (!parsed.success) throw new AccountError(400, "a value is required");
        const { value, inputs } = parsed.data;
        const option = f.choose.options.find((o) => o.value === value);
        if (!option) throw new AccountError(400, "not one of this flow's options");
        const settings = d.settings();
        if (option.requires && !settings?.[option.requires.setting]?.set) throw new AccountError(409, option.requires.otherwise);
        const wanted: [string, string][] = [[f.choose.setting, value]];
        for (const i of option.inputs ?? []) {
          if (!holds(i.when, settings)) continue;
          const v = (inputs[i.setting] ?? "").trim();
          if (!new RegExp(i.pattern).test(v)) throw new AccountError(400, `${i.label}: that doesn't look right.${i.help ? ` ${i.help}` : ""}`);
          wanted.push([i.setting, v]);
        }
        const changes = wanted.filter(([k, v]) => String(settings?.[k]?.value ?? "") !== v).map(([key, v]): SettingChangeInput => ({ kind: "setting", key, value: v }));
        const filed = changes.length ? await d.file(changes) : undefined;
        d.store.setMeta(`setup_choice:${f.module}`, value);
        return { ok: true, ...(filed ? { identifier: filed.identifier } : {}) };
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
        // minted_at (the board's clock, like the service's paired_at): a pairing after it is this code's, so a re-pair shows.
        const minted_at = Date.now();
        const { code, link } = (await pairCall(flow(m[1]!), "POST")) as { code?: string; link?: string };
        return { code, ...(link ? { link } : {}), minted_at };
      },
    },
    {
      method: "GET",
      path: /^\/api\/setup-flows\/([a-z0-9-]{1,63})\/pair$/,
      handle: async (m) => {
        const { paired, paired_at } = await pairCall(flow(m[1]!), "GET");
        return { paired: Boolean(paired), ...(paired_at != null ? { paired_at } : {}) };
      },
    },
  ];
  return routes.map((r) => ({ ...r, handle: async (m, b, who, host) => (ready(who), r.handle(m, b, who, host)) }));
}
