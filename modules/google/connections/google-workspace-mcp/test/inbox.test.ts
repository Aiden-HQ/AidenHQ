import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MultiWorkspace } from "../src/accounts.js";
import { InboxCursors } from "../src/inbox.js";

const GM = "/gmail/v1/users/me/messages";
const T0 = Math.floor(Date.now() / 1000) * 1000 - 3_600_000; // an hour ago, on a whole second

type Msg = { id: string; threadId: string; at: number; headers: Record<string, string>; labels?: string[] };
const message = (m: Msg) => ({ id: m.id, threadId: m.threadId, internalDate: String(m.at), labelIds: m.labels ?? [], snippet: `about ${m.id}`, payload: { headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })) } });
/** Two accounts' inboxes: `side.io` fails. Gmail lists newest first, pages by 2, and leaves the owner's own mail out (`-from:me`). */
function google(msgs: Msg[]) {
  const listed: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "at", expires_in: 3600 });
    const thread = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(url.pathname);
    if (thread) {
      const id = decodeURIComponent(thread[1]!);
      const inThread = msgs.filter((x) => x.threadId === id);
      if (!inThread.length) return new Response("not found", { status: 404 });
      return Response.json({ id, messages: inThread.map(message) });
    }
    if (url.pathname === GM) {
      const q = url.searchParams.get("q")!;
      listed.push(q);
      const after = Number(/after:(\d+)/.exec(q)![1]) * 1000;
      const all = msgs.filter((m) => m.at >= after && !/me@work\.com/i.test(m.headers.From ?? "")).sort((a, b) => b.at - a.at);
      const from = Number(url.searchParams.get("pageToken") ?? 0);
      return Response.json({ messages: all.slice(from, from + 2).map(({ id }) => ({ id })), ...(from + 2 < all.length ? { nextPageToken: String(from + 2) } : {}) });
    }
    const m = msgs.find((x) => url.pathname === `${GM}/${x.id}` && x.id !== "gone");
    if (!m) return new Response("not found", { status: 404 });
    return Response.json(message(m));
  }) as typeof fetch;
  return { impl, listed };
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
    expect(g.listed[0]).toContain("in:inbox -from:me -category:promotions -category:social -category:updates -category:forums after:");
    expect(first.threads.map((t) => [t.thread_id, t.id, t.cc_only])).toEqual([["tc", "c1", true], ["ta", "a2", false]]);
    expect(first.threads[0]).toMatchObject({ account: "me@work.com", link: expect.stringContaining("#all/tc") });
    expect(first.accounts[0]).toMatchObject({ dropped: { list: 1, "no-reply": 1, auto: 1 }, more: true });
    expect(first.cursor).toEqual({ "me@work.com": T0 + 6_000 });

    // Nothing moves until the ack; a replay sees the same batch.
    expect((await ws.gmailInbox(start, 2)).cursor).toEqual(first.cursor);
    cursors.ack("agent-1", first.cursor);
    expect(cursors.get("agent-1")).toEqual(first.cursor);

    const second = await ws.gmailInbox(cursors.get("agent-1"), 1);
    expect(second.threads.map((t) => t.thread_id).sort()).toEqual(["td", "te"]);
    expect(second.cursor).toEqual({ "me@work.com": T0 + 7_000 });
    cursors.ack("agent-1", second.cursor);

    const third = await ws.gmailInbox(cursors.get("agent-1"), 5);
    expect(third.threads.map((t) => t.thread_id)).toEqual(["tf"]);
    expect(third.accounts[0]).toMatchObject({ more: false });

    // Never back, never past now; another agent has its own cursor.
    cursors.ack("agent-1", { "me@work.com": T0 });
    expect(cursors.get("agent-1")).toEqual(second.cursor);
    expect(() => cursors.ack("agent-1", { "me@work.com": Date.now() + 60_000 })).toThrow(/not a time/);
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
    ];
    const ws = new MultiWorkspace(creds(), "primary", google(answered).impl);
    const r = await ws.gmailInbox({ "me@work.com": T0 }, 20);
    expect(r.threads.map((t) => [t.thread_id, t.id, t.from, t.replied])).toEqual([
      ["td", "d2", "Me <me@work.com>", true],
      ["tk", "k3", "Kim <kim@acme.com>", false],
    ]);
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
  });
});
