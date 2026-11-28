// The telegram.<action> write kinds (module.yaml writes: send, reply, react, forward, edit, delete; one tool each), the executor
// side: an agent's telegram_send / _reply / _react / _forward / _edit_own / _delete_own call is a kernel record. plan resolves the chat and checks ownership; the AI reviewer reads every call first
// (floor 1). execute runs it as the owner's account with a persisted idempotency guard (the writes table, keyed by the record
// id) and a persisted rate cap (send_log). A send whose outcome is ambiguous (a restart mid-send, no TDLib answer in 60 s) is
// never retried blind: it answers "outcome unknown".
import type { ExecuteRequest, Executor } from "./aidenhq-sdk/executor.js";
import { fence } from "./aidenhq-sdk/fence.js";
import type { Store } from "./store.js";
import { TdError, type TdClient } from "./td.js";

export const SEND_CAP_PER_HOUR = 30;
export const CHAT_GAP_MS = 10_000;
const HOUR_MS = 3_600_000;
const POLL_MS = 100;
const POLL_TIMEOUT_MS = 60_000;

export type SendArgs = {
  action: "send" | "reply" | "react" | "forward" | "edit" | "delete";
  chat_id: string;
  agent: string;
  text?: string;
  reply_to_message_id?: string;
  message_id?: string;
  from_chat_id?: string;
  emoji?: string;
  chat_title?: string;
};

const ID = /^-?[0-9]{1,20}$/;
const UNKNOWN = "Outcome unknown: AidenHQ restarted while sending. Check the chat in Telegram before asking again.";
const UNKNOWN_TIMEOUT = "Outcome unknown: Telegram didn't confirm the message in time. Check the chat in Telegram before asking again.";

/** A message's words for a card: its text or caption, else its kind. */
const bodyOf = (m: any): string => m?.content?.text?.text ?? m?.content?.caption?.text ?? `[${String(m?.content?._ ?? "message").replace(/^message/, "").toLowerCase()}]`;

/** The action each write kind carries: the kernel authorised the kind by the tool the caller holds, so the args must be that action's. */
export const KIND_ACTION: Record<string, SendArgs["action"]> = { "telegram.send": "send", "telegram.reply": "reply", "telegram.react": "react", "telegram.forward": "forward", "telegram.edit": "edit", "telegram.delete": "delete" };

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** The record's args: the action is inferred from the arg shape (the six tool shapes are pairwise distinct) and must be the one the record's kind carries. */
export function normalise(a: any, agent: string, kind: string): SendArgs {
  const want = KIND_ACTION[kind];
  if (!want) throw new Error(`${kind} is not a telegram write kind`);
  const got = infer(a, agent);
  if (got.action !== want) throw new Error(`a ${kind} record can only ${want}; these args ${got.action}`);
  return got;
}

function infer(a: any, agent: string): SendArgs {
  if (!agent) throw new Error("telegram sends need a known agent (its run key) to sign the card");
  const chat_id = str(a?.chat_id);
  if (!chat_id || !ID.test(chat_id)) throw new Error("chat_id must be a chat id, e.g. -1001234567890");
  const text = str(a?.text)?.slice(0, 4096);
  const message_id = str(a?.message_id);
  const reply = str(a?.reply_to_message_id);
  const from = str(a?.from_chat_id);
  const emoji = str(a?.emoji);
  for (const [k, v] of [["message_id", message_id], ["reply_to_message_id", reply], ["from_chat_id", from]] as const) {
    if (v && !(k === "from_chat_id" ? ID : /^[0-9]{1,20}$/).test(v)) throw new Error(`${k} is not a valid id`);
  }
  const base = { chat_id, agent };
  if (from) {
    if (!message_id) throw new Error("forward needs message_id");
    return { ...base, action: "forward", from_chat_id: from, message_id };
  }
  if (emoji) {
    if (!message_id) throw new Error("react needs message_id");
    return { ...base, action: "react", message_id, emoji: emoji.slice(0, 16) };
  }
  if (reply && text) return { ...base, action: "reply", reply_to_message_id: reply, text };
  if (message_id && text) return { ...base, action: "edit", message_id, text };
  if (message_id) return { ...base, action: "delete", message_id };
  if (text) return { ...base, action: "send", text };
  throw new Error("not a telegram send: expected text, a reply, a reaction, a forward, an edit or a delete");
}

