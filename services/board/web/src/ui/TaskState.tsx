// A task's state as the kernel computes it (the server's task-state.ts), in words: a dot and a word with what it is doing or
// waiting for, and a warning when an agent must act. The one place a state's codes become plain words; no view works a state
// out itself, and a task the kernel has no facts for shows none.
import type { ShownState } from "../types";
import { StatusDot, type StatusTone } from "./StatusDot";
import { dueWords } from "../util";

/** Something waits on the owner: a card, his answer, a handback. */
export const needsOwner = (s: ShownState | null | undefined) => Boolean(s?.attention.some((a) => a.who === "owner"));
/** The task waits for the owner's answer (an answer form shows only then). */
export const waitsForAnswer = (s: ShownState | null | undefined) => Boolean(s?.attention.some((a) => a.why === "owner_wait"));
/** An agent must act (a failure, a task nothing will wake): the warning mark. */
export const showsAttention = (s: ShownState | null | undefined) => Boolean(s?.attention.some((a) => a.who === "agent"));
/** Work is under way or someone must act: anything else is finished or at rest. */
export const isActive = (s: ShownState | null | undefined) =>
  Boolean(s && s.kind !== "done" && (s.kind === "working" || s.attention.length > 0 || s.reason === "job_queued" || s.reason === "job_held"));

const KIND_WORD = { working: "Working", waiting: "Waiting", idle: "Idle", done: "Done" } as const;

/** What a module is waiting on (a module wait's `ref` is its reason, not a task). */
const MODULE_WAIT: Record<string, string> = { checks: "CI checks", eval: "reviewer eval", retry: "retry", code_review: "code review", conflict: "merge conflict" };
const moduleWords = (ref: string) => MODULE_WAIT[ref] ?? ref.replace(/_/g, " ");

/** After a dot: what a reason means to the person reading it. `refLabel` names a card, a blocker or how a job ended. */
const REASON: Record<ShownState["reason"], (s: ShownState, timeZone?: string) => string> = {
  closed: (s) => (s.grade ? `graded ${s.grade}` : ""),
  cancelled: () => "stopped",
  job_running: () => "job running",
  job_queued: () => "queued",
  job_held: (s) => (s.ref ? `held: ${s.ref.replace(/_/g, " ")}` : "held"),
  card_review: (s) => (s.refLabel ? `AI review: ${s.refLabel}` : "AI review"),
  card_owner: (s) => (s.refLabel ? `your approval: ${s.refLabel}` : "your approval"),
  owner_wait: (s) => (s.question ? `your answer: “${s.question.split("\n")[0]!.slice(0, 80)}”` : "your answer"),
  delegator_wait: (s) => `an answer from ${s.waits_on_name ?? "another agent"}`,
  handback: () => "handed to you",
  blocked: (s) => (s.refLabel ? `blocked by ${s.refLabel}` : "blocked"),
  agent_wait: () => "its own wait",
  module_wait: (s) => MODULE_WAIT[s.ref ?? ""] ?? (s.ref ? s.ref.replace(/_/g, " ") : "a module's step"),
  scheduled: (s, tz) => (s.scheduled_for ? `scheduled for ${dueWords(s.scheduled_for, tz)}` : "scheduled"),
  chat_turn: () => "your turn",
  owner_task: () => "your task",
  backlog: () => "backlog",
  failed: (s) => (s.refLabel ? `failed: ${s.refLabel}` : "failed"),
  unpolled: () => "no dispatcher runs its agent",
  orphaned: () => "nothing scheduled",
  unknown: () => "unknown",
  history_expired: () => "unknown, history expired",
};

/** The board's timezone (App sets it from the board's read): every state's time reads in it, in every view. */
let boardZone: string | undefined;
export const setBoardTimezone = (tz: string | undefined) => void (boardZone = tz);

/** The tone, word and detail a state shows with (times in the board's timezone). A chat waiting on the owner's next message (no attention) is quiet. */
export function stateWords(s: ShownState): { tone: StatusTone; word: string; detail: string } {
  const tone: StatusTone = s.kind === "working" ? "working" : s.kind === "done" ? "done" : s.reason === "failed" ? "failed" : needsOwner(s) ? "needs" : "idle";
  const word = s.reason === "cancelled" ? "Stopped" : KIND_WORD[s.kind];
  const stalled = s.attention.find((a) => a.why === "stalled_wait");
  const reason = stalled ? `stalled · ${moduleWords(stalled.ref)}` : REASON[s.reason](s, boardZone);
  const note = s.note && s.note !== reason ? (s.note.length > 60 ? `${s.note.slice(0, 59)}…` : s.note) : "";
  return { tone, word, detail: [reason, note, s.stage].filter(Boolean).join(" · ") };
}

/** One state as a chip: `<dot> Waiting · your answer: “keep v1?”`, with ⚠ when an agent must act. Nothing for a task without one. */
export function TaskState({ state, bare }: { state: ShownState | null | undefined; /** The word and dot only (a narrow place). */ bare?: boolean }) {
  if (!state) return null;
  const w = stateWords(state);
  const warn = showsAttention(state);
  const quiet = state.reason === "chat_turn" || state.reason === "owner_task";
  return (
    <span className={`ts${quiet ? " ts-quiet" : ""}`} title={[w.word, w.detail].filter(Boolean).join(" · ")}>
      <StatusDot tone={w.tone}>{w.word}</StatusDot>
      {!bare && w.detail && <span className="ts-detail">· {w.detail}</span>}
      {warn && <span className="ts-warn" role="img" aria-label="needs attention">⚠</span>}
    </span>
  );
}
