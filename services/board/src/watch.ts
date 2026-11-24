// The board's one watch on Paperclip for open boards (events.ts): while any board listens, every 2s it asks Paperclip
// what changed (tasks updated since the last look, which a new comment counts as, and the live runs) and announces it.
// One small read per tick for every open board together, instead of each browser polling every chat.
// Paperclip's own event socket only admits agent keys, not the board's user key, so the board looks itself.
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { SessionActivity } from "./codex-activity.js";
import type { Events } from "./events.js";
import type { Issue, Paperclip } from "./paperclip.js";
import type { LiveRun } from "./runs.js";
import { isLive, type Records } from "./records.js";
import { statesOf, type TaskStates } from "./task-state.js";

const TICK_MS = 5_000;
/** After a failed look the next waits twice as long each time, up to this. */
const BACKOFF_MAX_MS = 60_000;
/** The kernel's live records (a page walk) are read every this many ticks; the newest records, every tick. */
const LIVE_EVERY_TICKS = 3;
/** Each look reaches back this far past the newest change seen, so a write that commits late isn't missed. */
const OVERLAP_MS = 5_000;
/** A working agent's live words come from its session log, which the board reads at most every 5s (live-activity.ts). */
const PROGRESS_MS = 5_000;
/** The board's sweep (app.ts `sweep`) runs when tasks changed (at most this often) and at least once a minute while boards listen, and when the watch starts. */
const SWEEP_MS = 10_000;
const SWEEP_IDLE_MS = 60_000;
/** Time alone changes a task's state (a task idle for 15 minutes needs someone, a wake falls due), and nothing in Paperclip says so: every minute the open tasks' states are read. */
const OPEN_EVERY_MS = 60_000;

interface Watched {
  label?: string;
  /** Ids of chats (tasks labelled `chat`) and the parent of every task seen. */
  chats: Set<string>;
  parents: Map<string, string | null>;
  cursor: string;
  /** What the last look returned (id → updatedAt), so the overlap isn't announced twice. */
  last: Map<string, string>;
  /** Each task's run: its state, then where its output is. */
  runs: Map<string, string>;
  /** Progress to announce per task, and when each was last announced (at most every PROGRESS_MS). */
  progress: Set<string>;
  progressAt: Map<string, number>;
  /** Each task's state as last seen (`kind|reason|ref|attention`), and the tasks the last open read listed. */
  states: Map<string, string>;
  open: Set<string>;
  ticks: number;
  /** When the open tasks' states were last read. */
  openAt: number;
}

/** A wait's fingerprint: the whole reason identifies a change, however long it is, and the key stays small. */
const hashOf = (s: string): string => (s.length <= 200 ? s : `${s.length}:${createHash("sha256").update(s).digest("hex").slice(0, 32)}`);

/** What a view shows of a state: when this changes, the task is announced. */
const stateKey = (r: { kind: string; reason: string; ref?: string; attention: { who: string; why: string; ref: string }[] }) =>
  `${r.kind}|${r.reason}|${r.ref ?? ""}|${r.attention.map((a) => `${a.who}:${a.why}:${a.ref}`).join(",")}`;

const isChat = (i: Issue, labelId?: string) => Boolean(i.labels?.some((l) => l.name === "chat") || (labelId && i.labelIds?.includes(labelId)));

/**
 * Announces, per change: `tasks` with the task's id (a conversation open on it refetches), `chat` with the chat's id when
 * the task is a chat or was handed out from one (the chat list, the needs-you badge and the chat refetch), and `progress`
 * with both ids when a run says more. `session`: a Paperclip-run agent's live words from its session log (Paperclip records output progress only
 * once a minute), read only for runs on chats and the work handed out from them. A change in the kernel's state of a task
 * (closures included) announces it too, though nothing changed in Paperclip.
 */