/** Runs a write record's execute with optional text entities. */
export type Run = (rec: ExecuteRequest, entities?: unknown[]) => Promise<{ ok: boolean; text: string }>;
const fmt = (t: number) => new Date(t).toISOString();
const content = (text: string, entities: unknown[] = []) => ({ _: "inputMessageText", text: { _: "formattedText", text, entities } });

export function sender(d: {
  td: () => TdClient | undefined;
  store: Store;
  onAgentSend: (chatId: number, tempId: number, writeId: string) => void;
  now?: () => number;
}): Executor & { run: Run } {
  const now = d.now ?? Date.now;
  const db = d.store.db;
  const getWrite = db.prepare(`SELECT state, text, message_id FROM writes WHERE id = ?`);
  const setWrite = db.prepare(`UPDATE writes SET state = ?, text = ?, message_id = ? WHERE id = ?`);
  const pending = db.prepare(`SELECT final_message_id, error FROM agent_pending WHERE chat_id = ? AND temp_message_id = ?`);

  const finish = (id: string, state: "done" | "failed" | "unknown", text: string, messageId?: number) => {
    setWrite.run(state, text, messageId ?? null, id);
    return { ok: state === "done", text };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    run: (rec, entities) => execute(rec, entities),
    async plan(req) {
      const td = d.td();
      if (!td) throw new Error("Telegram isn't connected: set it up on the board (#/setup/telegram)");
      const a = normalise(req.args, String(req.requester?.name ?? ""), req.kind);
      const chat = await td.invoke<any>({ _: "getChat", chat_id: Number(a.chat_id) });
      if (chat.type?._ === "chatTypeSecret") throw new Error("secret chats aren't supported");
      // The card's details: Telegram's words (a forwarded, edited or deleted message, a chat title) are fenced as data; the agent's own new text is not. The words the reviewer and the owner judge. A forward, an edit and a delete read the message they act on.
      let details = a.text ?? "";
      if (a.action === "edit" || a.action === "delete") {
        const m = await td.invoke<any>({ _: "getMessage", chat_id: Number(a.chat_id), message_id: Number(a.message_id) });
        if (!m.is_outgoing) throw new Error("only your own messages can be edited or deleted");
        const was = fence(bodyOf(m), `telegram:${a.chat_id}`);
        details = a.action === "edit" ? `Was: ${was}\nNow: ${a.text}` : `Deletes for everyone: ${was}`;
      } else if (a.action === "forward") {
        const m = await td.invoke<any>({ _: "getMessage", chat_id: Number(a.from_chat_id), message_id: Number(a.message_id) });
        const from = await td.invoke<any>({ _: "getChat", chat_id: Number(a.from_chat_id) });
        details = `Forwards from ${fence(String(from.title ?? a.from_chat_id).slice(0, 200), `telegram:${a.from_chat_id}`)}: ${fence(bodyOf(m), `telegram:${a.from_chat_id}`)}`;
      } else if (a.action === "react") details = a.emoji ?? "";
      const title = String(chat.title ?? a.chat_id).slice(0, 200);
      const what = { send: "send a message", reply: "reply to a message", react: `react ${a.emoji ?? ""} to a message`, forward: "forward a message", edit: "edit your message", delete: "delete your message" }[a.action];
      const who = chat.type?._ === "chatTypePrivate" ? `${title} sees it` : `Everyone in ${title} sees it`;
      return {
        args: { ...a, chat_title: title },
        targets: { chat_id: a.chat_id },
        card: { what, chat: fence(title, `telegram:${a.chat_id}`), changes: `${who}, from your own Telegram account.`, details },
      };
    },

    execute: (rec) => execute(rec),
  };

  async function execute(rec: ExecuteRequest, entities?: unknown[]): Promise<{ ok: boolean; text: string }> {
      // Everything up to the TDLib call is synchronous: no other execute can interleave with the guard, the cap and the row.
      const prev = getWrite.get(rec.id) as { state: string; text: string | null } | undefined;
      if (prev) {
        if (prev.state === "sending" || prev.state === "unknown") {
          if (prev.state === "sending") setWrite.run("unknown", UNKNOWN, null, rec.id);
          return { ok: false, text: prev.state === "unknown" && prev.text ? prev.text : UNKNOWN };
        }
        return { ok: prev.state === "done", text: prev.text ?? "" };
      }
      const td = d.td();
      if (!td) return { ok: false, text: "Telegram isn't connected: set it up on the board (#/setup/telegram)" };
      const a = normalise(rec.args, String(rec.args?.agent ?? ""), rec.kind);
      const chatId = Number(a.chat_id);
      const t = now();

      const recent = db.prepare(`SELECT at FROM send_log WHERE at > ? ORDER BY at`).all(t - HOUR_MS) as { at: number }[];
      if (recent.length >= SEND_CAP_PER_HOUR) return { ok: false, text: `Send cap reached (${SEND_CAP_PER_HOUR} an hour): try again after ${fmt(recent[0]!.at + HOUR_MS)}.` };
      const last = db.prepare(`SELECT MAX(at) AS at FROM send_log WHERE chat_id = ?`).get(chatId) as { at: number | null };
      if (last.at !== null && t - last.at < CHAT_GAP_MS) return { ok: false, text: `Send cap reached (one action per chat every ${CHAT_GAP_MS / 1000} s): try again after ${fmt(last.at + CHAT_GAP_MS)}.` };

      d.store.tx(() => {
        db.prepare(`INSERT INTO writes (id, state, chat_id, at, body) VALUES (?, 'sending', ?, ?, ?)`).run(rec.id, chatId, t, a.text ?? null);
        db.prepare(`INSERT INTO send_log (at, chat_id) VALUES (?, ?)`).run(t, chatId);
      });

      const title = a.chat_title ?? a.chat_id;
      try {
        if (a.action === "react") {
          await td.invoke({ _: "addMessageReaction", chat_id: chatId, message_id: Number(a.message_id), reaction_type: { _: "reactionTypeEmoji", emoji: a.emoji }, is_big: false, update_recent_reactions: true });
          return finish(rec.id, "done", `Reacted ${a.emoji} in ${title}.`, Number(a.message_id));
        }
        if (a.action === "edit") {
          await td.invoke({ _: "editMessageText", chat_id: chatId, message_id: Number(a.message_id), input_message_content: content(a.text!) });
          return finish(rec.id, "done", `Edited message ${a.message_id} in ${title}.`, Number(a.message_id));
        }
        if (a.action === "delete") {
          await td.invoke({ _: "deleteMessages", chat_id: chatId, message_ids: [Number(a.message_id)], revoke: true });
          return finish(rec.id, "done", `Deleted message ${a.message_id} in ${title}.`, Number(a.message_id));
        }
        let temp: any;
        if (a.action === "forward") {
          const r = await td.invoke<{ messages?: (any | null)[] }>({ _: "forwardMessages", chat_id: chatId, from_chat_id: Number(a.from_chat_id), message_ids: [Number(a.message_id)] });
          temp = r.messages?.[0];
        } else {
          temp = await td.invoke<any>({
            _: "sendMessage",
            chat_id: chatId,
            ...(a.action === "reply" ? { reply_to: { _: "inputMessageReplyToMessage", message_id: Number(a.reply_to_message_id) } } : {}),
            input_message_content: content(a.text!, entities),
          });
        }
        if (typeof temp?.id !== "number") throw new TdError(500, "Telegram returned no message for the send");
        d.onAgentSend(chatId, temp.id, rec.id);
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        for (;;) {
          const p = pending.get(chatId, temp.id) as { final_message_id: number | null; error: string | null } | undefined;
          if (p?.final_message_id) return finish(rec.id, "done", `Sent to ${title} (message ${p.final_message_id}).`, p.final_message_id);
          if (p?.error) return finish(rec.id, "failed", `Telegram refused the message: ${p.error}`);
          if (Date.now() >= deadline) return finish(rec.id, "unknown", UNKNOWN_TIMEOUT);
          await sleep(POLL_MS);
        }
      } catch (e) {
        // A TDLib error is Telegram's definite answer; anything else (a dropped client) leaves the outcome open.
        if (e instanceof TdError) return finish(rec.id, "failed", `Telegram refused: ${e.message}`);
        return finish(rec.id, "unknown", UNKNOWN);
      }
  }
}
