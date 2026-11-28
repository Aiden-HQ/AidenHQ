// The Slack app, made or updated by Slack's API from the owner's pasted App Configuration Token (the board's Slack setup page,
// through its /setup/app route with the module's pair token). The token is used for the one call and dropped: never stored,
// logged or answered. The app's id and which manifest it got are kept (not secret), so the page knows what to offer next.
// Install stays on the app's own page in Slack: an OAuth install of the bot can't return to every board (see
// slack-app-manifest.yml), and no Slack API makes the app-level token (xapp-).
import { createHash } from "node:crypto";
import { installs } from "./installs.js";
import manifests from "./manifests.json" with { type: "json" };
import type { Store } from "./store.js";

export type Part = "basic" | "advanced";
export const MANIFESTS: Record<Part, unknown> = manifests;
const hash = (m: unknown) => createHash("sha256").update(JSON.stringify(m)).digest("hex").slice(0, 16);

const isMap = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Slack's limits on the two names a create gives the app: the bot display name builds the @handle (cut to 21), the app name is at most 35. */
export const BOT_NAME_MAX = 21;
export const APP_NAME_MAX = 35;

/**
 * The instance's slug for a Slack app's name: lowercased, anything outside `a-z0-9-` becomes `-`, no leading or trailing `-`.
 * `instance_name` (a DNS label) is preferred; `owner_name` (always set) is the fallback.
 */
export function slugOf(name: string | undefined): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Whether the app already has a bot user: its @handle is fixed from the first install, so its name is never set again. */
export function hasBotUser(manifest: unknown): boolean {
  return isMap(manifest) && isMap(manifest.features) && isMap(manifest.features.bot_user);
}

/** Our manifest without the bot's display name, for an app that has a bot already: its label (like its name) stays the owner's. */
function withoutBotName(manifest: unknown): unknown {
  if (!isMap(manifest) || !isMap(manifest.features) || !isMap(manifest.features.bot_user)) return manifest;
  const { display_name: _kept, ...botUser } = manifest.features.bot_user;
  return { ...manifest, features: { ...manifest.features, bot_user: botUser } };
}

/**
 * The bot display name, which Slack builds the @handle from (21 at most). A slug that fits is used whole
 * (`aidenhq-acme`); a longer one keeps its head and adds a short hash of the whole slug, so two instances whose names share a
 * long head (`acme-finance-eu` and `acme-finance-us`) still ask for different handles — a plain cut would make them equal.
 */
export function botName(slug: string): string {
  const full = `aidenhq-${slug}`.replace(/[-_.]+$/, "");
  if (full.length <= BOT_NAME_MAX) return full;
  const room = BOT_NAME_MAX - "aidenhq-".length - "-".length - 4;
  const head = slug.slice(0, room).replace(/[-_.]+$/, "");
  return `aidenhq-${head}-${createHash("sha256").update(slug).digest("hex").slice(0, 4)}`;
}

/**
 * The manifest for an app's first bot install: ours with the instance's own names, so several AidenHQ bots in one workspace
 * don't all want `@AidenHQ` (Slack fixes the @handle at that first install; renaming later changes only the label). The update
 * path keeps the app's own display_information and an existing bot, and Slack won't change a handle after install, so a name is
 * set only here.
 */
export function named(manifest: unknown, slug: string): unknown {
  if (!isMap(manifest)) return manifest;
  // A name with no a-z0-9 left (an owner name in another script, no instance name) keeps the manifest's own labels.
  if (!slug) return manifest;
  // Cut the slug, not the finished name, and drop a separator the cut left at the end: `AidenHQ (<slug>)` keeps its closing
  // parenthesis.
  const appSlug = slug.slice(0, APP_NAME_MAX - "AidenHQ ()".length).replace(/-+$/, "");
  const app = `AidenHQ (${appSlug})`;
  const bot = botName(slug);
  return {
    ...manifest,
    display_information: isMap(manifest.display_information) ? { ...manifest.display_information, name: app } : { name: app },
    features: isMap(manifest.features) ? { ...manifest.features, bot_user: isMap(manifest.features.bot_user) ? { ...manifest.features.bot_user, display_name: bot } : manifest.features.bot_user } : manifest.features,
  };
}

