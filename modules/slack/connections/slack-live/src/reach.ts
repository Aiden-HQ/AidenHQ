// Agent reach (docs/superpowers/specs/2026-11-28-agent-reach-design.md): people reach an agent through the instance's bot (the
// default: map.ts classifies the message, `to_agent`) or through a dedicated Slack app of the agent's own, which this file runs:
// one installation record per app (installs.ts), one Socket Mode worker per record, each with its own socket, token and health.
//
// The tokens are a named-secret map (`slack_agent_apps`: agent key -> { app_token, bot_token }) read from its file on every pass,
// the agents are the setting `slack_agent_apps` (a list of `{ agent }`). A pass stops what the lists no longer hold, and a pair
// that changed stops its old worker BEFORE the new one starts (two consumers on one app split its events). A pair is checked first:
// the right app for both tokens, the instance's workspace, and not an app already in use (the instance's, or another agent's).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Logger } from "pino";
import { installs, type Installs } from "./installs.js";
import { toSourceEvent, type Route, type SourceEvent, type Target } from "./map.js";
import { carriesCode } from "./pair.js";
import { listen, type Listener } from "./socket.js";
import type { Store } from "./store.js";

const AGENT = /^[a-z][a-z0-9-]{0,63}$/;
const APP_TOKEN = /^xapp-[A-Za-z0-9-]{20,300}$/;
const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{20,300}$/;
export const APP_ENTRY = "slack:app:";
export type Pair = { app_token?: string; bot_token?: string };
export type AppState = { agent: string; state: "connected" | "disconnected" | "needs_tokens" | "invalid"; app_id?: string; detail?: string };

/** An app-level token (`xapp-1-<app id>-…`) names its own app. */
export const appIdOf = (appToken: string): string | undefined => /^xapp-\d+-([A-Z0-9]{6,20})-/.exec(appToken)?.[1];
const fingerprint = (p: { app_token: string; bot_token: string }) => createHash("sha256").update(`${p.app_token}\n${p.bot_token}`).digest("hex").slice(0, 16);

export type Slack = (method: string, token: string, params?: Record<string, string>) => Promise<Record<string, any>>;
/** Slack's Web API with a bot token: a refusal is a throw carrying Slack's error code. */
export const slackWeb = (fetchFn: typeof fetch = fetch): Slack => async (method, token, params = {}) => {
  const res = await fetchFn(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(15_000) });
  const r = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!r.ok) throw new Error(String(r.error ?? `slack ${method}: ${res.status}`));
  return r;
};

/** The instance bot's own identity (its user id, its workspace), asked once from Slack and kept. */
export function identity(botToken: string, slack: Slack = slackWeb()) {
  let known: { user?: string; team?: string } = {};
  return {
    get user() { return known.user; },
    get team() { return known.team; },
    /** Asks Slack when it isn't known yet; a failure is left for the next call. */
    async load(): Promise<void> {
      if (!botToken || known.user) return;
      const r = await slack("auth.test", botToken);
      known = { user: String(r.user_id ?? ""), team: String(r.team_id ?? "") };
    },
  };
}

/** The sender's display name (the event's `author_name`), by the bot's own token; the first lookup is kept. A missing scope or a lookup that fails names nobody. */
export function namer(slack: Slack = slackWeb()) {
  const names = new Map<string, string>();
  return async (token: string | undefined, user: string | undefined): Promise<string | undefined> => {
    if (!token || !user) return undefined;
    if (!names.has(user)) {
      const u = await slack("users.info", token, { user }).then((r) => r.user as { name?: string; real_name?: string; profile?: { display_name?: string } } | undefined, () => undefined);
      const name = u?.profile?.display_name || u?.real_name || u?.name;
      if (!name) return undefined;
      names.set(user, name.slice(0, 80));
    }
    return names.get(user);
  };
}

/**
 * One addressed message is one event: Slack sends its `message` and its `app_mention` as two envelopes (and a gap replay may find
 * it again), all classified the same (map.ts) and sharing the id. `begin` is true for the first, false while that one is in flight or
 * once it was taken; `done` marks it taken (durably, so a restart doesn't repeat it); `abandon` frees it after a failure.
 */
export function once(store: Pick<Store, "getKv" | "setKv">) {
  const flying = new Set<string>();
  return {
    begin(id: string): boolean {
      if (flying.has(id) || store.getKv(`reach_seen:${id}`)) return false;
      flying.add(id);
      return true;
    },
    done(id: string): void {
      store.setKv(`reach_seen:${id}`, "1");
      flying.delete(id);
    },
    abandon: (id: string): void => void flying.delete(id),
  };
}

