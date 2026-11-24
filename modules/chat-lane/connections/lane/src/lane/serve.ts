// The lane's edges: the scan of each lane agent's chat task (what the owner wrote on the board), each lane agent's own
// Telegram bot (the owner's chat only), and the wake ticker (wake_at).
import { ownerText, toTelegramHtml } from "./tg.js";
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

/** Every few seconds, each lane agent's chat is checked for an owner message with no reply yet (written on the board, or left by a restart). */
export function startScan(o: { lane: Lane; agents: () => Record<string, LaneAgent>; log: Log; everyMs?: number }) {
  const pass = () => {
    for (const key of Object.keys(o.agents())) if (!o.lane.busy(key)) void o.lane.poke(key).catch((e: Error) => o.log.warn({ agent: key, err: e.message }, "lane chat check failed"));
  };
  pass();
  return setInterval(pass, o.everyMs ?? 3000).unref();
}

/**
 * The owner's Telegram chat, as channel-telegram paired it (GET <telegramUrl>/owner-chat): asked now and every 30 s, the last
 * answer kept in the lane's store so a restart while channel-telegram is down still knows it.
 */
export function followOwnerChat(o: { telegramUrl: string; getKv: (k: string) => string | undefined; setKv: (k: string, v: string) => void; log: Log }): { current: () => string; refresh: () => Promise<void> } {
  const refresh = async () => {
    try {
      const r = await fetch(`${o.telegramUrl}/owner-chat`, { signal: AbortSignal.timeout(5000) });
      const j = (await r.json()) as { chat_id?: unknown };
      if (r.ok && typeof j.chat_id === "string" && /^-?\d+$/.test(j.chat_id) && j.chat_id !== o.getKv("owner_chat")) {
        o.setKv("owner_chat", j.chat_id);
        o.log.info({}, "owner chat updated from channel-telegram");
      }
    } catch (err) {
      o.log.warn({ err: String(err) }, "couldn't ask channel-telegram for the owner chat; keeping the last one");
    }
  };
  void refresh();
  setInterval(refresh, 30_000).unref();
  return { current: () => o.getKv("owner_chat") ?? "", refresh };
}

/** Each lane agent with its own bot: long-poll it for the owner's chat (anyone else is ignored). Started as config adds them. */
export function startLaneTelegram(o: { lane: Lane; agents: () => Record<string, LaneAgent>; ownerChatId: () => string; getKv: (k: string) => string | undefined; setKv: (k: string, v: string) => void; log: Log }) {
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
        // The offset moves past a message only once it is on the chat task (posted once per update id), so none is lost.
        for (const u of data.result ?? []) {
          const m = ownerText(u, o.ownerChatId());
          if (m) await o.lane.heard(key, `tg-${key}-${u.update_id}`, m, "telegram");
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
    if (!o.ownerChatId()) return;
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
  /** A wake for the task's agent in the kernel's wake inbox (POST /v1/wakes, keyed by the wake's id so it is filed once). */
  wakeTask: (id: number, task: string, note: string) => Promise<void>;
  /** Whether that task is done or cancelled: a wake left on finished work is dropped, never posted back onto it. */
  taskIsClosed: (task: string) => Promise<boolean>;
  log: Log;
}

/**
 * One wake pass: a lane agent's due chat wake runs a lane turn in its chat; any other goes into the kernel's wake inbox for
 * its task's agent — unless the task has finished, in which case the wake is released and nothing is filed. Due wakes are taken (marked fired) first so two passes never file one twice; one that fails to be delivered is released and retried next pass.
 * The same pass runs what the lane owes (lane.tick).
 */
export async function wakePass(o: WakeDeps): Promise<void> {
  for (const w of o.store.takeDue()) {
    try {
      if (w.chat && o.agents()[w.agent]) void o.lane.wake(w.agent, w.note).catch((e: Error) => o.log.warn({ wake: w.id, err: e.message }, "chat wake failed"));
      else if (!w.task) o.log.warn({ wake: w.id, agent: w.agent }, "wake had nowhere to go");
      else if (await o.taskIsClosed(w.task)) o.log.info({ wake: w.id, agent: w.agent, task: w.task }, "wake dropped: its task is done or cancelled");
      else await o.wakeTask(w.id, w.task, w.note);
    } catch (e) {
      // Not delivered: due again next pass (the kernel files a wake once per id), unless its task is gone (404).
      const gone = (e as { status?: number }).status === 404;
      if (!gone) o.store.unfire(w.id);
      o.log.warn({ wake: w.id, err: (e as Error).message }, gone ? "wake dropped: its task is gone" : "wake failed; retried next pass");
    }
  }
  await o.lane.tick().catch((e: Error) => o.log.warn({ err: e.message }, "lane owed pass failed"));
}

/** Fires due wakes every 15 s (wakePass); on start, turns a restart cut off are owed first (lane.resume). */
export function startWakes(o: WakeDeps) {
  void o.lane.resume().then(() => wakePass(o));
  return setInterval(() => void wakePass(o), 15_000).unref();
}