/**
 * The manifest of an agent's dedicated app: the advanced one without what only the instance's app uses (the owner's user token
 * and events, the `/aiden` command, the PKCE sign-in). It listens for the bot's DMs and mentions and answers as itself.
 */
export function agentManifest(advanced: unknown): unknown {
  if (!isMap(advanced)) return advanced;
  const oauth = isMap(advanced.oauth_config) ? advanced.oauth_config : {};
  const scopes = isMap(oauth.scopes) ? oauth.scopes : {};
  const { redirect_urls: _r, pkce_enabled: _p, ...oauthRest } = oauth;
  const settings = isMap(advanced.settings) ? advanced.settings : {};
  const events = isMap(settings.event_subscriptions) ? settings.event_subscriptions : {};
  const { user_events: _u, ...eventsRest } = events;
  const features = isMap(advanced.features) ? advanced.features : {};
  const { slash_commands: _s, ...featuresRest } = features;
  return {
    ...advanced,
    oauth_config: { ...oauthRest, scopes: { bot: ((scopes.bot as string[] | undefined) ?? []).filter((x) => x !== "commands") } },
    settings: { ...settings, event_subscriptions: eventsRest },
    features: featuresRest,
  };
}

/** An agent app's names: the app is "<Agent> · AidenHQ" (35 at most) and its bot is the agent's own name (21 at most, which Slack builds the @handle from). */
export function agentNamed(manifest: unknown, agentName: string): unknown {
  if (!isMap(manifest)) return manifest;
  const name = agentName.trim() || "Agent";
  return {
    ...manifest,
    display_information: { ...(isMap(manifest.display_information) ? manifest.display_information : {}), name: `${name} · AidenHQ`.slice(0, APP_NAME_MAX) },
    features: { ...(isMap(manifest.features) ? manifest.features : {}), bot_user: { ...(isMap(manifest.features) && isMap(manifest.features.bot_user) ? manifest.features.bot_user : {}), display_name: name.slice(0, BOT_NAME_MAX) } },
  };
}

export const CONFIG_TOKEN = /^xoxe\.xoxp-[A-Za-z0-9-]{20,400}$/;
const APP_ID = /^A[A-Z0-9]{6,20}$/;

/** Slack's refusals in words: what happened and what to do. */
const WORDS: Record<string, string> = {
  invalid_auth: "Slack didn't accept that token. Make a new App Configuration Token and paste its Access Token (it starts xoxe.xoxp-).",
  token_expired: "That token has expired (they last 12 hours). Make a new one.",
  not_authed: "No token reached Slack. Paste the Access Token again.",
  app_not_found: "Slack has no app with that App ID in this workspace. Copy it again from the app's Basic Information page.",
  not_allowed_token_type: "That isn't an App Configuration Token. Paste the Access Token from Your App Configuration Tokens.",
  ratelimited: "Slack is busy. Try again in a minute.",
};

/**
 * Our manifest added onto the app's own: maps merge, lists keep the app's entries and add ours (a slash command by its name),
 * a value ours sets wins, and the app's display information (its name, description, colour) stays as the owner has it.
 */
export function onto(theirs: unknown, ours: unknown, key = ""): unknown {
  if (key === "display_information" && isMap(theirs)) return theirs;
  if (isMap(theirs) && isMap(ours)) return Object.fromEntries([...new Set([...Object.keys(theirs), ...Object.keys(ours)])].map((k) => [k, k in ours ? (k in theirs ? onto(theirs[k], ours[k], k) : ours[k]) : theirs[k]]));
  if (Array.isArray(theirs) && Array.isArray(ours)) {
    const id = (x: unknown) => (isMap(x) && typeof x.command === "string" ? x.command : JSON.stringify(x));
    const mine = new Set(ours.map(id));
    return [...theirs.filter((x) => !mine.has(id(x))), ...ours];
  }
  return ours;
}

export interface AppStatus {
  app_id: string | null;
  part: Part | null;
  /** The app has today's manifest for its part (it was made or updated here since the manifest last changed). */
  current: boolean;
  url: string | null;
}

