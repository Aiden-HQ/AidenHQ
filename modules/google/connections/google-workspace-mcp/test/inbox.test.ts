import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MultiWorkspace, toolFailure } from "../src/accounts.js";
import { GoogleClient } from "../src/google.js";
import { Workspace } from "../src/workspace.js";
import { readNeed } from "../src/aidenhq-sdk/needs.js";
import { InboxCursors } from "../src/inbox.js";

const GM = "/gmail/v1/users/me/messages";
const T0 = Math.floor(Date.now() / 1000) * 1000 - 3_600_000; // an hour ago, on a whole second

type Msg = { id: string; threadId: string; at: number; headers: Record<string, string>; labels?: string[] };
const message = (m: Msg) => ({ id: m.id, threadId: m.threadId, internalDate: String(m.at), labelIds: m.labels ?? [], snippet: `about ${m.id}`, payload: { headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })) } });
/** Gmail's category search terms, as the label they exclude. */
const CATEGORY_TERMS: Record<string, string> = { promotions: "CATEGORY_PROMOTIONS", social: "CATEGORY_SOCIAL", updates: "CATEGORY_UPDATES", forums: "CATEGORY_FORUMS" };

/** Two accounts' inboxes: `side.io` fails. Gmail lists newest first, pages by 2, and honours `-from:me` and any `-category:` terms. */
function google(msgs: Msg[], onThread?: () => void, onMessage?: () => void) {
  const listed: string[] = [];
  /** Message metadata requests in flight (`reads`) and the most at once (`most`), so a test sees the walk overlap its reads. */
  const reads = { now: 0, most: 0 };
  const impl = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "at", expires_in: 3600 });
    const thread = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(url.pathname);
    if (thread) {
      const id = decodeURIComponent(thread[1]!);
      onThread?.();
      const inThread = msgs.filter((x) => x.threadId === id);
      if (!inThread.length) return new Response("not found", { status: 404 });
      return Response.json({ id, messages: inThread.map(message) });
    }
    if (url.pathname === GM) {
      const q = url.searchParams.get("q")!;
      listed.push(q);
      const after = Number(/after:(\d+)/.exec(q)![1]) * 1000;
      const excluded = [...q.matchAll(/-category:(\w+)/g)].map((x) => CATEGORY_TERMS[x[1]!]).filter((x): x is string => Boolean(x));
      const all = msgs
        .filter((m) => m.at >= after && !/me@work\.com/i.test(m.headers.From ?? "") && !(m.labels ?? []).some((l) => excluded.includes(l)))
        .sort((a, b) => b.at - a.at);
      const from = Number(url.searchParams.get("pageToken") ?? 0);
      return Response.json({ messages: all.slice(from, from + 2).map(({ id }) => ({ id })), ...(from + 2 < all.length ? { nextPageToken: String(from + 2) } : {}) });
    }
    const m = msgs.find((x) => url.pathname === `${GM}/${x.id}` && x.id !== "gone");
    if (!m) return new Response("not found", { status: 404 });
    reads.now++;
    reads.most = Math.max(reads.most, reads.now);
    onMessage?.();
    await new Promise((r) => setTimeout(r, 1));
    reads.now--;
    return Response.json(message(m));
  }) as typeof fetch;
  return { impl, listed, reads };
}

function creds() {
  const p = join(mkdtempSync(join(tmpdir(), "gw-")), "creds.json");
  writeFileSync(p, JSON.stringify({ client_id: "cid", primary: "me@work.com", accounts: { "me@work.com": { refresh_token: "r1" } } }));
  return p;
}

const person = (from: string, to = "me@work.com", cc = "") => ({ From: from, To: to, ...(cc ? { Cc: cc } : {}) });

