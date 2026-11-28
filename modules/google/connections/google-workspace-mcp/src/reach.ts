// Agent email addresses (agent-reach spec): an address that lands in the owner's Gmail and that the owner can send as (a Workspace
// alias or group, or a plus-address) becomes an agent's own. This file holds the parts the poller and the summon calls share:
// the durable state, the address book and identity check, the send ledger (provenance for every agent send), and the poller that
// turns mail to or cc an address into kernel events (`to_agent`, `entry`). summon.ts is the kernel's context/prepare/reply/react.
//
// One consumer per message: agentQuery() (inbox.ts) classifies "an agent's mail" for the poller and for the inbox feed alike, so
// Intake never sees it. With no address configured nothing here runs and the feed and gmail_send behave as before.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { GoogleApiError, GoogleAuthError } from "./google.js";
import { agentQuery, automated, category, MAX_LOOKBACK_MS, SEND_HEADER } from "./inbox.js";
import { header, messageText, type GmailMessage, type Workspace } from "./workspace.js";

export type Address = { agent: string; address: string };
const EMAIL = /^[^\s<>,;:"'()\\]+@[^\s<>,;:"'()\\]+\.[^\s<>,;:"'()\\]+$/;
export const isEmail = (v: string) => v.length <= 320 && EMAIL.test(v);

/** The setting `google_agent_addresses` as the service reads it (a JSON list of `{ agent, address }`): anything malformed is skipped. */
export function parseAddresses(json: string | undefined): Address[] {
  let raw: unknown;
  try { raw = JSON.parse(json || "[]"); } catch { return []; }
  const out: Address[] = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    const agent = typeof e?.agent === "string" ? e.agent.trim() : "", address = typeof e?.address === "string" ? e.address.trim().toLowerCase() : "";
    if (agent && isEmail(address) && !out.some((o) => o.address === address)) out.push({ agent, address });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ durable state

type Send = { at: number; account: string; token: string; state: "pending" | "sent"; message_id?: string; thread_id?: string };
type Data = { cursors: Record<string, number>; starts: Record<string, number>; seen: Record<string, number>; sends: Record<string, Send> };
const SEEN_KEEP_MS = 14 * 86_400_000, SENDS_KEEP_MS = 30 * 86_400_000;

/** The poller's cursors, the message ids it has handed to the kernel and the send ledger: one small JSON file in the service's
 *  state dir, written whole and renamed into place. Without a file it lives in memory (tests). */
export class ReachState {
  private d: Data = { cursors: {}, starts: {}, seen: {}, sends: {} };
  constructor(private readonly file?: string, now = Date.now()) {
    if (file && existsSync(file)) {
      try { this.d = { cursors: {}, starts: {}, seen: {}, sends: {}, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<Data>) }; } catch { /* unreadable: start clean, the cursors restart at now */ }
    }
    for (const [k, at] of Object.entries(this.d.seen)) if (at < now - SEEN_KEEP_MS) delete this.d.seen[k];
    for (const [k, s] of Object.entries(this.d.sends)) if (s.at < now - SENDS_KEEP_MS) delete this.d.sends[k];
  }
  private save() {
    if (!this.file) return;
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.d));
    renameSync(`${this.file}.tmp`, this.file);
  }
  cursor(address: string): number | undefined { return this.d.cursors[address]; }
  setCursor(address: string, ms: number) { this.d.cursors[address] = ms; this.save(); }
  /** When an address was first scanned: mail from before it is never handed to the agent. */
  start(address: string): number | undefined { return this.d.starts[address]; }
  setStart(address: string, ms: number) { this.d.starts[address] = ms; this.save(); }
  seen(id: string): boolean { return id in this.d.seen; }
  markSeen(id: string, at: number) { this.d.seen[id] = at; this.save(); }
  send(key: string): Send | undefined { return this.d.sends[key]; }
  setSend(key: string, s: Send) { this.d.sends[key] = s; this.save(); }
  delSend(key: string) { delete this.d.sends[key]; this.save(); }
}

// ------------------------------------------------------------------------------------------------ identities

