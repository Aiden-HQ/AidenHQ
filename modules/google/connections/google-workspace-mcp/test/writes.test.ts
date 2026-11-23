import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MultiWorkspace, toolFailure } from "../src/accounts.js";
import { readNeed } from "../src/aidenhq-sdk/needs.js";
import { SCOPES } from "../src/google.js";
import { registerWrites } from "../src/write-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const OLD = ["https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/gmail.readonly"];

/** Two accounts: the primary signed in with the write scopes, the other before Google writes (readonly scopes). */
function creds() {
  const p = join(mkdtempSync(join(tmpdir(), "gw-")), "creds.json");
  writeFileSync(p, JSON.stringify({ client_id: "cid", primary: "me@work.com", accounts: { "me@work.com": { refresh_token: "r1", scopes: SCOPES }, "me@side.io": { refresh_token: "r2", scopes: OLD } } }));
  return p;
}

type Call = { method: string; url: URL; body?: Record<string, unknown>; ifMatch?: string };
/** Google, answering `routes` by "METHOD path"; records every API call (the token refresh aside). */
function google(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "at", expires_in: 3600 });
    const method = init?.method ?? "GET";
    const ifMatch = (init?.headers as Record<string, string> | undefined)?.["if-match"];
    calls.push({ method, url, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}), ...(ifMatch ? { ifMatch } : {}) });
    const key = `${method} ${url.pathname}`;
    if (!(key in routes)) return new Response(`no route ${key}`, { status: 404 });
    return routes[key] === null ? new Response(null, { status: 204 }) : Response.json(routes[key]);
  }) as typeof fetch;
  return { impl, calls };
}

const EV = "/calendar/v3/calendars/primary/events";
const GM = "/gmail/v1/users/me";
const mime = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

