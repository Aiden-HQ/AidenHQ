// Approvals in Telegram: each pending approval record on the board becomes one card with Approve and
// Reject buttons that carry the record's id; an exact typed reply ("apply WOR-184") decides the one open record on that
// task. Decisions go to the board with the owner_decide_key, which only this service and the board hold. Only the owner
// chat reaches here (the poll checks the chat id); voice notes, forwards and agents' notify_owner buttons never do.
import { randomBytes } from "node:crypto";
import type { Store } from "./store.js";

export interface PendingApproval {
  id: string;
  identifier: string;
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
  /** The board's answer: the record after the decision, or why it refused. */
  decide(body: { id?: string; task?: string; decision: "approve" | "reject"; via: "telegram" }): Promise<{ ok: true; sentence: string; state: string } | { ok: false; reason: string }>;
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
    decide: async (body) => {
      const r = await call("POST", "/internal/owner/approvals/decide", body);
      return r.status === 200 ? { ok: true, sentence: String(r.json.sentence ?? ""), state: String(r.json.state ?? "") } : { ok: false, reason: String(r.json.error ?? `the board said ${r.status}`) };
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
  const btn = (text: string, decision: "approve" | "reject") => {
    const cb = `a${randomBytes(8).toString("hex")}`;
    store.setKv(`appr:${cb}`, `${id}:${decision}`);
    return { text, callback_data: cb };
  };
  return { inline_keyboard: [[btn("Approve", "approve"), btn("Reject", "reject")]] };
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
