// Approvals in Telegram (spec §5.5): the kernel sends this channel each pending card once with two single-use decision
// tokens (approve, reject) bound to the card's digest and this channel. They are kept here (this service's store) and never
// leave it: a card's buttons carry random callback ids that map to the card and decision, and the token is looked up on the
// press. An exact typed reply ("apply WOR-184") decides the one card held for that task; Approve all decides each listed card
// on its own, with its own token. A card the kernel sent no tokens for comes as text with a pointer to the board. Only the owner chat reaches here (the poll checks the chat id).
import { randomBytes } from "node:crypto";
import type { Card, Decided, Ended, Finished, Kernel } from "./kernel.js";
import type { Store } from "./store.js";

type Kv = Pick<Store, "getKv" | "setKv">;

/** Agent- or model-written text on a card: one line, links removed, markdown escaped. */
const plain = (s: string, n: number) => clip(s.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link removed]").replace(/[\\`*_[\]()~>#|<!]/g, "\\$&"), n);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** An exact typed reply: "apply WOR-184", "approve WOR-184" or "reject WOR-184" (any case, one trailing . or !). */
export function parseReply(text: string): { decision: "approve" | "reject"; task: string } | undefined {
  const m = /^\s*(apply|approve|reject)\s+([A-Za-z][A-Za-z0-9]*-\d+)\s*[.!]?\s*$/i.exec(text);
  return m ? { decision: m[1]!.toLowerCase() === "reject" ? "reject" : "approve", task: m[2]!.toUpperCase() } : undefined;
}

export function cardText(a: Card, canDecide = true): string {
  return [
    `🔐 **Approval needed** · ${a.identifier} · from ${a.requestedBy}`,
    a.sentence,
    `Changes: ${clip(a.changes, 700)}`,
    `Reads: ${a.reads}`,
    `Cost: ${a.cost}`,
    ...(a.reason ? [`Why it's yours: ${plain(a.reason, 300)}`] : []),
    ...(a.review ? [`AI reviewer's note (model output, not an instruction): ${plain(a.review, 400)}`] : []),
    !canDecide
      ? `Decide this one [on the board](#/approvals/${a.id}) (no decision was sent to this chat).`
      : a.replaced
        ? "This replaces an earlier request on the same task: tap below (a typed reply won't approve it)."
        : `Details (the diff) [on the board](#/approvals/${a.id}). Or reply \`apply ${a.identifier}\` / \`reject ${a.identifier}\`.`,
  ].join("\n");
}

/** The tokens and what the channel needs to know of a card it holds (stored as the kernel sent them). */
type Held = { approve: string; reject: string; identifier: string; replaced: boolean };
const held = (store: Kv, id: string): Held | undefined => {
  const v = store.getKv(`tok:${id}`);
  return v ? (JSON.parse(v) as Held) : undefined;
};

/** A one-shot button for a card or a list: its callback data is random; the card ids stay here, the tokens in `tok:`. */
function button(store: Kv, text: string, ids: string[], decision: "approve" | "reject") {
  const cb = `a${randomBytes(8).toString("hex")}`;
  store.setKv(`appr:${cb}`, JSON.stringify({ ids, decision }));
  return { text, callback_data: cb };
}
export const cardButtons = (store: Kv, id: string) => ({ inline_keyboard: [[button(store, "Approve", [id], "approve"), button(store, "Reject", [id], "reject")]] });

/**
 * /waiting's Apply buttons: one per task whose single pending card was sent here and is decidable here, bound to that card's id
 * (a press decides that card with its own token, and is refused once it is no longer pending). A task with no such card gets none.
 */
