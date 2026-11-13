/**
 * Calm agent loops: per task, per commenter (an agent, or the runner), per UTC day, at most WAKE_LIMIT of its comments
 * wake the task's agent. Paperclip wakes a task's agent on every comment someone else posts and has no way to post one
 * that doesn't (a pinned image), so the brake works after the fact: the commenter posts as always, under its own key,
 * then tells the board (`/internal/wake-check`); past the limit the board cancels the run that comment queued. The comment
 * stays on the task, and the agent reads it on its next run (a heartbeat, the owner, or another commenter). Nothing is
 * held or reposted, and the board never writes anyone's words. Owner comments never come here: the board's chat, the
 * Telegram and Slack bridge and the board's relays of the owner's words post directly, and their wakes are never cancelled.
 * The board's own wake-up notices (wake.ts) count as the commenter "board". Kill switch: `loop_brake: off` (read per use).
 */
import { readFileSync } from "node:fs";
import type { Paperclip } from "./paperclip.js";
import type { Store } from "./store.js";

export const WAKE_LIMIT = 12;
const KEY = "wake_brake";
const RUNNER_MARKER = "<!-- aidenhq-runner -->";

/** The instance's `loop_brake` setting (grants table, read per use). */
export function brakeOn(grantsFile = process.env.AIDENHQ_GRANTS_FILE): boolean {
  try {
    return JSON.parse(readFileSync(grantsFile ?? "", "utf8"))?.loop_brake !== "off";
  } catch {
    return true;
  }
}

/** Counts one wake of `task`'s agent by `by` today; false (nothing counted) once that commenter's limit there is reached. */
export function takeWake(store: Pick<Store, "meta" | "setMeta">, task: string, by: string, now = Date.now(), grantsFile?: string): boolean {
  if (!brakeOn(grantsFile)) return true;
  const day = new Date(now).toISOString().slice(0, 10);
  let s: { day?: string; n?: Record<string, number> } = {};
  try {
    s = JSON.parse(store.meta(KEY) ?? "{}");
  } catch {}
  const n = s.day === day ? (s.n ?? {}) : {}; // only today's counts are kept
  const k = `${task}|${by}`;
  if ((n[k] ?? 0) >= WAKE_LIMIT) return false;
  n[k] = (n[k] ?? 0) + 1;
  store.setMeta(KEY, JSON.stringify({ day, n }));
  return true;
}

type Pc = Pick<Paperclip, "issue" | "agents" | "comments" | "agentRuns" | "cancelRun">;
type CheckLog = { info(o: object, m: string): void };

/**
 * A comment `by` (an agent id, or "runner") just posted on `issue`: if it woke the task's agent and `by` has used up
 * today's wakes there, cancel that run. Only the commenter's own comment counts, and only once it actually woke someone.
 */
export async function wakeCheck(pc: Pc, store: Pick<Store, "meta" | "setMeta">, issueRef: string, commentId: string, by: string, log: CheckLog, opts: { now?: number; grantsFile?: string; waitMs?: number } = {}): Promise<{ woke: boolean; cancelled?: boolean }> {
  if (!brakeOn(opts.grantsFile)) return { woke: true };
  const issue = await pc.issue(issueRef);
  const agent = issue.assigneeAgentId;
  // Nobody to wake: no agent, the commenter's own task, or an agent Paperclip never wakes on comments (the Engineers).
  const a = (await pc.agents()).find((x) => x.id === agent) as { runtimeConfig?: { heartbeat?: { wakeOnDemand?: boolean } } } | undefined;
  if (!agent || agent === by || !a || a.runtimeConfig?.heartbeat?.wakeOnDemand === false) return { woke: false };
  const c = (await pc.comments(issue.id)).find((x) => x.id === commentId);
  const mine = by === "runner" ? Boolean(c && !c.authorAgentId && c.body.includes(RUNNER_MARKER)) : c?.authorAgentId === by;
  if (!mine) throw new Error("not your comment on that task");
  // The run Paperclip queued for this comment (it may take a moment to appear); none: it coalesced or woke nobody.
  let run: { id: string; status: string } | undefined;
  for (let i = 0; i < 4 && !run; i++) {
    if (i) await new Promise((r) => setTimeout(r, opts.waitMs ?? 1000));
    run = (await pc.agentRuns(agent, 20)).find((r) => r.wakeCommentId === commentId);
  }
  if (!run || ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) return { woke: Boolean(run) };
  if (takeWake(store, issue.id, by, opts.now, opts.grantsFile)) return { woke: true };
  // Cancel only a run still queued, and only if nobody else (the owner above all) commented after this comment: Paperclip
  // folds later wakes into the queued run, and cancelling it would swallow theirs.
  if (run.status !== "queued") return { woke: true };
  const all = await pc.comments(issue.id);
  const after = all.slice(all.findIndex((x) => x.id === commentId) + 1);
  if (after.some((x) => (by === "runner" ? x.authorAgentId || !x.body.includes(RUNNER_MARKER) : x.authorAgentId !== by))) return { woke: true };
  await pc.cancelRun(run.id);
  log.info({ issue: issue.identifier, agent, by, run: run.id }, "wake cancelled: this commenter's daily limit on the task");
  return { woke: false, cancelled: true };
}
