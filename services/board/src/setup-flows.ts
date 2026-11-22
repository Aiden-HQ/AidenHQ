// Module setup flows (board.setup_flows, compiled into the points file): the board renders each at #/setup/<module>. Secrets are
// saved by the kernel (account ops save_secret and setup_status, as the signed-in admin); pairing is the module service's own
// endpoint, reached with the module's pair token (read from the vault by name, never sent to the browser).
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { AccountError, type AccountSession, type KernelAuth } from "./kernel-auth.js";
import type { Store } from "./store.js";

/** A pair code's life when the channel doesn't say: the 15 minutes every pairing module keeps. */
export const PAIR_CODE_TTL_S = 15 * 60;

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
  /** The vendor's page where the owner makes the client the flow's fields ask for (an https link). */
  console_url?: string;
  pair_url?: string;
  pair_token?: string;
  /** A module with modes: the owner picks one first (a module setting), then Connect (modules/board/schemas/setup_flows.json). */
  choose?: ChooseSpec;
  /** Who else may need to approve (an honest label beside the effort). */
  admin?: string;
  /** Its `mode: advanced` flow: the person's own app, for what basic can't do; done once its secrets exist (and it is paired). */
  advanced?: AdvancedFlow;
}

/** A saved secret's services are still being recreated: the board's pairing waits on this, not on every module 409. */
const RESTARTING = (module: string) => `setup_restarting:${module}`;
export const RESTART_MS = 5 * 60_000;

/** How long a module's pairing endpoint may take to answer before the board calls it a timeout (a POST may have minted). */
const PAIR_TIMEOUT_MS = 15_000;

