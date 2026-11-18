// The board's one watch on Paperclip for open boards (events.ts): while any board listens, every 2s it asks Paperclip
// what changed (tasks updated since the last look, which a new comment counts as, and the live runs) and announces it.
// One small read per tick for every open board together, instead of each browser polling every chat.
// Paperclip's own event socket only admits agent keys, not the board's user key, so the board looks itself.
import type { Logger } from "pino";
import type { SessionActivity } from "./codex-activity.js";
import type { Events } from "./events.js";
import type { Issue, LiveRun, Paperclip } from "./paperclip.js";
import type { Records } from "./records.js";

const TICK_MS = 2_000;
/** Each look reaches back this far past the newest change seen, so a write that commits late isn't missed. */
const OVERLAP_MS = 5_000;
/** A working agent's live words come from its session log, which the board reads at most every 5s (live-activity.ts). */
const PROGRESS_MS = 5_000;

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
}

const isChat = (i: Issue, labelId?: string) => Boolean(i.labels?.some((l) => l.name === "chat") || (labelId && i.labelIds?.includes(labelId)));

/**
 * Announces, per change: `tasks` with the task's id (a conversation open on it refetches), `chat` with the chat's id when
 * the task is a chat or was handed out from one (the chat list, the needs-you badge and the chat refetch), and `progress`
 * with both ids when a run says more. `session`: a Paperclip-run agent's live words from its session log (Paperclip records output progress only
 * once a minute), read only for runs on chats and the work handed out from them.
 */
export function startWatch(o: {
  pc: Paperclip;
  events: Events;
  /** The kernel's records: a card filed, decided or finished announces `approvals`. */
  records?: Pick<Records, "list">;
  log: Logger;
  session?: (agentId: string, startedAt: string | null) => Promise<SessionActivity | null>;
  everyMs?: number;
}): () => void {
  let state: Watched | null = null;
  let busy = false;
  let failing = false;
  let cards: string | undefined;

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

  /** Each task's run as `state|output`: Paperclip's live runs (with live words on chats). */
  async function runs(s: Watched, live: LiveRun[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(
      live.map(async (r) => {
        if (!r.issueId) return;
        const words = r.status === "running" && o.session && chatOf(s, r.issueId) ? await o.session(r.agentId, r.startedAt ?? r.createdAt).catch(() => null) : null;
        out.set(r.issueId, `${r.status}|${r.lastOutputSeq ?? ""}|${words?.saidAt ?? ""}|${words?.steps.at(-1)?.at ?? ""}|${words?.steps.length ?? ""}`);
      }),
    );
    return out;
  }

  async function start(): Promise<Watched> {
    const [open, labels] = await Promise.all([o.pc.openIssues(), o.pc.labels()]);
    const s: Watched = { label: labels.find((l) => l.name === "chat")?.id, chats: new Set(), parents: new Map(), cursor: new Date(Date.now() - OVERLAP_MS).toISOString(), last: new Map(), runs: new Map(), progress: new Set(), progressAt: new Map() };
    for (const i of open) learn(s, i);
    s.runs = await runs(s, await o.pc.liveRuns());
    return s;
  }

  async function tick() {
    // Nobody listening: forget, and start fresh with the next board.
    if (!o.events.open) return void ((state = null), (cards = undefined));
    if (busy) return;
    busy = true;
    try {
      const s = (state ??= await start());
      const since = new Date(Date.parse(s.cursor) - OVERLAP_MS).toISOString();
      const [changed, live] = await Promise.all([o.pc.changedSince(since), o.pc.liveRuns()]);
      const touched = new Set<string>();
      const seen = new Map<string, string>();
      for (const i of changed) {
        seen.set(i.id, i.updatedAt);
        if (i.updatedAt > s.cursor) s.cursor = i.updatedAt;
        learn(s, i);
        if (s.last.get(i.id) !== i.updatedAt) touched.add(i.id);
      }
      s.last = seen;
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
        const now = (await o.records.list("recent", { limit: 100 })).map((a) => `${a.id}|${a.state}|${a.outcome ?? ""}`).join();
        if (cards !== undefined && now !== cards) o.events.emit("approvals");
        cards = now;
      }
      if (failing) o.log.info("live watch back");
      failing = false;
    } catch (err) {
      if (!failing) o.log.warn({ err: String((err as Error).message ?? err).slice(0, 300) }, "live watch failed; trying again every tick");
      failing = true;
    } finally {
      busy = false;
    }
  }

  const t = setInterval(() => void tick(), o.everyMs ?? TICK_MS);
  t.unref();
  return () => clearInterval(t);
}
