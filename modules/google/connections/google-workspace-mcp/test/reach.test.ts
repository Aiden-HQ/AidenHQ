import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { gmailLink, MultiWorkspace } from "../src/accounts.js";
import { Identities, Poller, ReachState, SendLedger, type ReachEvent } from "../src/reach.js";
import { summon, SummonError } from "../src/summon.js";
import { SCOPES } from "../src/google.js";

const ME = "me@work.com", ARIA = "aria@work.com", NOW = 1_800_000_000_000;
type Msg = { id: string; threadId: string; at: number; labels?: string[]; headers: Record<string, string>; body?: string };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const wire = (m: Msg) => ({ id: m.id, threadId: m.threadId, internalDate: String(m.at), labelIds: m.labels ?? ["INBOX"], snippet: "", payload: { mimeType: "text/plain", headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })), body: { data: b64(m.body ?? "hello") } } });

/** A mailbox: the Gmail calls the poller, the feed and the summon calls make. `failSend` answers that many sends with a 500 after storing them. */
function gmail(msgs: Msg[], o: { failSend?: number } = {}) {
  const sent: { raw: string; threadId?: string }[] = [];
  let failures = o.failSend ?? 0;
  const text = (hay: string, term: string) => hay.toLowerCase().includes(term.toLowerCase());
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.replace("/gmail/v1/users/me", "");
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "at", expires_in: 3600 });
    if (path === "/settings/sendAs") return Response.json({ sendAs: [{ sendAsEmail: ME, isPrimary: true, displayName: "Me" }, { sendAsEmail: ARIA, displayName: "Aria Botley", verificationStatus: "accepted" }, { sendAsEmail: "pending@work.com", verificationStatus: "pending" }] });
    if (path === "/messages/send" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { raw: string; threadId?: string };
      sent.push(body);
      const raw = Buffer.from(body.raw, "base64url").toString("utf8");
      const headers = Object.fromEntries([...raw.split("\r\n\r\n")[0]!.replace(/\r\n /g, " ").matchAll(/^([\w-]+): (.*)$/gm)].map((x) => [x[1]!, x[2]!]));
      msgs.push({ id: `sent${sent.length}`, threadId: body.threadId ?? `t-new${sent.length}`, at: NOW + sent.length, labels: ["SENT"], headers });
      if (failures-- > 0) return new Response("boom", { status: 500 });
      return Response.json({ id: `sent${sent.length}`, threadId: body.threadId ?? `t-new${sent.length}` });
    }
    if (path === "/messages") {
      const q = url.searchParams.get("q") ?? "";
      const terms = [...q.matchAll(/(?:to|cc|deliveredto):([^\s}]+)/g)].map((m) => m[1]!);
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
      const found = msgs.filter((m) => m.at >= after && !(m.labels ?? []).includes("TRASH") && (q.includes("in:sent") ? (m.labels ?? []).includes("SENT") : q.includes("in:inbox") ? (m.labels ?? ["INBOX"]).includes("INBOX") && !/me@work\.com/i.test(m.headers.From ?? "") : terms.some((t) => text(`${m.headers.To ?? ""} ${m.headers.Cc ?? ""} ${m.headers["Delivered-To"] ?? ""}`, t)))).sort((a, b) => b.at - a.at);
      return Response.json({ messages: found.map(({ id }) => ({ id })) });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    if (one) { const m = msgs.find((x) => x.id === one[1]); return m ? Response.json(wire(m)) : new Response("nf", { status: 404 }); }
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (thread) return Response.json({ id: thread[1], messages: msgs.filter((m) => m.threadId === thread[1]).sort((a, b) => a.at - b.at).map(wire) });
    return new Response(`no route ${path}`, { status: 404 });
  }) as typeof fetch;
  return { impl, sent, msgs };
}

