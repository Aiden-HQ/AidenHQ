// Home's Needs you list from the keyboard: J/K move, Enter opens the row's pane, E does the row's main action, S snoozes.
// Bound on the window only while Home is mounted; Enter, E and S do nothing until J/K or a click picked a row; every key is
// off while typing, with a modifier, or while focus is in Ask Aiden, a pane, a dialog or the ⌘K palette.
import { useEffect, useRef, useState } from "react";
import type { NeedRow } from "./types";

/** A wait answered in the pane's form, never by one tap: several questions (answered whole) or one that takes several options. */
export const formOnly = (row: NeedRow & { kind: "answer" }) => row.questions.length > 1 || !!row.questions[0]?.multi;

/** What E does to a row: approve a card, answer a one-question wait with its first (recommended) option, or mark an open
 * task done; null opens the pane (formOnly). */
export function doneAction(row: NeedRow): "approve" | { answer: string } | "close" | null {
  if (row.kind === "approval") return "approve";
  if (row.kind === "open") return "close";
  return !formOnly(row) && row.options[0] ? { answer: row.options[0] } : null;
}

const typing = (el: Element | null) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable);
const AWAY = "#ask-aiden, .ui-detail, dialog[open], .palette, .drawer-backdrop";
const CONTROL = "button, a[href], summary, [role=button], [role=link]";

/** `on`: Home is the page in front (an overlay over it, a task or a run, takes the keys). */
export function useNeedsKeys(rows: NeedRow[], opts: { open: (id: string) => void; done: (row: NeedRow) => void; snooze: (row: NeedRow) => void }, on = true): { at: string | null; setAt: (id: string | null) => void } {
  const [at, setAt] = useState<string | null>(null);
  const ref = useRef({ rows, opts, at, on });
  ref.current = { rows, opts, at, on };
  // The picked row left the list (answered elsewhere, snoozed): nothing is picked.
  useEffect(() => {
    if (at && !rows.some((r) => r.id === at)) setAt(null);
  }, [rows, at]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target as Element) || typing(document.activeElement)) return;
      if ((document.activeElement as HTMLElement | null)?.closest(AWAY) || document.querySelector("dialog[open], .palette, .drawer-backdrop")) return;
      const { rows, opts, at, on } = ref.current;
      if (!on) return;
      const i = rows.findIndex((r) => r.id === at);
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") {
        e.preventDefault();
        const next = rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (k === "j" ? 1 : -1)))];
        if (!next) return;
        setAt(next.id);
        requestAnimationFrame(() => document.getElementById(`need-${next.id}`)?.scrollIntoView?.({ block: "nearest" }));
        return;
      }
      const row = rows[i];
      if (!row) return;
      // A focused button or link keeps its own Enter.
      if (e.key === "Enter" && (e.target as Element | null)?.closest?.(CONTROL)) return;
      if (e.key === "Enter") return e.preventDefault(), opts.open(row.id);
      if (k === "e") return e.preventDefault(), opts.done(row);
      if (k === "s") return e.preventDefault(), opts.snooze(row);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { at, setAt };
}