export type Sender = { email: string; name?: string; primary: boolean; verified: boolean };
/** Each account's send-as list (`users.settings.sendAs`), kept 5 minutes. */
export class Identities {
  private readonly cache = new Map<string, { at: number; list: Sender[] }>();
  constructor(private readonly ws: (account: string) => Workspace | undefined, private readonly now = Date.now) {}
  private async list(account: string): Promise<Sender[]> {
    const hit = this.cache.get(account);
    if (hit && this.now() - hit.at < 300_000) return hit.list;
    const w = this.ws(account);
    if (!w) return [];
    const list = await w.sendAs();
    this.cache.set(account, { at: this.now(), list });
    return list;
  }
  /** Whether `account` may send as `address`: a verified send-as entry, or a plus-address of the account's own primary. */
  async check(account: string, address: string): Promise<{ ok: boolean; name?: string }> {
    const list = await this.list(account), a = address.toLowerCase();
    const hit = list.find((s) => s.email === a);
    if (hit) return { ok: hit.verified, ...(hit.name ? { name: hit.name } : {}) };
    const base = list.find((s) => s.primary), m = /^([^+@]+)\+[^@]+@(.+)$/.exec(a);
    if (base && m && `${m[1]}@${m[2]}` === base.email) return { ok: true, ...(base.name ? { name: base.name } : {}) };
    return { ok: false };
  }
  /** The addresses of `addresses` that `account` is the mailbox of (see owner): the only ones whose mail the inbox feed leaves alone. */
  async assigned(accounts: string[], addresses: readonly string[], account: string): Promise<string[]> {
    const mine: string[] = [];
    for (const a of addresses) if ((await this.owner(accounts, a))?.account === account) mine.push(a);
    return mine;
  }
  /** The first account (the primary first) that may send as `address`. */
  async owner(accounts: string[], address: string): Promise<{ account: string; name?: string } | undefined> {
    for (const account of accounts) {
      const c = await this.check(account, address).catch(() => ({ ok: false as const }));
      if (c.ok) return { account, ...("name" in c && c.name ? { name: c.name } : {}) };
    }
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ send ledger

/** The token an agent send carries in SEND_HEADER: fresh for each logical send (the key and the attempt's time), and kept in its
 *  ledger record so only a retry of that send reconciles against it. */
export const tokenOf = (key: string, at: number) => createHash("sha256").update(`${key}:${at}`).digest("hex").slice(0, 32);
/** The key of a gmail_send: the same call again is the same send. */
export const mailKey = (account: string, m: { to: string[]; cc?: string[]; bcc?: string[]; subject?: string; body: string; thread_id?: string }) =>
  createHash("sha256").update(JSON.stringify([account, m.to, m.cc ?? [], m.bcc ?? [], m.subject ?? "", m.thread_id ?? "", m.body])).digest("hex");

/** A failure that may have sent the message anyway (the answer lost, a timeout, a 5xx): every other failure proves nothing was sent. */
export function ambiguous(err: unknown): boolean {
  if (err instanceof GoogleAuthError) return false;
  if (err instanceof GoogleApiError) return err.status >= 500 || err.status === 408;
  const e = err as { name?: string };
  return err instanceof TypeError || err instanceof SyntaxError || e?.name === "TimeoutError" || e?.name === "AbortError";
}

type Sent = { message_id: string; thread_id: string };
/**
 * Every outbound Gmail write is recorded before it is attempted (the key, the account, the time) and stamped with its token in
 * SEND_HEADER. An attempt whose outcome is unknown stays pending; the next attempt with that key first looks for the stamped
 * message in the account's sent mail and returns it instead of sending twice. `once`: a finished key answers its stored result
 * (a reply, one per kernel record); otherwise a finished send does not stop an identical new one (gmail_send).
 */
export class SendLedger {
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(private readonly state: ReachState, private readonly now = Date.now) {}
  run<T extends Sent>(key: string, account: string, ops: { send: (token: string) => Promise<T>; find: (token: string, sinceMs: number) => Promise<Sent | undefined> }, once = false): Promise<T | Sent> {
    const running = this.inflight.get(key) as Promise<T | Sent> | undefined;
    if (running) return running;
    const p = this.attempt(key, account, ops, once).finally(() => void this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
  private async attempt<T extends Sent>(key: string, account: string, ops: { send: (token: string) => Promise<T>; find: (token: string, sinceMs: number) => Promise<Sent | undefined> }, once: boolean): Promise<T | Sent> {
    const prior = this.state.send(key);
    if (prior?.state === "sent" && once && prior.message_id && prior.thread_id) return { message_id: prior.message_id, thread_id: prior.thread_id };
    if (prior?.state === "pending") {
      const found = await ops.find(prior.token, prior.at);
      if (found) { this.state.setSend(key, { ...prior, state: "sent", ...found }); return found; }
    }
    const at = this.now(), token = tokenOf(key, at);
    this.state.setSend(key, { at, account, token, state: "pending" });
    try {
      const r = await ops.send(token);
      this.state.setSend(key, { at, account, token, state: "sent", message_id: r.message_id, thread_id: r.thread_id });
      return r;
    } catch (err) {
      if (!ambiguous(err)) this.state.delSend(key);
      throw err;
    }
  }
}

// ------------------------------------------------------------------------------------------------ messages as events

/** What the kernel's event router takes (kernel/src/events.ts SourceEvent, with the reach fields). */
export type ReachEvent = { connection: "google_workspace"; resource: string; id: string; kind: "message"; author: string; author_name?: string; text: string; bot: false; url: string; thread: string; from_owner: boolean; data: { subject: string }; to_agent: string; entry: string; truncated?: true };

/** The event id of a message as seen through one address: `<account>:<message id>:<address>`, so two agents cc'd on one mail are two events. */
export const eventId = (account: string, message: string, address: string) => `${account}:${message}:${address}`;
export function parseEventId(id: string): { account: string; message: string; address: string } | undefined {
  const [account, message, address, ...rest] = id.split(":");
  return account && message && address && !rest.length ? { account, message, address } : undefined;
}
/** The conversation's resource and entry-point id for one address on one account. */
export const resourceOf = (account: string, address: string) => `${account}:${address}`;
export const entryOf = (account: string, address: string) => `gmail:${account}:${address}`;
export function parseResource(resource: string): { account: string; address: string } | undefined {
  const i = resource.indexOf(":");
  return i > 0 && i < resource.length - 1 ? { account: resource.slice(0, i), address: resource.slice(i + 1) } : undefined;
}
export function parseEntry(entry: string): { account: string; address: string } | undefined {
  return entry.startsWith("gmail:") ? parseResource(entry.slice(6)) : undefined;
}

/** The mailboxes of an address header (`Name <a@x>, b@y`): the address inside angle brackets, or the bare address, never text in a quoted
 *  display name (`"old@x.com" <new@x.com>` is new@x.com), lower-cased. */
export function mailboxesIn(h: string | undefined): string[] {
  const parts: string[] = [];
  let cur = "", quoted = false, depth = 0;
  for (const ch of h ?? "") {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")" && depth) depth--;
    if (ch === "," && !quoted && !depth) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  return parts.flatMap((p) => {
    const bare = p.replace(/"(?:[^"\\]|\\.)*"/g, " ").replace(/\([^)]*\)/g, " ");
    const angle = /<([^<>\s]+)>/.exec(bare)?.[1] ?? bare.trim().split(/\s+/).find((t) => t.includes("@"));
    return angle && isEmail(angle.toLowerCase()) ? [angle.toLowerCase()] : [];
  });
}

/** A sender as a name and an address (`Ada L <ada@x.com>`). */
export function personOf(from: string | undefined): { address: string; name?: string } {
  const address = mailboxesIn(from)[0] ?? (from ?? "").trim().toLowerCase();
  const name = /^\s*"?([^"<]+?)"?\s*</.exec(from ?? "")?.[1]?.trim();
  return { address, ...(name ? { name } : {}) };
}

/** The new words of a message: the quoted history cut away (a `>` line, `On … wrote:`, an original-message rule). */
export function newWords(text: string): string {
  const out: string[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^On .{5,300} wrote:\s*$/.test(l) || (/^On .{5,300}$/.test(l) && /^.*wrote:\s*$/.test(lines[i + 1] ?? "")) || /^-{2,}\s*(original message|forwarded message)/i.test(l)) break;
    if (l.startsWith(">")) continue;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Whether a message is one of ours: an agent send (its token header), as a message of the owner's sent mail it is never the owner's words. */
export const agentSend = (m: GmailMessage) => Boolean(header(m, SEND_HEADER));
/** Whether the owner wrote it: sent mail (never a draft) that no agent sent. */
export const fromOwner = (m: GmailMessage) => (m.labelIds ?? []).includes("SENT") && !(m.labelIds ?? []).includes("DRAFT") && !agentSend(m);

const EVENT_TEXT = 2000;
export function toEvent(m: GmailMessage, account: string, a: Address, link: (thread: string, account: string) => string): ReachEvent | "echo" | "noise" | "draft" {
  const labels = m.labelIds ?? [];
  if (labels.includes("DRAFT")) return "draft";
  if (agentSend(m)) return "echo";
  if (category(labels) || automated((n) => header(m, n), true)) return "noise";
  const who = personOf(header(m, "From"));
  // The owner's event carries only the owner's new words (a reply keeps the other person's subject, which must not read as the owner's);
  // the subject travels as data. Anyone else's message leads with it.
  const subject = (header(m, "Subject") ?? "(no subject)").replace(/\s+/g, " ").slice(0, 190), words = newWords(messageText(m.payload));
  const mine = fromOwner(m);
  const text = mine ? words : `Subject: ${subject}\n\n${words}`;
  return {
    connection: "google_workspace", resource: resourceOf(account, a.address), id: eventId(account, m.id, a.address), kind: "message",
    author: who.address, ...(who.name ? { author_name: who.name } : {}), text: text.slice(0, EVENT_TEXT), bot: false, url: link(m.threadId, account),
    thread: m.threadId, from_owner: mine, data: { subject }, to_agent: a.agent, entry: entryOf(account, a.address), ...(text.length > EVENT_TEXT ? { truncated: true as const } : {}),
  };
}

// ------------------------------------------------------------------------------------------------ poller

export interface Mailboxes { primary: string; accounts(): string[]; workspace(account: string): Workspace | undefined }
const PER_SCAN = 50, OVERLAP_S = 120, LIST_MAX = 5000;

/**
 * Every 60 s, per configured address: the account that may send as it, one Gmail search for new mail to or cc it (the owner's own
 * sent mail included), each message oldest first as an event the kernel accepts. The cursor moves, and the message is remembered,
 * only after the kernel took it (`post` throws when it didn't), so a refused or failed post is retried on the next scan.
 */
export class Poller {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(private readonly o: {
    mail: () => Mailboxes | undefined; addresses: Address[]; state: ReachState; identities: Identities;
    post: (e: ReachEvent) => Promise<void>; link: (thread: string, account: string) => string;
    log: { warn: (o: object, msg: string) => void; info: (o: object, msg: string) => void }; now?: () => number;
  }) {}

  start(everyMs = 60_000) {
    this.timer = setInterval(() => void this.scan(), everyMs);
    this.timer.unref();
    void this.scan();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const a of this.o.addresses) {
        try { await this.one(a); } catch (err) { this.o.log.warn({ address: a.address, err: String((err as Error).message).slice(0, 200) }, "agent address scan failed; retried next scan"); }
      }
    } finally { this.running = false; }
  }

