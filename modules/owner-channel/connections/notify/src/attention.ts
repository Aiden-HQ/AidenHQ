import { randomUUID } from "node:crypto";
import { clip, TOLD_MAX, type Store, type ToldRow } from "./store.js";
import type { Kind } from "./notify.js";

// Attention control on notify: per-agent caps, an owner block list and a digest of routine messages. A decision
// and an urgent alert always pass; the chief of staff (role fleet-admin) is never blocked or digested. The block list and the digest
// are the owner's preferences and always act; only the cap is a gate, and it ships in observe mode (logs what it would
// have blocked and lets the message through).
export interface AttentionConfig {
  mode: "observe" | "enforce"; // the daily cap only
  blocked: string[]; // agent keys the owner silenced: their routine messages are dropped
  dailyCap: number; // routine messages one agent may send per UTC day
  digestHours: number[]; // owner-local hours at which the digest of fyi/done messages goes
  timezone: string;
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}
export type Attend = { do: "pass" } | { do: "block" | "limit"; note: string } | { do: "digest" };
/** A digest line, with what the ledger records once it goes out: `source` is the agent key ("kernel" for the kernel's), `at` when it was queued. */
type Item = { id?: string; agent: string; task?: string; text: string; source?: string; kind?: string; at?: number; told?: true };

/** The owner's calendar day: the daily cap resets at midnight in their timezone. */
const dayOf = (now: number, timezone: string) => {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); } catch { return new Date(now).toISOString().slice(0, 10); } // an unknown zone reads as UTC
};

/** What happens to one normal message. `conversing`: the owner is writing on its chat, so the reply goes straight back. */
export function attend(store: Store, cfg: AttentionConfig, who: { id: string; key: string; roles: string[] } | undefined, kind: Kind, o: { conversing: boolean; buttons: boolean }, now = Date.now()): Attend {
  if (!who) return { do: "pass" };
  const cos = who.roles.includes("fleet-admin");
  // The block list holds for every kind (an agent could label anything a decision); only urgent alerts bypass this function.
  if (!cos && cfg.blocked.includes(who.key)) return { do: "block", note: "The owner muted messages from you, so nothing was sent. That is expected: put it in your task result instead." };
  if (kind === "decision") return { do: "pass" };
  let out: Attend = { do: "pass" };
  const day = dayOf(now, cfg.timezone);
  const counts = JSON.parse(store.getKv("attn:counts") || "{}") as { day?: string; n?: Record<string, number> };
  const n = counts.day === day ? (counts.n ?? {}) : {};
  if ((n[who.id] ?? 0) >= cfg.dailyCap) out = { do: "limit", note: `Daily limit reached: ${cfg.dailyCap} routine messages today. Nothing was sent; put it in your task result or send it tomorrow.` };
  else if (!cos && !o.conversing && !o.buttons && cfg.digestHours.length) out = { do: "digest" };
  if (out.do === "pass" || out.do === "digest") n[who.id] = (n[who.id] ?? 0) + 1;
  store.setKv("attn:counts", JSON.stringify({ day, n }));
  if (out.do === "limit" && cfg.mode === "observe") {
    cfg.warn?.({ event: "gate.would_block", gate: "notify-attention", outcome: out.do, agent: who.key }, "notify attention gate would act");
    return { do: "pass" };
  }
  return out;
}

export function queueDigest(store: Store, item: Item, now = Date.now()): void {
  const q = JSON.parse(store.getKv("digest:queue") || "[]") as Item[];
  // One line per item: agent-supplied whitespace and newlines collapse so an item can't forge another agent's line.
  q.push({ id: randomUUID(), agent: clip(item.agent, 60), ...(item.task ? { task: clip(item.task, 40) } : {}), text: clip(item.text, TOLD_MAX), source: item.source ?? "kernel", kind: item.kind ?? "fyi", at: now, ...(item.told ? { told: true as const } : {}) });
  store.setKv("digest:queue", JSON.stringify(q.slice(-100)));
}

/** The owner-local slot now: its date plus the latest digest hour already reached (none before the first one). */
export function slotNow(cfg: Pick<AttentionConfig, "digestHours" | "timezone">, now: number): string | undefined {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: cfg.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  const hour = [...cfg.digestHours].sort((a, b) => a - b).filter((h) => h <= Number(p.hour)).pop();
  return hour === undefined ? undefined : `${p.year}-${p.month}-${p.day}T${hour}`;
}

