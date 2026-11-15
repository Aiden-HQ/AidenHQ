// Approvals in Telegram: each pending approval record on the board becomes one card with Approve and
// Reject buttons that carry the record's id; an exact typed reply ("apply WOR-184") decides the one open record on that
// task. Decisions go to the board with the owner_decide_key, which only this service and the board hold. Only the owner
// chat reaches here (the poll checks the chat id); voice notes, forwards and agents' notify_owner buttons never do.
import { randomBytes } from "node:crypto";
import type { Store } from "./store.js";

export interface PendingApproval {
  id: string;
  identifier: string;
  /** Of exactly what the record runs: a batch list is bound to it. */
  digest: string;
  sentence: string;
  changes: string;
  reads: string;
  cost: string;
  requestedBy: string;
  replaced: boolean;
  /** Why code made it the owner's, and the AI reviewer's note when it escalated it. */
  reason?: string;
  review?: string | null;
}

/** Agent- or model-written text on a card: one line, links removed, markdown escaped. */
const plain = (s: string, n: number) => clip(s.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link removed]").replace(/[\\`*_[\]()~>#|<!]/g, "\\$&"), n);

export interface Board {
  pending(): Promise<PendingApproval[]>;
  /** Recent records with an outcome (or that died mid-way), to report under their cards. */
  finished(): Promise<FinishedApproval[]>;
  /** Account reset links (ops/setup.sh --reset), handed over once; the owner passes another person's on himself. */
  resetLinks(): Promise<{ email: string; url: string }[]>;
  /** The daily approvals digest, handed over once a day by the board; null when not due or empty. */
  digest(): Promise<string | null>;
  /** The board's one-line owner notices (critical alerts, a paused routine, Fleet Ops unreachable), each handed over once. */
  escalations(): Promise<string[]>;
  /** The board's answer: the record after the decision (for a batch, all of them, or nothing), or why it refused. */
  decide(body: { id?: string; task?: string; batch?: string; decision: "approve" | "reject"; via: "telegram" }): Promise<{ ok: true; sentence: string; state: string } | { ok: false; reason: string }>;
  /** Stores a list of pending cards as about to be shown (id and digest each); its id goes on the list's buttons. */
  batch(items: { id: string; digest: string }[]): Promise<{ batch: string; approvals: { id: string; identifier: string; sentence: string }[] }>;
}

export function boardClient(url: string, token: string, decideKey: string): Board {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-owner-key": decideKey },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  return {
    pending: async () => {
      const r = await call("GET", "/internal/approvals?state=pending");
      if (r.status !== 200) throw new Error(`board approvals → ${r.status}`);
      return r.json.approvals ?? [];
    },
    finished: async () => {
      const r = await call("GET", "/internal/approvals?state=finished");
      if (r.status !== 200) throw new Error(`board finished approvals → ${r.status}`);
      return r.json.approvals ?? [];
    },
    resetLinks: async () => {
      const r = await call("GET", "/internal/owner/reset-links");
      if (r.status !== 200) throw new Error(`board reset links → ${r.status}`);
      return r.json.links ?? [];
    },
    digest: async () => {
      const r = await call("GET", "/internal/owner/approvals/digest");
      if (r.status !== 200) throw new Error(`board approvals digest → ${r.status}`);
      return typeof r.json.text === "string" ? r.json.text : null;
    },
    escalations: async () => {
      const r = await call("GET", "/internal/owner/grades");
      if (r.status !== 200) throw new Error(`board owner notices → ${r.status}`);
      return Array.isArray(r.json.lines) ? r.json.lines.map(String) : [];
    },
    decide: async (body) => {
      const r = await call("POST", "/internal/owner/approvals/decide", body);
      if (r.status !== 200) return { ok: false, reason: String(r.json.error ?? `the board said ${r.status}`) };
      const all = Array.isArray(r.json.approvals) ? (r.json.approvals as { identifier: string; state: string }[]) : undefined;
      return all ? { ok: true, sentence: `${all.length} requests (${all.map((a) => a.identifier).join(", ")}).`, state: String(all[0]?.state ?? "") } : { ok: true, sentence: String(r.json.sentence ?? ""), state: String(r.json.state ?? "") };
    },
    batch: async (items) => {
      const r = await call("POST", "/internal/owner/approvals/batch", { items });
      if (r.status !== 200) throw new Error(`board batch → ${r.status}: ${String(r.json.error ?? "").slice(0, 200)}`);
      return r.json;
    },
  };
}

