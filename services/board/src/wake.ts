/**
 * Event wake-ups (wave 2, item 5): wakes a heartbeat agent on its open task when something it waits on changed and
 * nothing else woke it. The primary paths stay as they are (the tasks bridge's note on the parent, the runner's outcome
 * comments, Paperclip's wake when every child closes); this reconciler covers only what they miss. Thin events: every
 * two minutes it lists the state and compares it with per-task cursors, never trusting update times or comment text.
 *
 * What it watches, per open task of an agent with an active "Heartbeat: <key>" routine. Only outcomes, as the primary paths
 * post them (notices inform; only an outcome wakes an agent: runner notices.ts): a sub-task's progress (its cards, its
 * PRs, a grade sending it back to its assignee) is the sub-task's own, and its outcome follows.
 *   - each sub-task delegated to someone else: its status (done or cancelled, or reopened from one; intermediate
 *     updates such as in progress or in review are not news);
 *   - approval cards on the task itself: rejected, or applied/failed (approved-not-yet-applied is not an event: the
 *     runner's outcome follows);
 *   - each sub-task's grade: satisfied or escalated;
 *   - pull requests named on the task itself (description, merge card): merged or closed (warehouse src_github through
 *     apps-mcp; it lags GitHub by up to 15 minutes and has no check runs).
 *
 * A change is the agent's to see unless a run of that agent on that task is live or queued (it coalesces) or finished
 * after the change (the agent saw it, or made it itself: reopening a child in its own run never wakes it). Otherwise,
 * after 3 minutes' grace for the primary paths, the board posts one notice on the task naming what changed (ids and
 * states only), which wakes the agent through Paperclip's comment wake; a recovery-held task's agent is woken directly.
 * Paperclip's suppressed disposition repairs leave such holds on tasks; each tick releases them (the run did nothing).
 * Cursors advance only once the notice is posted. The notice is on the agent's own task and nothing here reads comments,
 * so a wake never causes another. At most 4 wakes per agent per hour, and each counts against the task's daily limit
 * (brake.ts).
 */
import { takeWake } from "./brake.js";
import { NOTICE_MARKER } from "./chats.js";
import { appsApi } from "./fleet.js";
import { OPEN, REPAIR_SUPPRESSED, REPAIR_SUPPRESSED_WHY, type Agent, type Issue, type LiveRun, type Paperclip, type PastRun, type Routine } from "./paperclip.js";
import type { Approval, Records } from "./records.js";
import type { Grading, GradesView } from "./grading.js";
import type { Store } from "./store.js";

const MIN = 60_000;
const TICK_MS = 2 * MIN;
const GRACE_MS = 3 * MIN;
const PER_HOUR = 4;
const STATE_KEY = "wake_cursors";
export const WAKE_MARKER = "<!-- aidenhq-wake -->";
const OPEN_STATUSES = new Set(OPEN.split(","));

type PaperclipPart = Pick<Paperclip, "routines" | "agents" | "openIssues" | "closedSince" | "liveRuns" | "recentRuns" | "addComment" | "issue" | "wakeAgent" | "releaseCancelledRun">;
export interface PrState {
  repo: string;
  number: number;
  state: string;
  merged_at: string | null;
  closed_at: string | null;
}
export interface WakeDeps {
  pc: PaperclipPart;
  store: Pick<Store, "meta" | "setMeta" | "events">;
  grading: Pick<Grading, "grades">;
  records: Pick<Records, "list">;
  prStates: (refs: string[]) => Promise<PrState[] | undefined>;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

/** One watched thing's state: a cursor `value`, when it changed if known, and the notice line for a change from `was`. */
interface Signal {
  value: string;
  at?: string;
  line: (was: string) => string;
}
/** Per task: source → acknowledged value. */
type Cursors = Record<string, Record<string, string>>;
interface State {
  cursors: Cursors;
  /** `<task>|<source>` → when a change with no time of its own (a card's outcome) was first seen. */
  seen?: Record<string, string>;
  /** Last good tick, for the closed sub-tasks window. */
  at?: string;
}

const PR_REF = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)|codehost:([\w.-]+\/[\w.-]+)\/change\/(\d+)|\b([\w.-]+\/[\w.-]+)#(\d+)\b/g;
/** owner/repo#n refs named in some text (PR links, this server's change requests `codehost:<org>/<name>/change/<n>`, or owner/repo#n). */
function prRefs(text: string | null | undefined): string[] {
  return [...String(text ?? "").matchAll(PR_REF)].map((m) => `${(m[1] ?? m[3] ?? m[5])!.toLowerCase()}#${m[2] ?? m[4] ?? m[6]}`);
}

