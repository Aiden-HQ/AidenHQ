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
