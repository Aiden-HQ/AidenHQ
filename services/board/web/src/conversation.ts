// The conversation's shape, pure so it can be tested without React: which lines fold together, which approval cards
// fold to one line, the chat's short title, and which chats are throwaway tests.
import type { Approval, ChatMessage } from "./types.js";

/**
 * A system line that only reports progress: runner and agent notes, wake-ups and approval outcomes (the card shows
 * those too). A failure, a file the board couldn't read and someone else's opening words stay in the conversation.
 */
export function isNoise(m: ChatMessage): boolean {
  if (m.kind === "notes") return true;
  if (m.kind !== "notice") return false;
  return !/^(Someone else opened this|I couldn't read|\*\*Failed:\*\*)/.test(m.text);
}

export type Folded<T> = T | { type: "fold"; key: string; at: string; until: string; items: T[] };

/**
 * Two or more noise lines in a row (same day, nothing else between them) become one fold, keyed by its first line so
 * it stays open while new lines arrive. A lone line is left as it is.
 */
export function foldNoise<T extends { at: string; key: string }>(items: T[], noise: (it: T) => boolean): Folded<T>[] {
  const out: Folded<T>[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length > 1) out.push({ type: "fold", key: `fold:${run[0]!.key}`, at: run[0]!.at, until: run.at(-1)!.at, items: run });
    else out.push(...run);
    run = [];
  };
  for (const it of items) {
    if (!noise(it)) {
      flush();
      out.push(it);
      continue;
    }
    if (run.length && new Date(run[0]!.at).toDateString() !== new Date(it.at).toDateString()) flush();
    run.push(it);
  }
  flush();
  return out;
}

/** How many updates a fold holds: each note counts, so "Runner · 5 notes" plus a wake-up is 6. */
export const foldCount = (ms: ChatMessage[]) => ms.reduce((n, m) => n + (m.kind === "notes" ? m.notes.length : 1), 0);

type Outcome = { text: string; tone: "ok" | "bad" | "meh" | "needs" };
/** One word for where an approval ended. */
export function outcomeOf(a: Approval): Outcome {
  if (a.state === "pending") return a.tier === 1 ? { text: "With the reviewer", tone: "meh" } : { text: "Pending", tone: "needs" };
  if (a.state === "auto") return { text: a.outcome === "failed" ? "Ran, failed" : "Ran (Tier 0)", tone: a.outcome === "failed" ? "bad" : "ok" };
  if (a.outcome === "applied") return { text: "Applied", tone: "ok" };
  if (a.outcome === "failed") return { text: "Failed", tone: "bad" };
  if (a.state === "unknown") return { text: "Unknown", tone: "bad" };
  if (a.state === "rejected") return { text: "Rejected", tone: "meh" };
  if (a.state === "expired") return { text: /replaced/.test(a.outcomeText ?? "") || a.replaced ? "Replaced" : "Expired", tone: "meh" };
  return { text: "Applying", tone: "meh" };
}

/**
 * A card in a conversation folds to one line once it is decided; a pending one stays whole with its buttons. A card
 * the owner decides while looking at it (`seenPending`) stays open so it doesn't jump away under the tap.
 */
export const foldsInChat = (a: Approval, seenPending: boolean) => a.state !== "pending" && !seenPending;

/**
 * A card while the owner's tap is on its way: decided their way at once. The board's copy wins as soon as it has moved
 * on from pending; a refused tap clears `tapped`, which puts the card back as it was.
 */
export function shownDecision(a: Approval, tapped: "approve" | "reject" | null): Approval {
  if (!tapped || a.state !== "pending") return a;
  return { ...a, state: tapped === "approve" ? "approved" : "rejected", decidedBy: "account:you" };
}

/** Who decided a card, in words: a named admin, you (your tap or reply), the AI reviewer, or the stamp itself (watcher). */
export function deciderOf(a: Pick<Approval, "decidedBy" | "decidedByName">): string {
  if (a.decidedByName) return a.decidedByName;
  const d = a.decidedBy ?? "";
  if (!d || d.startsWith("auto:")) return "";
  if (d.startsWith("account:") || d.startsWith("owner:")) return "you";
  if (d.startsWith("reviewer:")) return "the AI reviewer";
  return d;
}

/**
 * A chat's title for its header: the first sentence or clause of its first line (the server keeps 80 characters of
 * it), cut at a word near `max` when there is none. The full title is on hover.
 */
export function shortTitle(title: string, max = 56): string {
  const t = title.trim();
  if (t.length <= max) return t;
  const stop = /[.!?](\s|$)| — | – | - /.exec(t);
  if (stop && stop.index >= 12 && stop.index <= max) return t.slice(0, stop.index);
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,:;(—–-]+$/, "")}…`;
}

/** A throwaway test chat ("TEST …", "(throwaway …)"): listed under a folded Tests bucket. */
export const isTestChat = (title: string) => /^\s*\[?TEST\b/.test(title) || /\bthrowaway\b/i.test(title);
