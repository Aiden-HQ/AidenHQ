// A task's state as the kernel serves it (GET /v1/tasks/state): the one definition of its shape. The kernel computes it
// (kernel/src/task-state.ts, task-state-read.ts); the board reads it through its copy (services/board/src/aidenhq-sdk/,
// kept identical by scripts/sync-shared.ts). Types only: no imports, no code.

export type Kind = "done" | "working" | "waiting" | "idle";
export type Reason =
  | "closed" | "cancelled"
  | "job_running"
  | "job_queued" | "job_held" | "card_review" | "card_owner" | "owner_wait" | "delegator_wait" | "handback" | "owner_task"
  | "blocked" | "agent_wait" | "module_wait" | "scheduled" | "chat_turn" | "backlog"
  | "failed" | "unpolled" | "orphaned" | "unknown" | "history_expired";
export type Attention = { who: "owner" | "agent" | "reviewer"; why: "card" | "owner_wait" | "delegator_wait" | "handback" | "failed" | "stalled_wait" | "unpolled" | "orphaned" | "unknown" | "history_expired"; ref: string; /** When what it names began (the board orders asks by it). */ since: string };
/** The board's column for a task (its Agent work layout): one per task, from all its obligations (laneOf). */
export type Lane = "needs_you" | "working" | "waiting" | "blocked" | "idle" | "done";
export type TaskState = {
  kind: Kind; reason: Reason; ref?: string; since: string; holder: string | null; attention: Attention[];
  lane: Lane;
  /** An open blocker (`task:<id>`), whatever the representative reason: a queued job or a wait can outrank it. */
  blocker?: string;
  /** A module stage's label, only while working or waiting. */
  stage?: string;
  /** The final attempt's grade, only when done. */
  grade?: "pass" | "fail";
  /** The open owner or delegator wait's question (the ask gate reads it). */
  question?: string;
  /** When the open owner or delegator wait began, whatever the representative reason (only the owner's has a `question`). */
  wait_since?: string;
  /** The open owner or delegator wait's own deadline (`until`), so a retry of its question reuses the wait instead of re-arming it. */
  wait_until?: string;
  /** The open wait's own words (task_wait's reason). */
  note?: string;
  /** When the earliest open scheduled wake is due, whatever the representative reason. */
  scheduled_for?: string;
  /** The agent (id) an open delegator wait's question went to, when the wait recorded it. */
  waits_on?: string;
};
/** `holder_name` and `holder_gone` name a holder Paperclip reports terminated (a holder no grant maps stays its raw id). */
export type StateRow = TaskState & { task: string; identifier: string | null; idle_wakes: number; holder_name?: string; holder_gone?: true };
export type StateRead = { as_of: string; tasks: StateRow[]; counts: { needs_you: number; failed: number; unexplained_idle: number } };
