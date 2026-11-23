// The Slack app, made or updated by Slack's API from the owner's pasted App Configuration Token (the board's Slack setup page,
// through its /setup/app route with the module's pair token). The token is used for the one call and dropped: never stored,
// logged or answered. The app's id and which manifest it got are kept (not secret), so the page knows what to offer next.
// Install stays on the app's own page in Slack: an OAuth install of the bot can't return to every board (see
// slack-app-manifest.yml), and no Slack API makes the app-level token (xapp-).
import { createHash } from "node:crypto";
import manifests from "./manifests.json" with { type: "json" };
import type { Store } from "./store.js";

export type Part = "basic" | "advanced";
export const MANIFESTS: Record<Part, unknown> = manifests;
const hash = (m: unknown) => createHash("sha256").update(JSON.stringify(m)).digest("hex").slice(0, 16);

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

const isMap = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
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
  const status = (): AppStatus => {
    const last = store.getKv("app:last");
    const { id, part } = last ? (JSON.parse(last) as { id: string; part: Part }) : { id: null, part: null };
    return { app_id: id, part, current: Boolean(id && part && store.getKv(`app:${id}`) === hash(MANIFESTS[part])), url: id ? `https://api.slack.com/apps/${id}` : null };
  };
  return {
    status,
    /** Makes the app for `part`, or updates `app_id` to it. Answers the public client id a new app has, as the board saves it. */
    async apply(input: { token: string; part: Part; app_id?: string }): Promise<AppStatus & { secrets?: { slack_client_id: string } }> {
      if (!CONFIG_TOKEN.test(input.token)) throw new AppError(400, "That isn't an App Configuration Token: paste the Access Token (it starts xoxe.xoxp-).");
      if (input.app_id !== undefined && !APP_ID.test(input.app_id)) throw new AppError(400, "An App ID starts with A, then letters and digits (Basic Information, App ID).");
      const manifest = MANIFESTS[input.part];
      let id = input.app_id;
      let clientId: string | undefined;
      if (id) {
        // The app's own settings stay (scopes the owner added, other redirect URLs, its name): ours are added on top.
        const current = (await call("apps.manifest.export", input.token, { app_id: id })).manifest;
        await call("apps.manifest.update", input.token, { app_id: id, manifest: JSON.stringify(onto(current, manifest)) });
      }
      else {
        const r = await call("apps.manifest.create", input.token, { manifest: JSON.stringify(manifest) });
        id = String(r.app_id ?? "");
        clientId = typeof r.credentials?.client_id === "string" ? r.credentials.client_id : undefined;
        if (!APP_ID.test(id) || !clientId) throw new AppError(502, "Slack made the app but its answer was incomplete. Open api.slack.com/apps, find the new AidenHQ app and copy its Client ID.");
      }
      store.setKv(`app:${id}`, hash(manifest));
      store.setKv("app:last", JSON.stringify({ id, part: input.part }));
      return { ...status(), ...(clientId ? { secrets: { slack_client_id: clientId } } : {}) };
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
