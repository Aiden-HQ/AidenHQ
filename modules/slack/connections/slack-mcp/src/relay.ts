// The sign-in, lent narrowly to slack-live (the module's other service), so the owner has one Slack user token, kept and
// renewed here (src/vendor/oauth.ts), and it never leaves this service:
//   GET /internal/owner          whose sign-in it is: { user_id, team_id } (slack_owner); 409 while Slack isn't connected
//   GET /internal/slack/<method> one read the src_slack gap sync makes, sent to Slack as the owner; Slack's answer as given
// Both need slack-live's own key (slack_relay_key). Only the gap sync's read methods pass.
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/** What the gap sync reads (slack-live src/sources.ts): nothing that writes, nothing else. */
export const RELAYED = new Set(["users.list", "users.conversations", "conversations.history", "conversations.replies", "conversations.info"]);

export interface RelayDeps {
  key: string | undefined;
  tokenFile: string;
  /** The owner's Authorization header; renews an access token about to expire. */
  headers: () => Promise<Record<string, string>>;
  signedIn: () => boolean;
  fetchImpl?: typeof fetch;
}

/** Answers the relay's paths; false for every other path. */
export function relay(o: RelayDeps) {
  const doFetch = o.fetchImpl ?? fetch;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/internal/")) return false;
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra }).end(typeof body === "string" ? body : JSON.stringify(body));
    const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(o.key ?? "");
    if (!o.key || presented.length !== expected.length || !timingSafeEqual(presented, expected)) return (send(401, { error: "unauthorized" }), true);
    if (req.method !== "GET") return (send(405, { error: "method not allowed" }), true);
    if (!o.signedIn()) return (send(409, { error: "Slack is not connected" }), true);
    if (url.pathname === "/internal/owner") {
      const t = JSON.parse(readFileSync(o.tokenFile, "utf8")) as { user_id?: unknown; team_id?: unknown };
      return (send(200, { user_id: typeof t.user_id === "string" ? t.user_id : null, team_id: typeof t.team_id === "string" ? t.team_id : null }), true);
    }
    const method = url.pathname.slice("/internal/slack/".length);
    if (!url.pathname.startsWith("/internal/slack/") || !RELAYED.has(method)) return (send(404, { error: "not relayed" }), true);
    const up = await doFetch(`https://slack.com/api/${method}${url.search}`, { headers: await o.headers(), signal: AbortSignal.timeout(30_000) });
    const retry = up.headers.get("retry-after");
    return (send(up.status, await up.text(), retry ? { "retry-after": retry } : {}), true);
  };
}
