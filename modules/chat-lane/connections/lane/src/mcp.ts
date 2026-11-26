import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LaneAgent } from "./lane/config.js";
import type { Lane } from "./lane/lane.js";
import type { LaneStore, Wake } from "./lane/store.js";
import { localShort, parseWhen } from "./lane/time.js";

/** Who called (the kernel's assertion of this call). */
export interface Caller {
  id: string;
  name?: string;
  key: string;
}

/**
 * The fast chat lane's side of the tools (wake_at, chat_send). `taskIsClosed` says whether a task is done or cancelled,
 * which the wake cap asks (the kernel's read of the control plane): a wake left on finished work is not a wake the agent still needs to keep.
 */
export interface LaneTools {
  store: LaneStore;
  lane: Lane;
  agents: () => Record<string, LaneAgent>;
  timezone: string;
  taskIsClosed: (task: string) => Promise<boolean>;
  /** Files a task wake in the kernel now, due at `at`, so the task's state sees it before it is due (the kernel refuses it unless `agent` is the assignee); never rejects. */
  fileWake: (id: number, task: string, note: string, at: number, agent: string) => Promise<void>;
}
export const MAX_WAKES = 50;

/** Its pending wakes that count toward the cap: the ones without a task, and those on a task still open. */
async function liveWakes(lane: LaneTools, wakes: Wake[]): Promise<Wake[]> {
  const queue = [...new Set(wakes.flatMap((w) => (w.task ? [w.task] : [])))];
  const closed = new Map<string, boolean>();
  // The kernel is asked about each task a few at a time (an agent at the cap can hold fifty), and one it can't answer for
  // stays counted: a full cap is the safer failure.
  const worker = async () => {
    for (let task = queue.shift(); task !== undefined; task = queue.shift()) closed.set(task, await lane.taskIsClosed(task).catch(() => false));
  };
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  return wakes.filter((w) => !w.task || !closed.get(w.task));
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function buildServer(lane: LaneTools, caller?: Caller): McpServer {
  const server = new McpServer(
    { name: "chat-lane", version: "0.1.0" },
    { instructions: "Wakes (reminders and follow-ups for yourself) and answers in your fast-lane chats." },
  );
  server.registerTool(
    "wake_at",
    {
      description:
        "Wake yourself later, with a note to your future self: a reminder for the owner, or a follow-up check (\"see whether X replied\"). when_local is the owner's local time, \"YYYY-MM-DD HH:MM\", or \"in 20 minutes\" / \"in 2 hours\" / \"in 1 day\". It echoes the time it stored: check it. With `chat: true` the wake is a turn in your fast-lane chat with the owner; with `task` it is a notice on that task, which wakes you there. At most 50 pending per agent, counting only wakes on tasks that are still open: a wake on a done or cancelled task doesn't count, and is dropped instead of posted when it comes due. `wake_list` shows yours.",
      inputSchema: z.strictObject({
        when_local: z.string().min(1).max(40),
        note: z.string().min(1).max(1000),
        chat: z.boolean().optional(),
        task: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (a) => {
      if (!lane || !caller) return json({ ok: false, reason: "wakes aren't available here" });
      // A lane agent's wakes are kept under its key (they show in its lane context); any other agent's under its id.
      const who = Object.values(lane.agents()).find((x) => x.id === caller.id)?.key;
      const owner = who ?? caller.id;
      if (!a.chat === !a.task) return json({ ok: false, reason: "pass exactly one of chat: true or task" });
      // A chat wake is a turn in the caller's own chat with the owner, so only a lane agent has one.
      if (a.chat && !who) return json({ ok: false, reason: "you have no fast-lane chat" });
      const due = parseWhen(a.when_local, lane.timezone);
      if (due === undefined) return json({ ok: false, reason: 'when_local must be "YYYY-MM-DD HH:MM" (owner-local) or "in N minutes|hours|days"' });
      if (due < Date.now() - 60_000) return json({ ok: false, reason: `that is in the past (${localShort(lane.timezone, due)})` });
      // The check awaits the board, so it and the insert run under the agent's wake lock: two calls can't both pass it.
      return lane.store.withWakeLock(owner, async () => {
        const pending = await liveWakes(lane, lane.store.pendingWakes(owner));
        if (pending.length >= MAX_WAKES)
          return json({
            ok: false,
            reason: `you already have ${MAX_WAKES} pending wakes on open tasks`,
            pending: pending.length,
            wakes: pending.map((w) => ({ task: w.task, chat: Boolean(w.chat), due_local: `${localShort(lane.timezone, w.due_at)} (${lane.timezone})` })),
          });
        const id = lane.store.addWake(owner, due, a.note, Boolean(a.chat), a.task ?? null);
        if (a.task) await lane.fileWake(id, a.task, a.note, Math.max(due, Date.now()), caller.id); // a time up to a minute past is filed as now
        return json({ ok: true, id, due_local: `${localShort(lane.timezone, due)} (${lane.timezone})` });
      });
    },
  );
  server.registerTool(
    "wake_list",
    {
      description:
        "Your pending wakes, oldest first, with the task each is for (or your chat) and its owner-local time: what counts toward the 50-wake cap, so a refusal can be diagnosed. Wakes on tasks that are done or cancelled don't count, and are dropped when due instead of posted.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      if (!lane || !caller) return json({ ok: false, reason: "wakes aren't available here" });
      const who = Object.values(lane.agents()).find((x) => x.id === caller.id)?.key;
      const owner = who ?? caller.id;
      const all = lane.store.pendingWakes(owner);
      const live = new Set((await liveWakes(lane, all)).map((w) => w.id));
      return json({
        pending: live.size,
        cap: MAX_WAKES,
        wakes: all.map((w) => ({
          id: w.id,
          task: w.task,
          chat: Boolean(w.chat),
          due_local: `${localShort(lane.timezone, w.due_at)} (${lane.timezone})`,
          note: w.note,
          counts: live.has(w.id),
        })),
      });
    },
  );
  server.registerTool(
    "chat_send",
    {
      description:
        "Answer in your fast-lane chat with the owner from a background run: the follow-up to an ask you replied \"on it\" to. Say which ask it answers. Posted as you in your chat task, and on your own Telegram bot if you have one.",
      inputSchema: z.strictObject({ text: z.string().min(1).max(8000) }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (a) => {
      if (!lane || !caller) return json({ ok: false, reason: "chat_send isn't available here" });
      const key = Object.values(lane.agents()).find((x) => x.id === caller.id)?.key ?? "";
      if (!key) return json({ ok: false, reason: "you have no fast-lane chats" });
      // Always the caller's own chat: there is no other to name.
      await lane.lane.followUp(key, a.text);
      return json({ ok: true });
    },
  );
  return server;
}