function setup(msgs: Msg[], o: { failSend?: number; addresses?: { agent: string; address: string }[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reach-"));
  const creds = join(dir, "creds.json");
  writeFileSync(creds, JSON.stringify({ client_id: "cid", primary: ME, accounts: { [ME]: { refresh_token: "r1", scopes: SCOPES } } }));
  const g = gmail(msgs, o);
  const state = new ReachState(join(dir, "reach-state.json"));
  const ledger = new SendLedger(state);
  const addresses = o.addresses ?? [{ agent: "aria", address: ARIA }];
  const ws = new MultiWorkspace(creds, "primary", g.impl, { addresses: addresses.map((a) => a.address), ledger });
  const identities = new Identities((a) => ws.workspace(a));
  const events: ReachEvent[] = [];
  const poller = new Poller({ mail: () => ws, addresses, state, identities, post: async (e) => void events.push(e), link: gmailLink, log: { warn: () => {}, info: () => {} }, now: () => NOW });
  const calls = summon({ mail: () => ws, addresses: () => addresses, identities, ledger, link: gmailLink });
  return { g, ws, state, events, poller, calls, ledger };
}

const mail = (id: string, thread: string, at: number, headers: Record<string, string>, labels?: string[], body?: string): Msg => ({ id, threadId: thread, at, labels, headers, body });
const FRESH = NOW + 1_000;

describe("agent address poller", () => {
  it("a stranger's email to the address is one event for the agent, not the owner's words", async () => {
    const t = setup([]);
    await t.poller.scan(); // the first scan only sets the cursor to now
    t.g.msgs.push(mail("m2", "t2", FRESH + 10, { From: "Dana <dana@acme.com>", To: ARIA, Subject: "Lunch?" }, undefined, "Can we move lunch?\n\nOn Mon, Ada wrote:\n> old"));
    await t.poller.scan();
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ id: `${ME}:m2:${ARIA}`, resource: `${ME}:${ARIA}`, thread: "t2", to_agent: "aria", entry: `gmail:${ME}:${ARIA}`, from_owner: false, author: "dana@acme.com", author_name: "Dana", kind: "message" });
    expect(t.events[0]!.text).toBe("Subject: Lunch?\n\nCan we move lunch?");
  });

  it("the owner's sent mail cc'ing the address is from_owner; a group delivery with list headers is kept; one message is one event", async () => {
    const t = setup([]);
    await t.poller.scan();
    t.g.msgs.push(
      mail("o1", "to", FRESH, { From: ME, To: "dana@acme.com", Cc: ARIA, Subject: "Hi" }, ["SENT"]),
      mail("g1", "tg", FRESH + 1, { From: "Eve <eve@acme.com>", To: ARIA, Subject: "Group", "List-Id": "<aria.work.com>", "List-Unsubscribe": "<mailto:x@y>", Precedence: "list" }),
      mail("n1", "tn", FRESH + 2, { From: "News <news@acme.com>", To: ARIA, Subject: "Deals", Precedence: "bulk" }),
      mail("d1", "td", FRESH + 3, { From: ME, To: "dana@acme.com", Cc: ARIA, Subject: "Draft" }, ["DRAFT"]),
    );
    await t.poller.scan();
    await t.poller.scan(); // the same messages again, still inside the overlap: nothing twice
    expect(t.events.map((e) => [e.id.split(":")[1], e.from_owner])).toEqual([["o1", true], ["g1", false]]);
  });

  it("an agent's own send is never the owner's words", async () => {
    const t = setup([]);
    await t.poller.scan();
    // gmail_send as the owner, cc'ing the address with text that names the agent: stamped, so the scan drops it.
    await t.ws.gmailSend({ to: ["dana@acme.com"], cc: [ARIA], subject: "cc Aria", body: "cc Aria please" });
    await t.poller.scan();
    expect(t.events).toHaveLength(0);
    const raw = Buffer.from(t.g.sent[0]!.raw, "base64url").toString("utf8");
    expect(raw).toMatch(/^X-AidenHQ-Token: [0-9a-f]{32}$/m);
  });

  it("the inbox feed leaves mail to an agent's address alone (one consumer)", async () => {
    const t = setup([mail("m1", "t1", FRESH, { From: "Dana <dana@acme.com>", To: ARIA, Cc: ME }), mail("m2", "t2", FRESH + 1, { From: "Kim <kim@acme.com>", To: ME })]);
    const feed = await t.ws.gmailInbox({ [ME]: NOW }, 10);
    expect(feed.threads.map((x) => x.thread_id)).toEqual(["t2"]);
    expect(feed.accounts[0]).toMatchObject({ dropped: { "agent-address": 1 } });
  });
});

