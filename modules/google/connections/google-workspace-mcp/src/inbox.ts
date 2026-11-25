// The owner's inbox as a feed (gmail_inbox_new, gmail_inbox_ack): what arrived since the caller's cursor, with the obvious
// noise set aside in code before any model reads it. Gmail's own categories (Promotions, Social, Updates, Forums) are left
// out by the query; mailing-list and automated headers and no-reply senders are dropped here, counted, never shown.
// The cursor is a per-account receipt time (ms), kept per calling agent and moved only by an ack, so a run that fails
// before its ack sees the same mail again (task markers make that replay idempotent).
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const INBOX_QUERY = "in:inbox -from:me -category:promotions -category:social -category:updates -category:forums";
/** A first call looks back a day; a cursor older than four days (paused over a long weekend and more) starts there. */
export const FIRST_LOOKBACK_MS = 86_400_000;
export const MAX_LOOKBACK_MS = 4 * 86_400_000;
/** Message ids listed per account and call: past this the oldest wait (Gmail lists newest first); `truncated` says so. */
export const MAX_IDS = 2000;

/** A sender's local part that never reads replies. */
const NO_REPLY = /^(?:.*[-_.+])?(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?)(?:[-_.+].*)?$/i;

/** Why a message is automated mail (a list, bulk, an auto-reply, a no-reply sender), or undefined for a person's mail. */
export function automated(h: (name: string) => string | undefined): "list" | "bulk" | "auto" | "no-reply" | undefined {
  if (h("List-Unsubscribe") || h("List-Id")) return "list";
  if (/^\s*(bulk|list|junk)\b/i.test(h("Precedence") ?? "")) return "bulk";
  const auto = h("Auto-Submitted");
  if (auto && !/^\s*no\b/i.test(auto)) return "auto";
  const addr = /<([^>]+)>/.exec(h("From") ?? "")?.[1] ?? h("From") ?? "";
  if (NO_REPLY.test(addr.split("@")[0]!.trim())) return "no-reply";
  return undefined;
}

/** Whether `me` is on Cc and not on To. */
export function ccOnly(me: string, to: string | undefined, cc: string | undefined): boolean {
  const has = (s: string | undefined) => (s ?? "").toLowerCase().includes(me.toLowerCase());
  return has(cc) && !has(to);
}

export type Cursor = Record<string, number>;

/** Each agent's inbox cursor, one small JSON file in the service's state dir. */
export class InboxCursors {
  constructor(private readonly file: string) {}

  private load(): Record<string, Cursor> {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Cursor>) : {};
  }

  get(agent: string): Cursor {
    return this.load()[agent] ?? {};
  }

  /** Moves the agent's cursor forward to `cursor` (never back; never past now). */
  ack(agent: string, cursor: Cursor, now = Date.now()): Cursor {
    const all = this.load();
    const mine = { ...(all[agent] ?? {}) };
    for (const [account, ms] of Object.entries(cursor)) {
      if (!Number.isFinite(ms) || ms > now) throw new Error(`cursor for ${account} is not a time gmail_inbox_new gave`);
      mine[account] = Math.max(mine[account] ?? 0, ms);
    }
    all[agent] = mine;
    writeFileSync(this.file, JSON.stringify(all, null, 2));
    return mine;
  }
}

/** Where an account's scan starts: its cursor, else a day back, and never more than four days back. */
export function startOf(cursor: number | undefined, now = Date.now()): number {
  return Math.max(cursor ?? now - FIRST_LOOKBACK_MS, now - MAX_LOOKBACK_MS);
}
