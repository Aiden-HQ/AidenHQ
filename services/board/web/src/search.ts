// The Tasks page's search field (docs/design/task-search.md): the warehouse module's task search, 250 ms after the last keystroke. The
// last answer stays in force while the next is on its way, so the cards never flash empty; `busy` marks the field meanwhile.
// Tasks closed before the board's 48 hours come a page at a time, newest close first; pages are read until the owner's other
// filters (`keep`) leave enough of them to show, so a filter never hides the newest match behind a page.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { WorkCard } from "./types";

export type TaskSearch = {
  /** The hit ids of the latest answer; undefined while there is no answer to apply (no text, or the first is on its way). */
  hits?: ReadonlySet<string>;
  /** Hits closed before the board's 48 hours, as Done cards, newest close first (the pages read so far). */
  done: WorkCard[];
  /** More older closed hits remain to be read. */
  hasMore: boolean;
  /** Ask for more older closed hits (the Done lane's "Show more"). */
  more: () => void;
  busy: boolean;
  /** "keyword": meaning search failed, keyword hits only; "unavailable": the search failed, so the text hides nothing (said so). */
  note: "keyword" | "unavailable" | null;
};

const DEBOUNCE_MS = 250;
/** While a query stays in the field its hits are asked for again this often (new and renamed tasks join them). */
const REFRESH_MS = 30_000;
/** Older closed matches wanted on screen at first, and per "Show more". */
const WANT = 25;
/**
 * `n`: the query's sequence number that produced it (a page or a refresh applies only to it). `keyword`: the first page was
 * keyword only, so its cursor pages in that mode. `stalled`: a page failed; pages resume on the owner's next "Show more".
 */
type Answer = { n: number; hits?: ReadonlySet<string>; done: WorkCard[]; next: string | null; keyword: boolean; busy: boolean; paging?: boolean; stalled?: boolean; note: TaskSearch["note"] };
const NONE: Answer = { n: 0, done: [], next: null, keyword: false, busy: false, note: null };
type Reply = Awaited<ReturnType<typeof api.search>>;
const answerOf = (n: number, r: Reply): Answer => ({ n, hits: new Set(r.ids), done: r.done, next: r.next, keyword: !r.semantic, busy: false, note: r.semantic ? null : "keyword" });

/** `active`: the Tasks page is on screen; elsewhere the answer stays as it is, with no refresh and no pages read. */
export function useTaskSearch(text: string, keep: (c: WorkCard) => boolean, active: boolean): TaskSearch {
  const q = text.trim();
  const [a, setA] = useState<Answer>(NONE);
  const loaded = useRef(0);
  loaded.current = a.done.length;
  const [want, setWant] = useState(WANT);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setWant(WANT);
    if (!q) return setA(NONE);
    setA((s) => ({ ...s, busy: true }));
    const timer = setTimeout(() => {
      api.search(q).then(
        (r) => { if (n === seq.current) setA(answerOf(n, r)); },
        () => { if (n === seq.current) setA({ ...NONE, n, note: "unavailable" }); },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);
  // The same query again now and then, as a whole answer: its hits, and the older closes read as far as the owner had paged
  // (so they and their cursor are fresh too), swapped in at once. Skipped while a page is on its way; a failure keeps the last
  // answer. (`seq` is read in the effects: the query effect above has moved it on when the text changed in the same render.)
  useEffect(() => {
    if (!q || !active || a.busy || a.n !== seq.current) return;
    const n = a.n;
    let running = false, gone = false;
    const refresh = async () => {
      const r = await api.search(q);
      let { done, next } = r;
      while (next && done.length < loaded.current && !gone) {
        const p = await api.search(q, { after: next, keyword: !r.semantic });
        done = [...done, ...p.done.filter((c) => !done.some((d) => d.id === c.id))];
        next = p.next;
      }
      if (!gone) setA((s) => (s.n !== n || n !== seq.current || s.paging ? s : answerOf(n, { ...r, done, next })));
    };
    const timer = setInterval(() => {
      if (document.hidden || running) return;
      running = true;
      refresh().catch(() => {}).finally(() => (running = false));
    }, REFRESH_MS);
    return () => { gone = true; clearInterval(timer); };
  }, [q, active, a.busy, a.n]);
  // The next page of older closed hits while the filters keep fewer than wanted: only from the answer to the query in the field.
  const kept = a.done.filter(keep).length;
  useEffect(() => {
    if (!q || !active || a.busy || a.n !== seq.current || a.paging || a.stalled || !a.next || kept >= want) return;
    const n = a.n, page = { after: a.next, keyword: a.keyword };
    setA((s) => ({ ...s, paging: true }));
    api.search(q, page).then(
      (r) => { if (n === seq.current) setA((s) => (s.n !== n ? s : { ...s, paging: false, done: [...s.done, ...r.done.filter((c) => !s.done.some((d) => d.id === c.id))], next: r.next })); },
      () => { if (n === seq.current) setA((s) => (s.n !== n ? s : { ...s, paging: false, stalled: true })); },
    );
  }, [q, active, a.busy, a.n, a.paging, a.stalled, a.next, a.keyword, kept, want]);
  // The older closed cards are hits too (the module pages them apart from the ranked ids).
  const hits = useMemo(() => (a.hits ? new Set([...a.hits, ...a.done.map((c) => c.id)]) : undefined), [a.hits, a.done]);
  return { hits, done: a.done, hasMore: !!a.next, more: () => { setA((s) => ({ ...s, stalled: false })); setWant((w) => w + WANT * 4); }, busy: a.busy, note: a.note };
}

export const NOTE_TEXT = { keyword: "Meaning search unavailable; showing keyword matches.", unavailable: "Search unavailable right now; showing every task." } as const;