describe("summon calls", () => {
  const anchor = mail("a1", "t1", FRESH, { From: "Dana <dana@acme.com>", To: `${ARIA}, Lee <lee@acme.com>`, Cc: "Pat <pat@acme.com>", Subject: "Lunch?", "Message-ID": "<a1@acme.com>" });
  const conv = { entry: `gmail:${ME}:${ARIA}`, resource: `${ME}:${ARIA}`, thread: "t1", agent: { key: "aria", name: "Aria" } };

  it("prepare freezes the recipients: a Cc added afterwards is not in the reply", async () => {
    const t = setup([anchor]);
    const { payload, preview } = (await t.calls.prepare({ ...conv, in_reply_to: `${ME}:a1:${ARIA}`, text: "Noon works.", reply_as: "agent" })) as { payload: Record<string, unknown>; preview: string };
    expect(payload).toMatchObject({ to: ["dana@acme.com"], cc: ["lee@acme.com", "pat@acme.com"], subject: "Re: Lunch?", from_name: "Aria Botley", as: "agent" });
    expect(preview).toContain("From: \"Aria Botley\" <aria@work.com>");
    // Someone is added to the thread's mail while the reply is in review.
    anchor.headers.Cc = "Pat <pat@acme.com>, Mallory <mallory@evil.com>";
    const r = (await t.calls.reply({ ...conv, in_reply_to: `${ME}:a1:${ARIA}`, text: "ignored", key: "rec-1", reply_as: "agent", payload })) as { id: string };
    expect(r.id).toBe(`${ME}:sent1:${ARIA}`);
    const raw = Buffer.from(t.g.sent[0]!.raw, "base64url").toString("utf8");
    expect(raw).toContain('From: "Aria Botley" <aria@work.com>');
    expect(raw).toContain("To: dana@acme.com");
    expect(raw).toContain("Cc: lee@acme.com,\r\n pat@acme.com");
    expect(raw).not.toContain("mallory");
    expect(raw).toContain("In-Reply-To: <a1@acme.com>");
    expect(t.g.sent[0]!.threadId).toBe("t1");
    // The same record again sends nothing.
    expect(((await t.calls.reply({ ...conv, in_reply_to: `${ME}:a1:${ARIA}`, text: "x", key: "rec-1", reply_as: "agent", payload })) as { id: string }).id).toBe(r.id);
    expect(t.g.sent).toHaveLength(1);
    anchor.headers.Cc = "Pat <pat@acme.com>";
  });

  it("refuses a reply without the frozen payload, an unverified sender and another agent's address", async () => {
    const t = setup([anchor]);
    await expect(t.calls.reply({ ...conv, in_reply_to: `${ME}:a1:${ARIA}`, text: "hi", key: "k", reply_as: "agent" })).rejects.toBeInstanceOf(SummonError);
    expect(t.g.sent).toHaveLength(0);
    const o = setup([anchor], { addresses: [{ agent: "aria", address: "pending@work.com" }] });
    await expect(o.calls.prepare({ entry: `gmail:${ME}:pending@work.com`, resource: `${ME}:pending@work.com`, thread: "t1", in_reply_to: `${ME}:a1:pending@work.com`, text: "hi", reply_as: "agent" })).rejects.toMatchObject({ status: 409 });
    await expect(t.calls.prepare({ ...conv, agent: { key: "someone-else" }, in_reply_to: `${ME}:a1:${ARIA}`, text: "hi" })).rejects.toMatchObject({ status: 403 });
  });

  it("an unclear send failure is reconciled by its token before any retry: sent once", async () => {
    const t = setup([anchor], { failSend: 1 });
    const { payload } = (await t.calls.prepare({ ...conv, in_reply_to: `${ME}:a1:${ARIA}`, text: "Noon works.", reply_as: "agent" })) as { payload: Record<string, unknown> };
    await expect(t.calls.reply({ ...conv, in_reply_to: `${ME}:a1:${ARIA}`, text: "x", key: "rec-2", reply_as: "agent", payload })).rejects.toBeInstanceOf(SummonError);
    // The 500 hid a send that happened; the retry finds the stamped message instead of sending again.
    const r = (await t.calls.reply({ ...conv, in_reply_to: `${ME}:a1:${ARIA}`, text: "x", key: "rec-2", reply_as: "agent", payload })) as { id: string };
    expect(t.g.sent).toHaveLength(1);
    expect(r.id).toBe(`${ME}:sent1:${ARIA}`);
  });

  it("context returns the thread with the owner's own words marked, agent sends not", async () => {
    const t = setup([anchor, mail("a2", "t1", FRESH + 5, { From: ME, To: "dana@acme.com", Subject: "Re: Lunch?" }, ["SENT"], "Sure"), mail("a3", "t1", FRESH + 6, { From: "Aria <aria@work.com>", To: "dana@acme.com", Subject: "Re: Lunch?", "X-AidenHQ-Token": "abc" }, ["SENT"], "Noon")]);
    const r = (await t.calls.context({ ...conv, n: 10, before: `${ME}:a3:${ARIA}` })) as { messages: { id: string; is_owner: boolean }[] };
    expect(r.messages.map((m) => [m.id.split(":")[1], m.is_owner])).toEqual([["a1", false], ["a2", true]]);
  });
});
