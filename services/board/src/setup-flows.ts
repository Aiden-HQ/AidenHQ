// Module setup flows (board.setup_flows, compiled into the points file): the board renders each at #/setup/<module>. Secrets are
// saved by the kernel (account ops save_secret and setup_status, as the signed-in admin); pairing is the module service's own
// endpoint, reached with the module's pair token (read from the vault by name, never sent to the browser).
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { AccountError, type AccountSession, type KernelAuth } from "./kernel-auth.js";
import { appliedKey } from "./organisations.js";
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
  steps: string;
  /** The scopes `{scopes}` in the steps stands for. */
  console_scopes?: string[];
  /** Alternative ways to get the paste fields' values: the page shows the picked one's steps (modules/board/schemas/setup_flows.json). */
  ways?: { id: string; title: string; detail: string; effort?: string; steps?: string; organisation?: boolean; paste?: boolean; domains?: string[] }[];
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
  /** With an advanced flow: the basic option's short name, and what it gives, on the page's two option cards. */
  label?: string;
  capabilities?: string[];
  /** The module makes or updates the vendor app from a pasted short-lived token (never stored), on its service that pairs. */
  app?: AppSpec;
}

export interface AppSpec {
  url: string;
  label: string;
  pattern: string;
  help: string;
  console_url?: string;
}

/** What the module says of the app it made or updated last (GET on `app.url`). */
export interface AppStatus {
  app_id: string | null;
  part: "basic" | "advanced" | null;
  current: boolean;
  url: string | null;
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
  signInMode?: (id: string) => "redirect" | "device" | "qr";
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
  /** The secrets of `module` an organisation's app supplies now: an app the module makes replaces them only when asked (`own`). */
  orgSecrets?: (module: string) => string[];
  /** A flow's state changed: the open boards refresh their setup state (the `setup` event). */
  onSetupChange?: () => void;
  fetchImpl?: typeof fetch;
}

export type SetupRoute = { method: string; path: RegExp; handle: (m: RegExpMatchArray, body: unknown, who: AccountSession, host: string) => Promise<unknown> };

const DISMISSED = "setup_dismissed";

