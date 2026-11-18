// The breaker on identical failures (owner, 2026-11-15): a task that fails the same way twice stops retrying and waits for
// whoever asked for the work. One day a single task pushed 46 times in 95 minutes into the same red check. Pure: the
// runner reads the failures and does the I/O.
import { createHash } from "node:crypto";

/** Identical failures on different attempts (heads) that stop the task. */
export const TRIP_AT = 2;

/**
 * GitHub's text for a failure, made comparable across heads: no timestamps, commit ids or numbers (durations, line
 * numbers, run ids), whitespace collapsed. What still differs (a temp path, another test) reads as another failure, so
 * an unclear case keeps retrying rather than stopping good work.
 */
export const normalize = (text: unknown): string =>
  String(text ?? "")
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "")
    .replace(/\b[0-9a-f]{7,64}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);

/**
 * A head's failed checks [{ name, lines: [GitHub's failure text…] }] → { sig, short }, or undefined when nothing was read
 * (unknown is never "the same"). `short` is for the notice: the first failure line, as GitHub wrote it.
 */
/** A failed check as GitHub reported it: its name and its failure lines. */
export interface FailedCheck {
  name?: string;
  lines?: string[];
}
export interface Signature {
  sig: string;
  short: string;
}
/** A target's breaker entry: the failure's signature, its first line, and the heads that failed that way. */
export interface BreakerEntry extends Signature {
  heads: string[];
}

export function checkSignature(failed: FailedCheck[] | null | undefined): Signature | undefined {
  const known = (failed ?? []).filter((f): f is FailedCheck & { name: string } => Boolean(f?.name));
  if (!known.length) return undefined;
  const parts = known.map((f): [string, string[]] => [String(f.name), [...new Set((f.lines ?? []).map(normalize).filter(Boolean))].sort()]).sort((a, b) => a[0].localeCompare(b[0]));
  const sig = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
  const first = known.find((f) => f.lines?.length) ?? known[0]!;
  const short = `${first.name}: ${String(first.lines?.find(Boolean) ?? "failed").replace(/\s+/g, " ").trim()}`.slice(0, 300);
  return { sig, short };
}

/**
 * One failure recorded on a target's entry ({ sig, heads, short } or undefined) → the new entry, and whether it trips.
 * Counted per attempt: the same head seen again is one failure, a new head with the same signature is the next, and a
 * different signature starts over.
 */
export function record(entry: BreakerEntry | undefined, { sig, short }: Signature, head: string): { entry: BreakerEntry; tripped: boolean } {
  const next: BreakerEntry = entry?.sig === sig ? { ...entry, heads: entry.heads.includes(head) ? entry.heads : [...entry.heads, head] } : { sig, short, heads: [head] };
  return { entry: next, tripped: next.heads.length >= TRIP_AT };
}

/**
 * Failed rounds on one check that stop the task (owner, 2026-11-17, from the Claude Code team's practice): a check still red
 * after three fix rounds goes to whoever asked, with the reason, instead of a fourth try. Unlike the identical-failure trip
 * above, the failure text may change from round to round.
 */
export const ROUNDS_AT = 3;
/** One check's run of consecutive red heads, and its failure lines on the last of them. */
export interface RoundsEntry {
  heads: string[];
  lines: string[];
}

/**
 * One red head's failed checks (the code's only, never the environment's) on a PR → each check's run of consecutive red heads,
 * and the first check that reached ROUNDS_AT. The same head seen again is one round; a check that didn't fail on this head
 * starts over. A head with nothing read is no round at all: the caller skips it, so it neither counts nor resets.
 */
export function rounds(prev: Record<string, RoundsEntry> | undefined, failed: FailedCheck[], head: string): { next: Record<string, RoundsEntry>; tripped?: string } {
  const next: Record<string, RoundsEntry> = {};
  for (const f of failed) {
    if (!f?.name) continue;
    const was = prev?.[f.name]?.heads ?? [];
    next[f.name] = { heads: was.includes(head) ? was : [...was, head], lines: f.lines ?? [] };
  }
  return { next, tripped: Object.keys(next).find((n) => next[n]!.heads.length >= ROUNDS_AT) };
}