interface Worker { agent: string; app_id: string; fp: string; bot_token: string; bot_user: string; listener: Listener; state: "connected" | "disconnected" }

export interface ReachOptions {
  store: Store;
  log: Pick<Logger, "info" | "warn" | "error">;
  /** The agents with a dedicated app (the setting `slack_agent_apps`). */
  agents: () => string[];
  /** The token map (the secret `slack_agent_apps`); {} while it is empty or unreadable. */
  tokens: () => Record<string, Pair>;
  /** The instance's own app: its app id (from its app token) and its bot's identity, for the workspace and duplicate checks. */
  instance: { app_id?: string | undefined; identity: ReturnType<typeof identity> };
  /** The owner's Slack user id (the pairing): the same person owns every app, so a dedicated app needs no pairing of its own. */
  owner: () => string | undefined;
  /** The one forward every entry point shares (main.ts): dedupe, naming, attestation, the kernel. Throws when the kernel didn't take it. */
  forward: (e: SourceEvent) => Promise<void>;
  slack?: Slack;
  listen?: typeof listen;
}

export function reach(o: ReachOptions) {
  const records: Installs = installs(o.store);
  const slack = o.slack ?? slackWeb();
  const open = o.listen ?? listen;
  const workers = new Map<string, Worker>();
  const problems = new Map<string, { fp: string; detail: string; until: number }>();
  let busy = false;

  /** Every bot of ours by user id, for a mention in any app's socket (map.ts Route.bots). */
  const bots = (): Record<string, Target> => Object.fromEntries([...workers.values()].map((w) => [w.bot_user, { to: w.agent, entry: `${APP_ENTRY}${w.app_id}` }]));

  async function check(agent: string, p: { app_token: string; bot_token: string }): Promise<{ app_id: string; team_id: string; bot_user: string }> {
    const app_id = appIdOf(p.app_token);
    if (!app_id) throw new Error("the app-level token isn't an app's (xapp-1-<app id>-…)");
    if (app_id === o.instance.app_id) throw new Error("that is the instance's own Slack app: an agent needs an app of its own");
    const auth = await slack("auth.test", p.bot_token).catch((e: Error) => { throw new Error(`Slack didn't accept the bot token (${e.message})`); });
    const team_id = String(auth.team_id ?? ""), bot_user = String(auth.user_id ?? "");
    // Both tokens must be one app. bots.info needs users:read: an app without it can't be checked, which is no proof of a mismatch.
    const bot = await slack("bots.info", p.bot_token, { bot: String(auth.bot_id ?? "") }).then((r) => r.bot as { app_id?: string } | undefined, (e: Error) => { if (!/missing_scope/.test(e.message)) throw e; return undefined; });
    if (bot?.app_id && bot.app_id !== app_id) throw new Error("the bot token and the app-level token are from different apps");
    await o.instance.identity.load().catch(() => undefined);
    if (o.instance.identity.team && team_id !== o.instance.identity.team) throw new Error("that app is installed in another Slack workspace than the instance's bot");
    if (bot_user === o.instance.identity.user) throw new Error("that bot is the instance's own bot");
    const clash = [...workers.values()].find((w) => w.agent !== agent && (w.app_id === app_id || w.bot_user === bot_user));
    if (clash) throw new Error(`that app is already ${clash.agent}'s`);
    return { app_id, team_id, bot_user };
  }

  function start(agent: string, v: { app_id: string; team_id: string; bot_user: string }, p: { app_token: string; bot_token: string }, fp: string): Worker {
    const entry = `${APP_ENTRY}${v.app_id}`;
    const receiver: Target = { to: agent, entry };
    const w: Worker = { agent, app_id: v.app_id, fp, bot_token: p.bot_token, bot_user: v.bot_user, state: "disconnected", listener: undefined as never };
    w.listener = open({
      appToken: p.app_token,
      log: o.log as Logger,
      onState: (s) => void (w.state = s),
      onEvent: async (msg) => {
        const ack = () => msg.ack().catch(() => undefined);
        const body = msg.body as { event?: Record<string, unknown>; authorizations?: { is_bot?: boolean }[] } | null;
        // Only what this app's bot was sent: a user-token envelope of the same app is the instance's stream, never this agent's.
        if (msg.type !== "events_api" || !body?.authorizations?.some((a) => a?.is_bot === true) || carriesCode(body.event as never)) return void (await ack());
        const route: Route = { receiver, bots: { ...bots(), [v.bot_user]: receiver } };
        const e = toSourceEvent(body, o.owner(), route);
        if (!e?.to_agent || e.entry !== entry) return void (await ack());
        try {
          await o.forward(e);
        } catch (err) {
          o.log.error({ agent, err: String(err) }, "agent app event not taken; not acking so Slack redelivers");
          return;
        }
        await ack();
      },
    });
    workers.set(agent, w);
    return w;
  }

  /** One pass: stop what is gone or rotated, then check and start what has a pair and no worker. */
  async function reconcile(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const want = [...new Set(o.agents().filter((a) => AGENT.test(a)))];
      const map = o.tokens();
      for (const w of [...workers.values()]) {
        const p = map[w.agent];
        const same = want.includes(w.agent) && APP_TOKEN.test(p?.app_token ?? "") && BOT_TOKEN.test(p?.bot_token ?? "") && fingerprint(p as { app_token: string; bot_token: string }) === w.fp;
        if (same) continue;
        // Rotation, removal: the old consumer is down before anything new starts.
        await w.listener.stop();
        workers.delete(w.agent);
        if (!want.includes(w.agent)) records.del(w.app_id);
      }
      for (const agent of want) {
        const p = map[agent];
        if (workers.has(agent) || !p?.app_token || !p.bot_token || !APP_TOKEN.test(p.app_token) || !BOT_TOKEN.test(p.bot_token)) continue;
        const pair = { app_token: p.app_token, bot_token: p.bot_token };
        const fp = fingerprint(pair);
        const bad = problems.get(agent);
        if (bad?.fp === fp && bad.until > Date.now()) continue;
        try {
          const v = await check(agent, pair);
          // The agent's earlier app (a rotation to another app) is no longer its installation.
          const before = records.ofAgent(agent);
          if (before && before.app_id !== v.app_id) records.del(before.app_id);
          records.put(v.app_id, { agent, team_id: v.team_id, bot_user: v.bot_user, fp, part: records.get(v.app_id)?.part ?? "advanced" });
          start(agent, v, pair, fp);
          problems.delete(agent);
          o.log.info({ agent, app_id: v.app_id }, "agent app started");
        } catch (err) {
          const detail = String((err as Error).message).slice(0, 200);
          problems.set(agent, { fp, detail, until: Date.now() + 300_000 });
          o.log.warn({ agent, detail }, "agent app not started");
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    reconcile,
    bots,
    /** The bot token an entry's replies, reads and reactions use (a running, checked app's), else none. */
    token: (entry: string): string | undefined => (entry.startsWith(APP_ENTRY) ? [...workers.values()].find((w) => `${APP_ENTRY}${w.app_id}` === entry)?.bot_token : undefined),
    /** The board's list, derived from the records and the workers: one row per agent that has a dedicated app. */
    status(): AppState[] {
      const map = o.tokens();
      return [...new Set(o.agents().filter((a) => AGENT.test(a)))].map((agent): AppState => {
        const w = workers.get(agent);
        if (w) return { agent, state: w.state, app_id: w.app_id };
        const bad = problems.get(agent);
        const made = records.ofAgent(agent);
        if (bad) return { agent, state: "invalid", detail: bad.detail, ...(made ? { app_id: made.app_id } : {}) };
        return { agent, state: map[agent]?.app_token && map[agent]?.bot_token ? "disconnected" : "needs_tokens", ...(made ? { app_id: made.app_id } : {}) };
      });
    },
    /** Runs a pass now and then on a timer; a pass never throws. */
    run(everyMs = 30_000): void {
      const pass = () => void reconcile().catch((err: unknown) => o.log.error({ err: String(err) }, "agent apps pass failed"));
      pass();
      setInterval(pass, everyMs).unref();
    },
    async stop(): Promise<void> {
      for (const w of workers.values()) await w.listener.stop();
      workers.clear();
    },
  };
}

/** The token map as the secret file holds it: `{ <agent>: { app_token, bot_token } }`, {} when absent or not that shape. */
export function readTokens(path: string | undefined): Record<string, Pair> {
  if (!path) return {};
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, Pair>) : {};
  } catch {
    return {};
  }
}
