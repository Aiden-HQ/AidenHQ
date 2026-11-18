// notify: the one way a message reaches the owner, from an agent (the MCP tool) or from the kernel, the board and the runner
// (the kernel's queue). One message reaches the owner once: on its chat on the board (an agent's reply, as that agent) and
// on the first channel that delivers it (where the owner last wrote in that chat, else the transports setting's order).
// Duplicates are dropped, muted and routine ones go to the board or the digest, and while every channel is down the
// message waits and goes once one is back.
import { createHash } from "node:crypto";
import { attend, queueDigest, type AttentionConfig } from "./attention.js";
import type { Store } from "./store.js";

/**
 * decision: needs the owner (never held back by the limit); done: a finished result (never muted); fyi: news (the owner may
 * mute these); alert: something is wrong now (no brake, no digest; one per dedupe key an hour); digest: a routine's summary.
 */
export type Kind = "decision" | "done" | "fyi" | "alert" | "digest";
export const KINDS: Kind[] = ["decision", "done", "fyi", "alert", "digest"];
/** A multiple-choice question: the recommended option first; the owner may always answer in their own words instead. */
export type Question = { question: string; options: string[]; multi?: boolean | undefined };
export interface NotifyArgs {
  kind: Kind;
  text: string;
  task?: string | undefined; // the chat (task identifier) this is about: its agent's name heads it; the reply lands there
  questions?: Question[] | undefined; // multiple choice: the board shows a form; channels get them spelled out
  actions?: string[] | undefined; // one-tap answers (a press sends the label as the owner's message)
  dedupe_key?: string | undefined; // one message per key in the window, from any sender
  /** A job's reply the kernel relays (kernel relay.ts): already on its task, it goes only to the channel the owner wrote from. */
  relay?: { via: "telegram" | "slack"; agentName: string; issueId: string } | undefined;
}
/** What a channel's transport gets: the text as written (each channel renders and escapes it), and who it is from. */
export type Message = { kind: Kind; text: string; head?: { agent: string; task: string; issue: string }; actions?: string[]; asks?: true };
export type Found = { issueId: string; agentId: string; agentName: string; ownerVia?: "board" | "telegram" | "slack" | undefined };
/** Who called notify: the agent, its key, its roles, and the kernel's assertion of this call (its reply is posted on it). */
export interface Caller { id: string; name?: string | undefined; key: string; roles?: string[] | undefined; assertion: string }
export type Result = { sent: boolean; reason?: "duplicate" | "limit" | "muted" | "blocked" | "error"; onChat?: true; queued?: true; note?: string };

export interface Deps {
  store: Store;
  /** The channel modules to try, in the owner's order (setting notify_transports). */
  transports: string[];
  /** One message to one channel (the kernel's POST /v1/notify/send): sent, or off (not installed or not set up). */
  send: (to: string, m: Message) => Promise<{ sent: boolean; off?: boolean | undefined }>;
  /** The task's id, its live agent and where the owner last wrote on it (through the kernel; never from the message text). */
  resolveTask?: (identifier: string) => Promise<Found | undefined>;
  /** Posts the reply on its chat as the calling agent (the kernel's /v1/cp/agent, on this call's assertion). */
  postReply?: (issueId: string, body: string, assertion: string) => Promise<boolean>;
  /** The kernel's loop brake: whether one more message about this task may go now. */
  brake?: (task: string, agent: string, decision: boolean) => Promise<{ allow: boolean; note?: string }>;
  /** Setting notify_fyi: mute. */
  muteFyi?: boolean;
  attention?: AttentionConfig;
}

const MIN = 60_000;
const WINDOW = { alert: 60 * MIN, other: 10 * MIN };