export function startWatch(o: {
  pc: Paperclip;
  /** The kernel's jobs running now. */
  liveRuns: () => Promise<LiveRun[]>;
  /** The kernel's task states: re-read for each task seen to change, and for every open task each minute. */
  states: TaskStates;
  events: Events;
  /** The kernel's records: a card filed, decided or finished announces `approvals`. */
  records?: Pick<Records, "list" | "live">;
  log: Logger;
  session?: (agentId: string, startedAt: string | null) => Promise<SessionActivity | null>;
  /** The board's writes (new tasks placed, crew parts closed, settled tasks back), off its read path; run on its own, never two at once. */
  sweep?: () => Promise<void>;
  everyMs?: number;
}): () => void {
  let state: Watched | null = null;
  let busy = false;
  let failing = false;
  let cards: string | undefined;
  let liveCards: Awaited<ReturnType<Records["live"]>> | undefined;
  let failures = 0;
  let sweeping = false, sweptAt = 0, sweepFailing = false;
  const sweep = () => {
    if (!o.sweep || sweeping) return;
    sweeping = true;
    sweptAt = Date.now();
    void o.sweep().then(
      () => (sweepFailing && o.log.info("board sweep back"), (sweepFailing = false)),
      (err) => (!sweepFailing && o.log.warn({ err: String((err as Error).message ?? err).slice(0, 300) }, "board sweep failed; trying again every 10s"), (sweepFailing = true)),
    ).finally(() => (sweeping = false));
  };

  /** The chat a task belongs to: itself, or the chat it was handed out from. */
  const chatOf = (s: Watched, id: string) => {
    if (s.chats.has(id)) return id;
    const parent = s.parents.get(id);
    return parent && s.chats.has(parent) ? parent : undefined;
  };

  function learn(s: Watched, i: Issue) {
    s.parents.set(i.id, i.parentId ?? null);
    if (isChat(i, s.label)) s.chats.add(i.id);
  }

  /** Each task's run as `state|output`: the kernel's running jobs (with live words on chats). */
  async function runs(s: Watched, live: LiveRun[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(
      live.map(async (r) => {
        if (!r.issueId) return;
        const words = r.status === "running" && o.session && chatOf(s, r.issueId) ? await o.session(r.agentId, r.startedAt).catch(() => null) : null;
        out.set(r.issueId, `${r.status}|${words?.saidAt ?? ""}|${words?.steps.at(-1)?.at ?? ""}|${words?.steps.length ?? ""}`);
      }),
    );
    return out;
  }

  async function start(): Promise<Watched> {
    const [open, labels] = await Promise.all([o.pc.openIssues(), o.pc.labels()]);
    const s: Watched = { label: labels.find((l) => l.name === "chat")?.id, chats: new Set(), parents: new Map(), cursor: new Date(Date.now() - OVERLAP_MS).toISOString(), last: new Map(), runs: new Map(), progress: new Set(), progressAt: new Map(), states: new Map(), open: new Set(), ticks: 0, openAt: Date.now() };
    for (const i of open) learn(s, i);
    s.runs = await runs(s, await o.liveRuns());
    // What every open task shows now: the first look announces nothing.
    for (const r of (await o.states.read({ open: true })).tasks) (s.states.set(r.task, stateKey(r)), s.open.add(r.task));
    return s;
  }

  async function tick() {
    // Nobody listening: forget, and start fresh with the next board.
    if (!o.events.open) return void ((state = null), (cards = undefined), (liveCards = undefined));
    if (busy) return;
    busy = true;
    try {
      // A watch that starts again (no board listened meanwhile) catches up first: its cursor restarts near now.
      if (!state) sweep();
      const s = (state ??= await start());
      const since = new Date(Date.parse(s.cursor) - OVERLAP_MS).toISOString();
      const [changed, live] = await Promise.all([o.pc.changedSince(since), o.liveRuns()]);
      const touched = new Set<string>();
      const seen = new Map<string, string>();
      for (const i of changed) {
        seen.set(i.id, i.updatedAt);
        if (i.updatedAt > s.cursor) s.cursor = i.updatedAt;
        learn(s, i);
        if (s.last.get(i.id) !== i.updatedAt) touched.add(i.id);
      }
      s.last = seen;
      // The board's writes follow the tasks that changed (the snapshot already has these rows); a quiet board looks once a minute.
      if (touched.size ? Date.now() - sweptAt >= SWEEP_MS : Date.now() - sweptAt >= SWEEP_IDLE_MS) sweep();
      // A run that started, ended or changed state touches its task; more output is progress.
      const now = await runs(s, live);
      for (const id of new Set([...now.keys(), ...s.runs.keys()])) {
        const [was, is] = [s.runs.get(id), now.get(id)];
        if (was === is) continue;
        if (was?.split("|")[0] === is?.split("|")[0]) s.progress.add(id);
        else touched.add(id);
      }
      s.runs = now;
      const chats = new Set<string>();
      for (const id of touched) {
        o.events.emit("tasks", id);
        const chat = chatOf(s, id);
        if (chat) chats.add(chat);
      }
      for (const chat of chats) o.events.emit("chat", chat);
      // Progress waits out its interval (never dropped); a task just refetched for a change needs none.
      const t = Date.now();
      for (const id of s.progress) {
        if (touched.has(id)) s.progress.delete(id);
        else if (t - (s.progressAt.get(id) ?? 0) >= PROGRESS_MS) {
          s.progress.delete(id);
          s.progressAt.set(id, t);
          o.events.emit("progress", id);
          const chat = chatOf(s, id);
          if (chat && chat !== id && !chats.has(chat)) o.events.emit("progress", chat);
        }
      }
      if (o.records) {
        // The cards Approvals can show: the newest reads, and every live record in its own uncapped, any-tier read paged to the
        // last one (a Tier 0 record in flight is `running` too, and neither the newest 100 nor the kernel's page size may drop a
        // blocked merge). A live record's wait reason changes nothing else about it, so it is in the key too: an open view refetches
        // when the reason does (a merge entering or leaving code review's wait), not a minute later. The record's own reason is
        // compared whole (`records.list`, before the wire's display cap), so a change past the cap still refreshes.
        const readLive = !liveCards || s.ticks % LIVE_EVERY_TICKS === 0;
        const [recent, read] = await Promise.all([o.records.list("recent", { limit: 100 }), readLive ? o.records.live().catch(() => undefined) : undefined]);
        const live = read ?? liveCards;
        if (read) liveCards = read;
        // A failed live page throws (never a short list posing as the whole set): the watcher then leaves its key alone, so a
        // transient kernel restart neither hides a blocked card nor announces a reason it couldn't read.
        if (live) {
          const seen = new Set(recent.map((a) => a.id));
          const held = live.filter((a) => isLive(a.state) && !seen.has(a.id) && (seen.add(a.id), true));
          const now = [...recent, ...held].map((a) => `${a.id}|${a.state}|${a.outcome ?? ""}|${hashOf(a.wait ?? "")}`).join();
          if (cards !== undefined && now !== cards) o.events.emit("approvals");
          cards = now;
        }
      }
      // The kernel's states: re-read for each task seen to change (so a change already announced isn't announced twice), and
      // for every open task each minute. A task whose state differs from the last seen is announced.
      const shifted = new Set<string>();
      const learnStates = (rows: { task: string; kind: string; reason: string; ref?: string; attention: { who: string; why: string; ref: string }[] }[], ids: Iterable<string>, quiet: boolean) => {
        const have = new Map(rows.map((r) => [r.task, stateKey(r)]));
        for (const id of ids) {
          const key = have.get(id) ?? "";
          if (!quiet && s.states.has(id) && s.states.get(id) !== key) shifted.add(id);
          s.states.set(id, key);
        }
      };
      if (touched.size) learnStates([...(await statesOf(o.states, [...touched])).values()], touched, true);
      s.ticks++;
      if (Date.now() - s.openAt >= OPEN_EVERY_MS) {
        s.openAt = Date.now();
        const rows = (await o.states.read({ open: true })).tasks;
        const now = new Set(rows.map((r) => r.task));
        // One that left the open list was closed: its own read says how.
        const gone = [...s.open].filter((id) => !now.has(id));
        learnStates([...rows, ...(gone.length ? (await statesOf(o.states, gone)).values() : [])], [...now, ...gone], false);
        s.open = now;
      }
      for (const id of shifted) {
        o.events.emit("tasks", id);
        const chat = chatOf(s, id);
        if (chat) o.events.emit("chat", chat);
      }
      if (failing) o.log.info("live watch back");
      failing = false;
      failures = 0;
    } catch (err) {
      if (!failing) o.log.warn({ err: String((err as Error).message ?? err).slice(0, 300) }, "live watch failed; trying again every tick");
      failing = true;
      failures++;
    } finally {
      busy = false;
    }
  }

  sweep(); // start-up catch-up
  // One look at a time, the next after the base wait (longer after failures, so a struggling upstream isn't asked every tick).
  const every = o.everyMs ?? TICK_MS;
  let t: NodeJS.Timeout;
  let stopped = false;
  const next = () => {
    t = setTimeout(() => void tick().finally(() => !stopped && next()), Math.min(BACKOFF_MAX_MS, every * 2 ** Math.min(failures, 6)));
    t.unref();
  };
  next();
  return () => ((stopped = true), clearTimeout(t));
}