export function apps(store: Store, fetchImpl: typeof fetch = fetch) {
  const call = async (method: string, token: string, body: Record<string, string>) => {
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((e: unknown) => {
      // A creation that timed out may still have happened: say so, so nobody makes a second app blind.
      throw new AppError(504, `Slack didn't answer in time (${(e as Error).name}). Check api.slack.com/apps for a new AidenHQ app before trying again.`);
    });
    const r = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (r.ok) return r;
    const code = String(r.error ?? res.status).slice(0, 60);
    const detail = Array.isArray(r.errors) ? ` (${r.errors.slice(0, 3).map((e: any) => `${String(e?.pointer ?? "")}: ${String(e?.message ?? "")}`.slice(0, 120)).join("; ")})` : "";
    throw new AppError(400, `${WORDS[code] ?? `Slack refused it: ${code}.`}${detail}`);
  };
  const records = installs(store);
  const base = (part: Part, agent: boolean): unknown => (agent ? agentManifest(MANIFESTS.advanced) : MANIFESTS[part]);
  /** The instance's app, or (with an agent key) that agent's dedicated app. */
  const status = (agent?: string): AppStatus => {
    const r = agent ? records.ofAgent(agent) : records.instance();
    const part = (r?.part as Part | undefined) ?? null;
    return { app_id: r?.app_id ?? null, part, current: Boolean(r && part && r.hash === hash(base(part, Boolean(agent)))), url: r ? `https://api.slack.com/apps/${r.app_id}` : null };
  };
  return {
    status,
    /**
     * Makes the app for `part`, or updates `app_id` to it. With `agent` it is that agent's dedicated app: the advanced manifest for
     * a bot of its own, named after the agent. Answers the public client id a new app has, as the board saves it.
     */
    async apply(input: { token: string; part: Part; app_id?: string; agent?: { key: string; name: string } }): Promise<AppStatus & { secrets?: { slack_client_id: string } }> {
      if (!CONFIG_TOKEN.test(input.token)) throw new AppError(400, "That isn't an App Configuration Token: paste the Access Token (it starts xoxe.xoxp-).");
      if (input.app_id !== undefined && !APP_ID.test(input.app_id)) throw new AppError(400, "An App ID starts with A, then letters and digits (Basic Information, App ID).");
      const agent = input.agent;
      if (agent && input.part !== "advanced") throw new AppError(400, "An agent's own app has a bot: the advanced part.");
      const manifest = base(input.part, Boolean(agent));
      const instanceName = slugOf(process.env.INSTANCE_NAME || process.env.OWNER_NAME);
      let id = input.app_id;
      let clientId: string | undefined;
      if (id) {
        // The app's own settings stay (scopes the owner added, other redirect URLs, its name): ours are added on top.
        const current = (await call("apps.manifest.export", input.token, { app_id: id })).manifest;
        // Adding the bot to an app that has none is its first install, and Slack fixes the @handle then: name it per instance
        // like a new app. An app that already has a bot keeps both its handle and its label (Slack won't change a handle after
        // install, and the owner may have renamed it): only the rest of our bot settings are added.
        const hasBot = hasBotUser(current);
        const overlay = hasBot ? withoutBotName(manifest) : agent ? agentNamed(manifest, agent.name) : input.part === "advanced" ? named(manifest, instanceName) : manifest;
        await call("apps.manifest.update", input.token, { app_id: id, manifest: JSON.stringify(onto(current, overlay)) });
      }
      else {
        // A new app is named after this instance (or its agent): Slack fixes its @handle at this first install, so it must be distinct now.
        const created = agent ? agentNamed(manifest, agent.name) : named(manifest, instanceName);
        const r = await call("apps.manifest.create", input.token, { manifest: JSON.stringify(created) });
        id = String(r.app_id ?? "");
        clientId = typeof r.credentials?.client_id === "string" ? r.credentials.client_id : undefined;
        if (!APP_ID.test(id) || (!clientId && !agent)) throw new AppError(502, "Slack made the app but its answer was incomplete. Open api.slack.com/apps, find the new AidenHQ app and copy its Client ID.");
      }
      records.put(id, { part: input.part, hash: hash(manifest), ...(agent ? { agent: agent.key } : {}) });
      return { ...status(agent?.key), ...(clientId && !agent ? { secrets: { slack_client_id: clientId } } : {}) };
    },
  };
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