// Each write tool is tagged destructive, so the kernel files every call as a write record at floor 1 (the AI reviewer decides
// before it runs; kernel/src/writes.ts fileTool), and is granted only by name. gmail_label alone is unreviewed (Tier 0).
describe("module.yaml: the write tools are reviewed records", () => {
  const yaml = readFileSync(join(import.meta.dirname, "../../../module.yaml"), "utf8");
  const list = (tag: string) => (new RegExp(`^\\s+${tag}: \\[([^\\]]*)\\]`, "m").exec(yaml)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  it("tags every calendar and Gmail write destructive, and only gmail_label unreviewed", () => {
    expect(list("destructive").sort()).toEqual(["calendar_create_event", "calendar_delete_event", "calendar_respond", "calendar_update_event", "gmail_draft", "gmail_label", "gmail_send"]);
    expect(list("unreviewed")).toEqual(["gmail_label"]);
    expect(list("write")).toEqual([]);
  });
});

describe("calendar writes", () => {
  it("creates, moves with a guest change merged into Google's list, answers an invite and cancels, on the named account", async () => {
    const held = { id: "ev1", etag: '"e1"', summary: "Sync", start: { dateTime: "2026-11-24T10:00:00Z" }, end: { dateTime: "2026-11-24T10:30:00Z" }, attendees: [{ email: "me@work.com", self: true, responseStatus: "needsAction" }, { email: "dana@example.com", responseStatus: "accepted", optional: true }, { email: "lee@example.com" }] };
    const g = google({ [`POST ${EV}`]: { ...held, id: "new" }, [`GET ${EV}/ev1`]: held, [`PATCH ${EV}/ev1`]: held, [`DELETE ${EV}/ev1`]: null });
    const ws = new MultiWorkspace(creds(), "primary", g.impl);

    const made = await ws.createEvent({ title: "Plan", start: "2026-11-25T15:00:00+04:00", end: "2026-11-25", attendees: ["dana@example.com"], meet: true }, "all");
    expect(made).toMatchObject({ id: "new", account: "me@work.com" });
    expect(g.calls[0]).toMatchObject({ method: "POST" });
    expect(g.calls[0]!.url.searchParams.get("sendUpdates")).toBe("all");
    expect(g.calls[0]!.url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(g.calls[0]!.body).toMatchObject({ summary: "Plan", start: { dateTime: "2026-11-25T15:00:00+04:00" }, end: { date: "2026-11-25" }, attendees: [{ email: "dana@example.com" }] });

    g.calls.length = 0;
    await ws.updateEvent("ev1", { start: "2026-11-24T12:00:00Z", end: "2026-11-24T12:30:00Z", add_attendees: ["kim@example.com", "DANA@example.com"], remove_attendees: ["Lee@example.com"] }, "none");
    const patch = g.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url.searchParams.get("sendUpdates")).toBe("none");
    expect(patch.ifMatch).toBe('"e1"');
    // Untouched guests keep their answers and fields; the removed one goes; the new one is added once.
    expect(patch.body!.attendees).toEqual([held.attendees[0], held.attendees[1], { email: "kim@example.com" }]);
    expect(patch.body!.start).toEqual({ dateTime: "2026-11-24T12:00:00Z" });

    g.calls.length = 0;
    await ws.respondToEvent("ev1", "declined");
    expect(g.calls.at(-1)!.body).toEqual({ attendees: [{ email: "me@work.com", self: true, responseStatus: "declined" }], attendeesOmitted: true });

    expect(await ws.deleteEvent("ev1", "all")).toEqual({ id: "ev1", deleted: true, account: "me@work.com" });
    expect(g.calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("an account signed in before Google writes answers needs_owner scope, without calling Google", async () => {
    const g = google({});
    const ws = new MultiWorkspace(creds(), "primary", g.impl);
    const err = await ws.createEvent({ title: "x", start: "2026-11-25", end: "2026-11-26" }, "all", "me@side.io").catch((e) => e);
    expect(readNeed(toolFailure(err))).toMatchObject({ cause: "scope", scope: "calendar.events", account: "me@side.io" });
    expect(g.calls).toEqual([]);
    expect(ws.authStatus().find((a) => a.email === "me@side.io")!.missing).toEqual(["calendar.events", "gmail.modify"]);
    expect(ws.authStatus().find((a) => a.email === "me@work.com")!.missing).toBeUndefined();
  });
});

describe("Gmail writes", () => {
  const thread = { messages: [{ id: "m1", threadId: "t1", payload: { headers: [{ name: "Subject", value: "Agenda" }, { name: "Message-ID", value: "<a@x>" }] } }, { id: "m2", threadId: "t1", payload: { headers: [{ name: "Subject", value: "Re: Agenda" }, { name: "Message-ID", value: "<b@x>" }, { name: "References", value: "<a@x>" }] } }] };

  it("sends a reply threaded on the last message, drafts a new one, and refuses a header line break", async () => {
    const g = google({ [`GET ${GM}/threads/t1`]: thread, [`POST ${GM}/messages/send`]: { id: "s1", threadId: "t1" }, [`POST ${GM}/drafts`]: { id: "d1", message: { id: "m9", threadId: "t9" } } });
    const ws = new MultiWorkspace(creds(), "primary", g.impl);

    expect(await ws.gmailSend({ to: ["dana@example.com"], body: "Yes, Thursday works. Café at 3?", thread_id: "t1" })).toMatchObject({ message_id: "s1", thread_id: "t1", account: "me@work.com" });
    const sent = g.calls.find((c) => c.url.pathname.endsWith("/messages/send"))!.body!;
    expect(sent.threadId).toBe("t1");
    const text = mime(String(sent.raw));
    expect(text).toContain("To: dana@example.com\r\n");
    expect(text).toContain("Subject: Re: Agenda\r\n");
    expect(text).toContain("In-Reply-To: <b@x>\r\nReferences: <a@x>\r\n <b@x>\r\n");
    expect(Buffer.from(text.split("\r\n\r\n")[1]!, "base64").toString("utf8")).toBe("Yes, Thursday works. Café at 3?");

    const long = "Ünïcode ".repeat(20);
    expect(await ws.gmailDraft({ to: ["lee@example.com", "kim@example.com"], subject: long, body: "Hi" })).toMatchObject({ draft_id: "d1", thread_id: "t9" });
    const draft = mime(String((g.calls.at(-1)!.body!.message as { raw: string }).raw));
    expect(draft).toContain("To: lee@example.com,\r\n kim@example.com\r\n");
    // A long non-ASCII subject: folded encoded words of whole characters, each under 75 characters, decoding to the subject.
    const words = /Subject: ((?:=\?UTF-8\?B\?[^?]+\?=(?:\r\n )?)+)\r\n/.exec(draft)![1]!.split("\r\n ");
    expect(words.every((w) => w.length <= 75)).toBe(true);
    expect(words.map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8")).join("")).toBe(long);

    const before = g.calls.length;
    await expect(ws.gmailSend({ to: ["dana@example.com"], subject: "Hi\r\nBcc: spy@example.com", body: "x" })).rejects.toThrow(/line break/);
    expect(g.calls.length).toBe(before);
  });

  it("changes only the mailbox's own labels, by name; never a system label", async () => {
    const g = google({ [`GET ${GM}/labels`]: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_7", name: "Aiden", type: "user" }] }, [`POST ${GM}/threads/t1/modify`]: {} });
    const ws = new MultiWorkspace(creds(), "primary", g.impl);
    expect(await ws.gmailLabel("t1", [], ["aiden"])).toMatchObject({ thread_id: "t1", removed: ["aiden"] });
    expect(g.calls.at(-1)!.body).toEqual({ addLabelIds: [], removeLabelIds: ["Label_7"] });
    const before = g.calls.length;
    await expect(ws.gmailLabel("t1", [], ["INBOX"])).rejects.toThrow(/never system ones/);
    expect(g.calls.slice(before).some((c) => c.method === "POST")).toBe(false);
  });
});

// The registered tools, called as an agent's MCP client calls them: each reaches its account's write with the agent's arguments.
describe("the write tools over MCP", () => {
  it("a calendar and a Gmail tool call reach Google with their arguments", async () => {
    const g = google({ [`POST ${EV}`]: { id: "new", start: { date: "2026-11-25" }, end: { date: "2026-11-26" } }, [`POST ${GM}/messages/send`]: { id: "s1", threadId: "t2" } });
    const ws = new MultiWorkspace(creds(), "primary", g.impl);
    const server = new McpServer({ name: "t", version: "0" });
    registerWrites(server, <A,>(_name: string, fn: (w: MultiWorkspace, a: A) => Promise<unknown>) => async (a: A) => ({ content: [{ type: "text" as const, text: JSON.stringify(await fn(ws, a)) }] }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "agent", version: "0" });
    await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text);
    expect(await call("calendar_create_event", { title: "Plan", start: "2026-11-25", end: "2026-11-26", send_updates: "all" })).toMatchObject({ id: "new", account: "me@work.com" });
    expect(g.calls.at(-1)!.url.searchParams.get("sendUpdates")).toBe("all");
    expect(await call("gmail_send", { to: ["dana@example.com"], subject: "Hi", body: "Hello" })).toMatchObject({ message_id: "s1", account: "me@work.com" });
    expect(mime(String(g.calls.at(-1)!.body!.raw))).toContain("Subject: Hi\r\n");
  });
});
