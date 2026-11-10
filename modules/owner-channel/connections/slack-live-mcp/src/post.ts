// slack_post: an agent's message to a Slack channel the instance allows (setting slack_post_channels), sent by the
// instance's bot and headed with the agent's name as an AI agent. Never as the owner: only the bot token is used.
import { createHash } from "node:crypto";
import type { Store } from "./store.js";

export interface PostConfig {
  botToken: string;
  allowed: Set<string>; // channel ids
}
export interface PostArgs {
  channel: string;
  text: string;
  thread_ts?: string | undefined;
}
export type PostResult = { ok: true; channel: string; ts: string; duplicate?: true };

const DUPLICATE_MS = 10 * 60_000;

export async function slackPost(store: Store, cfg: PostConfig, a: PostArgs, caller: { id: string; name: string } | undefined, now = Date.now()): Promise<PostResult> {
  if (!caller?.name) throw new Error("slack_post needs a known agent (its run key) to sign the message");
  if (!cfg.allowed.has(a.channel)) throw new Error(`channel ${a.channel} isn't one the owner allowed (instance setting slack_post_channels)`);
  if (!cfg.botToken) throw new Error("no Slack bot is configured on this instance");
  const key = `post:${createHash("sha256").update(`${a.channel}\n${a.thread_ts ?? ""}\n${a.text}`).digest("hex").slice(0, 32)}`;
  const prev = store.getKv(key);
  if (prev) {
    const p = JSON.parse(prev) as { at: number; ts: string };
    if (now - p.at < DUPLICATE_MS) return { ok: true, channel: a.channel, ts: p.ts, duplicate: true };
  }
  // No special mentions (@channel, @here, @everyone, user groups): an agent never pages a whole channel or team.
  const body = noSpecial(a.text);
  const name = noSpecial(caller.name).replace(/[<>*&]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: a.channel, text: `*${name}* (AI agent)\n${body}`, unfurl_links: false, ...(a.thread_ts ? { thread_ts: a.thread_ts } : {}) }),
  });
  const r = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string; error?: string };
  if (!r.ok || !r.ts) throw new Error(`Slack refused the post: ${r.error ?? res.status}`);
  store.setKv(key, JSON.stringify({ at: now, ts: r.ts }));
  return { ok: true, channel: a.channel, ts: r.ts };
}

/** Strips every `<!…>` token (repeatedly, so nested ones can't reassemble), keeping its visible words; no `<!` survives. */
function noSpecial(t: string): string {
  let out = t;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/<!([^<>]*)>/g, (_, inner: string) => inner.split("|").pop()!.replace(/^[a-z]+\^\S*$/i, ""));
  }
  return out.replace(/<!/g, "‹!");
}
