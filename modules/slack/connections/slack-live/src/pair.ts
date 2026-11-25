// Pairing the owner's Slack account: the board (a signed-in admin with an authenticator) mints a one-time code, and the owner
// DMs it to the bot. The DM gives the owner's Slack user id and the DM channel (the command channel); nothing is typed or guessed.
import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

const TTL_MS = 15 * 60_000;
const WINDOW_MS = 60_000;
const MAX_WRONG = 5;
const CODE = /^[A-Za-z0-9_-]{22}$/; // randomBytes(16) as base64url
const hash = (code: string): string => createHash("sha256").update(code).digest("hex");

export interface Owner {
  user: string;
  channel: string; // the DM with the bot
}

export function createPairing(db: Database.Database, now: () => number = Date.now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pair_codes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pair_wrong (user_id TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pair_owner (id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT NOT NULL, channel TEXT NOT NULL, paired_at INTEGER);`);
  // A store made before paired_at existed.
  if (!(db.prepare(`PRAGMA table_info(pair_owner)`).all() as { name: string }[]).some((c) => c.name === "paired_at")) db.exec(`ALTER TABLE pair_owner ADD COLUMN paired_at INTEGER`);
  const getOwner = db.prepare(`SELECT user_id, channel FROM pair_owner WHERE id = 1`);
  const setOwner = db.prepare(`INSERT OR REPLACE INTO pair_owner (id, user_id, channel, paired_at) VALUES (1, ?, ?, ?)`);
  const owner = (): Owner | undefined => {
    const r = getOwner.get() as { user_id: string; channel: string } | undefined;
    return r && { user: r.user_id, channel: r.channel };
  };

  const redeemTx = db.transaction((code: string, user: string, channel: string): { ok: boolean; previous?: Owner } => {
    const t = now();
    db.prepare(`DELETE FROM pair_wrong WHERE at < ?`).run(t - WINDOW_MS);
    const wrong = (db.prepare(`SELECT COUNT(*) AS n FROM pair_wrong WHERE user_id = ?`).get(user) as { n: number }).n;
    if (wrong >= MAX_WRONG) return { ok: false };
    // Consumed in the same statement that checks it: two DMs of one code cannot both win.
    if (db.prepare(`DELETE FROM pair_codes WHERE hash = ? AND expires_at >= ?`).run(hash(code), t).changes !== 1) {
      db.prepare(`INSERT INTO pair_wrong (user_id, at) VALUES (?, ?)`).run(user, t);
      return { ok: false };
    }
    const old = owner();
    setOwner.run(user, channel, t);
    return { ok: true, ...(old && (old.user !== user || old.channel !== channel) ? { previous: old } : {}) };
  });

  return {
    owner,
    paired: (): boolean => owner() !== undefined,
    /** When the owner last paired (ISO). */
    pairedAt(): string | undefined {
      const at = (db.prepare(`SELECT paired_at AS at FROM pair_owner WHERE id = 1`).get() as { at: number | null } | undefined)?.at;
      return at ? new Date(at).toISOString() : undefined;
    },
    mint(): string {
      const code = randomBytes(16).toString("base64url");
      db.prepare(`DELETE FROM pair_codes`).run(); // a new code replaces any earlier one
      db.prepare(`INSERT INTO pair_codes (hash, expires_at) VALUES (?, ?)`).run(hash(code), now() + TTL_MS);
      return code;
    },
    redeem: (code: string, user: string, channel: string) => redeemTx(code, user, channel),
  };
}
export type Pairing = ReturnType<typeof createPairing>;

type Body = { event?: Record<string, string>; authorizations?: { is_bot?: boolean }[] } | null;

/** Does the event name a bot install at all? Slack truncates `authorizations` to one arbitrary entry, so it is a hint, not the gate. */
const namesBot = (b: Body): boolean => Boolean(b?.authorizations?.some((a) => a?.is_bot === true));

/** "bot": this DM is with the bot. "other": the bot cannot see it (a DM between two people). "unknown": the lookup itself failed. */
type BotDm = "bot" | "other" | "unknown";

/**
 * Is this DM one with this bot, rather than the owner's DM with another person? The bot token answers it: the bot sees its own
 * DMs (`conversations.info` -> `is_im`), while a DM between two people answers `channel_not_found`/`missing_scope`. A lookup that
 * itself failed (network, 5xx, rate limit) is "unknown", and the event's `authorizations` naming a bot makes it a "bot" DM.
 */
async function botDm(b: Body, channel: string, botToken: string, doFetch: typeof fetch): Promise<BotDm> {
  const fallback = (): BotDm => (namesBot(b) ? "bot" : "unknown");
  if (!botToken) return fallback();
  let res: Response;
  try {
    res = await doFetch(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(channel)}`, { headers: { authorization: `Bearer ${botToken}` }, signal: AbortSignal.timeout(2_500) });
  } catch {
    return fallback();
  }
  if (res.status >= 500 || res.status === 429) return fallback();
  const j = (await res.json().catch(() => undefined)) as { ok?: boolean; channel?: { is_im?: boolean }; error?: string } | undefined;
  if (!j) return fallback();
  if (j.ok) return j.channel?.is_im === true ? "bot" : "other";
  // The bot token could not see the channel: a DM between other people, never a pairing DM.
  if (j.error === "channel_not_found" || j.error === "missing_scope" || j.error === "not_in_channel") return "other";
  return fallback();
}