  private async one(a: Address) {
    const mail = this.o.mail(), now = (this.o.now ?? Date.now)();
    if (!mail) return;
    const accounts = [mail.primary, ...mail.accounts().filter((x) => x !== mail.primary)];
    const own = await this.o.identities.owner(accounts, a.address);
    const ws = own && mail.workspace(own.account);
    if (!own || !ws) { this.o.log.warn({ address: a.address }, "no connected Google account can send as this agent address (not a verified send-as alias); skipped"); return; }
    // A new address starts now: enabling it never replays old mail to the agent.
    let cursor = this.o.state.cursor(a.address);
    if (cursor === undefined) { cursor = now; this.o.state.setCursor(a.address, now); this.o.state.setStart(a.address, now); }
    const from = this.o.state.start(a.address) ?? 0;
    const start = Math.max(cursor, now - MAX_LOOKBACK_MS);
    // The whole window (Gmail lists newest first; a partial list would let the cursor pass mail never listed): past the cap, nothing is done.
    const listed = await ws.gmailIds(`${agentQuery([a.address])} after:${Math.floor(start / 1000) - OVERLAP_S}`, LIST_MAX, LIST_MAX / 500, 500);
    if (listed.length >= LIST_MAX) { this.o.log.warn({ address: a.address }, "too much mail to this agent address to list in one go; skipped until the window shrinks"); return; }
    const ids = listed.reverse();
    let done = 0;
    for (const id of ids) {
      const key = eventId(own.account, id, a.address);
      if (this.o.state.seen(key)) continue;
      if (done >= PER_SCAN) break;
      const m = await ws.gmailMessage(id, "full");
      if (!m) { this.o.state.markSeen(key, now); continue; }
      const e = toEvent(m, own.account, a, this.o.link);
      const at = Number(m.internalDate ?? now);
      if (e === "draft") continue; // a draft's id is the sent message's later: not remembered
      if (at < from) { this.o.state.markSeen(key, now); continue; } // from before the address was switched on
      done++;
      if (typeof e === "object") await this.o.post(e);
      this.o.state.markSeen(key, now);
      if (at > (this.o.state.cursor(a.address) ?? 0)) this.o.state.setCursor(a.address, at);
    }
  }
}