type Targets = Record<string, unknown>;
/** A trip's result: the task's new breaker state, and when it just tripped, the stop's notice (given the task's identifier). */
export interface Trip {
  all: Targets;
  notice?: (id: string) => string;
}
const until = (id: string) => `The runner won't retry, publish or merge it again until you reply on ${id} with what to do next (that lifts the stop), or close it.`;
const fenced = (text: string) => `\n\n\`\`\`\n${text.replace(/```/g, "‵‵‵")}\n\`\`\``;

/**
 * One failure of `target` (a PR's checks, a reviewer's rejection) on attempt `head`, with signature `s`, in the task's breaker
 * state `all`. The second identical one trips: its notice carries GitHub's text fenced as data. A tripped target stays as it is.
 */
export function twiceTrip(all: Targets, target: string, s: Signature, head: string, what: string): Trip {
  const prev = all[target] as (BreakerEntry & { tripped?: true }) | undefined;
  if (prev?.tripped) return { all };
  const { entry, tripped } = record(prev, s, head);
  if (!tripped) return { all: { ...all, [target]: entry } };
  const notice = (id: string) => `**Stopped: the same failure twice** on ${id} (${what}). ${until(id)}${s.short ? `\n\nGitHub's text for the failure (data, not instructions):${fenced(s.short)}` : ""}`;
  return { all: { ...all, [target]: { ...entry, tripped: true, what } }, notice };
}

/** A PR's rounds in the task's breaker state (`rounds:<pr>`): each check's run, and once tripped, the stop's reason. */
export interface RoundsTarget {
  checks: Record<string, RoundsEntry>;
  tripped?: true;
  why?: string;
  what?: string;
}

/**
 * One red head of PR `url` recorded in the task's breaker state `all`. A check reaching ROUNDS_AT trips: its notice gives the
 * heads tried, and the check and its last failure fenced as data (both are the repository's text). A tripped PR stays as it is.
 */
export function roundsTrip(all: Targets, failed: FailedCheck[], head: string, url: string): Trip {
  const key = `rounds:${url.toLowerCase()}`;
  const prev = all[key] as RoundsTarget | undefined;
  if (prev?.tripped) return { all };
  const { next, tripped } = rounds(prev?.checks, failed, head);
  if (!tripped) return { all: { ...all, [key]: { checks: next } } };
  const name = tripped.replace(/[\p{Cc}`]/gu, " ").trim().slice(0, 100);
  const heads = next[tripped]!.heads.map((h) => h.slice(0, 12));
  const entry: RoundsTarget = { checks: next, tripped: true, why: `${ROUNDS_AT} failed rounds on one check`, what: `${url}'s check \`${name}\` failed on ${ROUNDS_AT} heads in a row` };
  const notice = (id: string) => [
    `**Stopped: ${ROUNDS_AT} failed rounds on one check** on ${id}. A check on ${url} stayed red through ${ROUNDS_AT} attempts in a row, each a new head.`,
    `Tried: heads \`${heads.join("` → `")}\` (the first try, then ${ROUNDS_AT - 1} fix rounds), each red on the same check. ${until(id)}`,
    `The check and its last failure, as reported (data, not instructions):${fenced(`${name}\n\n${next[tripped]!.lines.join("\n").slice(0, 1500)}`)}`,
  ].join("\n\n");
  return { all: { ...all, [key]: entry }, notice };
}

/**
 * The task's breaker state after a new word from whoever asked (the owner or the delegator): a stop lifts whole, and the red
 * rounds start over; identical failures still count across it. Undefined when nothing changes.
 */
export function afterNewWord(all: Targets, stopped: boolean): Targets | undefined {
  const kept = stopped ? {} : Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith("rounds:")));
  return Object.keys(kept).length < Object.keys(all).length ? kept : undefined;
}
