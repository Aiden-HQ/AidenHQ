// The summon contract for an agent's email address (kernel/src/summon.ts; module.yaml `summon:`): POST /summon/context, /prepare,
// /reply and /react, with the connection's key.
//   context  the thread, oldest first, as the poller's events saw it (ids are the event ids);
//   prepare  resolves and FREEZES the reply: the anchor message, the account, the send-as-verified From address and the exact
//            reply-all recipients, from the anchor alone. The kernel stores the payload in the reviewed record;
//   reply    sends exactly that payload (never recipients from the call), From the frozen address, once per `key`;
//   react    no-op.
// A Cc added to the thread while a reply is in review never widens its audience: nothing is read again at send time except the
// send-as check. A reply without a payload is refused.
import { z } from "zod";
import { addresses as addressesIn } from "./inbox.js";
import { type Address, eventId, fromOwner, type Identities, isEmail, newWords, parseEntry, parseEventId, parseResource, personOf, type SendLedger, type Mailboxes } from "./reach.js";
import { fromHeader, type GmailMessage, header, messageText, type FrozenMail } from "./workspace.js";

export class SummonError extends Error { constructor(public status: number, message: string) { super(message); } }
type Json = Record<string, unknown>;
const str = (v: unknown, max = 2000) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const MAX_RECIPIENTS = 50, BODY_MAX = 50_000;

const Frozen = z.object({
  account: z.string().min(3).max(320), address: z.string().min(3).max(320), from_name: z.string().max(200).optional(), as: z.enum(["agent", "owner"]),
  anchor: z.string().min(1).max(100), thread_id: z.string().min(1).max(200),
  to: z.array(z.string().max(320)).min(1).max(MAX_RECIPIENTS), cc: z.array(z.string().max(320)).max(MAX_RECIPIENTS),
  subject: z.string().min(1).max(998), body: z.string().min(1).max(BODY_MAX), in_reply_to: z.string().max(998), references: z.string().max(4000),
}).strict();
export type Frozen = z.infer<typeof Frozen>;