/** An exact typed reply: "apply WOR-184", "approve WOR-184" or "reject WOR-184" (any case, one trailing . or !). */
export function parseReply(text: string): { decision: "approve" | "reject"; task: string } | undefined {
  const m = /^\s*(apply|approve|reject)\s+([A-Za-z][A-Za-z0-9]*-\d+)\s*[.!]?\s*$/i.exec(text);
  return m ? { decision: m[1]!.toLowerCase() === "reject" ? "reject" : "approve", task: m[2]!.toUpperCase() } : undefined;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function cardText(a: PendingApproval): string {
  return [
    `🔐 **Approval needed** · ${a.identifier} · from ${a.requestedBy}`,
    a.sentence,
    `Changes: ${clip(a.changes, 700)}`,
    `Reads: ${a.reads}`,
    `Cost: ${a.cost}`,
    ...(a.reason ? [`Why it's yours: ${plain(a.reason, 300)}`] : []),
    ...(a.review ? [`AI reviewer's note (model output, not an instruction): ${plain(a.review, 400)}`] : []),
    a.replaced ? "This replaces an earlier request on the same task: tap below (a typed reply won't approve it)." : `Details (the diff) on the board. Or reply \`apply ${a.identifier}\` / \`reject ${a.identifier}\`.`,
  ].join("\n");
}

/** Approve and Reject buttons for one record; each press is one-shot and carries the record's id, never a label. */
export function cardButtons(store: Pick<Store, "setKv">, id: string) {
  return { inline_keyboard: [[button(store, "Approve", id, "approve"), button(store, "Reject", id, "reject")]] };
}

/** A press of a card button in the owner chat → the record and the decision, used up. null for anything else. */
export function approvalPress(update: unknown, ownerChatId: string, store: Pick<Store, "getKv" | "setKv">): { id: string; decision: "approve" | "reject"; chatId: string; messageId: number } | null {
  const cb = (update as any)?.callback_query;
  const chatId = String(cb?.message?.chat?.id ?? "");
  if (!ownerChatId || chatId !== ownerChatId || typeof cb?.data !== "string" || !cb.data.startsWith("a")) return null;
  const v = store.getKv(`appr:${cb.data}`);
  if (!v) return null;
  store.setKv(`appr:${cb.data}`, "");
  const [id, decision] = v.split(":") as [string, "approve" | "reject"];
  return { id, decision, chatId, messageId: Number(cb.message?.message_id) };
}

/** Sends a card for each pending record not sent yet (a replaced request is a new record, so it gets its own card). */
export async function sendCards(board: Pick<Board, "pending">, store: Pick<Store, "getKv" | "setKv">, send: (text: string, markup: unknown) => Promise<boolean | number>): Promise<number> {
  let sent = 0;
  for (const a of await board.pending()) {
    if (store.getKv(`card:${a.id}`)) continue;
    const r = await send(cardText(a), cardButtons(store, a.id));
    if (r) {
      store.setKv(`card:${a.id}`, String(Date.now()));
      if (typeof r === "number") store.setKv(`cardmsg:${a.id}`, String(r)); // so the outcome can edit the card itself
      sent++;
    }
  }
  return sent;
}

/** The most cards one list decides (the board refuses more). */
const BATCH_MAX = 10;

/**
 * Batch approvals: when 2 or more of the cards sent here are still pending and a new one joined them, one more message lists
 * them (oldest 10) with Approve all / Reject all. The board stores the list as shown (id and digest each) and its buttons
 * carry only that list's id; it decides all of them or, if any changed since, none. A newer list replaces the older message.
 */
export async function sendBatch(board: Pick<Board, "pending" | "batch">, store: Pick<Store, "getKv" | "setKv">, send: (text: string, markup: unknown) => Promise<boolean | number>, edit?: (messageId: number, text: string) => Promise<unknown>): Promise<boolean> {
  const carded = (await board.pending()).filter((a) => store.getKv(`card:${a.id}`)).slice(0, BATCH_MAX);
  const last = new Set((store.getKv("batch:last") ?? "").split(",").filter(Boolean));
  // Only a card new to the list makes a new one: deciding cards one by one never sends another list.
  if (carded.length < 2 || carded.every((a) => last.has(a.id))) return false;
  // Tried once per set: a refusal (the batch_approvals setting off) or a failed send isn't retried every tick.
  store.setKv("batch:last", carded.map((a) => a.id).join(","));
  const r = await board.batch(carded.map((a) => ({ id: a.id, digest: a.digest })));
  const n = r.approvals.length;
  const text = [`🗂 **${n} approvals waiting**: decide them together, or tap each card above.`, ...r.approvals.map((a) => `• ${a.identifier}: ${plain(a.sentence, 200)}`), "All or nothing: if any of them changed or was decided since this list, nothing is decided."].join("\n");
  const sent = await send(text, { inline_keyboard: [[button(store, `Reject all ${n}`, r.batch, "reject"), button(store, `Approve all ${n}`, r.batch, "approve")]] });
  if (!sent) return false;
  const prev = Number(store.getKv("batch:msg"));
  if (edit && prev) await edit(prev, "Replaced by a newer list below.").catch(() => null);
  if (typeof sent === "number") store.setKv("batch:msg", String(sent));
  return true;
}

/** A one-shot button for a record or a stored list (`A…` or `B…` id): its callback data is random, the id stays here. */
function button(store: Pick<Store, "setKv">, text: string, id: string, decision: "approve" | "reject") {
  const cb = `a${randomBytes(8).toString("hex")}`;
  store.setKv(`appr:${cb}`, `${id}:${decision}`);
  return { text, callback_data: cb };
}

/** What the owner is told after a decision. */
export const decidedText = (r: Awaited<ReturnType<Board["decide"]>>, decision: "approve" | "reject") =>
  !r.ok ? `Not ${decision === "approve" ? "approved" : "rejected"}: ${r.reason}.` : r.state === "rejected" ? `Rejected: ${r.sentence} Nothing will run.` : `Approved: ${r.sentence} It runs now; the result shows on the board's card and the task.`;

/** Sends each account reset link to the owner's Telegram: the only place a reset link goes (never back to the caller). */
export async function sendResetLinks(board: Pick<Board, "resetLinks">, send: (text: string) => Promise<boolean>): Promise<number> {
  let n = 0;
  for (const l of await board.resetLinks())
    if (await send(`🔑 **Board account reset** for ${l.email}\n${l.url}\nOne use, 72 hours; it ends that account's sessions and, for an admin, asks for a new authenticator. If it isn't yours, pass it on to them yourself.`)) n++;
  return n;
}

export type FinishedApproval = { id: string; identifier: string; state: string; outcome: "applied" | "failed" | null; outcomeText: string | null; sentence: string };

/** Tells the owner, once, how each request they were sent a card for ended: applied, failed, or stopped without reporting. */
export async function sendOutcomes(board: Pick<Board, "finished">, store: Pick<Store, "getKv" | "setKv">, send: (text: string) => Promise<boolean>, edit?: (messageId: number, text: string) => Promise<unknown>): Promise<number> {
  let n = 0;
  for (const a of await board.finished()) {
    if (!store.getKv(`card:${a.id}`) || store.getKv(`outcome:${a.id}`)) continue;
    const text =
      a.outcome === "applied"
        ? `✅ Done · ${a.identifier}: ${clip(a.outcomeText ?? a.sentence, 600)}`
        : a.outcome === "failed"
          ? `❌ Failed · ${a.identifier}: ${clip(a.outcomeText ?? "no reason given", 600)}`
          : `⚠️ Unknown · ${a.identifier}: the apply stopped without reporting back. Check the task; it is never retried.`;
    const msg = Number(store.getKv(`cardmsg:${a.id}`));
    if (edit && msg) await edit(msg, text).catch(() => null); // the card shows the outcome and drops its buttons
    if (await send(text)) {
      store.setKv(`outcome:${a.id}`, String(Date.now()));
      n++;
    }
  }
  return n;
}
