// The owner's inbox as a feed (gmail_inbox_new, gmail_inbox_ack): what arrived since the caller's cursor, with the obvious
// noise set aside in code before any model reads it. The feed lists the inbox broadly and drops Gmail's own categories
// (Promotions, Social, Updates, Forums) from each message's labelIds, with mailing-list and automated headers and no-reply
// senders, all counted, never shown; a message at or before the window start is counted too, so an empty feed explains
// itself. The cursor is a per-account receipt time (ms), kept per calling agent and moved only by an ack, so a run that
// fails before its ack sees the same mail again (task markers make that replay idempotent).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** The whole inbox except the owner's own mail: Gmail's categories are filtered from labelIds in code, not hidden by the
 *  query, so a message they would exclude still comes back and is counted under `dropped` instead of looking like nothing. */
export const INBOX_QUERY = "in:inbox -from:me";
/** A first call looks back a day; a cursor older than four days (paused over a long weekend and more) starts there. */
export const FIRST_LOOKBACK_MS = 86_400_000;
export const MAX_LOOKBACK_MS = 4 * 86_400_000;
/** Messages read per account and call (one metadata request each): past this the rest wait for the next call (`more`). */
export const MAX_READS = 200;
/** Metadata reads in flight at once: one request each, so a window full of mail overlaps its reads instead of walking them
 *  one at a time; the messages themselves are still decided oldest first, in order. */
export const READS_AT_ONCE = 8;
/** One inbox call's wall-clock budget for its listing and per-message walk (split across the accounts still to serve). Past
 *  it the rest is handed to the next call (`more`, cursor up to the last decided message), so a wide window answers inside the
 *  kernel's 300 s tool timeout instead of dying with neither threads nor a cursor. Thread enrichment follows, bounded by
 *  `limit` (50 threads = 7 batches of 8, at worst 210 s against the 30 s per-request timeout), and runs past this budget so
 *  every row it serves carries its real `replied`; the two together stay inside the timeout. */
export const INBOX_BUDGET_MS = 60_000;

/** A sender's local part that never reads replies. */
const NO_REPLY = /^(?:.*[-_.+])?(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?)(?:[-_.+].*)?$/i;

/** Gmail's noise categories, as the label each message carries and the `dropped` key it counts under. */
const CATEGORIES: Record<string, string> = {
  CATEGORY_PROMOTIONS: "category:promotions",
  CATEGORY_SOCIAL: "category:social",
  CATEGORY_UPDATES: "category:updates",
  CATEGORY_FORUMS: "category:forums",
};

/** Why a message belongs to one of Gmail's noise categories (from its own labels), or undefined for the main inbox. */
export function category(labelIds: readonly string[] | undefined): string | undefined {
  for (const label of labelIds ?? []) if (CATEGORIES[label]) return CATEGORIES[label];
  return undefined;
}

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

/** The addresses in an address header, lower-cased. */
const addresses = (s: string | undefined) => new Set((s ?? "").toLowerCase().match(/[^\s<>,;:"']+@[^\s<>,;:"']+/g) ?? []);

/** Whether `me` is on Cc and not on To. */
export function ccOnly(me: string, to: string | undefined, cc: string | undefined): boolean {
  const m = me.toLowerCase();
  return addresses(cc).has(m) && !addresses(to).has(m);
}

export type Cursor = Record<string, number>;

/** Each agent's inbox cursor, one small JSON file in the service's state dir. */
export class InboxCursors {
  /** The cursor gmail_inbox_new last gave each agent, in memory: an ack may move only up to it. After a restart nothing
   *  is offered, so an ack fails and the agent reads the feed again (task markers make the replay idempotent). */
  private readonly offered = new Map<string, Cursor>();

  constructor(private readonly file: string) {}

  private load(): Record<string, Cursor> {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Cursor>) : {};
  }

  get(agent: string): Cursor {
    return this.load()[agent] ?? {};
  }

  /** Records the cursor gmail_inbox_new just returned to this agent. */
  offer(agent: string, cursor: Cursor): void {
    this.offered.set(agent, { ...cursor });
  }

  /** Moves the agent's cursor forward to `cursor`, never back and never past what gmail_inbox_new last gave it. */
  ack(agent: string, cursor: Cursor): Cursor {
    const given = this.offered.get(agent) ?? {};
    const all = this.load();
    const mine = { ...(all[agent] ?? {}) };
    for (const [account, ms] of Object.entries(cursor)) {
      const max = given[account];
      if (!Number.isFinite(ms) || max === undefined || ms > max) throw new Error(`cursor for ${account} is not a time gmail_inbox_new gave; call gmail_inbox_new again`);
      mine[account] = Math.max(mine[account] ?? 0, ms);
    }
    all[agent] = mine;
    // Written whole and renamed into place: an interrupted ack leaves the last cursor readable.
    writeFileSync(`${this.file}.tmp`, JSON.stringify(all, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
    return mine;
  }
}

/** Where an account's scan starts: its cursor, else a day back, and never more than four days back. */
export function startOf(cursor: number | undefined, now = Date.now()): number {
  return Math.max(cursor ?? now - FIRST_LOOKBACK_MS, now - MAX_LOOKBACK_MS);
}
