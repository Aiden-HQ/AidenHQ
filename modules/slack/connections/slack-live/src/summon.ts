// Summoning (the kernel's summon path, POST /summon/context|reply|react with the connection's key): the three calls a source
// implements so an agent can read the conversation a summons came from, answer in it as the owner, and acknowledge it.
// Everything is done AS THE OWNER through slack-mcp's relay (the same user token slack_send_message uses; slack-live never holds
// it): reads over the relay's GET, the reply and the reaction over its two fixed-shape POSTs. Ids are the event ids slack-live
// emits (`<channel>:<ts>`, map.ts), so the kernel's echo guard compares like with like; the bare ts is accepted on input too.
import { escape } from "./mrkdwn.js";
import type { Api } from "./sources.js";
import type { Store } from "./store.js";

export class SummonError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type Json = Record<string, unknown>;
export interface Relay {
  /** A Slack Web API read as the owner (sources.ts slackApi). */
  read: Api;
  /** One of the relay's two writes ("post-message" | "add-reaction"): Slack's answer. */
  write: (path: "post-message" | "add-reaction", body: Json) => Promise<Json>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const tsOf = (id: string): string => id.slice(id.lastIndexOf(":") + 1);
const TS = /^\d+\.\d+$/;

/** Agent markdown for a message posted as the owner: everything escaped (no mentions, broadcasts or raw links an agent could
 * form), then each `[label](https://…)` becomes Slack's `<url|label>`. Not toSlackMrkdwn: that one keeps the address visible. */
export function toSlackLinks(text: string): string {
  return escape(text).replace(/\[([^\]\n|]+)\]\((https?:\/\/[^\s)"|]+)\)/g, (_, label: string, url: string) => `<${url}|${label}>`);
}

/** Slack's refusals as the kernel should read them: a missing scope or a gone channel is a failure to report, never a 403
 * (that one means "an excluded conversation": the kernel cancels the summons on it). */
function slackError(method: string, err: unknown): never {
  const e = String((err as Error)?.message ?? err);
  if (/missing_scope|not_allowed_token_type/.test(e)) throw new SummonError(502, `${method}: ${e}. Add the User Token Scopes chat:write and reactions:write to the Slack app and Connect again.`);
  throw new SummonError(502, e);
}

export function summon(o: { relay: Relay; store: Pick<Store, "getKv" | "setKv">; owner: () => string | undefined }) {
  const names = new Map<string, string>();
  const author = async (m: Json): Promise<string> => {
    const user = str(m.user);
    if (!user) return str(m.username) ?? str(m.bot_id) ?? "unknown";
    if (!names.has(user)) {
      const info = await o.relay.read("users.info", { user }).then((r) => r.user as { name?: string; real_name?: string; profile?: { display_name?: string } } | undefined, () => undefined);
      names.set(user, info?.profile?.display_name || info?.real_name || info?.name || user);
    }
    return names.get(user)!;
  };
  const shape = async (channel: string, ms: Json[]) => Promise.all(ms.map(async (m) => ({
    id: `${channel}:${String(m.ts)}`, author: await author(m), is_owner: Boolean(o.owner()) && m.user === o.owner(), text: str(m.text) ?? "", ts: String(m.ts),
  })));

  /** The last `n` messages of the conversation, oldest first, strictly before `before` when given. A thread reads its replies;
   * a channel's top-level message is its own thread root, so when the thread has nothing before it the channel's history does. */
  async function context(b: Json) {
    const channel = str(b.resource), thread = str(b.thread), before = str(b.before) ? tsOf(str(b.before)!) : undefined;
    const n = Math.min(Math.max(Number(b.n) || 10, 1), 50);
    if (!channel) throw new SummonError(400, "resource is required");
    if (before && !TS.test(before)) throw new SummonError(400, "before is a message id");
    const upTo: Record<string, string> = before ? { latest: before, inclusive: "false" } : {};
    let found: Json[] = [];
    try {
      if (thread) found = ((await o.relay.read("conversations.replies", { channel, ts: thread, limit: "200", ...upTo })).messages as Json[] | undefined ?? []).filter((m) => !before || Number(m.ts) < Number(before));
      if (found.length === 0) found = ((await o.relay.read("conversations.history", { channel, limit: String(n), ...upTo })).messages as Json[] | undefined ?? []).slice().reverse();
    } catch (err) { slackError("context", err); }
    return { messages: await shape(channel, found.slice(-n)) };
  }

  /** Posts as the owner, threaded under the summons' thread in a channel and top-level in a DM. A repeated `key` returns the
   * first id and posts nothing. `in_reply_to` needs no use: the thread root is the anchor, and a DM has no thread. */
  const inflight = new Map<string, Promise<{ id: string }>>();
  async function reply(b: Json) {
    const channel = str(b.resource), thread = str(b.thread), text = str(b.text), key = str(b.key);
    if (!channel || !text || !key) throw new SummonError(400, "resource, text and key are required");
    const done = o.store.getKv(`summon_reply:${key}`);
    if (done) return { id: done };
    const running = inflight.get(key);
    if (running) return running;
    const p = (async () => {
      try {
        const r = await o.relay.write("post-message", { channel, text: toSlackLinks(text), ...(thread ? { thread_ts: thread } : {}) });
        if (r.ok !== true || !str(r.ts)) throw new Error(String(r.error ?? "chat.postMessage failed"));
        const id = `${channel}:${String(r.ts)}`;
        o.store.setKv(`summon_reply:${key}`, id);
        return { id };
      } catch (err) { return slackError("reply", err); }
    })().finally(() => void inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function react(b: Json) {
    const channel = str(b.resource), message = str(b.message), emoji = str(b.emoji);
    if (!channel || !message || emoji !== "eyes" || !TS.test(tsOf(message))) throw new SummonError(400, "resource, message and emoji \"eyes\" are required");
    try {
      const r = await o.relay.write("add-reaction", { channel, timestamp: tsOf(message), name: "eyes" });
      if (r.ok !== true && r.error !== "already_reacted") throw new Error(String(r.error ?? "reactions.add failed"));
    } catch (err) { slackError("react", err); }
    return {};
  }
  return { context, reply, react };
}
export type Summon = ReturnType<typeof summon>;

/** The relay as slack-live reaches it (slack-mcp's /internal, slack_relay_key). */
export function relayWrites(base: string, key: string, fetchFn: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Relay["write"] {
  return async (path, body) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchFn(`${base}/internal/${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 && attempt === 0) {
        await sleep(Math.min(Number(res.headers.get("retry-after")) || 2, 30) * 1000);
        continue;
      }
      return (await res.json().catch(() => ({ ok: false, error: `relay ${res.status}` }))) as Json;
    }
  };
}
