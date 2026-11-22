// Channel memory: a short note per bound channel, written by the agent the channel is bound to and stored beside the binding
// (`mem:<channel>`). One write replaces the whole note (slack.memory, Tier 1: the AI reviewer reads it for private or
// secret content); a stale base_revision is refused. The code check is where the write may come from: a task that is a thread
// of that same channel (the mapping noteTask keeps when a mention files the thread), by the agent the channel is bound to.
// The note is cleared when the channel is unbound or handed to another agent (bind.ts).
import type { Executor } from "./aidenhq-sdk/executor.js";
import { bindings, CHANNEL } from "./bind.js";
import type { Store } from "./store.js";

export const NOTE_MAX = 2048; // bytes
export type Memory = { note: string; revision: number; updated_at: number; provenance: string };

export const channelMemoryOf = (store: Store, channel: string): Memory => {
  const v = store.getKv(`mem:${channel}`);
  return v ? (JSON.parse(v) as Memory) : { note: "", revision: 0, updated_at: 0, provenance: "" };
};
export const clearMemory = (store: Store, channel: string) => store.delKv(`mem:${channel}`);

/** A mention's task and the Slack thread ("channel:ts") it is: the module's own record of the tasks it made channel threads. */
export function noteTask(store: Store, task: { id?: string; identifier?: string } | undefined, thread: string) {
  for (const id of [task?.id, task?.identifier]) if (id) store.setKv(`tt:${id}`, thread);
}

const check = (store: Store, a: any, requester: { key?: string; task?: string } | undefined) => {
  const channel = String(a?.channel ?? "");
  if (!CHANNEL.test(channel)) throw new Error("channel must be a channel id, e.g. C0123ABCD");
  if (typeof a?.note !== "string") throw new Error("note must be text (empty clears it)");
  if (Buffer.byteLength(a.note) > NOTE_MAX) throw new Error(`the note is over ${NOTE_MAX} bytes: rewrite it shorter`);
  if (!Number.isInteger(a?.base_revision) || a.base_revision < 0) throw new Error("base_revision is the revision you read (0 when there is no note yet)");
  const bound = bindings(store).get(channel);
  if (!bound || !requester?.key || bound.agent !== requester.key) throw new Error(`${channel} isn't a channel assigned to you`);
  const thread = requester.task ? store.getKv(`tt:${requester.task}`) : undefined;
  if (!thread || thread.split(":")[0] !== channel) throw new Error(`channel memory is written only from a task that is a thread of ${channel}`);
  const cur = channelMemoryOf(store, channel);
  if (a.base_revision !== cur.revision) throw new Error(`stale: the note is at revision ${cur.revision}, you wrote from ${a.base_revision}; read slack_channel_context again and rewrite`);
  return { channel, note: a.note, base_revision: a.base_revision as number, agent: bound.agent, provenance: `slack:${thread}` };
};

export function memoryWriter(store: Store): Executor {
  return {
    async plan(req) {
      const args = check(store, req.args, { ...req.requester, task: req.requester?.task ?? req.task });
      return { args, targets: { channel: args.channel }, card: { where: args.channel } };
    },
    async execute(rec) {
      const a = rec.args;
      const bound = bindings(store).get(String(a?.channel));
      const thread = String(a?.provenance ?? "").slice(6);
      // The record was planned for this agent and thread; the binding and the revision are checked again at the write.
      if (!bound || bound.agent !== a.agent || thread.split(":")[0] !== a.channel) throw new Error("the channel is no longer assigned to that agent");
      const cur = channelMemoryOf(store, a.channel);
      if (a.base_revision !== cur.revision) throw new Error(`stale: the note moved to revision ${cur.revision}`);
      store.setKv(`mem:${a.channel}`, JSON.stringify({ note: a.note, revision: cur.revision + 1, updated_at: Date.now(), provenance: a.provenance } satisfies Memory));
      return { ok: true, text: `${a.channel} note is now revision ${cur.revision + 1}.` };
    },
  };
}