export interface PairingDeps {
  /** The bot token: the DM channel is looked up with it, so a code pasted into a two-person DM pairs nobody. */
  botToken?: string;
  /** The HTTP client (tests replace it). */
  fetch?: typeof fetch;
}

/**
 * A DM to the bot that is a pairing code. Only a DM with this bot counts: the owner's user-token events also carry their DMs with
 * other people, and a code pasted there pairs nobody. Returns true when the event was a code attempt (right or wrong), so it
 * goes no further (not to triage, not to src_slack).
 */
export async function handlePairingDm(
  pairing: Pairing,
  body: unknown,
  say: (channel: string, text: string) => Promise<unknown>,
  onPaired: (owner: Owner) => void,
  deps: PairingDeps = {},
): Promise<boolean> {
  const b = body as Body;
  const ev = b?.event;
  if (!ev || ev.type !== "message" || ev.channel_type !== "im" || ev.subtype || ev.bot_id || !ev.user || !ev.channel) return false;
  const code = ev.text?.trim() ?? "";
  if (!CODE.test(code)) return false;
  // The code is checked before the lookup, so ordinary chat in the DM costs no Slack API call.
  const dm = await botDm(b, ev.channel, deps.botToken ?? "", deps.fetch ?? fetch);
  // A DM between two people is not ours to answer, and pairing it must fail before the code is even looked at.
  if (dm === "other") return false;
  // The lookup could not say whether the bot sees this DM: a code that may be a pairing credential never goes on to ingestion.
  if (dm === "unknown") {
    await say(ev.channel, "I couldn't check that DM with the bot. Try again in a moment.").catch(() => undefined);
    return true;
  }
  const r = pairing.redeem(code, ev.user, ev.channel);
  if (!r.ok) {
    // Slack redelivers an event whose slow lookup outran its 3 s ack; the first delivery already paired this very DM.
    const already = pairing.owner();
    if (already && already.user === ev.user && already.channel === ev.channel) return true;
    await say(ev.channel, "That code didn't work. Make a new one on the AidenHQ board.");
    return true;
  }
  onPaired({ user: ev.user, channel: ev.channel });
  await say(ev.channel, "Paired. Say hi to Aiden.");
  if (r.previous) await say(r.previous.channel || r.previous.user, "This Slack account is no longer paired with AidenHQ.");
  return true;
}
