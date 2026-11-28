// The sign-in, lent narrowly to slack-live (the module's other service), so the owner has one Slack user token, kept and
// renewed here (src/vendor/oauth.ts), and it never leaves this service:
//   GET /internal/owner          whose sign-in it is: { user_id, team_id } (slack_owner); 409 while Slack isn't connected
//   GET /internal/slack/<method> one read the src_slack gap sync and summoning make, sent to Slack as the owner; Slack's answer as given
//   POST /internal/post-message  one message posted as the owner (chat.postMessage): {channel, text, thread_ts?}   (summoning's reply)
//   GET /internal/posted?channel=&ts=  whether this service posted that message for an agent (by ts, or by its words): { posted: boolean }
//   POST /internal/add-reaction  one reaction added as the owner (reactions.add): {channel, timestamp, name}      (summoning's 👀)
// All need slack-live's own key (slack_relay_key). Only those read methods pass, and the two writes have a fixed shape: the
// token stays here, and slack-live can't send anything else as the owner.
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Posted } from "./posted.js";

/** What the gap sync reads (slack-live src/sources.ts): nothing that writes, nothing else. */
export const RELAYED = new Set(["users.list", "users.info", "users.conversations", "conversations.history", "conversations.replies", "conversations.info"]);

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
/** The two writes' fixed bodies: the Slack call and its arguments, or why not. Nothing outside these fields reaches Slack. */
export function writeCall(path: string, b: Record<string, unknown>): { method: string; body: Record<string, unknown> } | string {
  if (path === "/internal/post-message") {
    if (!text(b.channel, 40) || !text(b.text, 40_000) || (b.thread_ts !== undefined && !text(b.thread_ts, 40))) return "channel and text are required; thread_ts is a timestamp";
    return { method: "chat.postMessage", body: { channel: b.channel, text: b.text, unfurl_links: false, unfurl_media: false, ...(b.thread_ts ? { thread_ts: b.thread_ts } : {}) } };
  }
  if (!text(b.channel, 40) || !text(b.timestamp, 40) || !text(b.name, 100)) return "channel, timestamp and name are required";
  return { method: "reactions.add", body: { channel: b.channel, timestamp: b.timestamp, name: b.name } };
}

export interface RelayDeps {
  key: string | undefined;
  tokenFile: string;
  /** The owner's Authorization header; renews an access token about to expire. */
  headers: () => Promise<Record<string, string>>;
  signedIn: () => boolean;
  fetchImpl?: typeof fetch;
  /** Messages posted for an agent as the owner (posted.ts): the relay's own post-message is recorded, and `GET /internal/posted` answers. */
  posted?: Posted;
}

/** Answers the relay's paths; false for every other path. */
export function relay(o: RelayDeps) {
  const doFetch = o.fetchImpl ?? fetch;
  // auth.test's answer for the stored sign-in, kept until the token file changes (a new sign-in).
  let whoami: { at: number; p: Promise<{ user_id: string | null; team_id: string | null }> } | undefined;
  const ask = async () => {
    const r = (await (await doFetch("https://slack.com/api/auth.test", { headers: await o.headers(), signal: AbortSignal.timeout(15_000) })).json()) as { ok?: boolean; user_id?: unknown; team_id?: unknown; error?: unknown };
    if (!r.ok || typeof r.user_id !== "string") throw new Error(`auth.test: ${String(r.error ?? "no user")}`);
    return { user_id: r.user_id, team_id: typeof r.team_id === "string" ? r.team_id : null };
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/internal/")) return false;
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra }).end(typeof body === "string" ? body : JSON.stringify(body));
    const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(o.key ?? "");
    if (!o.key || presented.length !== expected.length || !timingSafeEqual(presented, expected)) return (send(401, { error: "unauthorized" }), true);
    const write = url.pathname === "/internal/post-message" || url.pathname === "/internal/add-reaction";
    // The provenance lookup is this service's own record: it needs no Slack sign-in.
    if (req.method === "GET" && url.pathname === "/internal/posted") return (send(200, { posted: Boolean(o.posted?.has(url.searchParams.get("channel") ?? "", url.searchParams.get("ts") ?? "", url.searchParams.get("text") ?? undefined)) }), true);
    if (req.method !== (write ? "POST" : "GET")) return (send(405, { error: "method not allowed" }), true);
    if (!o.signedIn()) return (send(409, { error: "Slack is not connected" }), true);
    if (write) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = (() => { try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>; } catch { return undefined; } })();
      const call = body && typeof body === "object" && !Array.isArray(body) ? writeCall(url.pathname, body) : "a JSON object is required";
      if (typeof call === "string") return (send(400, { error: call }), true);
      if (call.method === "chat.postMessage") o.posted?.sending(String(call.body.channel), String(call.body.text)); // before: Slack may deliver it first
      const up = await doFetch(`https://slack.com/api/${call.method}`, { method: "POST", headers: { ...(await o.headers()), "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(call.body), signal: AbortSignal.timeout(30_000) });
      const retry = up.headers.get("retry-after");
      const answer = await up.text();
      if (call.method === "chat.postMessage") { try { const r = JSON.parse(answer) as { ok?: boolean; channel?: string; ts?: string }; if (r.ok && r.channel && r.ts) o.posted?.record(r.channel, r.ts); } catch { /* not JSON: nothing to record */ } }
      return (send(up.status, answer, retry ? { "retry-after": retry } : {}), true);
    }
    if (url.pathname === "/internal/owner") {
      const t = JSON.parse(readFileSync(o.tokenFile, "utf8")) as { user_id?: unknown; team_id?: unknown };
      if (typeof t.user_id === "string") return (send(200, { user_id: t.user_id, team_id: typeof t.team_id === "string" ? t.team_id : null }), true);
      // A sign-in stored without its user id: Slack's auth.test says whose token it is (asked once per sign-in).
      const at = statSync(o.tokenFile).mtimeMs;
      if (whoami?.at !== at) whoami = { at, p: ask() };
      const r = await whoami.p.catch((e: unknown) => {
        whoami = undefined;
        throw e;
      });
      return (send(200, r), true);
    }
    const method = url.pathname.slice("/internal/slack/".length);
    if (!url.pathname.startsWith("/internal/slack/") || !RELAYED.has(method)) return (send(404, { error: "not relayed" }), true);
    const up = await doFetch(`https://slack.com/api/${method}${url.search}`, { headers: await o.headers(), signal: AbortSignal.timeout(30_000) });
    const retry = up.headers.get("retry-after");
    return (send(up.status, await up.text(), retry ? { "retry-after": retry } : {}), true);
  };
}