/** One digest message stays under every transport's limit (Telegram cuts at 3,500 characters). */
const DIGEST_MAX = 3000;
/** A connection line carries its reconnect link whole: clipping would cut off the URL the owner needs. */
const line = (i: Item) => `- ${i.agent}${i.task ? ` · ${i.task}` : ""}: ${i.id?.startsWith("need:") ? i.text : clip(i.text, 300)}`;
/**
 * Sends the queued digest once per slot (called on a timer), as as many messages as it takes to stay under DIGEST_MAX. Each
 * message's items leave the queue (and are told) only once it went; a failed send keeps the rest for the next tick.
 */
export async function flushDigest(store: Store, cfg: AttentionConfig, send: (text: string) => Promise<boolean | "off">, now = Date.now(), needs?: () => Promise<string[]>): Promise<boolean> {
  const slot = slotNow(cfg, now);
  if (!slot || store.getKv("digest:slot") === slot) return false;
  const q = JSON.parse(store.getKv("digest:queue") || "[]") as Item[];
  // The connections still broken, pulled from the kernel each time the digest is composed (a retry asks again): a recovered one is
  // simply absent. When the kernel can't be read, one line says so rather than hiding it. Not queue items: nothing to replay or clear.
  const asked = needs ? await needs().then((l) => l, () => undefined) : [];
  const extra = (text: string): Item => ({ id: `need:${text}`, agent: "AidenHQ", text, source: "kernel", kind: "fyi" });
  // Lines of this slot a failed attempt already delivered are not sent again.
  const done = JSON.parse(store.getKv("digest:needs-sent") || "{}") as { slot?: string; ids?: string[] };
  const delivered = new Set(done.slot === slot ? done.ids : []);
  const items = [...q, ...(asked ?? (q.length ? ["couldn't check connections"] : [])).map(extra).filter((i) => !delivered.has(i.id!))];
  const batches: Item[][] = [];
  for (const i of items) {
    const b = batches.at(-1);
    if (b && [...b, i].map(line).join("\n").length <= DIGEST_MAX) b.push(i);
    else batches.push([i]);
  }
  for (const [n, b] of batches.entries()) {
    const head = `Digest${batches.length > 1 ? ` (${n + 1}/${batches.length})` : ""}: ${b.length} update${b.length > 1 ? "s" : ""}`;
    const out = await send(`${head}\n\n${b.map(line).join("\n")}`);
    if (out === false) return false;
    // Only what was sent goes: a notice queued during the send (or a trim that shifted the queue) stays for the next digest.
    const sent = new Set(b.map((i) => i.id));
    store.setKv("digest:needs-sent", JSON.stringify({ slot, ids: [...delivered, ...b.filter((i) => i.id?.startsWith("need:")).map((i) => i.id)] }));
    for (const i of b) if (i.id?.startsWith("need:")) delivered.add(i.id);
    store.setKv("digest:queue", JSON.stringify((JSON.parse(store.getKv("digest:queue") || "[]") as Item[]).filter((i) => !sent.has(i.id))));
    if (out === true) for (const i of b) if (!i.told) store.told({ source: i.source ?? "kernel", task: i.task, kind: i.kind ?? "fyi", text: clip(i.text, 300) }); // stamped once delivered (notify.ts)
  }
  store.setKv("digest:slot", slot);
  return items.length > 0;
}

/** Digest lines the kernel's connection state used to queue (before the digest pulled them): dropped, so none repeats or goes stale. */
export function dropQueuedNeeds(store: Store): void {
  const q = JSON.parse(store.getKv("digest:queue") || "[]") as Item[];
  const keep = q.filter((i) => !(i.source === "kernel" && / isn't connected \(.*\)(, and work is waiting on it)?: https?:\/\//.test(i.text)));
  if (keep.length !== q.length) store.setKv("digest:queue", JSON.stringify(keep));
}

/** The digest lines waiting for their slot, as ledger rows (not yet told: the digest hasn't gone). */
export const waitingDigest = (store: Store): (Omit<ToldRow, "id"> & { queued: true })[] =>
  (JSON.parse(store.getKv("digest:queue") || "[]") as Item[]).filter((i) => !i.told).map((i) => ({ at: i.at ?? 0, source: i.source ?? "kernel", task: i.task ?? null, kind: i.kind ?? "fyi", text: i.text, queued: true as const }));
