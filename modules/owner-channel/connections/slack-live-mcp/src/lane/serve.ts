// The lane's edges: the board's internal API (a lane agent's board chat), each lane agent's own Telegram bot (the owner's
// chat only), and the wake ticker (wake_at).
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatComment, fromTelegram } from "../chat.js";
import { toTelegramHtml } from "../telegram.js";
import type { LaneAgent } from "./config.js";
import type { Lane } from "./lane.js";
import type { LaneStore } from "./store.js";

type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

/** Sends a lane reply to Telegram as the agent's own bot (HTML-escaped; long text split under Telegram's limit). */
export async function telegramSend(token: string, chatId: string, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += 3800) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: toTelegramHtml(text.slice(i, i + 3800)), parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`telegram sendMessage ${res.status}`);
  }
}

/**
 * GET  /lane/agents                       → {agents: [{key, id, name}]}
 * GET  /lane/<key>/messages?after=<id>    → {messages: [{id, role, text, at}], busy}   (the board conversation)
 * POST /lane/<key>/messages {text, by?}   → 202 {id}: stored, and a turn answers it
 * Bearer: the board's internal token. undefined when the path isn't the lane's.
 */
export function laneRoutes(o: { lane: Lane; store: LaneStore; agents: () => Record<string, LaneAgent>; token: string; log: Log }) {
  const authed = (req: IncomingMessage) => {
    const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(o.token);
    return o.token.length > 0 && got.length === want.length && timingSafeEqual(got, want);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith("/lane/")) return false;
    if (!authed(req)) return json(res, 401, { error: "unauthorized" }), true;
    if (req.method === "GET" && url.pathname === "/lane/agents") return json(res, 200, { agents: Object.values(o.agents()).map((a) => ({ key: a.key, id: a.id, name: a.name })) }), true;
    const m = /^\/lane\/([a-z0-9_-]+)\/messages$/.exec(url.pathname);
    const agent = m ? o.agents()[m[1]!] : undefined;
    if (!agent) return json(res, 404, { error: "no such lane agent" }), true;
    if (req.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      return json(res, 200, { messages: o.store.after(agent.key, "board", after).map((x) => ({ id: x.id, role: x.role, text: x.text, at: x.at })), busy: o.lane.busy(agent.key, "board") }), true;
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { text?: unknown; by?: unknown } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
      const text = typeof body.text === "string" ? body.text.trim().slice(0, 8000) : "";
      if (!text) return json(res, 400, { error: "send {text}" }), true;
      // Another admin than the owner is labelled, as on the board's own chats.
      const by = typeof body.by === "string" && body.by.trim() ? `(by ${body.by.trim().slice(0, 60)}) ` : "";
      void o.lane.receive(agent.key, "board", `${by}${text}`).catch((e: Error) => o.log.warn({ agent: agent.key, err: e.message }, "board lane message failed"));
      return json(res, 202, { ok: true }), true;
    }
    return json(res, 405, { error: "method not allowed" }), true;
  };
}

/** Each lane agent with its own bot: long-poll it for the owner's chat (anyone else is ignored). Started as config adds them. */
export function startLaneTelegram(o: { lane: Lane; agents: () => Record<string, LaneAgent>; ownerChatId: string; getKv: (k: string) => string | undefined; setKv: (k: string, v: string) => void; log: Log }) {
  const polling = new Set<string>();
  const poll = async (key: string, token: string) => {
    const still = () => o.agents()[key]?.telegramToken === token;
    o.log.info({ agent: key }, "lane telegram polling started");
    while (still()) {
      try {
        const offset = Number(o.getKv(`lane_tg_offset:${key}`) ?? 0);
        const q = new URLSearchParams({ timeout: "30", offset: String(offset), allowed_updates: '["message"]' });
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?${q}`, { signal: AbortSignal.timeout(45_000) });
        const data = (await res.json()) as { ok?: boolean; result?: { update_id: number }[] };
        if (!data.ok) throw new Error(`getUpdates ${res.status}`);
        for (const u of data.result ?? []) {
          const m = fromTelegram(u, o.ownerChatId);
          if (m) void o.lane.receive(key, `telegram:${o.ownerChatId}`, m.forward ? formatComment(m).replace(/^\[telegram\] /, "") : m.text).catch((e: Error) => o.log.warn({ agent: key, err: e.message }, "lane telegram message failed"));
          o.setKv(`lane_tg_offset:${key}`, String(u.update_id + 1));
        }
      } catch (err) {
        o.log.warn({ agent: key, err: String(err).replace(token, "***") }, "lane telegram poll failed; retrying");
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    polling.delete(token);
  };
  const check = () => {
    if (!o.ownerChatId) return;
    for (const a of Object.values(o.agents())) {
      if (!a.telegramToken || polling.has(a.telegramToken)) continue;
      polling.add(a.telegramToken);
      void poll(a.key, a.telegramToken);
    }
  };
  check();
  return setInterval(check, 30_000).unref();
}

export interface WakeDeps {
  store: LaneStore;
  lane: Lane;
  agents: () => Record<string, LaneAgent>;
  noticeOnTask: (task: string, text: string) => Promise<void>;
  /** Whether that task is done or cancelled: a wake left on finished work is dropped, never posted back onto it. */
  taskIsClosed: (task: string) => Promise<boolean>;
  log: Log;
}

/**
 * One wake pass: a lane agent's due wake with a conversation runs a lane turn there; any other is a labelled notice on its
 * task, which wakes that task's agent through Paperclip — unless the task has finished, in which case the wake is released
 * and nothing is posted. Due wakes are taken (marked fired) before their task is checked, so a dropped wake never returns.
 * The same pass runs what the lane owes (lane.tick).
 */
export async function wakePass(o: WakeDeps): Promise<void> {
  for (const w of o.store.takeDue()) {
    try {
      if (w.conversation && o.agents()[w.agent]) void o.lane.receive(w.agent, w.conversation, w.note, "wake");
      else if (!w.task) o.log.warn({ wake: w.id, agent: w.agent }, "wake had nowhere to go");
      else if (await o.taskIsClosed(w.task)) o.log.info({ wake: w.id, agent: w.agent, task: w.task }, "wake dropped: its task is done or cancelled");
      else await o.noticeOnTask(w.task, `[wake] ${w.note}`);
    } catch (e) {
      o.log.warn({ wake: w.id, err: (e as Error).message }, "wake failed");
    }
  }
  await o.lane.tick().catch((e: Error) => o.log.warn({ err: e.message }, "lane owed pass failed"));
}

/** Fires due wakes every 15 s (wakePass); on start, turns a restart cut off are owed first (lane.resume). */
export function startWakes(o: WakeDeps) {
  o.lane.resume();
  void wakePass(o);
  return setInterval(() => void wakePass(o), 15_000).unref();
}