const latest = (...xs: (string | null | undefined)[]) => xs.filter(Boolean).sort().at(-1) ?? undefined;
/** A sub-task's status as an event: only a terminal state is news (picking a task up, reviewing it or blocking it is not). */
const childState = (status: string) => (status === "done" || status === "cancelled" ? status : "open");

/** The PRs a task names: its description and its merge cards. */
function prsOf(x: Issue, cards: Approval[]): string[] {
  const refs = prRefs(x.description);
  for (const a of cards) if (a.action === "merge") for (const p of (a.args as { prs?: { url: string }[] }).prs ?? []) refs.push(...prRefs(p.url));
  return refs;
}

/** The signals for one task: its sub-tasks (others' only) and their grades' outcomes, its own cards and the PRs it names. */
function signals(task: Issue, kids: Issue[], cards: Approval[], grades: GradesView["grades"], prs: Map<string, PrState>): Map<string, Signal> {
  const out = new Map<string, Signal>();
  const refs = new Set(prsOf(task, cards));
  for (const k of kids) {
    const st = childState(k.status);
    out.set(`child:${k.id}`, { value: st, at: latest(k.completedAt, k.cancelledAt, k.updatedAt), line: (was) => `${k.identifier} is ${was === "done" || was === "cancelled" ? `reopened (${k.status})` : `now ${k.status}`}.` });
    const g = grades[k.id];
    // A settled row (not_graded: the task closed before the grader decided, a cancellation included) is no signal at all:
    // it must never read as "open", or a cancelled task's escalated row settling would wake its delegator with "grade: open".
    // A sub-task at a terminal status takes no decision either: a verdict recorded against it after it closed (a pass that
    // was already running) is never presented as an escalation waiting on the delegator.
    if (g && g.state !== "not_graded" && st === "open") {
      // A grade sending the work back is the assignee's to act on, not the delegator's: only satisfied and escalated are news.
      // Its own key (not `grade:`), so a cursor saved before this rule is dropped, never read as a change.
      const gs = ["satisfied", "escalated"].includes(g.state) ? g.state : "open";
      out.set(`graded:${k.id}`, { value: gs, at: g.updatedAt, line: () => `${k.identifier}'s grade: ${gs}.` });
    }
  }
  for (const a of cards) {
    // Approved and not yet applied is not news: the runner's outcome follows. An outcome carries no time of its own.
    const terminal = a.outcome != null || a.state === "rejected" || a.state === "stale";
    out.set(`card:${a.id}`, { value: terminal ? `${a.state}|${a.outcome ?? ""}` : "open", at: a.state === "rejected" || a.state === "stale" ? (a.decidedAt ?? undefined) : undefined, line: () => `The ${a.action} card on ${a.identifier} is ${a.outcome ?? a.state}.` });
  }
  for (const r of refs) {
    const p = prs.get(r);
    if (!p) continue;
    const value = p.merged_at ? "merged" : p.state;
    out.set(`pr:${r}`, { value, at: latest(p.merged_at, p.closed_at), line: () => `PR ${r} is ${value}.` });
  }
  return out;
}

function readState(store: WakeDeps["store"]): State {
  try {
    return { cursors: {}, ...JSON.parse(store.meta(STATE_KEY) ?? "{}") };
  } catch {
    return { cursors: {} };
  }
}

/** Wakes per agent in the last hour (in memory: a restart allows a few more, never a storm). */
export type Recent = Map<string, number[]>;

