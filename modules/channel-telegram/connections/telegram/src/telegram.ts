// Telegram output for owner messages: readable formatting and one-tap buttons, without letting agent text inject markup.
// Formatting: the text is HTML-escaped first, then a small markdown subset is rendered (bold, italics, headings, inline code,
// code blocks, bullets). Task IDs become links only through a host-configured URL template; a `[label](#/route)` link points
// at the board's own configured address and nowhere else, and any other agent link stays literal (Telegram links bare URLs
// itself), so a label can't hide a different URL.
// Buttons: each label is stored server-side; a press delivers exactly that label as the owner's message, once.
import { randomBytes } from "node:crypto";
import type { ChatMessage } from "./chat.js";
import type { Store } from "./store.js";

export const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A board's https address as a bare origin: anything else (unset, malformed) gives "" and links stay literal. */
const boardOrigin = (url?: string): string => { if (!url) return ""; try { return new URL(url).origin; } catch { return ""; } };
// An in-app route: a plain label, and a path (no host, scheme or markup) after "#/".
const ROUTE_LINK = /\[([^[\]\n<>`&*_]+)\]\(#\/([A-Za-z0-9][A-Za-z0-9\-._/]*)\)/g;

export function toTelegramHtml(text: string, taskUrl?: string, boardUrl?: string): string {
  const board = boardOrigin(boardUrl);
  const parts = escape(text).split(/```(?:[a-z]*)\n?([\s\S]*?)\n?```/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre>${part}</pre>`;
      // Inline code is kept as written, so a markdown link written inside it stays literal.
      let s = part
        .split(/(`[^`\n]+`)/)
        .map((seg, j) => {
          if (j % 2 === 1) return `<code>${seg.slice(1, -1)}</code>`;
          const out = seg
            .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, "<b>$1</b>")
            .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
            .replace(/__([^_\n]+)__/g, "<i>$1</i>")
            .replace(/^[ \t]*[-*] /gm, "• ");
          return board ? out.replace(ROUTE_LINK, (_, label: string, route: string) => `<a href="${board}/#/${route}">${label}</a>`) : out;
        })
        .join("");
      if (taskUrl) s = s.replace(/(?<![\w/-])([A-Z][A-Z0-9]*-\d+)\b(?![^<]*<\/code>)/g, (id) => `<a href="${escape(taskUrl.replace("{id}", id))}">${id}</a>`);
      return s;
    })
    .join("");
}

export type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

/** Stores each label under a random id; one row per button. undefined when there are no buttons. */
export function buttonsMarkup(store: Store, labels: string[]): InlineKeyboard | undefined {
  if (!labels.length) return undefined;
  if (labels.length > 4) throw new Error("at most 4 buttons");
  labels = labels.map((l) => l.normalize("NFC"));
  for (const l of labels) {
    if (/[\r\n]/.test(l) || !l.trim()) throw new Error("a button label is a single line of text");
    if (l.length > 40) throw new Error("a button label is at most 40 characters");
    // What the owner sees must be what is sent: printable ASCII only (labels are short commands), so no bidi overrides,
    // zero-width, filler or other invisible or look-alike characters.
    if (!/^[\x20-\x7E]+$/.test(l)) throw new Error("a button label is printable ASCII only (no invisible or look-alike characters)");
  }
  return {
    inline_keyboard: labels.map((label) => {
      const id = `b${randomBytes(8).toString("hex")}`;
      store.setKv(`btn:${id}`, label);
      return [{ text: label, callback_data: id }];
    }),
  };
}

const rec = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});

export interface ButtonPress {
  message: ChatMessage;
  chatId: string;
  messageId: number;
  label: string;
}

/** A button press from the owner chat → the owner's message (the label they saw). One-shot: the button is used up. */
export function fromTelegramCallback(update: unknown, ownerChatId: string, store: Store): ButtonPress | null {
  const cb = rec(rec(update).callback_query);
  const msg = rec(cb.message);
  const chatId = String(rec(msg.chat).id ?? "");
  if (!ownerChatId || chatId !== ownerChatId || typeof cb.data !== "string") return null;
  const key = `btn:${cb.data}`;
  const label = store.getKv(key);
  if (!label) return null;
  store.setKv(key, "");
  return { message: { source: "telegram", text: label, ...(msg.message_id ? { replyTo: String(msg.message_id) } : {}) }, chatId, messageId: Number(msg.message_id), label };
}