/** Marks an agent's comment as its visible reply to the owner (the board shows it as a message, not a run note). */
export const REPLY_MARKER = "<!-- aidenhq-reply -->";
/** The comment that mirrors a notify(task) message onto its chat, with its one-tap answers and questions for the board. */
export function replyBody(text: string, actions: string[] = [], questions: Question[] = []): string {
  const safe = (x: string) => x.replace(/--+/g, "—").replace(/[<>]/g, "");
  const labels = actions.map(safe);
  const qs = questions.map((q) => ({ question: safe(q.question), options: q.options.map(safe), ...(q.multi ? { multi: true } : {}) }));
  return `${text}\n\n${REPLY_MARKER}${labels.length ? `\n<!-- aidenhq-actions:${JSON.stringify(labels)} -->` : ""}${qs.length ? `\n<!-- aidenhq-questions:${JSON.stringify(qs)} -->` : ""}`;
}

/** The questions as text, for channels without a form. */
export function spellOut(questions: Question[] = []): string {
  if (!questions.length) return "";
  const letter = (i: number) => String.fromCharCode(65 + i);
  const blocks = questions.map((q, n) => [`**${n + 1}. ${q.question}**${q.multi ? " (pick any)" : ""}`, ...q.options.map((o, i) => `- ${letter(i)}) ${o}${i === 0 ? " (recommended)" : ""}`)].join("\n"));
  return `\n\n${blocks.join("\n\n")}\n\nReply like "1A, 2B", or in your own words.`;
}

// Some agents fill `text` with the word "placeholder" (the real message in `questions`): it never reaches the owner.
const stripPlaceholder = (text: string) => text.replace(/^\s*placeholder\b[\s:.\-–—]*/i, "").trim();

/** The channels to try: the one the owner last wrote from in this chat first, then the owner's order. */
const order = (transports: string[], via: Found["ownerVia"]) => {
  const first = via && via !== "board" ? `channel-${via}` : undefined;
  return first && transports.includes(first) ? [first, ...transports.filter((t) => t !== first)] : transports;
};

/** Tries each channel in turn: sent by one; down when one that is set up failed (try again later); off when none is set up. */
async function deliver(d: Pick<Deps, "send">, m: Message, to: string[]): Promise<"sent" | "down" | "off"> {
  let down = false;
  for (const t of to) {
    const r = await d.send(t, m).catch(() => ({ sent: false, off: false }));
    if (r.sent) return "sent";
    if (!r.off) down = true;
  }
  return down ? "down" : "off";
}

