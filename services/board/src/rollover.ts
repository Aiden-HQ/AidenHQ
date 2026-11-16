/**
 * Task rollover. Paperclip inlines a task's whole comment history into the prompt whenever a run starts a fresh session
 * (executionContinuation, coverage full_task_history, no size bound), and Codex refuses input over 1,048,576 characters.
 * A failed run never saves its session, so every later run on that task fails the same way: Aiden's chat WOR-2275 reached
 * 918 comments and every run on it failed for ten hours (2026-11-14).
 *
 * So, for any open task an agent works on (chats and every other long-lived task alike): before its history nears the
 * limit, or as soon as a run on it fails with that error, the board moves it to a successor. The successor gets the same
 * agent, labels, priority and parent, a description pointing back, and the owner's messages that were still unanswered
 * (re-posted, so they wake the agent there). The old task's open sub-tasks move under the successor, so Paperclip's
 * child-done wakes, the runner's outcome and grade notes and the board's wake-ups (all read parentId) reach it. The old
 * task gets a pointer the board and the bridge follow when someone writes to it, loses its agent (Paperclip reopens a
 * closed task and wakes its agent on any comment) and closes.
 *
 * Only the owner's own tasks move: made with the board's key, by no agent, with no source marker (a chat, the bridge's
 * daily chat, a task the owner wrote). The successor is made the same way, so it has the same origin: a task an agent, a
 * source or the runner made would become "the owner's" in a successor (ownRequest, ownerMade), so those never move. Its
 * description only links the old task (never copies it), and only the owner's own messages are re-posted. Which task
 * continues which is the board's record (meta `task_rollover`), never read back from description text: the board's writes
 * follow it, and the bridge asks for it (GET /internal/successor/:id). The description markers are for people.
 *
 * Never moved either: a task a run is on or queued for (unassigning cancels the run), one with an approval card still
 * waiting or being applied, a graded task, and an Engineer task the runner runs (all keyed by the task's id). Fleet Ops'
 * detector names the input-length failure, so one of those gets a specific flag instead of a generic "runs failed".
 */
import { APPROVAL_MARKER, NOTICE_MARKER, chatAgentMarker, continuedIn, continuedMarker, continuesMarker } from "./chats.js";
import { RUNNER_MARKER, displayText } from "./board.js";
import { OPEN, type Comment, type Issue, type Paperclip } from "./paperclip.js";
import type { Grading } from "./grading.js";
import type { Records } from "./records.js";
import type { Store } from "./store.js";

const MIN = 60_000;
const TICK_MS = 10 * MIN;
/** Codex's limit is 1,048,576 characters; Paperclip's envelope adds about 370 per comment (WOR-2275: 742K of comments, 1.08M sent). */
export const LIMIT = 600_000;
const PER_COMMENT = 400;
const RESCAN_MS = 60 * MIN; // a task whose times didn't change is measured again this often anyway
/** The error a run ends with when the prompt is over the harness's input limit. */
export const TOO_LONG = /input exceeds the maximum length|input_too_large/i;
const STATE_KEY = "task_rollover";
const OPEN_STATUSES = new Set(OPEN.split(","));