/** A module's advanced flow (compile nests it in the basic one): what it unlocks, its steps, secrets and pairing. */
export interface AdvancedFlow {
  title: string;
  why: string;
  effort: string;
  admin?: string;
  steps: string;
  capabilities: string[];
  secrets?: string[];
  fields?: SetupFlowPoint["fields"];
  console_url?: string;
  pair_url?: string;
  pair_token?: string;
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

/** The compiled board.setup_flows, ordered; the pair token's value is read once from `<secrets>/<pair_token>`. */
export function setupFlowPoints(file: string, secrets: string): (SetupFlowPoint & { token?: string })[] {
  const list: SetupFlowPoint[] = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).setup_flows ?? []) : [];
  return list
    .map((f) => {
      const pairToken = f.pair_token ?? f.advanced?.pair_token;
      const path = pairToken ? `${secrets}/${pairToken}` : "";
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
  /** How the sign-in `id` signs in: its Connect opens a device code dialog rather than the vendor's page. */
  signInMode?: (id: string) => "redirect" | "device";
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
  /** A flow's state changed: the open boards refresh their setup state (the `setup` event). */
  onSetupChange?: () => void;
  fetchImpl?: typeof fetch;
}

export type SetupRoute = { method: string; path: RegExp; handle: (m: RegExpMatchArray, body: unknown, who: AccountSession, host: string) => Promise<unknown> };

const DISMISSED = "setup_dismissed";

export function setupFlowRoutes(d: SetupFlowDeps): { routes: SetupRoute[]; states: (module?: string) => Promise<{ module: string; title: string; done: boolean; dismissed: boolean }[]> } {
  const doFetch = d.fetchImpl ?? fetch;
  const changed = () => d.onSetupChange?.();
  /** Each module's last confirmed pairing state: a change (paired, or revoked) is announced to the open boards once. */
  const pairedBefore = new Map<string, boolean>();
  /** The last confirmed pairing as stored, so it still stands after a restart when the module cannot be asked. */
  const rememberedPairing = (module: string): boolean | undefined => {
    const v = d.store.meta(`setup_paired:${module}`);
    return v === "true" ? true : v === "false" ? false : undefined;
  };
  const notePairing = (module: string, paired: boolean) => {
    // Compare with what the last read or the stored value said (a restart empties the map): only a real change is announced.
    const before = pairedBefore.has(module) ? pairedBefore.get(module) : rememberedPairing(module);
    pairedBefore.set(module, paired);
    d.store.setMeta(`setup_paired:${module}`, String(paired));
    if (before !== undefined && before !== paired) changed();
  };
  /** What the board believes about a module's pairing: a read that failed says nothing, so the last confirmed state stands. */
  const confirmedPairing = (module: string, paired: boolean | undefined) => paired ?? pairedBefore.get(module) ?? rememberedPairing(module);
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
    // A module pairs once: on its basic flow, or on its advanced one.
    const url = f.pair_url ?? f.advanced?.pair_url;
    if (!url || !f.token) throw new AccountError(404, "this module has no pairing");
    // While a saved secret's service is being recreated, the fetch itself can fail. That is "not reachable yet", which the
    // page may wait out only when the save said the service is restarting; it is not a 502 application failure. A timeout is
    // its own answer: a mint it was still running may have made a code the board never saw, so the page must not retry it.
    const res = await doFetch(url, { method, headers: { authorization: `Bearer ${f.token}` }, signal: AbortSignal.timeout(PAIR_TIMEOUT_MS) }).catch((e: unknown) => {
      throw new AccountError((e as Error)?.name === "TimeoutError" ? 504 : 503, (e as Error)?.name === "TimeoutError" ? `${f.module} didn't answer in time` : `${f.module} isn't reachable yet`);
    });
    // The body is part of the answer: a response cut off mid-body (the module restarted while sending it) is a timeout too,
    // so the page neither reads it as an empty success nor retries it as a second mint.
    const data = (await res.json().catch((e: unknown) => {
      throw new AccountError((e as Error)?.name === "TimeoutError" ? 504 : 502, (e as Error)?.name === "TimeoutError" ? `${f.module} didn't answer in time` : `${f.module} sent a bad answer`);
    })) as Record<string, unknown>;
    // 409 is the module's conflict (for pairing, a token it does not have yet): keep it, so the page can decide whether a
    // reported restart makes it retryable. Every other refusal is the board's 502.
    if (!res.ok) throw new AccountError(res.status === 409 ? 409 : 502, String(data.error ?? `${f.module} answered ${res.status}`));
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
  /** The module's pairing as its endpoint reports it; undefined when it has no pairing or the read failed, which is never "unpaired". */
  const pairedOf = async (f: SetupFlowPoint & { token?: string }): Promise<boolean | undefined> => {
    if (!(f.pair_url ?? f.advanced?.pair_url)) return true;
    const r = (await pairCall(f, "GET").catch(() => null)) as { paired?: unknown } | null;
    // Only an explicit boolean is an answer; a 200 with a missing or malformed body says nothing about pairing.
    return typeof r?.paired === "boolean" ? r.paired : undefined;
  };

  /** The one completion rule, the setup page's: a connection's real state when the flow has one (sign-in, connect path or pairing), else its secrets (`present`, unknown without a session: not done). */
  const flowDone = (f: SetupFlowPoint, signedIn: boolean, paired: boolean | undefined, present: Record<string, boolean> = {}) =>
    f.signin || f.connect_url || f.pair_url ? signedIn && (f.pair_url ? paired === true : true) : (f.secrets ?? []).every((x) => present[x]);
  const signedInOf = async (f: SetupFlowPoint, connected?: boolean) => (f.signin ? await d.signedIn(f.signin) : f.connect_url ? connected === true : true);
  /** Each flow's done and dismissed state as the setup page counts it: the owner MCP's `status` lists the open ones, `connect` marks the done ones. */
  const states = async (module?: string) => {
    const gone = new Set(dismissed());
    return Promise.all(
      d.flows
        .filter((f) => !module || f.module === module)
        .map(async (f) => {
          const paired = await pairedOf(f);
          // A confirmed read is remembered here too, so a later failed read falls back to it rather than to an older state.
          if (paired !== undefined) notePairing(f.module, paired);
          return { module: f.module, title: f.title, done: flowDone(f, await signedInOf(f, f.connect_url ? await d.connected(f.connect_url) : undefined), confirmedPairing(f.module, paired)), dismissed: gone.has(f.module) };
        }),
    );
  };

  const routes: SetupRoute[] = [
    {
      method: "GET",
      path: /^\/api\/setup-flows$/,
      handle: async (_m, _b, who, host) => {
        const gone = new Set(dismissed());
        const flows = await Promise.all(
          d.flows.map(async ({ token: _t, pair_token: _p, connect_url, advanced, ...f }) => {
            const full = d.flows.find((x) => x.module === f.module)!;
            const present = f.secrets?.length || advanced?.secrets?.length ? (await d.accounts.call<{ secrets: Record<string, boolean> }>("setup_status", who, { module: f.module })).secrets : {};
            // A connect path counts only if the board serves it; then its connection's state is the sign-in's.
            const connected = connect_url ? await d.connected(connect_url) : undefined;
            const signedIn = await signedInOf(full, connected);
            const paired = await pairedOf(full);
            // A pairing completed while no setup page was open is seen here, by whichever board reads the flows next.
            if (paired !== undefined) notePairing(f.module, paired);
            // A read that failed is no answer: keep what the last confirmed read said rather than reporting it unpaired.
            const pairing = confirmedPairing(f.module, paired);
            // Basic is done once it is connected (and paired, when the basic flow pairs); advanced once its secrets exist (and paired).
            const scopes = f.signin ? await d.scopeChoice(f.signin) : false;
            // A connection's real state decides when it has one (an upgraded instance keeps values outside the vault and works);
            // only a flow with no sign-in, connect path or pairing is done by its secrets.
            const done = flowDone(full, signedIn, pairing, present);
            const adv = advanced && (({ pair_token: _a, ...a }) => ({ ...a, done: (a.secrets ?? []).every((s) => present[s]) && (a.pair_url ? pairing === true : true) }))(advanced);
            const redirect_url = f.signin ? d.redirectUrl(f.signin, host) : undefined;
            const choose = full.choose ? { choose: chooseView(full.choose, f.module) } : {};
            const signinMode = f.signin && d.signInMode?.(f.signin) === "device" ? { signin_mode: "device" as const } : {};
            // How long the wait has left, not when it ends: the page counts it down on its own clock, which need not agree with the board's.
            const restarting_for = Number(d.store.meta(RESTARTING(f.module)) ?? 0) - Date.now();
            return { ...f, ...choose, ...signinMode, ...(adv ? { advanced: adv } : {}), ...(connected !== undefined ? { connect_url } : {}), ...(redirect_url ? { redirect_url } : {}), present, signedIn, scopes, paired: pairing === true, done, dismissed: gone.has(f.module), ...(restarting_for > 0 ? { restarting: true, restarting_for } : {}) };
          }),
        );
        const boardUrl = d.boardUrl(host);
        return { flows, board_url: boardUrl };
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
        if (!f.secrets?.includes(secret) && !f.advanced?.secrets?.includes(secret)) throw new AccountError(400, "not one of this flow's secrets");
        const saved = await d.accounts.call<{ ok: boolean; restarted?: string[] }>("save_secret", who, { module: f.module, secret, value });
        // The kernel recreates those services after answering; remember it briefly, so the page (and a reload) can wait for
        // them instead of treating the module's own "not ready" answer as a failure. Saves go out together (one POST per
        // field), so a save that restarts nothing must not clear a marker another save just set: only an expired one goes.
        const until = Number(d.store.meta(RESTARTING(f.module)) ?? 0);
        if (saved.restarted?.length) d.store.setMeta(RESTARTING(f.module), String(Date.now() + RESTART_MS));
        else if (until <= Date.now()) d.store.delMeta(RESTARTING(f.module));
        const restarting_for = Number(d.store.meta(RESTARTING(f.module)) ?? 0) - Date.now();
        // A flow's next step changed with the saved secret: the open boards refresh their setup state.
        changed();
        return { ...saved, ...(restarting_for > 0 ? { restarting_for } : {}) };
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
        changed();
        return { ok: true, ...(filed ? { identifier: filed.identifier } : {}) };
      },
    },
    {
      method: "POST",
      path: /^\/api\/setup-flows\/([a-z0-9-]{1,63})\/dismiss$/,
      handle: async (m) => {
        const f = flow(m[1]!);
        d.store.setMeta(DISMISSED, JSON.stringify([...new Set([...dismissed(), f.module])]));
        changed();
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
        const f = flow(m[1]!);
        // A save that lands while this request is out set the marker after the module answered: that restart is not over.
        const before = Number(d.store.meta(RESTARTING(f.module)) ?? 0);
        const { code, link, expires_in } = (await pairCall(f, "POST")) as { code?: string; link?: string; expires_in?: number };
        // How many seconds the code lives, as the channel keeps it: the page times its screen by this, not by a copy or a clock.
        const ttl = typeof expires_in === "number" && expires_in > 0 ? Math.round(expires_in) : PAIR_CODE_TTL_S;
        // Paired: the restart this marker was waiting out is over, so it must not turn a later 409 into a five-minute wait. Only
        // the marker this call found goes, never one a concurrent save set meanwhile.
        if (Number(d.store.meta(RESTARTING(f.module)) ?? 0) === before) d.store.delMeta(RESTARTING(f.module));
        return { code, ...(link ? { link } : {}), minted_at, expires_in: ttl };
      },
    },
    {
      method: "GET",
      path: /^\/api\/setup-flows\/([a-z0-9-]{1,63})\/pair$/,
      handle: async (m) => {
        const f = flow(m[1]!);
        const before = Number(d.store.meta(RESTARTING(f.module)) ?? 0);
        const { paired, paired_at } = await pairCall(f, "GET");
        const known = typeof paired === "boolean" ? paired : undefined;
        if (known && Number(d.store.meta(RESTARTING(f.module)) ?? 0) === before) d.store.delMeta(RESTARTING(f.module));
        // The setup page learns a code was sent by polling here; any change (paired or revoked) tells the other open boards.
        if (known !== undefined) notePairing(m[1]!, known);
        return { paired: known ?? confirmedPairing(m[1]!, undefined) ?? false, ...(paired_at != null ? { paired_at } : {}) };
      },
    },
  ];
  return { routes: routes.map((r) => ({ ...r, handle: async (m, b, who, host) => (ready(who), r.handle(m, b, who, host)) })), states };
}