export async function notify(d: Deps, a: NotifyArgs, caller?: Caller, now = Date.now()): Promise<Result> {
  try {
    const text = stripPlaceholder(a.text);
    if (!text && !a.questions?.length) return { sent: false, reason: "error", note: "The message is empty." };
    const kind: Kind = a.questions?.length ? "decision" : a.kind;
    const dedupe = `dedupe:${createHash("sha256").update(a.dedupe_key ? `key\n${a.dedupe_key}` : `${kind}\n${a.task ?? ""}\n${text}\n${JSON.stringify(a.questions ?? [])}`).digest("hex").slice(0, 32)}`;
    const last = Number(d.store.getKv(dedupe) ?? 0);
    if (last && now - last < (kind === "alert" ? WINDOW.alert : WINDOW.other)) return { sent: true, reason: "duplicate" };
    // The loop brake (the kernel's count) on an agent's messages about a task: fails open when the kernel doesn't answer.
    if (a.task && caller && kind !== "alert" && d.brake) {
      const b = await d.brake(a.task, caller.id, kind === "decision").catch(() => ({ allow: true, note: undefined }));
      if (!b.allow) return { sent: false, reason: "limit", note: b.note ?? `Limit reached on ${a.task} since the owner last wrote there (or since UTC midnight). Nothing was sent; batch it into your next update.` };
    }
    // The chat is the calling agent's own, running on it now: only then its name heads the message, the reply lands there and
    // goes where the owner wrote. (The kernel's, the board's and the runner's messages carry the task in their text.)
    const resolved = a.task && caller && d.resolveTask ? await d.resolveTask(a.task).catch(() => undefined) : undefined;
    const found: Found | undefined = a.relay ? { issueId: a.relay.issueId, agentId: "", agentName: a.relay.agentName, ownerVia: a.relay.via } : resolved?.agentId === caller?.id ? resolved : undefined;
    // Attention: a blocked or over-cap agent sends nothing; a crew agent's routine done/fyi goes to the digest (and its chat).
    const att = caller && d.attention && ["decision", "done", "fyi"].includes(kind) ? attend(d.store, d.attention, { id: caller.id, key: caller.key, roles: caller.roles ?? [] }, kind, { conversing: Boolean(found?.ownerVia), buttons: Boolean(a.actions?.length) }, now) : ({ do: "pass" } as const);
    if (att.do === "block" || att.do === "limit") return { sent: false, reason: att.do === "block" ? "blocked" : "limit", note: att.note };
    const muted = kind === "fyi" && d.muteFyi === true && !a.actions?.length;
    const digested = att.do === "digest" && found?.ownerVia !== "board" && !muted;
    if (digested) queueDigest(d.store, { agent: found?.agentName ?? caller?.name ?? "agent", ...(a.task ? { task: a.task } : {}), text });
    // The reply on its chat, as the agent's own comment.
    const mirror = found && caller && d.postReply;
    const onChat = mirror ? await d.postReply!(found.issueId, replyBody(text, a.actions, a.questions), caller.assertion).catch(() => false) : false;
    // The owner is typing in this chat on the board: the reply stays there (the board notifies them).
    const boardOnly = found?.ownerVia === "board" || digested || muted;
    let out: "sent" | "down" | "off" | "board" = "board";
    if (!boardOnly) {
      const m: Message = { kind, text: text + spellOut(a.questions), ...(found && a.task ? { head: { agent: found.agentName, task: a.task, issue: found.issueId } } : {}), ...(a.actions?.length ? { actions: a.actions } : {}), ...(a.questions?.length ? { asks: true as const } : {}) };
      const to = a.relay ? [`channel-${a.relay.via}`] : order(d.transports, found?.ownerVia);
      out = await deliver(d, m, to);
      // The kernel's, the board's and the runner's messages have no chat to land on: they also wait for a channel to be set
      // up (an account reset link before Telegram is paired).
      if (out === "off" && !caller) out = "down";
      if (out === "down") d.store.wait({ m, to, at: now, keep: !caller });
    }
    const ok = out === "sent" || out === "down" || onChat || digested;
    if (ok) d.store.setKv(dedupe, String(now));
    const chat = onChat ? { onChat: true as const } : {};
    // Sent only when a channel took it, its chat holds it or the digest will carry it; waiting for a channel is never "sent".
    if (out === "down" && !onChat && !digested) return { sent: false, queued: true, note: "No channel reaches the owner right now: it goes out once one is back." };
    if (ok) return { sent: true, ...chat, ...(digested ? { note: "Routine update: it goes to the owner in the next digest." } : {}) };
    if (muted) return { sent: false, reason: "muted", note: "The owner muted fyi messages, so nothing was sent. That is expected: don't resend it; put it in your next result instead." };
    return { sent: false, reason: "error", note: "No channel is set up to reach the owner, and this message has no chat on the board to land on." };
  } catch {
    return { sent: false, reason: "error" };
  }
}

/**
 * Sends what waited while every channel was down: done once a channel takes it, or none is set up for it any more. A message
 * still undelivered after a day is dropped (by then the board shows what it was about).
 */
export async function retry(d: Pick<Deps, "send" | "store">, now = Date.now()): Promise<number> {
  let n = 0;
  for (const w of d.store.waiting()) {
    const { m, to, at, keep } = w.msg as { m: Message; to: string[]; at: number; keep?: boolean };
    const out = now - at > 24 * 60 * MIN ? "off" : await deliver(d, m, to);
    if (out === "down" || (out === "off" && keep && now - at <= 24 * 60 * MIN)) continue;
    d.store.done(w.id);
    if (out === "sent") n++;
  }
  return n;
}

/** The digest of routine messages as one message: done once a channel took it, or when none is set up to. */
export const sendDigest = async (d: Pick<Deps, "send" | "transports">, text: string): Promise<boolean> => (await deliver(d, { kind: "digest", text }, d.transports)) !== "down";
