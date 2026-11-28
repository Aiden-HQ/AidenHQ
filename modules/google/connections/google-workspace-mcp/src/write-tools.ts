import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { MultiWorkspace } from "./accounts.js";

/** The write methods a workspace may have (a fixture workspace has none). */
export type Writer = Partial<Pick<MultiWorkspace, "createEvent" | "updateEvent" | "deleteEvent" | "respondToEvent" | "gmailDraft" | "gmailSend" | "gmailLabel">>;
type Run<W> = <A extends { account?: string }>(name: string, fn: (ws: W, a: A) => Promise<unknown>) => (a: A) => Promise<CallToolResult>;

/** `ws`'s write method `k`, bound to it; a workspace without it (fixture mode) refuses the tool. */
function method<W extends Writer, K extends keyof Writer>(ws: W, k: K, tool: string): NonNullable<Writer[K]> {
  const f = ws[k];
  if (!f) throw new Error(`${tool} is not available in fixture mode`);
  return (f as (...a: unknown[]) => unknown).bind(ws) as NonNullable<Writer[K]>;
}

/** The calendar and Gmail write tools, each answered through `run` (main.ts: auth, the account that served, needs). */
export function registerWrites<W extends Writer>(server: McpServer, run: Run<W>): void {
  // Writes act as the owner on one account (`account`, default the primary). Each is a kernel write record (module.yaml tags
  // them destructive: the AI reviewer decides first, gmail_label excepted) and needs the account's write scope.
  const rw = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
  const writeAccount = z.string().max(320).optional().describe("Google account (email) to act as; default: primary");
  const emails = z.array(z.string().email().max(320)).max(100);
  // Required, so every record the reviewer reads says who Google emails.
  const sendUpdates = z.enum(["all", "externalOnly", "none"]).describe("Who Google emails about the change: all (the guests, as when you do it by hand), externalOnly, or none");
  const time = z.string().min(10).max(40).describe("ISO-8601 date-time with offset (2026-11-24T15:00:00+04:00), or a date (2026-11-24) for an all-day event");
  const allowConflict = z.boolean().optional().describe("Book the time although another event holds it. Only when the owner said to double-book; otherwise a taken time is refused and reported");
  const eventFields = {
    description: z.string().max(8000).optional(),
    location: z.string().max(500).optional(),
    timezone: z.string().max(64).optional().describe("IANA zone for the times, e.g. Asia/Dubai"),
  };

  server.registerTool(
    "calendar_create_event",
    {
      description:
        "Create an event on your calendar and invite attendees (Google emails them per send_updates). meet: add a Google Meet link. A time another event holds is refused (nothing is created) unless allow_conflict. request_key makes a retried call create one event: the same key answers the event it made. Reviewed before it runs.",
      inputSchema: { title: z.string().min(1).max(500), start: time, end: time, attendees: emails.optional(), meet: z.boolean().optional(), ...eventFields, request_key: z.string().min(1).max(200).describe("One fixed string per booking you intend (e.g. the task id and the slot); reuse it when retrying"), allow_conflict: allowConflict, send_updates: sendUpdates, account: writeAccount },
      annotations: rw,
    },
    run("calendar_create_event", (ws, a: { title: string; start: string; end: string; attendees?: string[]; meet?: boolean; description?: string; location?: string; timezone?: string; request_key: string; allow_conflict?: boolean; send_updates: "all" | "externalOnly" | "none"; account?: string }) =>
      method(ws, "createEvent", "calendar_create_event")({ title: a.title, start: a.start, end: a.end, attendees: a.attendees, meet: a.meet, description: a.description, location: a.location, timezone: a.timezone, request_key: a.request_key, allow_conflict: a.allow_conflict }, a.send_updates, a.account)),
  );
  server.registerTool(
    "calendar_update_event",
    {
      description:
        "Change an event: move it (start and end), rename it, change its description or location, add or remove attendees. An id from calendar_list_events (one occurrence) changes only that occurrence. A new time another event holds is refused unless allow_conflict. Pass the `etag` you read the event with and the change is refused if the event changed since. Reviewed before it runs.",
      inputSchema: { id: z.string().min(1).max(1024), etag: z.string().max(200).optional().describe("The event's etag as calendar_list_events or calendar_get_event returned it"), allow_conflict: allowConflict, title: z.string().min(1).max(500).optional(), start: time.optional(), end: time.optional(), add_attendees: emails.optional(), remove_attendees: emails.optional(), ...eventFields, send_updates: sendUpdates, account: writeAccount },
      annotations: rw,
    },
    run("calendar_update_event", (ws, a: { id: string; etag?: string; allow_conflict?: boolean; title?: string; start?: string; end?: string; add_attendees?: string[]; remove_attendees?: string[]; description?: string; location?: string; timezone?: string; send_updates: "all" | "externalOnly" | "none"; account?: string }) =>
      method(ws, "updateEvent", "calendar_update_event")(a.id, { title: a.title, start: a.start, end: a.end, add_attendees: a.add_attendees, remove_attendees: a.remove_attendees, description: a.description, location: a.location, timezone: a.timezone, etag: a.etag, allow_conflict: a.allow_conflict }, a.send_updates, a.account)),
  );
  server.registerTool(
    "calendar_delete_event",
    {
      description: "Cancel or delete an event: one you organise is cancelled for every attendee (Google tells them per send_updates); one you were invited to leaves your calendar (to say no, use calendar_respond). Reviewed before it runs.",
      inputSchema: { id: z.string().min(1).max(1024), send_updates: sendUpdates, account: writeAccount },
      annotations: rw,
    },
    run("calendar_delete_event", (ws, a: { id: string; send_updates: "all" | "externalOnly" | "none"; account?: string }) => method(ws, "deleteEvent", "calendar_delete_event")(a.id, a.send_updates, a.account)),
  );
  server.registerTool(
    "calendar_respond",
    {
      description: "Answer an invite as you: accepted, declined or tentative (the organiser sees the answer; a note to them is an email). Reviewed before it runs.",
      inputSchema: { id: z.string().min(1).max(1024), response: z.enum(["accepted", "declined", "tentative"]), account: writeAccount },
      annotations: rw,
    },
    run("calendar_respond", (ws, a: { id: string; response: "accepted" | "declined" | "tentative"; account?: string }) => method(ws, "respondToEvent", "calendar_respond")(a.id, a.response, a.account)),
  );
  const mail = {
    to: emails.min(1),
    cc: emails.optional(),
    bcc: emails.optional(),
    subject: z.string().min(1).max(500).optional().describe("A new message's subject; a reply (thread_id) takes the thread's own, so Gmail keeps it in the thread"),
    body: z.string().min(1).max(50_000).describe("Plain text"),
    thread_id: z.string().min(5).max(200).optional().describe("Reply in this thread (from gmail_search or gmail_read_thread)"),
    account: writeAccount,
  };
  type Mail = { to: string[]; cc?: string[]; bcc?: string[]; subject?: string; body: string; thread_id?: string; account?: string };
  const message = ({ account: _a, ...m }: Mail) => m;
  server.registerTool(
    "gmail_draft",
    { description: "Save an email as a draft in your Gmail (a new message, or a reply in thread_id) for you to send yourself. Reviewed before it runs.", inputSchema: mail, annotations: rw },
    run("gmail_draft", (ws, a: Mail) => method(ws, "gmailDraft", "gmail_draft")(message(a), a.account)),
  );
  server.registerTool(
    "gmail_send",
    { description: "Send an email as you (a new message, or a reply in thread_id). Reviewed before it runs.", inputSchema: mail, annotations: rw },
    run("gmail_send", (ws, a: Mail) => method(ws, "gmailSend", "gmail_send")(message(a), a.account)),
  );
  server.registerTool(
    "gmail_label",
    {
      description: "Add or remove your own Gmail labels on a thread, by name (e.g. remove Aiden). Only labels you made that exist; never Inbox, Unread, Trash, Spam or other system labels.",
      inputSchema: { thread_id: z.string().min(5).max(200), add: z.array(z.string().min(1).max(225)).max(10).default([]), remove: z.array(z.string().min(1).max(225)).max(10).default([]), account: writeAccount },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run("gmail_label", (ws, a: { thread_id: string; add: string[]; remove: string[]; account?: string }) => method(ws, "gmailLabel", "gmail_label")(a.thread_id, a.add, a.remove, a.account)),
  );
}