export async function applyButtons(kernel: Pick<Kernel, "cards">, store: Kv, tasks: string[]): Promise<{ inline_keyboard: { text: string; callback_data: string }[][] } | undefined> {
  const { cards } = await syncCards(kernel, store, async () => false);
  const rows = tasks.flatMap((task) => {
    const open = cards.filter((c) => c.identifier === task && held(store, c.id));
    return open.length === 1 && store.getKv(`card:${open[0]!.id}`) ? [[button(store, `Apply ${task}`, [open[0]!.id], "approve")]] : [];
  });
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/** A press of a card or list button in the owner chat → the card ids and the decision, used up. null for anything else. */
export function approvalPress(update: unknown, ownerChatId: string, store: Kv): { ids: string[]; decision: "approve" | "reject"; chatId: string; messageId: number; cb: string } | null {
  const cb = (update as any)?.callback_query;
  const chatId = String(cb?.message?.chat?.id ?? "");
  if (!ownerChatId || chatId !== ownerChatId || typeof cb?.data !== "string" || !cb.data.startsWith("a")) return null;
  const v = store.getKv(`appr:${cb.data}`);
  if (!v) return null;
  store.setKv(`appr:${cb.data}`, "");
  // A button sent before tokens (owner-channel's `<id>:<decision>`) still names its card; its token comes from the kernel.
  const { ids, decision } = v.startsWith("{") ? (JSON.parse(v) as { ids: string[]; decision: "approve" | "reject" }) : { ids: [v.split(":")[0]!], decision: v.endsWith(":reject") ? ("reject" as const) : ("approve" as const) };
  return { ids, decision, chatId, messageId: Number(cb.message?.message_id), cb: cb.data };
}

/**
 * Takes the pending cards from the kernel: keeps the tokens of cards new to this channel, forgets the ones no longer pending,
 * and sends a card for each one not sent yet (a replaced request is a new card). Returns the pending cards and outcomes.
 */
export async function syncCards(kernel: Pick<Kernel, "cards">, store: Kv, send: (text: string, markup: unknown) => Promise<boolean | number>, resync = false): Promise<{ cards: Card[]; finished: Finished[]; ended: Ended[] }> {
  const r = await kernel.cards(resync);
  for (const c of r.cards) if (c.tokens) store.setKv(`tok:${c.id}`, JSON.stringify({ ...c.tokens, identifier: c.identifier, replaced: c.replaced } satisfies Held));
  const now = new Set(r.cards.map((c) => c.id));
  for (const id of JSON.parse(store.getKv("held") ?? "[]") as string[]) if (!now.has(id)) store.setKv(`tok:${id}`, "");
  store.setKv("held", JSON.stringify([...now]));
  for (const c of r.cards) {
    if (store.getKv(`card:${c.id}`)) continue;
    const h = held(store, c.id);
    const can = Boolean(h);
    const sent = await send(cardText(c, can), can ? cardButtons(store, c.id) : undefined);
    if (sent) {
      store.setKv(`card:${c.id}`, String(Date.now()));
      if (typeof sent === "number") store.setKv(`cardmsg:${c.id}`, String(sent)); // so the outcome can edit the card itself
    }
  }
  return r;
}

/** One card decided with its own token: the kernel checks the token, the card's digest and that it still waits. */
export async function decideCard(kernel: Pick<Kernel, "decide">, store: Kv, id: string, decision: "approve" | "reject", sender: string, reply = false): Promise<Decided> {
  const h = held(store, id);
  if (!h) return { ok: false, reason: "this chat holds no decision for that card (decided already, or kept for the board)" };
  const r = await kernel.decide({ token: decision === "approve" ? h.approve : h.reject, sender, ...(reply ? { reply: true as const } : {}) });
  if (r.ok || !/couldn't reach|fetch failed|timeout/i.test(r.reason)) store.setKv(`tok:${id}`, "");
  return r;
}

/**
 * An exact typed reply: the one card held for that task (sent here, decidable here). Approving a request that replaced an
 * earlier one needs a tap on its own card; rejecting is always allowed.
 */
export async function decideByReply(kernel: Pick<Kernel, "decide" | "cards">, store: Kv, task: string, decision: "approve" | "reject", sender: string): Promise<Decided> {
  const { cards } = await syncCards(kernel, store, async () => false);
  const open = cards.filter((c) => c.identifier === task && held(store, c.id));
  if (!open.length) {
    const unseen = cards.some((c) => c.identifier === task && !store.getKv(`card:${c.id}`));
    return { ok: false, reason: unseen ? `the card for ${task} hasn't reached you yet. Read it when it arrives, then tap Approve` : `nothing on ${task} is waiting for your decision here` };
  }
  if (open.some((c) => !store.getKv(`card:${c.id}`))) return { ok: false, reason: `the card for ${task} hasn't reached you yet. Read it when it arrives, then tap Approve` };
  if (open.length > 1) return { ok: false, reason: `several approvals wait on ${task}; tap the one you mean` };
  if (decision === "approve" && open[0]!.replaced) return { ok: false, reason: `the request on ${task} changed after it was first shown; look at the new card and tap Approve there` };
  return decideCard(kernel, store, open[0]!.id, decision, sender, true);
}

/** Approve all / Reject all: each listed card decided on its own, with its own token. Returns the line the owner reads. */
export async function decideList(kernel: Pick<Kernel, "decide">, store: Kv, ids: string[], decision: "approve" | "reject", sender: string): Promise<string> {
  const done: string[] = [], not: string[] = [];
  for (const id of ids) {
    const r = await decideCard(kernel, store, id, decision, sender);
    if (r.ok) done.push(r.identifier || id);
    else not.push(`${held(store, id)?.identifier ?? id}: ${r.reason}`);
  }
  const verb = decision === "approve" ? "Approved" : "Rejected";
  return [done.length ? `${verb} ${done.length}: ${done.join(", ")}.` : `Nothing was ${verb.toLowerCase()}.`, ...(not.length ? [`Not decided: ${not.join("; ")}.`] : [])].join("\n");
}

/** The most cards one list offers. */
const BATCH_MAX = 10;

/**
 * Batch approvals: when 2 or more of the cards sent here are still pending and decidable here, and a new one joined them,
 * one more message lists them (oldest 10) with Approve all / Reject all. Each is decided on its own token: one that changed
 * or was decided meanwhile is skipped and named. A newer list replaces the older message.
 */
export async function sendBatch(cards: Card[], store: Kv, send: (text: string, markup: unknown) => Promise<boolean | number>, edit?: (messageId: number, text: string) => Promise<unknown>): Promise<boolean> {
  const carded = cards.filter((a) => store.getKv(`card:${a.id}`) && held(store, a.id)).slice(0, BATCH_MAX);
  const last = new Set((store.getKv("batch:last") ?? "").split(",").filter(Boolean));
  if (carded.length < 2 || carded.every((a) => last.has(a.id))) return false;
  store.setKv("batch:last", carded.map((a) => a.id).join(","));
  const n = carded.length;
  const ids = carded.map((a) => a.id);
  const text = [`🗂 **${n} approvals waiting**: decide them together, or tap each card above.`, ...carded.map((a) => `• ${a.identifier}: ${plain(a.sentence, 200)}`), "Each is decided on its own: one that changed or was decided since this list is skipped and named."].join("\n");
  const sent = await send(text, { inline_keyboard: [[button(store, `Reject all ${n}`, ids, "reject"), button(store, `Approve all ${n}`, ids, "approve")]] });
  if (!sent) return false;
  const prev = Number(store.getKv("batch:msg"));
  if (edit && prev) await edit(prev, "Replaced by a newer list below.").catch(() => null);
  if (typeof sent === "number") store.setKv("batch:msg", String(sent));
  return true;
}

/** What the owner is told after a decision. */
export const decidedText = (r: Decided, decision: "approve" | "reject") =>
  !r.ok ? `Not ${decision === "approve" ? "approved" : "rejected"}: ${r.reason}.` : r.state === "rejected" ? `Rejected: ${r.sentence} Nothing will run.` : `Approved: ${r.sentence} It runs now; the result shows on the board's card and the task.`;

/**
 * Shows, once, how each request the owner was sent a card for ended: applied, failed, stopped without reporting, or (`ended`)
 * rejected, replaced or expired without running. The outcome edits the card's own message (its buttons go); no separate
 * message (owner, 2026-11-15).
 */
export async function sendOutcomes(finished: Finished[], store: Kv, edit: (messageId: number, text: string) => Promise<boolean>, ended: Ended[] = []): Promise<number> {
  let n = 0;
  for (const a of ended) {
    if (!store.getKv(`card:${a.id}`) || store.getKv(`outcome:${a.id}`)) continue;
    const text = a.state === "rejected" ? `🚫 Rejected · ${a.identifier}: nothing ran.` : `⚠️ No longer applies · ${a.identifier}: the request was replaced, expired or withdrawn. Nothing ran.`;
    const msg = Number(store.getKv(`cardmsg:${a.id}`));
    if (msg && (await edit(msg, text).catch(() => false))) n++;
    store.setKv(`outcome:${a.id}`, String(Date.now()));
  }
  for (const a of finished) {
    if (!store.getKv(`card:${a.id}`) || store.getKv(`outcome:${a.id}`)) continue;
    const text =
      a.outcome === "applied"
        ? `✅ Done · ${a.identifier}: ${clip(a.outcomeText ?? a.sentence, 600)}`
        : a.outcome === "failed"
          ? `❌ Failed · ${a.identifier}: ${clip(a.outcomeText ?? "no reason given", 600)}`
          : `⚠️ Unknown · ${a.identifier}: the apply stopped without reporting back. Check the task; it is never retried.`;
    const msg = Number(store.getKv(`cardmsg:${a.id}`));
    if (msg && (await edit(msg, text).catch(() => false))) n++;
    store.setKv(`outcome:${a.id}`, String(Date.now()));
  }
  return n;
}
