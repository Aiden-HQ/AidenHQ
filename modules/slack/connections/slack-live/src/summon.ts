// Summoning (the kernel's summon path, POST /summon/context|reply|react with the connection's key): the three calls a source
// implements so an agent can read the conversation a summons came from, answer in it as the owner, and acknowledge it.
// Everything is done AS THE OWNER through slack-mcp's relay (the same user token slack_send_message uses; slack-live never holds
// it): reads over the relay's GET, the reply and the reaction over its two fixed-shape POSTs. Ids are the event ids slack-live
// emits (`<channel>:<ts>`, map.ts), so the kernel's echo guard compares like with like; the bare ts is accepted on input too.
import { toSlackMrkdwn } from "./mrkdwn.js";
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

/** Slack's refusals as the kernel should read them: a missing scope or a gone channel is a failure to report, never a 403
 * (that one means "an excluded conversation": the kernel cancels the summons on it). */
function slackError(method: string, err: unknown): never {
  const e = String((err as Error)?.message ?? err);
  if (/missing_scope|not_allowed_token_type/.test(e)) throw new SummonError(502, `${method}: ${e}. Add the User Token Scopes chat:write and reactions:write to the Slack app and Connect again.`);
  throw new SummonError(502, e);
}

export function summon(o: { relay: Relay; store: Pick<Store, "getKv" | "setKv" | "delKv">; owner: () => string | undefined;
  /** Whose sign-in the relay holds (slack-mcp); null while Slack isn't connected. */
  signedIn: () => Promise<string | null> }) {
  // Attestation is the paired owner's, the calls are made with the sign-in's token: one account, or nothing is done.
  const same = async () => {
    const me = await o.signedIn().catch(() => null);
    if (!me || !o.owner() || me !== o.owner()) throw new SummonError(409, "the Slack sign-in is not the paired owner's account: Connect Slack as the account that paired the bot");
  };
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
    await same();
    if (before && !TS.test(before)) throw new SummonError(400, "before is a message id");
    const upTo: Record<string, string> = before ? { latest: before, inclusive: "false" } : {};
    let found: Json[] = [];
    try {
      if (thread) {
        // Replies come oldest first, a page at a time: read to the cutoff, then keep the last n.
        for (let cursor = "", pages = 0; pages < 10; pages++) {
          const r = await o.relay.read("conversations.replies", { channel, ts: thread, limit: "200", ...upTo, ...(cursor ? { cursor } : {}) });
          // Slack repeats the thread's parent on every page: one message per ts.
          for (const m of (r.messages as Json[] | undefined) ?? []) if ((!before || Number(m.ts) < Number(before)) && !found.some((f) => f.ts === m.ts)) found.push(m);
          cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
          if (!cursor) break;
        }
      }
      if (found.length === 0) found = ((await o.relay.read("conversations.history", { channel, limit: String(n), ...upTo })).messages as Json[] | undefined ?? []).slice().reverse();
    } catch (err) { slackError("context", err); }
    return { messages: await shape(channel, found.slice(-n)) };
  }

  /** Posts as the owner, threaded under the summons' thread in a channel and top-level in a DM. A repeated `key` returns the
   * first id and posts nothing. `in_reply_to` needs no use: the thread root is the anchor, and a DM has no thread.
   * The attempt is recorded before the post; one whose outcome is unknown (the answer lost, a restart) is reconciled on the
   * retry by looking for the owner's message with that exact text since the attempt began, and only then posted again. */
  const inflight = new Map<string, Promise<{ id: string }>>();
  async function reply(b: Json) {
    const channel = str(b.resource), thread = str(b.thread), text = str(b.text), key = str(b.key);
    if (!channel || !text || !key) throw new SummonError(400, "resource, text and key are required");
    await same(); // before the lookups: nothing may await between the stored-id and in-flight checks and the post
    const done = o.store.getKv(`summon_reply:${key}`);
    if (done) return { id: done };
    const running = inflight.get(key);
    if (running) return running;
    const rendered = toSlackMrkdwn(text, { labelled: true });
    const p = (async () => {
      try {
        const pending = o.store.getKv(`summon_pending:${key}`);
        if (pending) {
          const since = (JSON.parse(pending) as { at: number }).at / 1000 - 2; // our clock to Slack's: a little skew
          let seen: Json | undefined;
          // Every page of the window, or the attempt stays pending (a throw): a scan that couldn't finish proves nothing.
          for (let cursor = "", pages = 0; !seen; pages++) {
            if (pages >= 10) throw new Error("too many messages since the unsure post to check it");
            const r = thread ? await o.relay.read("conversations.replies", { channel, ts: thread, oldest: String(since), limit: "200", ...(cursor ? { cursor } : {}) })
              : await o.relay.read("conversations.history", { channel, oldest: String(since), limit: "200", ...(cursor ? { cursor } : {}) });
            seen = ((r.messages as Json[] | undefined) ?? []).find((m) => m.user === o.owner() && m.text === rendered && Number(m.ts) >= since);
            cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
            if (!cursor) break;
          }
          if (seen) {
            const id = `${channel}:${String(seen.ts)}`;
            o.store.setKv(`summon_reply:${key}`, id);
            o.store.delKv(`summon_pending:${key}`);
            return { id };
          }
        }
        o.store.setKv(`summon_pending:${key}`, JSON.stringify({ at: Date.now() }));
        const r = await o.relay.write("post-message", { channel, text: rendered, ...(thread ? { thread_ts: thread } : {}) });
        if (r.ok !== true || !str(r.ts)) {
          // Slack answered with a refusal that proves nothing was posted: nothing was posted, so nothing is pending. Any other error (internal_error, a
          // transport or unreadable answer) and a throw are the uncertain cases: they stay pending.
          if (r.ok === false && typeof r.error === "string" && /^(channel_not_found|not_in_channel|is_archived|missing_scope|not_allowed_token_type|invalid_auth|token_expired|token_revoked|account_inactive|msg_too_long|no_text|restricted_action|access_denied)$/.test(r.error)) o.store.delKv(`summon_pending:${key}`);
          throw new Error(String(r.error ?? "chat.postMessage failed"));
        }
        const id = `${channel}:${String(r.ts)}`;
        o.store.setKv(`summon_reply:${key}`, id);
        o.store.delKv(`summon_pending:${key}`);
        return { id };
      } catch (err) { return slackError("reply", err); }
    })().finally(() => void inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function react(b: Json) {
    const channel = str(b.resource), message = str(b.message), emoji = str(b.emoji);
    if (!channel || !message || emoji !== "eyes" || !TS.test(tsOf(message))) throw new SummonError(400, "resource, message and emoji \"eyes\" are required");
    await same();
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

/** Whether slack-mcp posted that message for an agent (its record, posted.ts): by channel and ts, or by its words. */
export const postedByAgent = (base: string, key: string, fetchFn: typeof fetch = fetch) => async (channel: string, ts: string, text: string): Promise<boolean> => {
  const res = await fetchFn(`${base}/internal/posted?${new URLSearchParams({ channel, ts, text })}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`slack-mcp posted: ${res.status}`);
  return ((await res.json()) as { posted?: boolean }).posted === true;
};

/** What slack-mcp remembers (posted.ts), less a day: an older message can't be told from an agent's, so it is never attested. */
const PROVENANCE_MS = 6 * 86_400_000;
/** An owner-authored event is the owner's own only if no agent posted it as the owner: an agent's text ("cc Aria") must never
 * summon. A lookup that can't be answered throws, so the event is retried (an unacked socket event is redelivered, a replay is
 * kept), never attested without the answer. */
export async function attest<E extends { id: string; resource: string; text?: string; from_owner?: boolean }>(e: E, posted: (channel: string, ts: string, text: string) => Promise<boolean>, now = Date.now()): Promise<E> {
  if (!e.from_owner) return e;
  const ts = tsOf(e.id);
  if (now - Number(ts) * 1000 > PROVENANCE_MS || (await posted(e.resource, ts, e.text ?? ""))) return { ...e, from_owner: false };
  return e;
}
