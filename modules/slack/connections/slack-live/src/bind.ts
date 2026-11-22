// Channel binding: the owner binds a Slack channel to an agent (`/aiden assign-channel <agent>`), and from then on an
// @mention of the bot in that channel becomes a task for that agent, one Slack thread per task. Only mentions wake the agent;
// it reads the channel's history and the thread through slack_channel_context, which answers only for the channel bound to
// the calling agent. A binding is changed only by the owner's own command: the listener files `slack.bind` (Tier 0,
// a kernel record, so every change is on the record) after checking the Slack user id against the paired owner, and the
// executor checks it again. The table lives in this module's store; the kernel never reads it.
import { randomBytes } from "node:crypto";
import type { Executor } from "./aidenhq-sdk/executor.js";
import { fence } from "./aidenhq-sdk/fence.js";
import { permalink } from "./map.js";
import { clearMemory, channelMemoryOf, noteTask } from "./memory.js";
import type { Store } from "./store.js";

export const CHANNEL = /^[CG][A-Z0-9]{6,}$/;
const AGENT = /^[a-z][a-z0-9-]{0,63}$/;
const USER = /^[UW][A-Z0-9]{2,}$/;
export type Binding = { agent: string; by: string; at: number };
export type Agents = () => Promise<Record<string, { key?: string; trial?: boolean }>>;

export const bindings = (store: Store) => ({
  get: (channel: string): Binding | undefined => {
    const v = store.getKv(`bind:${channel}`);
    return v ? (JSON.parse(v) as Binding) : undefined;
  },
  all: () => store.listKv("bind:").map((r) => ({ channel: r.k.slice(5), ...(JSON.parse(r.v) as Binding) })),
});

const TOKEN_MS = 120_000;
/** The single-use proof that a bind record comes from the owner's own /aiden command: made by the slash handler, spent by execute. */
const pending = (store: Store, a: { op: string; channel: string; agent?: string; by: string }) => {
  const token = randomBytes(24).toString("base64url");
  store.setKv(`bindtok:${token}`, JSON.stringify({ ...a, exp: Date.now() + TOKEN_MS }));
  return token;
};

/**
 * slack.bind, the executor side. Tier 0, but only a record this module filed for a command the owner typed: the slash
 * handler (which checked the Slack-asserted user id) left a single-use token that matches the record's channel, op and agent;
 * a record without one (a forged `by`) is refused. The kernel names the requester, not the args.
 */
export function binder(store: Store, opts: { ownerId: string; agents: Agents; module?: string }): Executor {
  const { agents, module = process.env.AIDENHQ_MODULE ?? "slack" } = opts; // ownerId is read per check: pairing changes it after start
  const check = async (a: any, requester: { kind?: string; module?: string } | undefined, spend: boolean) => {
    const ownerId = opts.ownerId;
    if (requester?.kind !== "module" || requester.module !== module) throw new Error("only this module files a binding");
    const key = `bindtok:${String(a?.token ?? "")}`;
    const t = a?.token ? (JSON.parse(store.getKv(key) ?? "null") as { op: string; channel: string; agent?: string; by: string; exp: number } | null) : null;
    if (!t || t.exp < Date.now() || t.by !== ownerId || !ownerId || t.op !== a.op || t.channel !== a.channel || (t.agent ?? "") !== (a.agent ?? "")) throw new Error("only the owner may bind a channel, with their own /aiden command");
    if (spend) store.delKv(key);
    if (!CHANNEL.test(a?.channel ?? "")) throw new Error("run it in a channel (a public or private channel, not a DM)");
    if (a.op === "unassign") return { op: "unassign", channel: a.channel, by: t.by, agent: "", token: a.token };
    if (a.op !== "assign" || !AGENT.test(a.agent ?? "")) throw new Error("assign needs an agent key");
    const g = Object.values(await agents()).find((x) => x.key === a.agent);
    if (!g) throw new Error(`no agent ${a.agent}`);
    if (g.trial) throw new Error(`${a.agent} is in trial and can't take a channel`);
    return { op: "assign", channel: a.channel, by: t.by, agent: a.agent as string, token: a.token };
  };
  return {
    async plan(req) {
      const args = await check(req.args, req.requester, false);
      return { args, targets: { channel: args.channel }, card: { summary: args.op === "assign" ? `Assign ${args.channel} to ${args.agent}` : `Unassign ${args.channel}` } };
    },
    async execute(rec) {
      const a = await check(rec.args, { kind: "module", module }, true);
      // A channel's memory belongs to its binding: an unbind or a hand-over to another agent clears it.
      if (a.op === "unassign" || bindings(store).get(a.channel)?.agent !== a.agent) clearMemory(store, a.channel);
      if (a.op === "assign") store.setKv(`bind:${a.channel}`, JSON.stringify({ agent: a.agent, by: a.by, at: Date.now() } satisfies Binding));
      else store.delKv(`bind:${a.channel}`);
      return { ok: true, text: a.op === "assign" ? `${a.channel} is bound to ${a.agent}.` : `${a.channel} is unbound.` };
    },
  };
}

type Slash = { user_id?: string; channel_id?: string; text?: string };
/**
 * `/aiden assign-channel <agent>`, `/aiden unassign-channel`, `/aiden channels`: the text to answer the owner with. `file` files a
 * kernel record and returns its state; the check of who is asking is here, from the id Slack asserts on the command.
 */
