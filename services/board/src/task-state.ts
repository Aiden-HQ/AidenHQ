// The kernel's task state, as the board reads it (kernel/src/task-state.ts computes it from the fact log; GET /v1/tasks/state
// serves it). The board never works a state out itself: every view shows this row, a task the kernel has no facts for shows none.
// Its shape is the kernel's own (aidenhq-sdk/task-state-types.ts, a synced copy).
import type { IssueRow, StateRead, StateRow } from "./aidenhq-sdk/task-state-types.js";

/**
 * A row with what its refs name, read from where the board already has it (see `shown`): `refLabel` for the primary reason's
 * `ref` (the web's one chip wording reads it), `refs` for each attention entry's and the blocker's (a card's callout reads those).
 */
export type ShownState = StateRow & { refLabel?: string; refs?: Record<string, string>; /** The name of the agent `waits_on` names. */ waits_on_name?: string };

/** `closed_since` (an ISO instant, with `open`): the tasks closed since then too, in the same snapshot. */
export type StateQuery = { ids?: string[]; open?: boolean; closed_since?: string };
export type TaskStates = {
  read(q: StateQuery): Promise<StateRead>;
  /** The kernel's issue mirror (GET /v1/tasks/issues): identifier, title, status and parent by id or identifier, ≤ MAX_IDS. */
  issues(ids: string[]): Promise<IssueRow[]>;
  /** The kernel's once-per-wait claim on an owner's answer (POST /v1/answers/claim): "stale" when that wait is no longer the open one, "taken" when someone answered it. */
  claimAnswer(task: string, waitSince: string): Promise<"ok" | "stale" | "taken">;
  /** Give the claim back after a failed post, so the owner can answer again. */
  releaseAnswer(task: string, waitSince: string): Promise<void>;
};

/** The most ids one read takes (the kernel refuses more). */
export const MAX_IDS = 200;
/** The open tasks' read is shared this long: every board list asks for it. */
const OPEN_FRESH_MS = 2_000;

/** The kernel's state reads, with the board's key. */
export function kernelStates(k: { url: string; token: string }): TaskStates {
  const kernel = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${k.url}${path}`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`the kernel answered ${res.status}`);
    return res.json() as Promise<T>;
  };
  const post = (path: string, body: unknown) => fetch(`${k.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const get = (query: string) => kernel<StateRead>(`/v1/tasks/state?${query}`);
  let open: { at: number; read: Promise<StateRead> } | undefined;
  return {
    claimAnswer: async (task, waitSince) => {
      const res = await post("/v1/answers/claim", { task, wait_since: waitSince });
      if (res.ok) return "ok";
      if (res.status === 409) return ((await res.json()) as { error: "stale" | "taken" }).error;
      throw new Error(`the kernel answered ${res.status}`);
    },
    releaseAnswer: async (task, waitSince) => {
      const res = await post("/v1/answers/release", { task, wait_since: waitSince });
      if (!res.ok) throw new Error(`the kernel answered ${res.status}`);
    },
    issues: async (ids) => (ids.length ? (await kernel<{ issues: IssueRow[] }>(`/v1/tasks/issues?ids=${[...new Set(ids)].map(encodeURIComponent).join(",")}`)).issues : []),
    read: (q) => {
      if (!q.open) return get(`ids=${(q.ids ?? []).map(encodeURIComponent).join(",")}`);
      if (q.closed_since) return get(`open=1&closed_since=${encodeURIComponent(q.closed_since)}`);
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
export const noStates: TaskStates = { claimAnswer: async () => "stale", releaseAnswer: async () => {}, issues: async () => [], read: async () => ({ as_of: new Date().toISOString(), tasks: [], counts: { needs_you: 0, failed: 0, unexplained_idle: 0 } }) };

/** Every id's row (batches of MAX_IDS, side by side); a task the kernel has no facts for has none. */
export async function statesOf(states: TaskStates, ids: string[]): Promise<Map<string, StateRow>> {
  const all = [...new Set(ids)];
  const batches: string[][] = [];
  for (let i = 0; i < all.length; i += MAX_IDS) batches.push(all.slice(i, i + MAX_IDS));
  const out = new Map<string, StateRow>();
  for (const read of await Promise.all(batches.map((ids) => states.read({ ids })))) for (const r of read.tasks) out.set(r.task, r);
  return out;
}

/** The mirror's rows for any number of ids (batches of MAX_IDS, side by side), by task id. */
export async function issuesOf(states: TaskStates, ids: string[]): Promise<Map<string, IssueRow>> {
  const all = [...new Set(ids)];
  const batches: string[][] = [];
  for (let i = 0; i < all.length; i += MAX_IDS) batches.push(all.slice(i, i + MAX_IDS));
  return new Map((await Promise.all(batches.map((b) => states.issues(b)))).flat().map((r) => [r.id, r]));
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
  /** An agent's name, by its id. */
  agent(id: string): string | undefined;
}

const JOB_ENDED: Record<string, string> = { timeout: "timed out", lost: "lost", failed: "run failed" };

/** What one ref names: a card's sentence, a task's identifier, how a job ended. */
function labelOf(ref: string, src: RefSources): string | undefined {
  if (ref === "no_reply") return "ended without a reply";
  const [kind, id] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  if (kind === "record") return src.card(id);
  if (kind === "task") return src.identifier(id);
  if (kind === "job") { const j = src.job(id); return j ? ((j.error ?? "").split("\n")[0]!.trim().slice(0, 100) || (JOB_ENDED[j.state] ?? j.state)) : undefined; }
  return undefined;
}

export function shown(row: StateRow, src: RefSources): ShownState {
  const named = ["failed", "blocked", "card_owner", "card_review"].includes(row.reason) && row.ref ? labelOf(row.ref, src) : undefined;
  const refs: Record<string, string> = {};
  for (const ref of [...row.attention.map((a) => a.ref), ...(row.blocker ? [row.blocker] : [])]) {
    const l = labelOf(ref, src);
    if (l) refs[ref] = l;
  }
  const waitsOn = row.waits_on ? src.agent(row.waits_on) : undefined;
  return { ...row, ...(named ? { refLabel: named } : {}), ...(Object.keys(refs).length ? { refs } : {}), ...(waitsOn ? { waits_on_name: waitsOn } : {}) };
}