type PaperclipPart = Pick<Paperclip, "me" | "agents" | "openIssues" | "liveRuns" | "recentRuns" | "issue" | "createIssue" | "updateIssue" | "addComment" | "children" | "commentPage">;
export interface RolloverDeps {
  pc: PaperclipPart;
  store: Pick<Store, "meta" | "setMeta">;
  grading: Pick<Grading, "grades">;
  records: Pick<Records, "list">;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

/** How much of a task's history has been counted: up to comment `after`, as of the task's times `seen`. */
interface Size {
  seen: string;
  at: number;
  after?: string;
  chars: number;
  count: number;
}
interface State {
  sizes: Record<string, Size>;
  /** Old task → successor, until the old task is closed and its sub-tasks moved (a failed step resumes next tick). */
  moving: Record<string, string>;
  /** Old task → successor, kept: where a message written to the old task goes. */
  moved: Record<string, string>;
}

function readState(store: RolloverDeps["store"]): State {
  try {
    return { sizes: {}, moving: {}, moved: {}, ...JSON.parse(store.meta(STATE_KEY) ?? "{}") };
  } catch {
    return { sizes: {}, moving: {}, moved: {} };
  }
}

/** What a fresh session on the task would send, roughly. */
export const estimate = (s: Pick<Size, "chars" | "count">) => s.chars + PER_COMMENT * s.count;

/** Counts the task's comments since the last count (only new pages are fetched). */
async function measure(pc: PaperclipPart, t: Issue, prev: Size | undefined, now: number): Promise<Size> {
  const seen = `${t.updatedAt}|${t.lastActivityAt ?? ""}`;
  if (prev && prev.seen === seen && now - prev.at < RESCAN_MS) return prev;
  const s: Size = prev ? { ...prev, seen, at: now } : { seen, at: now, chars: (t.description ?? "").length, count: 0 };
  for (;;) {
    const page = await pc.commentPage(t.id, { after: s.after });
    for (const c of page) {
      s.chars += c.body.length;
      s.count++;
    }
    if (page.length) s.after = page.at(-1)!.id;
    if (page.length < 500) return s;
  }
}

/** The owner's messages since the agent last wrote there (oldest first): what the successor must still answer. */
function unanswered(newestFirst: Comment[], me: string): Comment[] {
  const out: Comment[] = [];
  for (const c of newestFirst) {
    if (c.authorType === "agent") break;
    // Only the board key's own words are re-posted with it (another admin's stay on the old task, linked).
    if (c.authorUserId !== me || c.deletedAt || c.createdByRunId || [NOTICE_MARKER, APPROVAL_MARKER, RUNNER_MARKER].some((m) => c.body.includes(m)) || !displayText(c.body)) continue;
    out.push(c);
  }
  return out.slice(0, 10).reverse();
}

const baseTitle = (title: string) => title.replace(/ \(continued from [A-Z]+-\d+\)$/, "");

/** The owner's own task: made with the board's key, by no agent, carrying no source. A successor keeps exactly this origin. */
export const ownersOwn = (i: Pick<Issue, "createdByUserId" | "createdByAgentId" | "description">, me: string) =>
  i.createdByUserId === me && !i.createdByAgentId && !/<!--\s*(?:merged-)?source:/.test(i.description ?? "");

/** Creates the successor. Returns its id and the owner's unanswered messages to re-post there once it is recorded. */
async function successor(deps: RolloverDeps, old: Issue, count: number, me: string): Promise<{ id: string; repost: Comment[] }> {
  const { pc } = deps;
  const repost = unanswered(await pc.commentPage(old.id, { newest: true }), me);
  // Only a chat that recorded its agent carries the marker on (on any other task it would read as a chat's opening words).
  const agent = /\n\n<!-- aidenhq-chat-agent:([A-Za-z0-9_-]+) -->\s*$/.exec(old.description ?? "")?.[1];
  const description = [
    `Continues ${old.identifier} (its description and history are there), which grew too long for an agent's fresh session (${count} comments). Its open sub-tasks are under this task now, and messages to ${old.identifier} come here. Read ${old.identifier} only for what you need from it.`,
    continuesMarker(old.id),
    // The chat-agent marker stays last (it is read end-anchored).
    ...(agent ? [chatAgentMarker(agent)] : []),
  ].join("\n\n");
  const next = await pc.createIssue({
    title: `${baseTitle(old.title)} (continued from ${old.identifier})`,
    description,
    status: "todo",
    priority: old.priority,
    assigneeAgentId: old.assigneeAgentId,
    labelIds: old.labelIds ?? old.labels?.map((l) => l.id) ?? [],
    ...(old.parentId ? { parentId: old.parentId } : {}),
    ...(old.projectId ? { projectId: old.projectId } : {}),
    // Its own folder, never the parent's (agents in computers can't share one).
    executionWorkspacePreference: "agent_default",
    executionWorkspaceSettings: { mode: "agent_default" },
    allowDuplicate: true,
  });
  return { id: next.id, repost };
}

/** Points the old task at its successor, takes its agent off, moves its open sub-tasks and closes it. Safe to repeat. */
async function finish(deps: RolloverDeps, oldId: string, nextId: string): Promise<void> {
  const { pc } = deps;
  const [old, next] = await Promise.all([pc.issue(oldId), pc.issue(nextId)]);
  // Off its agent first: moving the last open sub-task away must not wake it there. The notice goes on while it is open and
  // has no agent (a comment on a closed task is never posted: Paperclip reopens such tasks).
  if (continuedIn(old.description) !== nextId || old.assigneeAgentId) {
    await pc.updateIssue(oldId, { description: `Continued in ${next.identifier}.\n\n${continuedMarker(nextId)}\n\n${(old.description ?? "").replace(/^Continued in [A-Z]+-\d+\.\n\n<!-- aidenhq-continued:[A-Za-z0-9_-]+ -->\n\n/, "")}`, assigneeAgentId: null, status: "backlog" });
    await pc.addComment(oldId, `Continued in ${next.identifier}: this task grew too long for an agent's fresh session. Its open sub-tasks move there, and messages written here go there.\n\n${NOTICE_MARKER}`);
  }
  for (const k of await pc.children(oldId)) if (OPEN_STATUSES.has(k.status)) await pc.updateIssue(k.id, { parentId: nextId });
  if (old.status !== "done") await pc.updateIssue(oldId, { status: "done" });
}

/** Where a message to task `id` goes, by the board's record: its successor's successor…, or undefined when it never moved. */
export function successorOf(store: Pick<Store, "meta">, id: string): string | undefined {
  const { moved } = readState(store as RolloverDeps["store"]);
  let next: string | undefined;
  for (let hops = 0; hops < 5 && moved[next ?? id]; hops++) next = moved[next ?? id];
  return next;
}

/** The task a message to `issue` belongs in: its successor by the board's record, else the task itself. */
export async function latest(pc: Pick<Paperclip, "issue">, store: Pick<Store, "meta">, issue: Issue): Promise<Issue> {
  const next = successorOf(store, issue.id);
  return next ? await pc.issue(next).catch(() => issue) : issue;
}

/** One pass. Returns the ids of the tasks it moved. */
export async function rolloverTick(deps: RolloverDeps, now = Date.now()): Promise<string[]> {
  const { pc, store, records, log } = deps;
  const state = readState(store);
  const save = () => store.setMeta(STATE_KEY, JSON.stringify(state));

  for (const [oldId, nextId] of Object.entries(state.moving)) {
    try {
      await finish(deps, oldId, nextId);
      delete state.moving[oldId];
      save();
    } catch (err) {
      log.warn({ issue: oldId, err: String(err) }, "rollover: couldn't finish moving a task; retried next tick");
    }
  }

  const me = await pc.me();
  const runner = new Set((await pc.agents()).filter((a) => a.metadata?.runnerEngine).map((a) => a.id));
  const tasks = (await pc.openIssues()).filter((t) => t.assigneeAgentId && !runner.has(t.assigneeAgentId) && !state.moving[t.id]);
  const live = await pc.liveRuns();
  const runs = await pc.recentRuns(200);
  const busy = new Set([...live, ...runs].filter((r) => ["queued", "scheduled_retry", "running"].includes(r.status)).map((r) => r.issueId));
  // Tasks whose latest finished run hit the input limit: they can never run again where they are.
  const lastRun = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (r.issueId && r.finishedAt && r.finishedAt > (lastRun.get(r.issueId)?.finishedAt ?? "")) lastRun.set(r.issueId, r);
  const stuck = new Set([...lastRun].filter(([, r]) => r.status === "failed" && TOO_LONG.test(r.error ?? "")).map(([id]) => id));

  const sizes: Record<string, Size> = {};
  const moved: string[] = [];
  for (const t of tasks) {
    let size = state.sizes[t.id];
    try {
      size = await measure(pc, t, size, now);
    } catch (err) {
      log.warn({ issue: t.identifier, err: String(err) }, "rollover: couldn't count a task's comments");
    }
    if (size) sizes[t.id] = size;
    if (!stuck.has(t.id) && !(size && estimate(size) > LIMIT)) continue;
    // A card still waiting, or decided in the last day and not yet applied: its outcome is posted on this task.
    const cards = (await records.list("recent", { task: t.id, limit: 50 })).some((a) => a.state === "pending" || (["approved", "used"].includes(a.state) && a.outcome == null && now - Date.parse(a.createdAt) < 24 * 60 * MIN));
    // A task with a grade row isn't moved; the grading module unreachable: treated as graded.
    const graded = await deps.grading.grades([t.id]).then((v) => Boolean(v.grades[t.id]), () => true);
    if (busy.has(t.id) || cards || graded) {
      log.warn({ issue: t.identifier, size: size && estimate(size), stuck: stuck.has(t.id), busy: busy.has(t.id), cards, graded }, "rollover: task too long, not moved now");
      continue;
    }
    try {
      const full = await pc.issue(t.id);
      if (!ownersOwn(full, me)) {
        log.warn({ issue: t.identifier, size: size && estimate(size), stuck: stuck.has(t.id) }, "rollover: task too long, not moved: not the owner's own task, so a successor couldn't keep its origin");
        continue;
      }
      const { id: nextId, repost } = await successor(deps, full, size?.count ?? 0, me);
      // Recorded before anything else can fail, so a retry finishes this move instead of making a second successor.
      state.moving[t.id] = nextId;
      state.moved[t.id] = nextId;
      save();
      for (const c of repost) await pc.addComment(nextId, c.body).catch((err) => log.warn({ issue: t.identifier, err: String(err) }, "rollover: couldn't re-post an unanswered message"));
      await finish(deps, t.id, nextId);
      delete state.moving[t.id];
      delete sizes[t.id];
      moved.push(t.id);
      log.info({ issue: t.identifier, successor: nextId, size: size && estimate(size), stuck: stuck.has(t.id) }, "rollover: task moved to a successor");
    } catch (err) {
      log.warn({ issue: t.identifier, err: String(err) }, "rollover: couldn't move a task; retried next tick");
    }
  }
  state.sizes = sizes;
  save();
  return moved;
}

/** Starts the reconciler (main.ts). */
export function startRollover(pc: Paperclip, store: Store, records: Records, grading: Grading, log: RolloverDeps["log"]): void {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await rolloverTick({ pc, store, records, grading, log });
    } catch (err) {
      log.warn({ err: String(err) }, "rollover failed");
    } finally {
      busy = false;
    }
  };
  setInterval(run, TICK_MS).unref();
  setTimeout(run, 2 * MIN).unref();
  log.info({}, "task rollover on");
}