describe("gmail_inbox_new: the inbox since the cursor, automated mail set aside", () => {
  const msgs: Msg[] = [
    { id: "a1", threadId: "ta", at: T0 + 1_000, headers: person("Dana <dana@acme.com>") },
    { id: "n1", threadId: "tn", at: T0 + 2_000, headers: { ...person("Weekly <news@acme.com>"), "List-Unsubscribe": "<mailto:u@acme.com>" } },
    { id: "r1", threadId: "tr", at: T0 + 3_000, headers: person("GitHub <noreply@github.com>") },
    { id: "b1", threadId: "tb", at: T0 + 4_000, headers: { ...person("Ops <ops@acme.com>"), "Auto-Submitted": "auto-generated" } },
    { id: "c1", threadId: "tc", at: T0 + 5_000, headers: person("Raj <raj@acme.com>", "lee@acme.com, some.me@work.com", "Me <me@work.com>") },
    { id: "a2", threadId: "ta", at: T0 + 6_000, headers: person("Dana <dana@acme.com>") },
    // Deleted between the listing and its read: skipped.
    { id: "gone", threadId: "tg", at: T0 + 6_500, headers: person("Pat <pat@acme.com>") },
    { id: "d1", threadId: "td", at: T0 + 7_000, headers: person("Kim <kim@acme.com>") },
    // Same millisecond as d1: a capped call can't split the two, so both come together.
    { id: "e1", threadId: "te", at: T0 + 7_000, headers: person("Lee <lee@acme.com>") },
    { id: "f1", threadId: "tf", at: T0 + 8_000, headers: person("Sam <sam@acme.com>") },
  ];

  it("walks oldest first, drops automated mail, keeps each thread's newest message, caps by thread and acks forward", async () => {
    const g = google(msgs);
    const ws = new MultiWorkspace(creds(), "primary", g.impl);
    const cursors = new InboxCursors(join(mkdtempSync(join(tmpdir(), "cur-")), "inbox-cursors.json"));
    const start = { "me@work.com": T0 };

    const first = await ws.gmailInbox(start, 2);
    // The listing is broad: categories are filtered from labelIds in code, so a promotional message is counted, not hidden.
    expect(g.listed[0]).toContain("in:inbox -from:me after:");
    expect(g.listed[0]).not.toContain("-category:");
    expect(first.threads.map((t) => [t.thread_id, t.id, t.cc_only])).toEqual([["tc", "c1", true], ["ta", "a2", false]]);
    expect(first.threads[0]).toMatchObject({ account: "me@work.com", link: expect.stringContaining("#all/tc") });
    expect(first.accounts[0]).toMatchObject({ dropped: { list: 1, "no-reply": 1, auto: 1 }, more: true });
    expect(first.cursor).toEqual({ "me@work.com": T0 + 6_000 });

    // Nothing moves until the ack; a replay sees the same batch.
    expect((await ws.gmailInbox(start, 2)).cursor).toEqual(first.cursor);
    cursors.offer("agent-1", first.cursor);
    cursors.ack("agent-1", first.cursor);
    expect(cursors.get("agent-1")).toEqual(first.cursor);

    const second = await ws.gmailInbox(cursors.get("agent-1"), 1);
    expect(second.threads.map((t) => t.thread_id).sort()).toEqual(["td", "te"]);
    expect(second.cursor).toEqual({ "me@work.com": T0 + 7_000 });
    cursors.offer("agent-1", second.cursor);
    cursors.ack("agent-1", second.cursor);

    const third = await ws.gmailInbox(cursors.get("agent-1"), 5);
    expect(third.threads.map((t) => t.thread_id)).toEqual(["tf"]);
    expect(third.accounts[0]).toMatchObject({ more: false });

    // Never back, never past what the feed gave; another agent has its own cursor and nothing offered.
    cursors.ack("agent-1", { "me@work.com": T0 });
    expect(cursors.get("agent-1")).toEqual(second.cursor);
    expect(() => cursors.ack("agent-1", { "me@work.com": T0 + 7_001 })).toThrow(/not a time/);
    expect(() => cursors.ack("agent-2", second.cursor)).toThrow(/not a time/);
    expect(cursors.get("agent-2")).toEqual({});
  });

  it("a thread the owner answered shows the owner's newest message, so it is not re-filed", async () => {
    const own = (to: string): Msg["headers"] => ({ From: "Me <me@work.com>", To: to });
    const answered: Msg[] = [
      { id: "d1", threadId: "td", at: T0 + 1_000, headers: person("Dana <dana@acme.com>") },
      // The owner's reply lives in SENT, not the inbox listing, and is the thread's newest message.
      { id: "d2", threadId: "td", at: T0 + 2_000, headers: own("dana@acme.com"), labels: ["SENT"] },
      { id: "k1", threadId: "tk", at: T0 + 3_000, headers: person("Kim <kim@acme.com>") },
      { id: "k2", threadId: "tk", at: T0 + 4_000, headers: own("kim@acme.com"), labels: ["SENT"] },
      // Kim wrote again after that reply, so this thread needs the owner again.
      { id: "k3", threadId: "tk", at: T0 + 5_000, headers: person("Kim <kim@acme.com>") },
      // A notification lands in Pat's thread after Pat's ask: the row stays Pat's.
      { id: "p1", threadId: "tp", at: T0 + 6_000, headers: person("Pat <pat@acme.com>") },
      { id: "p2", threadId: "tp", at: T0 + 7_000, headers: person("Docs <comments-noreply@docs.google.com>") },
    ];
    const ws = new MultiWorkspace(creds(), "primary", google(answered).impl);
    const r = await ws.gmailInbox({ "me@work.com": T0 }, 20);
    expect(r.threads.map((t) => [t.thread_id, t.id, t.from, t.replied])).toEqual([
      ["td", "d2", "Me <me@work.com>", true],
      ["tk", "k3", "Kim <kim@acme.com>", false],
      ["tp", "p1", "Pat <pat@acme.com>", false],
    ]);
  });

  it("counts category mail under its own key instead of serving an empty feed", async () => {
    // The report: the whole window's inbox mail is in Gmail's noise categories, so the old query never listed it and the feed
    // said `threads: 0, dropped: {}` — indistinguishable from an empty inbox.
    const categorised: Msg[] = [
      { id: "p1", threadId: "tp", at: T0 + 1_000, headers: person("Shop <deals@shop.com>"), labels: ["CATEGORY_PROMOTIONS"] },
      { id: "s1", threadId: "ts", at: T0 + 2_000, headers: person("Ann <ann@social.com>"), labels: ["CATEGORY_SOCIAL"] },
      { id: "u1", threadId: "tu", at: T0 + 3_000, headers: person("Docs <docs@acme.com>"), labels: ["CATEGORY_UPDATES"] },
      { id: "o1", threadId: "to", at: T0 + 4_000, headers: person("List <list@acme.com>"), labels: ["CATEGORY_FORUMS"] },
    ];
    const g = google(categorised);
    const r = await new MultiWorkspace(creds(), "primary", g.impl).gmailInbox({ "me@work.com": T0 }, 20);
    expect(r.threads).toEqual([]);
    expect(r.accounts[0]).toMatchObject({ threads: 0, dropped: { "category:promotions": 1, "category:social": 1, "category:updates": 1, "category:forums": 1 }, more: false });
    expect(r.cursor).toEqual({ "me@work.com": T0 + 4_000 });
  });

  it("counts a category message before the thread limit, so it neither blocks nor replays the thread behind it", async () => {
    // limit: 1. Oldest first: thread A's person, then a promotion in B, then A's newer reply. The promotion must not take the
    // only thread slot: it is dropped and counted, and the call reaches A's reply instead of serving A's stale first row.
    const interleaved: Msg[] = [
      { id: "a1", threadId: "ta", at: T0 + 1_000, headers: person("Dana <dana@acme.com>") },
      { id: "p1", threadId: "tp", at: T0 + 2_000, headers: person("Shop <deals@shop.com>"), labels: ["CATEGORY_PROMOTIONS"] },
      { id: "a2", threadId: "ta", at: T0 + 3_000, headers: person("Dana <dana@acme.com>") },
      { id: "z1", threadId: "tz", at: T0 + 4_000, headers: person("Kim <kim@acme.com>") },
    ];
    const ws = new MultiWorkspace(creds(), "primary", google(interleaved).impl);
    const first = await ws.gmailInbox({ "me@work.com": T0 }, 1);
    expect(first.threads.map((t) => [t.thread_id, t.id])).toEqual([["ta", "a2"]]);
    expect(first.accounts[0]).toMatchObject({ threads: 1, dropped: { "category:promotions": 1 }, more: true });
    expect(first.cursor).toEqual({ "me@work.com": T0 + 3_000 });

    const second = await ws.gmailInbox(first.cursor, 1);
    expect(second.threads.map((t) => t.thread_id)).toEqual(["tz"]);
    expect(second.accounts[0]).toMatchObject({ more: false });
  });

  it("never splits a millisecond at the budget, so a stopped call loses no message", async () => {
    // Three messages at one millisecond, then one later. With the budget already spent the walk still decides the whole first
    // group and stops before the later message: the cursor it returns (that millisecond) is one the next call skips, so a
    // message left at it would be lost forever.
    const same: Msg[] = [
      { id: "g1", threadId: "tg1", at: T0 + 1_000, headers: person("Dana <dana@acme.com>") },
      { id: "g2", threadId: "tg2", at: T0 + 1_000, headers: person("Kim <kim@acme.com>") },
      { id: "g3", threadId: "tg3", at: T0 + 1_000, headers: person("Sam <sam@acme.com>") },
      { id: "g4", threadId: "tg4", at: T0 + 2_000, headers: person("Pat <pat@acme.com>") },
    ];
    let clock = Date.now();
    let reads = 0;
    // The budget is spent by the metadata reads themselves: the fourth message arrives with the walk's time gone.
    const g = google(same, undefined, () => { if (++reads === 4) clock += 60_000; });
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const ws = new Workspace(new GoogleClient({ client_id: "cid", refresh_token: "r1" }, g.impl), "primary");
      const first = await ws.gmailInbox("me@work.com", T0, 20);
      // Within one millisecond the order is Gmail's own (it lists newest first, the walk reverses it): all three come together.
      expect(first.threads.map((t) => t.thread_id).sort()).toEqual(["tg1", "tg2", "tg3"]);
      expect(first).toMatchObject({ cursor: T0 + 1_000, more: true });

      reads = 0;
      const second = await ws.gmailInbox("me@work.com", first.cursor, 20);
      expect(second.threads.map((t) => t.thread_id)).toEqual(["tg4"]);
      expect(second).toMatchObject({ cursor: T0 + 2_000, more: false });
    } finally {
      now.mockRestore();
    }
  });

  it("stops enrichment at the budget and hands the rows it did not read to the next call", async () => {
    // limit 20 over 12 threads, with thread reads slow enough to spend the call's budget after the first batch: those 8 rows
    // are served, the rest is not served (a row must carry the `replied` the call read) and the cursor goes back to the last
    // served row with `more: true`, so the next call picks the rest up instead of losing them behind the cursor.
    const many: Msg[] = Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, threadId: `tw${i}`, at: T0 + (i + 1) * 1_000, headers: person(`P${i} <p${i}@acme.com>`) }));
    let clock = Date.now();
    const slow = google(many, () => { clock += 20_000; });
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const ws = new Workspace(new GoogleClient({ client_id: "cid", refresh_token: "r1" }, slow.impl), "primary");
      const first = await ws.gmailInbox("me@work.com", T0, 20);
      expect(first.threads.map((t) => t.thread_id)).toEqual(["tw0", "tw1", "tw2", "tw3", "tw4", "tw5", "tw6", "tw7"]);
      expect(first).toMatchObject({ cursor: T0 + 8_000, more: true });

      const second = await ws.gmailInbox("me@work.com", first.cursor, 20);
      expect(second.threads.map((t) => t.thread_id)).toEqual(["tw8", "tw9", "tw10", "tw11"]);
      expect(second).toMatchObject({ cursor: T0 + 12_000, more: false });
    } finally {
      now.mockRestore();
    }
  });

  it("stops paging at the walk budget instead of serving a partial listing past the cursor", async () => {
    // 600 inbox messages = two list pages. With the budget spent before the second page, the call cannot walk the window (it
    // needs the whole listing to keep the oldest-first order and an honest cursor): it serves nothing, keeps the cursor, says
    // more, and the next call starts over with a fresh budget.
    const bulk: Msg[] = Array.from({ length: 600 }, (_, i) => ({ id: `q${i}`, threadId: `tq${i}`, at: T0 + (i + 1) * 1_000, headers: person(`P${i} <p${i}@acme.com>`) }));
    let clock = Date.now();
    let lists = 0;
    const slow = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === GM && ++lists === 2) clock += 60_000; // the second page starts past the walk budget
      return google(bulk).impl(input);
    }) as typeof fetch;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const ws = new Workspace(new GoogleClient({ client_id: "cid", refresh_token: "r1" }, slow), "primary");
      const r = await ws.gmailInbox("me@work.com", T0, 20);
      expect(r).toEqual({ threads: [], dropped: {}, cursor: T0, more: true });
    } finally {
      now.mockRestore();
    }
  });

  it("a failing account keeps its place and shows its error", async () => {
    const p = creds();
    writeFileSync(p, JSON.stringify({ client_id: "cid", primary: "me@work.com", accounts: { "me@work.com": { refresh_token: "r1" }, "me@side.io": { refresh_token: "r2" } } }));
    const ok = google(msgs).impl;
    const impl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com" && String(init?.body ?? "").includes("r2")) return new Response("{}", { status: 503 });
      return ok(input, init);
    }) as typeof fetch;
    const r = await new MultiWorkspace(p, "primary", impl).gmailInbox({ "me@work.com": T0 + 7_500 }, 5);
    expect(r.threads.map((t) => t.thread_id)).toEqual(["tf"]);
    expect(Object.keys(r.cursor)).toEqual(["me@work.com"]);
    expect(r.accounts.find((a) => a.account === "me@side.io")).toHaveProperty("error");

    // A sign-in Google refused for good is the owner's to fix: the call answers needs_owner naming that account.
    const dead = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com" && String(init?.body ?? "").includes("r2")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return ok(input, init);
    }) as typeof fetch;
    const err = await new MultiWorkspace(p, "primary", dead).gmailInbox({ "me@work.com": T0 + 7_500 }, 5).catch((e) => e);
    expect(readNeed(toolFailure(err))).toMatchObject({ cause: "expired", account: "me@side.io" });

    // A sign-in whose recorded scopes allow no Gmail read is the owner's reconnect too, before any read is tried.
    const q = join(mkdtempSync(join(tmpdir(), "gw-")), "creds.json");
    writeFileSync(q, JSON.stringify({ client_id: "cid", primary: "me@work.com", accounts: { "me@work.com": { refresh_token: "r1", scopes: ["https://www.googleapis.com/auth/calendar.events"] } } }));
    const noScope = await new MultiWorkspace(q, "primary", ok).gmailInbox({}, 5).catch((e) => e);
    expect(readNeed(toolFailure(noScope))).toMatchObject({ cause: "scope", account: "me@work.com" });
  });
});