/** One pass. Returns the task ids it woke. */
export async function wakeTick(deps: WakeDeps, recent: Recent, now = Date.now()): Promise<string[]> {
  const { pc, store, records, log } = deps;
  const routines = await pc.routines();
  const agents = await pc.agents(); // one at a time: Paperclip limits a client's concurrent list requests
  const paused = new Set(agents.filter((a: Agent) => a.status === "paused" || a.status === "terminated").map((a) => a.id));
  const watched = new Set(routines.filter((r: Routine) => r.title.startsWith("Heartbeat: ") && r.status === "active" && r.assigneeAgentId && !paused.has(r.assigneeAgentId)).map((r) => r.assigneeAgentId!));
  const state = readState(store);
  if (!watched.size) {
    store.setMeta(STATE_KEY, JSON.stringify({ cursors: {}, at: new Date(now).toISOString() }));
    return [];
  }
  const open = await pc.openIssues();
  // Sub-tasks closed since the last good tick (with a margin), at most a day back.
  const since = new Date(Math.max(Date.parse(state.at ?? "") || 0, now - 24 * 60 * MIN) - 10 * MIN).toISOString();
  const closed = await pc.closedSince(since);
  const kidsOf = new Map<string, Issue[]>();
  for (const i of [...open, ...closed]) if (i.parentId) kidsOf.set(i.parentId, [...(kidsOf.get(i.parentId) ?? []).filter((k) => k.id !== i.id), i]);
  const tasks = open.filter((t) => t.assigneeAgentId && watched.has(t.assigneeAgentId) && OPEN_STATUSES.has(t.status) && !t.title.startsWith("Heartbeat: "));
  const ownKids = (t: Issue) => (kidsOf.get(t.id) ?? []).filter((k) => k.assigneeAgentId !== t.assigneeAgentId);

  // The grading module unreachable: no graded: signals this pass (a state is never invented; their cursors stay).
  const grades = await deps.grading.grades([...new Set(tasks.flatMap(ownKids).map((k) => k.id))]).then((v) => v.grades, (err) => (log.warn({ err: String(err) }, "wake-ups: grading module unreachable; skipping graded signals"), undefined));

  const cardsOf = new Map<string, Approval[]>();
  for (const a of await records.list("recent", { limit: 500 })) cardsOf.set(a.issueId, [...(cardsOf.get(a.issueId) ?? []), a]);
  const refs = [...new Set(tasks.flatMap((t) => prsOf(t, cardsOf.get(t.id) ?? [])))].slice(0, 100);
  const prs = new Map<string, PrState>();
  const found = refs.length ? await deps.prStates(refs).catch(() => undefined) : [];
  for (const p of found ?? []) prs.set(`${p.repo.toLowerCase()}#${p.number}`, p);

  const live = await pc.liveRuns();
  const runs = await pc.recentRuns(200);
  // Paperclip cancels its own disposition-repair run before dispatch when the task already has a disposition, yet holds the
  // task (legacy_execution_requires_reconciliation), parking every later wake on it: a finished, graded result's note on
  // the owner's chat woke nobody until this reconciler's notice 5 minutes later (WOR-4626). The run did nothing: release it.
  for (const r of runs) {
    if (r.errorCode !== REPAIR_SUPPRESSED || !r.issueId) continue;
    const held = await pc.issue(r.issueId).catch(() => undefined);
    if (held?.executionBlocker?.runId !== r.id) continue;
    await pc.releaseCancelledRun(held, r.id, REPAIR_SUPPRESSED_WHY).then(
      () => log.info({ issue: held.identifier, run: r.id }, "released the hold Paperclip's suppressed repair left"),
      (err) => log.warn({ issue: held.identifier, err: String(err) }, "couldn't release the hold Paperclip's suppressed repair left"),
    );
  }
  // Busy: a run queued or going. Seen: a run that succeeded after the change (a failed or cancelled one may never have
  // looked, and some cancelled runs never get a finish time).
  const busy = new Set([...live, ...runs].filter((r) => ["queued", "scheduled_retry", "running"].includes(r.status)).map((r: LiveRun | PastRun) => `${r.agentId}:${r.issueId}`));
  const lastFinished = new Map<string, string>();
  for (const r of runs as PastRun[]) {
    if (r.status !== "succeeded" || !r.finishedAt) continue;
    const k = `${r.agentId}:${r.issueId}`;
    if (r.finishedAt > (lastFinished.get(k) ?? "")) lastFinished.set(k, r.finishedAt);
  }

  const cursors: Cursors = {};
  const seen: Record<string, string> = {};
  const woke: string[] = [];
  for (const t of tasks) {
    const agent = t.assigneeAgentId!;
    const was = state.cursors[t.id];
    const kids = ownKids(t);
    const sig = signals(t, kids, cardsOf.get(t.id) ?? [], grades ?? {}, prs);
    const next: Record<string, string> = {};
    // A source's first sighting is its baseline; a source that went away (a pruned card, an old closed sub-task) is dropped.
    const changed: [string, Signal][] = [];
    for (const [k, s] of sig) {
      if (was?.[k] === undefined || was[k] === s.value) next[k] = s.value;
      else {
        next[k] = was[k]!;
        changed.push([k, s]);
      }
    }
    // The warehouse didn't answer: its PRs keep their cursors (a merge meanwhile is still news next tick).
    if (!found) for (const [k, v] of Object.entries(was ?? {})) if (k.startsWith("pr:")) next[k] ??= v;
    // The grading module didn't answer: its graded: signals keep their cursors (a merge meanwhile is still news next tick).
    if (!grades) for (const [k, v] of Object.entries(was ?? {})) if (k.startsWith("graded:")) next[k] ??= v;
    // A grade signals() stopped presenting (its row settled, or its sub-task closed) keeps its cursor for the same reason a
    // closed sub-task does: the task reopened, graded again and escalated is still news. A sub-task that has dropped out of
    // the closed window is known closed by its own cursor, so its grade's cursor is kept too.
    const quiet = new Set([
      ...kids.filter((k) => childState(k.status) !== "open" || grades?.[k.id]?.state === "not_graded").map((k) => k.id),
      ...Object.entries(was ?? {}).flatMap(([k, v]) => (k.startsWith("child:") && (v === "done" || v === "cancelled") ? [k.slice("child:".length)] : [])),
    ]);
    if (grades) for (const [k, v] of Object.entries(was ?? {})) if (k.startsWith("graded:") && quiet.has(k.slice("graded:".length))) next[k] ??= v;
    // A closed sub-task leaves the closed list after a while: its cursor stays, so reopening it later is still news.
    for (const [k, v] of Object.entries(was ?? {})) if (k.startsWith("child:") && (v === "done" || v === "cancelled")) next[k] ??= v;
    cursors[t.id] = next;
    if (!was || !changed.length) continue;
    const key = `${agent}:${t.id}`;
    for (const [k] of changed) seen[`${t.id}|${k}`] = state.seen?.[`${t.id}|${k}`] ?? new Date(now).toISOString();
    if (busy.has(key)) continue; // a live or queued run takes the change; looked at again once it ends
    const at = Math.max(...changed.map(([k, s]) => Date.parse(s.at ?? seen[`${t.id}|${k}`]!)));
    const finished = lastFinished.get(key);
    if (finished && Date.parse(finished) >= at) {
      for (const [k, s] of changed) next[k] = s.value; // the agent ran on this task since: it saw (or made) the change
      continue;
    }
    if (now - at < GRACE_MS) continue;
    const mine = (recent.get(agent) ?? []).filter((x) => now - x < 60 * MIN);
    recent.set(agent, mine);
    if (mine.length >= PER_HOUR) {
      log.warn({ issue: t.identifier, agent }, "wake-up held: this agent's hourly limit");
      continue;
    }
    // The loop brake (brake.ts): the board's own wakes on this task today are used up; the change stays news for tomorrow.
    if (!takeWake(store, t.id, "board", now)) {
      log.warn({ issue: t.identifier, agent }, "wake-up held: the task's daily limit");
      continue;
    }
    const body = `Wake-up: something ${t.identifier} waits on changed.\n${changed.map(([k, s]) => `- ${s.line(was[k]!)}`).join("\n")}\n\n${NOTICE_MARKER}${WAKE_MARKER}`;
    try {
      const c = await pc.addComment(t.id, body);
      store.events.emit("chat", t.id);
      mine.push(now);
      woke.push(t.id);
      for (const [k, s] of changed) next[k] = s.value;
      log.info({ issue: t.identifier, agent, changed: changed.map(([k]) => k) }, "wake-up posted");
      // Paperclip parks a recovery-held task's comment wake, and a comment on a blocked task has been seen to wake nobody
      // (ops' aiden-msg): wake the agent without the task, as the board does for the owner; it finds the notice there.
      const held = t.status === "blocked" ? t : await pc.issue(t.id).catch(() => undefined);
      if (held?.status === "blocked" || held?.executionBlocker) await pc.wakeAgent(agent, `A wake-up notice is on ${t.identifier} (${held.executionBlocker?.cause ?? "blocked"}). Read the newest comments on ${t.identifier}.`, `wake-held:${c.id}`).catch((err) => log.warn({ issue: t.identifier, err: String(err) }, "couldn't wake the agent of a held task"));
    } catch (err) {
      log.warn({ issue: t.identifier, err: String(err) }, "wake-up not posted; retried next tick");
    }
  }
  // A change acknowledged this tick leaves `seen` with its cursor; one still waiting keeps its first-seen time.
  for (const k of Object.keys(seen)) {
    const [id, src] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    if (state.cursors[id]?.[src] !== cursors[id]?.[src]) delete seen[k];
  }
  store.setMeta(STATE_KEY, JSON.stringify({ cursors, seen, at: new Date(now).toISOString() }));
  return woke;
}

/** Starts the reconciler (main.ts). */
export function startWake(pc: Paperclip, store: Store, records: Records, grading: Grading, log: WakeDeps["log"]): void {
  const deps: WakeDeps = {
    pc,
    store,
    grading,
    records,
    log,
    prStates: async (refs) => (await appsApi<{ prs?: PrState[] }>(`/internal/pr-states?${new URLSearchParams(refs.map((r) => ["pr", r]))}`, undefined, { auth: true, timeoutMs: 20_000 })).prs,
  };
  const recent: Recent = new Map();
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await wakeTick(deps, recent);
    } catch (err) {
      log.warn({ err: String(err) }, "wake-ups failed");
    } finally {
      busy = false;
    }
  };
  setInterval(run, TICK_MS).unref();
  setTimeout(run, MIN).unref();
  log.info({}, "wake-ups on");
}
