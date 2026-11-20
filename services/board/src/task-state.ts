// The kernel's task state, as the board reads it (kernel/src/task-state.ts computes it from the fact log; GET /v1/tasks/state
// serves it). The board never works a state out itself: every view shows this row, a task the kernel has no facts for shows none.
//
// The types are copies of the kernel's (kernel/src/task-state.ts, task-state-read.ts); change them together.

export type Kind = "done" | "working" | "waiting" | "idle";
export type Reason =
  | "closed" | "cancelled"
  | "job_running"
  | "job_queued" | "job_held" | "card_review" | "card_owner" | "owner_wait" | "delegator_wait" | "handback"
  | "blocked" | "agent_wait" | "module_wait" | "owner_task" | "scheduled" | "chat_turn" | "backlog"
  | "failed" | "orphaned" | "unknown" | "history_expired";
export type Attention = { who: "owner" | "agent" | "reviewer"; why: "card" | "owner_wait" | "delegator_wait" | "handback" | "failed" | "stalled_wait" | "orphaned" | "unknown" | "history_expired"; ref: string };
export type TaskState = {
  kind: Kind; reason: Reason; ref?: string; since: string; holder: string | null; attention: Attention[];
  stage?: string;
  grade?: "pass" | "fail";
  question?: string;
  /** The open wait's own words. */
  note?: string;
  /** When the open owner wait began (present whenever one is open, whatever the task shows first). */
  wait_since?: string;
};
export type StateRow = TaskState & { task: string; identifier: string | null; idle_wakes: number };
export type StateRead = { as_of: string; tasks: StateRow[]; counts: { needs_you: number; failed: number; unexplained_idle: number } };

/** A row with what its `ref` names, read from where the board already has it (see `shown`): the web's one chip wording reads this. */
export type ShownState = StateRow & { refLabel?: string };

export type TaskStates = { read(q: { ids?: string[]; open?: boolean }): Promise<StateRead> };

/** The most ids one read takes (the kernel refuses more). */
export const MAX_IDS = 200;
/** The open tasks' read is shared this long: every board list asks for it. */
const OPEN_FRESH_MS = 2_000;

/** The kernel's state reads, with the board's key. */
export function kernelStates(k: { url: string; token: string }): TaskStates {
  const get = async (query: string): Promise<StateRead> => {
    const res = await fetch(`${k.url}/v1/tasks/state?${query}`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`the kernel answered ${res.status}`);
    return res.json() as Promise<StateRead>;
  };
  let open: { at: number; read: Promise<StateRead> } | undefined;
  return {
    read: (q) => {
      if (!q.open) return get(`ids=${(q.ids ?? []).map(encodeURIComponent).join(",")}`);
      if (!open || Date.now() - open.at > OPEN_FRESH_MS) {
        const mine = { at: Date.now(), read: get("open=1") };
        open = mine;
        mine.read.catch(() => open === mine && (open = undefined));
      }
      return open.read;
    },
  };
}

/** Without a kernel (a test, an unconfigured board) no task has a state. */
export const noStates: TaskStates = { read: async () => ({ as_of: new Date().toISOString(), tasks: [], counts: { needs_you: 0, failed: 0, unexplained_idle: 0 } }) };

/** Every id's row (batches of MAX_IDS, side by side); a task the kernel has no facts for has none. */
export async function statesOf(states: TaskStates, ids: string[]): Promise<Map<string, StateRow>> {
  const all = [...new Set(ids)];
  const batches: string[][] = [];
  for (let i = 0; i < all.length; i += MAX_IDS) batches.push(all.slice(i, i + MAX_IDS));
  const out = new Map<string, StateRow>();
  for (const read of await Promise.all(batches.map((ids) => states.read({ ids })))) for (const r of read.tasks) out.set(r.task, r);
  return out;
}

/** Something waits on the owner: a card, his answer, a handback. */
export const needsOwner = (s: StateRow | null | undefined) => Boolean(s?.attention.some((a) => a.who === "owner"));
/** The task waits for the owner's answer (a form shows only then). */
export const waitsForAnswer = (s: StateRow | null | undefined) => Boolean(s?.attention.some((a) => a.why === "owner_wait"));
/** Work is under way or someone must act: a task that is neither is finished or quiet, and may be settled out of the lists. */
export const isActive = (s: StateRow | null | undefined) =>
  Boolean(s && s.kind !== "done" && (s.kind === "working" || s.attention.length > 0 || s.reason === "job_queued" || s.reason === "job_held"));

/** What a row's `ref` names, in a few words, from what the board already has: a card's sentence, a blocker's identifier, how a job ended. */
export interface RefSources {
  /** A task id's identifier. */
  identifier(task: string): string | undefined;
  /** A pending card by its kernel record id (`k-…`). */
  card(id: string): string | undefined;
  /** How a kernel job ended (state, and the first line of why), by job id. */
  job(id: string): { state: string; error?: string | null } | undefined;
}

const JOB_ENDED: Record<string, string> = { timeout: "timed out", lost: "lost", failed: "run failed" };

export function shown(row: StateRow, src: RefSources): ShownState {
  const ref = row.ref?.replace(/^(job|record|task):/, "");
  const label =
    row.reason === "failed" && ref === "no_reply" ? "ended without a reply"
    : row.reason === "failed" && ref ? (() => { const j = src.job(ref); return j ? ((j.error ?? "").split("\n")[0]!.trim().slice(0, 100) || (JOB_ENDED[j.state] ?? j.state)) : undefined; })()
    : row.reason === "blocked" && ref ? src.identifier(ref)
    : (row.reason === "card_owner" || row.reason === "card_review") && ref ? src.card(ref)
    : undefined;
  return label ? { ...row, refLabel: label } : row;
}