export function setupFlowRoutes(d: SetupFlowDeps): { routes: SetupRoute[]; states: (module?: string) => Promise<{ module: string; title: string; done: boolean; dismissed: boolean }[]> } {
  const doFetch = d.fetchImpl ?? fetch;
  const changed = () => d.onSetupChange?.();
  /** A pairing read's answer: the module's `paired` and the time it reports, both from that one answer. */
  type Pairing = { paired: boolean; paired_at?: string | number };
  /** Each module's last confirmed pairing: what the board shows, and what a real change is measured against. */
  const observed = new Map<string, Pairing>();
  /** Each module's pairing reads: the one out, and the one waiting behind it. */
  const reads = new Map<string, { running?: Promise<Pairing | undefined>; more?: Promise<Pairing | undefined> }>();
  /** The last confirmed pairing as stored, so it still stands after a restart when the module cannot be asked. */
  const rememberedPairing = (module: string): boolean | undefined => {
    const v = d.store.meta(`setup_paired:${module}`);
    return v === "true" ? true : v === "false" ? false : undefined;
  };
  /** What the board shows for a module: the accepted read's own answer (state and time together), else the stored one. */
  const confirmedPairing = (module: string): Pairing | undefined => {
    const last = observed.get(module);
    if (last) return last;
    const stored = rememberedPairing(module);
    return stored === undefined ? undefined : { paired: stored };
  };
  /**
   * Records a confirmed pairing read, the state and its time together. A real change is announced once, and so is a module's
   * first-ever confirmation (nothing known before it and now paired); a read that matches the stored state after a restart
   * stays quiet.
   */
  const notePairing = (module: string, read: Pairing): Pairing => {
    // Compare with what the last read or the stored value said (a restart empties the map): only a real change is announced.
    const before = observed.has(module) ? observed.get(module)!.paired : rememberedPairing(module);
    observed.set(module, read);
    d.store.setMeta(`setup_paired:${module}`, String(read.paired));
    if (before === undefined ? read.paired : before !== read.paired) changed();
    return read;
  };
  /**
   * Reads the module's pairing once, recorded as it lands. Reads for a module never overlap: one is out and at most one waits
   * behind it, and a caller arriving meanwhile shares one of those rather than stacking another. So an answer is never older
   * than one already recorded (a read that began earlier can be the one that saw a pairing land), and a slow module does not
   * pile up polls behind it. Throws what the module's read throws (404, 502, 503, 504); undefined is an answer that says
   * nothing about pairing.
   */
  const readPairing = (f: SetupFlowPoint & { token?: string }): Promise<Pairing | undefined> => {
    const start = async (): Promise<Pairing | undefined> => {
      const r = (await pairCall(f, "GET")) as Record<string, unknown> & { paired?: unknown };
      // Only an explicit boolean is an answer; a 200 with a missing or malformed body says nothing about pairing.
      if (typeof r?.paired !== "boolean") return undefined;
      // The time is this answer's own, so a state never ships another answer's time.
      return notePairing(f.module, { paired: r.paired, ...(r.paired_at != null ? { paired_at: r.paired_at as string | number } : {}) });
    };
    const st = reads.get(f.module) ?? {};
    reads.set(f.module, st);
    const settle = (which: "running" | "more", run: Promise<Pairing | undefined>) => {
      const done = () => {
        if (st[which] === run) delete st[which];
        if (!st.running && !st.more) reads.delete(f.module);
      };
      void run.then(done, done);
    };
    // A read already out, or one already waiting behind it: share it.
    if (st.more) return st.more;
    if (st.running) {
      const more = st.running.then(start, start);
      st.more = more;
      settle("more", more);
      return more;
    }
    const run = start();
    st.running = run;
    settle("running", run);
    return run;
  };
  /** The module's pairing as its endpoint reports it; a flow with no pairing is done, and a failed read is never "unpaired". */
  const pairedOf = async (f: SetupFlowPoint & { token?: string }): Promise<Pairing | undefined> => {
    if (!(f.pair_url ?? f.advanced?.pair_url)) return { paired: true };
    return readPairing(f).catch(() => undefined);
  };
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
  /** The module's app endpoint, with the pair token; its refusal's words are the owner's to read. */
  const appCall = async (f: SetupFlowPoint & { token?: string }, body?: unknown): Promise<Record<string, unknown>> => {
    if (!f.app || !f.token) throw new AccountError(404, "this module makes no app");
    const res = await doFetch(f.app.url, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${f.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(body ? 45_000 : 5_000),
    }).catch((e: unknown) => {
      throw new AccountError((e as Error)?.name === "TimeoutError" ? 504 : 503, (e as Error)?.name === "TimeoutError" ? `${f.module} didn't answer in time` : `${f.module} isn't reachable yet`);
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new AccountError(res.status === 400 || res.status === 504 ? res.status : 502, String(data.error ?? `${f.module} answered ${res.status}`).slice(0, 400));
    return data;
  };
  const appStatusOf = async (f: SetupFlowPoint & { token?: string }): Promise<AppStatus | undefined> => {
    if (!f.app || !f.token) return undefined;
    const r = await appCall(f).catch(() => undefined);
    return r && { app_id: typeof r.app_id === "string" ? r.app_id : null, part: r.part === "basic" || r.part === "advanced" ? r.part : null, current: r.current === true, url: typeof r.url === "string" && r.url.startsWith("https://") ? r.url : null };
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
          // A confirmed read is recorded as it lands (readPairing); a failed one keeps the last confirmed state rather than
          // reporting the flow as unpaired.
          const pairing = await pairedOf(f);
          const shown = pairing ?? confirmedPairing(f.module);
          return { module: f.module, title: f.title, done: flowDone(f, await signedInOf(f, f.connect_url ? await d.connected(f.connect_url) : undefined), shown?.paired), dismissed: gone.has(f.module) };
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
          d.flows.map(async ({ token: _t, pair_token: _p, connect_url, advanced, app: appSpec, ...f }) => {
            const full = d.flows.find((x) => x.module === f.module)!;
            const present = f.secrets?.length || advanced?.secrets?.length ? (await d.accounts.call<{ secrets: Record<string, boolean> }>("setup_status", who, { module: f.module })).secrets : {};
            // A connect path counts only if the board serves it; then its connection's state is the sign-in's.
            const connected = connect_url ? await d.connected(connect_url) : undefined;
            const signedIn = await signedInOf(full, connected);
            // A pairing completed while no setup page was open is seen here, by whichever board reads the flows next; a read
            // that failed is no answer, so the last confirmed state stands rather than the flow reading as unpaired.
            const pairing = (await pairedOf(full)) ?? confirmedPairing(f.module);
            // Basic is done once it is connected (and paired, when the basic flow pairs); advanced once its secrets exist (and paired).
            const scopes = f.signin ? await d.scopeChoice(f.signin) : false;
            // A connection's real state decides when it has one (an upgraded instance keeps values outside the vault and works);
            // only a flow with no sign-in, connect path or pairing is done by its secrets.
            const done = flowDone(full, signedIn, pairing?.paired, present);
            const adv = advanced && (({ pair_token: _a, ...a }) => ({ ...a, done: (a.secrets ?? []).every((s) => present[s]) && (a.pair_url ? pairing?.paired === true : true) }))(advanced);
            const redirect_url = f.signin ? d.redirectUrl(f.signin, host) : undefined;
            const choose = full.choose ? { choose: chooseView(full.choose, f.module) } : {};
            const app = appSpec ? { app: { label: appSpec.label, pattern: appSpec.pattern, help: appSpec.help, ...(appSpec.console_url ? { console_url: appSpec.console_url } : {}), status: (await appStatusOf(full)) ?? null, org_secrets: (d.orgSecrets?.(f.module) ?? []).filter((x) => [...(f.secrets ?? []), ...(advanced?.secrets ?? [])].includes(x)) } } : {};
            const mode = f.signin ? d.signInMode?.(f.signin) : undefined;
            const signinMode = mode === "device" || mode === "qr" ? { signin_mode: mode } : {};
            // How long the wait has left, not when it ends: the page counts it down on its own clock, which need not agree with the board's.
            const restarting_for = Number(d.store.meta(RESTARTING(f.module)) ?? 0) - Date.now();
            return { ...f, ...choose, ...app, ...signinMode, ...(adv ? { advanced: adv } : {}), ...(connected !== undefined ? { connect_url } : {}), ...(redirect_url ? { redirect_url } : {}), present, signedIn, scopes, paired: pairing?.paired === true, done, dismissed: gone.has(f.module), ...(restarting_for > 0 ? { restarting: true, restarting_for } : {}) };
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
        // A pasted client is the owner's own, not an organisation's; a bot token beside the organisation's sign-in changes nothing.
        if (!d.orgSecrets || d.orgSecrets(f.module).includes(secret)) d.store.delMeta(appliedKey(f.module));
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
      // The module makes or updates its vendor app from the owner's pasted token (sent on, never kept or logged here), and the
      // public values a new app has are saved as this flow's own fields: only those, and never one the chosen organisation supplies.
      method: "POST",
      path: /^\/api\/setup-flows\/([a-z0-9-]{1,63})\/app$/,
      handle: async (m, body, who) => {
        if (!who.account.owner) throw new AccountError(403, "only the owner can make the app");
        const f = flow(m[1]!);
        if (!f.app) throw new AccountError(404, "this module makes no app");
        // `own`: the owner's own app replaces the organisation's sign-in client (a bot beside it never does).
        const parsed = z.object({ token: z.string().min(1).max(600), part: z.enum(["basic", "advanced"]), app_id: z.string().max(40).optional(), own: z.boolean().optional() }).strict().safeParse(body);
        if (!parsed.success) throw new AccountError(400, "a token and an option are required");
        if (!new RegExp(f.app.pattern).test(parsed.data.token.trim())) throw new AccountError(400, `That doesn't look like an ${f.app.label}.`);
        const { own, ...sent } = parsed.data;
        const r = await appCall(f, { ...sent, token: sent.token.trim() });
        // Only the basic flow's fields: a new app's public client. Never a token of the advanced part, whatever the module says.
        const fields = f.fields ?? [];
        const supplied = new Set(own ? [] : (d.orgSecrets?.(f.module) ?? []));
        const saved: string[] = [];
        let restarting = false;
        for (const [secret, value] of Object.entries((r.secrets ?? {}) as Record<string, unknown>)) {
          const field = fields.find((x) => x.secret === secret);
          if (!field || supplied.has(secret) || typeof value !== "string" || !new RegExp(field.pattern).test(value)) continue;
          const out = await d.accounts.call<{ ok: boolean; restarted?: string[] }>("save_secret", who, { module: f.module, secret, value });
          restarting ||= Boolean(out.restarted?.length);
          saved.push(secret);
          d.store.delMeta(appliedKey(f.module)); // the client is the owner's own app now, not an organisation's
        }
        if (restarting) d.store.setMeta(RESTARTING(f.module), String(Date.now() + RESTART_MS));
        changed();
        return { status: await appStatusOf(f), saved };
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
        // A save that lands while this read is out set the marker after the module answered: that restart is not over.
        const before = Number(d.store.meta(RESTARTING(f.module)) ?? 0);
        // The setup page learns a code was sent by polling here; any change (paired or revoked) tells the other open boards. A
        // read that fails is the module's own answer (503, 504), as it always was.
        const read = await readPairing(f);
        // Paired: an accepted answer says the restart is over, so a later 409 is a real conflict. A read that failed, said
        // nothing, or said "not yet" leaves the marker for the next one, and never clears one a concurrent save set meanwhile.
        if (read?.paired && Number(d.store.meta(RESTARTING(f.module)) ?? 0) === before) d.store.delMeta(RESTARTING(f.module));
        // An answer that says nothing keeps the last confirmed state; the state and its time are one answer's, never mixed.
        const pairing = read ?? confirmedPairing(f.module);
        return { paired: pairing?.paired ?? false, ...(pairing?.paired_at != null ? { paired_at: pairing.paired_at } : {}) };
      },
    },
  ];
  return { routes: routes.map((r) => ({ ...r, handle: async (m, b, who, host) => (ready(who), r.handle(m, b, who, host)) })), states };
}
