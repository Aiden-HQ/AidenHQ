// The coverage queue: every (page, width, theme, state) a run owes, persisted to queue.json after each item so a killed run
// resumes where it stopped. A run takes at most `max` pages, in the page list's order; the rest are `deferred`, and the next
// `--resume` of a finished run takes the next `max` of them. Captures go to captures.jsonl next to it (the last one per key wins).
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Capture, Page, QueueItem, State, Theme } from "./types.ts";

export type Queue = {
  items: QueueItem[];
  next(): QueueItem | undefined;
  done(i: QueueItem, c: Capture): void;
  failed(i: QueueItem, why: string, final?: boolean): void; // final: no second try
  counts(): { done: number; total: number; failed: number; deferred: number };
  captures(): Capture[];
};

export const keyOf = (x: { page: string; width: number; theme: Theme; state: State }) => `${x.page}|${x.width}|${x.theme}|${x.state}`;
const TRIES = 2;

/**
 * Opens the queue in `file`: a fresh one from `pages` (the first `max` pages to do, the rest deferred), or with `resume` the
 * saved one: unfinished items are done first; a finished run takes its next `max` deferred pages.
 */
export function openQueue(file: string, pages: Page[], o: { widths: number[]; themes: Theme[]; states: State[]; max: number; resume?: boolean }): Queue {
  const capsFile = join(dirname(file), "captures.jsonl");
  let items: QueueItem[];
  if (o.resume && existsSync(file)) {
    items = JSON.parse(readFileSync(file, "utf8")) as QueueItem[];
    // A queue restored from an earlier pass (its captures stay on that pass's run): this folder's captures start empty.
    if (!existsSync(capsFile)) writeFileSync(capsFile, "");
    if (!items.some((i) => i.status === "todo")) {
      const take = new Set([...new Set(items.filter((i) => i.status === "deferred").map((i) => i.page))].slice(0, o.max));
      for (const i of items) if (i.status === "deferred" && take.has(i.page)) i.status = "todo";
    }
  } else {
    items = pages.flatMap((p, n) => o.themes.flatMap((theme) => o.widths.flatMap((width) => o.states.map((state): QueueItem => ({ page: p.path, width, theme, state, status: n < o.max ? "todo" : "deferred", tries: 0 })))));
    writeFileSync(capsFile, "");
  }
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(items)); renameSync(`${file}.tmp`, file); };
  save();
  const taken = new Set<QueueItem>();
  return {
    items,
    next: () => { const i = items.find((x) => x.status === "todo" && !taken.has(x)); if (i) taken.add(i); return i; },
    done: (i, c) => { appendFileSync(capsFile, JSON.stringify(c) + "\n"); i.status = "done"; i.tries++; delete i.why; taken.delete(i); save(); },
    failed: (i, why, final) => { i.tries++; i.why = why; i.status = final || i.tries >= TRIES ? "failed" : "todo"; taken.delete(i); save(); },
    counts: () => ({ done: items.filter((i) => i.status === "done").length, total: items.length, failed: items.filter((i) => i.status === "failed").length, deferred: items.filter((i) => i.status === "deferred").length }),
    captures: () => {
      const by = new Map<string, Capture>();
      for (const l of readFileSync(capsFile, "utf8").split("\n")) if (l) { const c = JSON.parse(l) as Capture; by.set(keyOf(c), c); }
      const done = new Set(items.filter((i) => i.status === "done").map(keyOf));
      return [...by.values()].filter((c) => done.has(keyOf(c)));
    },
  };
}
