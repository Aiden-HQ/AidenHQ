// slack.post (module.yaml writes.post), the executor side: an agent's slack_post call is a kernel record. plan names
// the agent (from the kernel's requester, never the args) and raises a channel outside the slack_post_channels setting to the
// owner (Tier 2); the AI reviewer reads every post first (floor 1). execute posts it from the instance's bot, headed with the
// agent's name as an AI agent. Never as the owner: only the bot token is used.
import { createHash } from "node:crypto";
import type { Executor } from "./aidenhq-sdk/executor.js";
import { bindings } from "./bind.js";
import { toSlackMrkdwn } from "./mrkdwn.js";
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

/** Posts as the labelled bot; the channel list is the kernel's tier (plan), not a refusal here. */
export async function slackPost(store: Store, cfg: PostConfig, a: PostArgs, caller: { name: string } | undefined, now = Date.now()): Promise<PostResult> {
  if (!caller?.name) throw new Error("slack_post needs a known agent (its run key) to sign the message");
  if (!cfg.botToken) throw new Error("no Slack bot is configured on this instance");
  const key = `post:${createHash("sha256").update(`${a.channel}\n${a.thread_ts ?? ""}\n${a.text}`).digest("hex").slice(0, 32)}`;
  const prev = store.getKv(key);
  if (prev) {
    const p = JSON.parse(prev) as { at: number; ts: string };
    if (now - p.at < DUPLICATE_MS) return { ok: true, channel: a.channel, ts: p.ts, duplicate: true };
  }
  // No special mentions (@channel, @here, @everyone, user groups): an agent never pages a whole channel or team.
  const body = toSlackMrkdwn(noSpecial(a.text), { labelled: true, keepTokens: true });
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

const CHANNEL = /^[CG][A-Z0-9]{6,}$/;
/** The post's args as recorded: the call's channel, text and thread, and the agent that heads it (the requester's name). */
export function normalise(a: any, agent: string): PostArgs & { agent: string } {
  if (typeof a?.channel !== "string" || !CHANNEL.test(a.channel)) throw new Error("channel must be a channel id, e.g. C0123ABCD");
  if (typeof a?.text !== "string" || !a.text.trim()) throw new Error("the message is empty");
  if (!agent) throw new Error("slack_post needs a known agent (its run key) to sign the message");
  return { channel: a.channel, text: a.text.slice(0, 3000), ...(typeof a.thread_ts === "string" && a.thread_ts ? { thread_ts: a.thread_ts } : {}), agent };
}

export function poster(store: Store, cfg: PostConfig): Executor {
  return {
    async plan(req) {
      const args = normalise(req.args, String(req.requester?.name ?? ""));
      // A channel bound to this agent is its own: the reviewer reads the post, the owner isn't asked about the channel again.
      const b = bindings(store).get(args.channel);
      const own = !!b && typeof req.requester?.key === "string" && req.requester.key !== "" && b.agent === req.requester.key;
      const outside = !cfg.allowed.has(args.channel) && !own;
      return {
        args,
        targets: { channel: args.channel, ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}) },
        ...(outside ? { raise: { tier: 2 as const, rule: "slack-channel-not-allowed", reason: `channel ${args.channel} isn't in the slack_post_channels setting` } } : {}),
        card: { where: args.thread_ts ? `a thread in ${args.channel}` : args.channel },
      };
    },
    async execute(rec) {
      const a = normalise(rec.args, String(rec.args?.agent ?? ""));
      const r = await slackPost(store, cfg, a, { name: a.agent });
      return { ok: true, text: `Posted to ${r.channel} (ts ${r.ts})${r.duplicate ? ", the same message as 10 minutes ago" : ""}.` };
    },
  };
}