export async function slashCommand(body: Slash, { store, ownerId, file }: { store: Store; ownerId: string; file: (args: Record<string, string>) => Promise<{ state: string }> }): Promise<string> {
  if (!ownerId || body.user_id !== ownerId) return "Only the owner can use /aiden.";
  const [cmd, agent] = String(body.text ?? "").trim().split(/\s+/);
  const channel = String(body.channel_id ?? "");
  if (cmd === "channels") {
    const rows = bindings(store).all();
    return rows.length ? rows.map((r) => `<#${r.channel}> → ${r.agent}`).join("\n") : "No channel is assigned to an agent.";
  }
  if (cmd !== "assign-channel" && cmd !== "unassign-channel") return "Use `/aiden assign-channel <agent-key>`, `/aiden unassign-channel` or `/aiden channels`.";
  const op = cmd === "assign-channel" ? "assign" : "unassign";
  if (op === "assign" && !agent) return "Which agent? `/aiden assign-channel <agent-key>`";
  try {
    const args = { op, channel, by: body.user_id!, ...(agent ? { agent } : {}) };
    const r = await file({ ...args, token: pending(store, args) });
    // The executor runs a moment after the record is claimed: wait for it before saying it is done.
    for (let i = 0; i < 10 && r.state === "claimed" && (bindings(store).get(channel)?.agent ?? "") !== (agent ?? ""); i++) await new Promise((ok) => setTimeout(ok, 200));
    if (r.state !== "claimed" || (bindings(store).get(channel)?.agent ?? "") !== (agent ?? "")) return `Filed (${r.state}); it applies once it is approved.`;
    return op === "assign"
      ? `Done: <#${channel}> is assigned to ${agent}. Invite the bot to this channel if it isn't in it, then @mention it to hand ${agent} a task.`
      : `Done: <#${channel}> is no longer assigned.`;
  } catch (e) {
    return `Not done: ${(e as Error).message}`;
  }
}

const MENTIONS_PER_HOUR = 30;
const recent = new Map<string, number[]>();
type Ev = { type?: string; subtype?: string; bot_id?: string; app_id?: string; user?: string; channel?: string; ts?: string; thread_ts?: string; text?: string };
/**
 * An @mention in a bound channel: one Slack thread is one task for the bound agent (the kernel keys it by channel:thread_ts and
 * fences the text). Mentions only; bots and apps (so an agent never wakes itself or another agent), edits and joins are
 * ignored. A channel over its mention rate gets a reaction and no task. True when the event was this module's to handle.
 */
export async function mention(ev: Ev | undefined, { store, thread, react, now = Date.now() }: { store: Store; thread: (b: Record<string, string>) => Promise<any>; react: (channel: string, ts: string, name: string) => Promise<void>; now?: number }): Promise<boolean> {
  if (ev?.type !== "app_mention" || ev.subtype || ev.bot_id || ev.app_id || !ev.channel || !ev.ts || !ev.text?.trim() || !USER.test(ev.user ?? "")) return false;
  const bound = bindings(store).get(ev.channel);
  if (!bound) return false;
  if (store.getKv(`bind_seen:${ev.channel}:${ev.ts}`)) return true;
  const window = (recent.get(ev.channel) ?? []).filter((t) => now - t < 3_600_000);
  if (window.length >= MENTIONS_PER_HOUR) {
    recent.set(ev.channel, window);
    await react(ev.channel, ev.ts, "hourglass_flowing_sand").catch(() => undefined);
    return true;
  }
  recent.set(ev.channel, [...window, now]);
  const threadTs = ev.thread_ts ?? ev.ts;
  const t = await thread({ agent: bound.agent, thread: `${ev.channel}:${threadTs}`, from: ev.user!, text: ev.text.trim(), link: permalink(ev.channel, ev.ts) });
  noteTask(store, t?.task, `${ev.channel}:${threadTs}`); // which tasks are this channel's threads: channel_memory is allowed from those only
  store.setKv(`bind_seen:${ev.channel}:${ev.ts}`, "1");
  await react(ev.channel, ev.ts, "eyes").catch(() => undefined);
  return true;
}

/** slack_channel_context: the recent messages of a bound channel (or one thread of it) for the agent it is bound to, and nobody else. */
export async function channelContext(store: Store, botToken: string, callerKey: string | undefined, a: { channel: string; thread_ts?: string | undefined; limit?: number | undefined }) {
  const bound = bindings(store).get(a.channel);
  if (!bound || !callerKey || bound.agent !== callerKey) throw new Error(`${a.channel} isn't a channel assigned to you`);
  const method = a.thread_ts ? "conversations.replies" : "conversations.history";
  const q = new URLSearchParams({ channel: a.channel, limit: String(Math.min(a.limit ?? 30, 100)), ...(a.thread_ts ? { ts: a.thread_ts } : {}) });
  const r = (await (await fetch(`https://slack.com/api/${method}?${q}`, { headers: { authorization: `Bearer ${botToken}` } })).json()) as { ok?: boolean; error?: string; messages?: { user?: string; bot_id?: string; ts?: string; text?: string }[] };
  if (!r.ok) throw new Error(`Slack refused: ${r.error ?? "unknown"} (the bot must be a member of the channel)`);
  const messages = [...(r.messages ?? [])].sort((x, y) => Number(x.ts) - Number(y.ts)).map((m) => ({ ts: m.ts, from: m.user ?? m.bot_id ?? "", text: fence(m.text ?? "", `slack:${a.channel}:${m.user ?? "bot"}`) }));
  const mem = channelMemoryOf(store, a.channel);
  return { channel: a.channel, ...(a.thread_ts ? { thread_ts: a.thread_ts } : {}), messages, memory: { revision: mem.revision, updated_at: mem.updated_at, from: mem.provenance, note: fence(mem.note, `slack-channel-memory:${a.channel}`) } };
}
