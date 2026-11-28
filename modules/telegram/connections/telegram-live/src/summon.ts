// The summon contract (summon-agents spec, "The source contract"): the kernel calls context / reply / react here, with the service
// key, for a conversation the owner summoned an agent in. A Telegram chat is one conversation (events carry no `thread`).
// Message ids on this contract are the event ids `<chat_id>:<message_id>`; a bare message id is read as in the call's chat.
// reply goes through send.ts' run (the writes table's idempotency, the per-chat gap, the hourly cap, agent_pending, so ingest
// drops the echo as agentSent) and honours telegram_exclude_chats; react is a plain reaction (no send cap: it is the 3 s ack).
import { createHash } from "node:crypto";
import type { Run } from "./send.js";
import type { Settings } from "./ingest.js";
import type { Store } from "./store.js";
import { TdError, type TdClient } from "./td.js";

/** How long a chat stays forwarded while muted after the kernel last touched it (the connector never learns a task closed). */
export const WATCH_MS = 48 * 3_600_000;
export const EMOJI: Record<string, string> = { eyes: "👀" };
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

export type Reply = { status: number; body: unknown };
const reply = (status: number, body: unknown): Reply => ({ status, body });

/** `[label](url)` as the text-link entities Telegram renders (offsets in UTF-16 units, as TDLib counts them). */
export function renderLinks(markdown: string): { text: string; entities: unknown[] } {
  let text = "";
  let last = 0;
  const entities: unknown[] = [];
  for (const m of markdown.matchAll(LINK)) {
    text += markdown.slice(last, m.index);
    entities.push({ _: "textEntity", offset: text.length, length: m[1]!.length, type: { _: "textEntityTypeTextUrl", url: m[2] } });
    text += m[1];
    last = m.index! + m[0].length;
  }
  return { text: text + markdown.slice(last), entities };
}

const str = (v: unknown, max = 20_000) => (typeof v === "string" && v !== "" && v.length <= max ? v : undefined);
/** `<chat>:<message>` or a bare message id, in `chat`: the message id. */
function messageId(v: unknown, chat: number): number | undefined {
  const s = str(v, 60);
  const m = s && /^(?:(-?[0-9]{1,20}):)?([0-9]{1,20})$/.exec(s);
  if (!m || (m[1] !== undefined && Number(m[1]) !== chat)) return undefined;
  return Number(m[2]);
}

export function createSummon(d: { td: () => TdClient | undefined; store: Store; settings: Pick<Settings, "exclude">; run: Run; now?: () => number }) {
  const now = d.now ?? Date.now;
  const db = d.store.db;
  const watch = db.prepare(`INSERT OR REPLACE INTO summoned_chats (chat_id, until) VALUES (?, ?)`);
  const written = db.prepare(`SELECT state, message_id, text FROM writes WHERE id = ?`);

  /** The chat of a call, or the refusal: bad id 400, an excluded or secret chat 403, Telegram not connected 503. */
  async function chatOf(b: any): Promise<{ id: number; td: TdClient } | Reply> {
    const r = str(b?.resource, 22);
    if (!r || !/^-?[0-9]{1,20}$/.test(r)) return reply(400, { error: "resource must be a chat id" });
    const id = Number(r);
    if (d.settings.exclude.has(id)) return reply(403, { error: "this chat is excluded" });
    const td = d.td();
    if (!td) return reply(503, { error: "Telegram isn't connected" });
    const chat = await td.invoke<any>({ _: "getChat", chat_id: id });
    if (chat.type?._ === "chatTypeSecret") return reply(403, { error: "secret chats aren't supported" });
    watch.run(id, now() + WATCH_MS);
    return { id, td };
  }

  async function context(b: any): Promise<Reply> {
    const c = await chatOf(b);
    if ("status" in c) return c;
    const n = Number.isInteger(b?.n) && b.n > 0 ? Math.min(b.n, 100) : 20;
    let from = 0;
    if (b?.before !== undefined) {
      const before = messageId(b.before, c.id);
      if (before === undefined) return reply(400, { error: "before must be a message id" });
      from = before;
    }
    // TDLib may answer a page short of the limit: ask again from the oldest until n or the history ends.
    const got: any[] = [];
    for (let i = 0; i < 5 && got.length < n; i++) {
      const page = await c.td.invoke<{ messages?: (any | null)[] }>({ _: "getChatHistory", chat_id: c.id, from_message_id: got.length ? got[got.length - 1].id : from, offset: 0, limit: n - got.length, only_local: false });
      const ms = (page.messages ?? []).filter(Boolean);
      if (!ms.length) break;
      got.push(...ms);
    }
    const names = new Map<number, string>();
    const nameOf = async (s: any): Promise<string> => {
      if (s?._ !== "messageSenderUser") return String(s?.chat_id ?? "");
      if (!names.has(s.user_id)) {
        const u = await c.td.invoke<any>({ _: "getUser", user_id: s.user_id }).catch(() => undefined);
        names.set(s.user_id, [u?.first_name, u?.last_name].filter(Boolean).join(" ") || String(s.user_id));
      }
      return names.get(s.user_id)!;
    };
    const messages = [];
    for (const m of got.reverse())
      messages.push({
        id: `${c.id}:${m.id}`, author: await nameOf(m.sender_id), is_owner: !!m.is_outgoing,
        text: m.content?.text?.text ?? m.content?.caption?.text ?? `[${String(m.content?._ ?? "message").replace(/^message/, "").toLowerCase()}]`,
        ts: new Date(m.date * 1000).toISOString(),
      });
    return reply(200, { messages });
  }

  async function post(b: any): Promise<Reply> {
    const c = await chatOf(b);
    if ("status" in c) return c;
    const key = str(b?.key, 200);
    const text = str(b?.text, 4096);
    const to = messageId(b?.in_reply_to, c.id);
    if (!key || !text || to === undefined) return reply(400, { error: "send { resource, in_reply_to, text, key }" });
    // The writes row's id is the idempotency key's hash: the same key reaches the same row, which sends at most once.
    const id = `summon-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
    const { text: plain, entities } = renderLinks(text);
    const r = await d.run({ id, kind: "telegram.reply", digest: "", idempotency_key: key, args: { action: "reply", chat_id: String(c.id), reply_to_message_id: String(to), text: plain, agent: "summon" } }, entities);
    const w = written.get(id) as { state: string; message_id: number | null; text: string | null } | undefined;
    if (r.ok && w?.state === "done" && w.message_id) return reply(200, { id: `${c.id}:${w.message_id}` });
    return reply(r.text.startsWith("Send cap") ? 429 : 502, { error: r.text });
  }

  async function react(b: any): Promise<Reply> {
    const c = await chatOf(b);
    if ("status" in c) return c;
    const emoji = EMOJI[String(b?.emoji)];
    const mid = messageId(b?.message, c.id);
    if (!emoji || mid === undefined) return reply(400, { error: 'send { resource, message, emoji: "eyes" }' });
    await c.td.invoke({ _: "addMessageReaction", chat_id: c.id, message_id: mid, reaction_type: { _: "reactionTypeEmoji", emoji }, is_big: false, update_recent_reactions: true });
    return reply(200, {});
  }

  return {
    /** `context`, `reply` or `react` (the path after /summon/): a refusal or failure is a status the kernel reads. */
    async handle(op: string, body: unknown): Promise<Reply> {
      try {
        if (op === "context") return await context(body);
        if (op === "reply") return await post(body);
        if (op === "react") return await react(body);
        return reply(404, { error: "not found" });
      } catch (e) {
        return reply(e instanceof TdError ? 502 : 500, { error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    },
  };
}