export function summon(o: { mail: () => Mailboxes | undefined; addresses: () => Address[]; identities: Identities; ledger: SendLedger; link: (thread: string, account: string) => string }) {
  /** The configured address a conversation is about (entry and resource must agree), and the connected account's mailbox. */
  const bind = (b: Json): { account: string; address: string; ws: NonNullable<ReturnType<Mailboxes["workspace"]>> } => {
    const resource = str(b.resource), entry = str(b.entry);
    const r = resource ? parseResource(resource) : undefined, e = entry ? parseEntry(entry) : undefined;
    if (!r || !e || r.account !== e.account || r.address !== e.address) throw new SummonError(400, "resource and entry must name the same account and address");
    const agent = o.addresses().find((a) => a.address === r.address);
    if (!agent) throw new SummonError(403, `${r.address} is not an agent address`);
    const key = (b.agent as Json | undefined)?.key;
    if (key !== undefined && key !== agent.agent) throw new SummonError(403, `${r.address} belongs to ${agent.agent}`);
    const mail = o.mail(), ws = mail?.workspace(r.account);
    if (!mail || !ws) throw new SummonError(409, `Google account ${r.account} is not connected`);
    return { account: r.account, address: r.address, ws };
  };

  async function context(b: Json) {
    const { account, address, ws } = bind(b);
    const thread = str(b.thread);
    if (!thread) throw new SummonError(400, "thread is required");
    const before = str(b.before) ? parseEventId(str(b.before)!) : undefined;
    const n = Math.min(Math.max(Number(b.n) || 10, 1), 50);
    const all = await ws.gmailThreadRaw(thread).catch((err) => { throw new SummonError(502, String((err as Error).message).slice(0, 200)); });
    const upTo = before ? all.findIndex((m) => m.id === before.message) : -1;
    const kept = (upTo >= 0 ? all.slice(0, upTo) : all).slice(-n);
    return {
      messages: kept.map((m) => {
        const who = personOf(header(m, "From"));
        return { id: eventId(account, m.id, address), author: who.name ? `${who.name} <${who.address}>` : who.address, is_owner: fromOwner(m), text: newWords(messageText(m.payload)).slice(0, 4000), ts: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : "" };
      }),
    };
  }

  /** The recipients of a reply-all to `m`, nobody twice, never the sender's own addresses: its sender (or Reply-To) and everyone it
   *  went to; when the anchor is our own mail, the people it went to. */
  function recipients(m: GmailMessage, mine: Set<string>): { to: string[]; cc: string[] } {
    const sent = (m.labelIds ?? []).includes("SENT");
    const first = sent ? addressesIn(header(m, "To")) : addressesIn(header(m, "Reply-To") || header(m, "From"));
    const rest = sent ? addressesIn(header(m, "Cc")) : new Set([...addressesIn(header(m, "To")), ...addressesIn(header(m, "Cc"))]);
    const seen = new Set(mine);
    const take = (s: Set<string>) => [...s].filter((a) => isEmail(a) && !seen.has(a) && (seen.add(a), true));
    let to = take(first);
    const cc = take(rest);
    if (!to.length && cc.length) to = cc.splice(0, cc.length);
    return { to, cc };
  }

  async function prepare(b: Json) {
    const { account, address, ws } = bind(b);
    const text = str(b.text, BODY_MAX), anchorId = str(b.in_reply_to) ? parseEventId(str(b.in_reply_to)!) : undefined;
    const as = b.reply_as === "owner" ? "owner" : "agent";
    if (!text || !anchorId || anchorId.account !== account || anchorId.address !== address) throw new SummonError(400, "text and an in_reply_to message of this conversation are required");
    const from = as === "owner" ? account : address;
    const who = await o.identities.check(account, from).catch((err) => { throw new SummonError(502, `send-as check: ${String((err as Error).message).slice(0, 200)}`); });
    if (!who.ok) throw new SummonError(409, `${account} cannot send as ${from}: add it as a verified "Send mail as" address in Gmail settings`);
    const m = await ws.gmailMessage(anchorId.message, "metadata").catch((err) => { throw new SummonError(502, String((err as Error).message).slice(0, 200)); });
    if (!m) throw new SummonError(404, "the message being answered is gone");
    const thread = str(b.thread);
    if (thread && thread !== m.threadId) throw new SummonError(400, "in_reply_to is not in this thread");
    const subject0 = header(m, "Subject") ?? "";
    const subject = /^re:/i.test(subject0) ? subject0 : `Re: ${subject0 || "(no subject)"}`;
    const msgId = header(m, "Message-ID") ?? "";
    const { to, cc } = recipients(m, new Set([address, account.toLowerCase(), from.toLowerCase()]));
    if (!to.length) throw new SummonError(422, "nobody to reply to");
    if (to.length + cc.length > MAX_RECIPIENTS) throw new SummonError(422, `more than ${MAX_RECIPIENTS} recipients`);
    const name = (as === "agent" ? who.name ?? str((b.agent as Json | undefined)?.name, 200) : who.name) ?? undefined;
    const payload: Frozen = {
      account, address, ...(name ? { from_name: name } : {}), as, anchor: anchorId.message, thread_id: m.threadId, to, cc, subject, body: text,
      in_reply_to: msgId, references: [header(m, "References"), msgId].filter(Boolean).join(" "),
    };
    const preview = `From: ${fromHeader(name, from)}\nTo: ${to.join(", ")}${cc.length ? `\nCc: ${cc.join(", ")}` : ""}\nSubject: ${subject}\n\n${text}`;
    return { preview, payload };
  }

  async function reply(b: Json) {
    const key = str(b.key, 300), parsed = Frozen.safeParse(b.payload);
    if (!key) throw new SummonError(400, "key is required");
    if (!parsed.success) throw new SummonError(400, "reply needs the payload prepare froze");
    const p = parsed.data;
    const { ws } = bind(b);
    if (p.account !== parseResource(str(b.resource) ?? "")?.account || p.address !== parseResource(str(b.resource) ?? "")?.address) throw new SummonError(400, "the payload is for another conversation");
    for (const a of [...p.to, ...p.cc]) if (!isEmail(a)) throw new SummonError(400, "the payload has an invalid recipient");
    const fromAddress = p.as === "owner" ? p.account : p.address;
    // The identity is checked again at send time; nothing else is read again.
    const who = await o.identities.check(p.account, fromAddress).catch((err) => { throw new SummonError(502, `send-as check: ${String((err as Error).message).slice(0, 200)}`); });
    if (!who.ok) throw new SummonError(409, `${p.account} cannot send as ${fromAddress} any more`);
    const frozen: FrozenMail = { from: fromHeader(p.from_name, fromAddress), to: p.to, cc: p.cc, subject: p.subject, body: p.body, thread_id: p.thread_id, in_reply_to: p.in_reply_to, references: p.references };
    try {
      const sent = await o.ledger.run(`reply:${key}`, p.account, { send: (token) => ws.sendFrozen(frozen, token), find: (token, since) => ws.findSent(token, since) }, true);
      return { id: eventId(p.account, sent.message_id, p.address) };
    } catch (err) {
      throw new SummonError(502, String((err as Error).message).slice(0, 200));
    }
  }

  // Email has no acknowledgement to give (a read receipt would tell a stranger); the kernel's 👀 step is satisfied by an empty answer.
  async function react(b: Json) { bind(b); return {}; }

  return { context, prepare, reply, react };
}
export type Summon = ReturnType<typeof summon>;
