// Pairing: which Telegram chat is the owner's. That chat decides approval cards, so a code is
// minted only through the board (a signed-in admin with an authenticator; the board's bearer is this module's pair token).
// A code has 128 random bits, is kept only as its hash, is used once (one transaction with recording the chat), lives 15
// minutes, and each chat gets 5 wrong tries a minute. Only a private chat can pair: the owner checks compare the chat, not
// the sender, so a group would let every member decide.
import { createHash, randomBytes } from "node:crypto";
import type { Store, TakePairCode } from "./store.js";

/** Where a pairing outcome is said: a line per attempt, with the chat's id and no code or token. */
export type PairLog = { info: (fields: { chatId: number; reason?: TakePairCode | "limited" | "group" }, message: string) => void };

type PairStore = Pick<Store, "ownerChat" | "pairedAt" | "setOwnerChat" | "putPairCode" | "takePairCode">;

export const CODE_TTL_MS = 15 * 60_000;
const WRONG_LIMIT = 5;
const WINDOW_MS = 60_000;
const hash = (code: string) => createHash("sha256").update(code).digest("hex");

export function createPairing(store: PairStore, now: () => number = Date.now) {
  const wrong = new Map<number, number[]>();
  return {
    /** A new code; any earlier code stops working. */
    mint(): string {
      const code = randomBytes(16).toString("base64url");
      store.putPairCode(hash(code), now() + CODE_TTL_MS);
      return code;
    },
    /**
     * What `code` did for `chatId`. A chat over its wrong-try limit is refused without the code being looked at (and the
     * code stays live for another chat); an expired code is used up and says `expired`.
     */
    redeem(code: string, chatId: number): TakePairCode | "limited" {
      const t = now();
      const recent = (wrong.get(chatId) ?? []).filter((at) => t - at < WINDOW_MS);
      if (recent.length >= WRONG_LIMIT) return "limited";
      const took = store.takePairCode(hash(code), String(chatId), t);
      if (took === "paired") {
        wrong.delete(chatId);
        return "paired";
      }
      wrong.set(chatId, [...recent, t]);
      return took;
    },
    paired: (): boolean => Boolean(store.ownerChat()),
    /** The last pairing's time (ISO), or null: changes when a re-pair finishes. */
    pairedAt: (): string | null => store.pairedAt() ?? null,
  };
}
export type Pairing = ReturnType<typeof createPairing>;

/** Upgrade: an owner chat id from the host's .env is stored once, when the store has none. */
export function seedOwnerChat(store: PairStore, envChatId: string, log: (msg: string) => void): void {
  if (store.ownerChat() || !/^-?\d+$/.test(envChatId)) return;
  store.setOwnerChat(envChatId);
  log("owner chat seeded from env");
}

/**
 * A Telegram update that is `/start <code>` in a private chat: tries the code and answers. Returns whether the update was a
 * pairing attempt (so it goes no further). Sends are best effort: the code is already used, so a failed send never retries it.
 */
export async function handleStart(update: unknown, pairing: Pairing, store: PairStore, send: (chatId: string, text: string) => Promise<unknown>, log?: PairLog): Promise<boolean> {
  const msg = (update as { message?: { text?: unknown; chat?: { id?: unknown; type?: unknown } } })?.message;
  const m = typeof msg?.text === "string" ? /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(msg.text) : null;
  if (!m || typeof msg?.chat?.id !== "number") return false;
  const chatId = msg.chat.id;
  const say = (to: string, text: string) => send(to, text).catch(() => undefined);
  if (msg.chat.type !== "private") {
    log?.info({ chatId, reason: "group" }, "pairing refused: not a private chat");
    await say(String(chatId), "Pair AidenHQ from a private chat with this bot, not a group.");
    return true;
  }
  const before = store.ownerChat();
  const outcome = pairing.redeem(m[1]!, chatId);
  if (outcome !== "paired") {
    log?.info({ chatId, reason: outcome }, "pairing code rejected");
    await say(String(chatId), outcome === "expired" ? "That code expired. Make a new one on the board and tap its link." : "That code didn't work. Make a new one on the board and tap its link.");
    return true;
  }
  log?.info({ chatId }, "chat paired");
  if (before && before !== String(chatId)) await say(before, "This chat is no longer paired with AidenHQ.");
  await say(String(chatId), "Paired. Say hi to Aiden.");
  return true;
}

/** The bot's username, for the t.me deep link (Telegram's getMe). The token never leaves the request. */
export async function botUsername(token: string): Promise<string> {
  const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const j = (await r?.json().catch(() => null)) as { ok?: boolean; result?: { username?: unknown } } | null;
  const name = j?.ok ? j.result?.username : undefined;
  if (typeof name !== "string" || !/^\w{5,64}$/.test(name)) throw new Error("Telegram didn't accept the bot token (getMe failed)");
  return name;
}
