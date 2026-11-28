import { createHash } from "node:crypto";
import { type GoogleClient, GoogleApiError } from "./google.js";
import { blocksOf, conflictWith } from "./find-times.js";
import { dateIn, renderInZone, wallInstant, zoneOrUtc } from "./zones.js";

export { renderInZone };
import { automated, category, ccOnly, INBOX_BUDGET_MS, INBOX_QUERY, INBOX_WALK_SHARE, MAX_READS, READS_AT_ONCE } from "./inbox.js";

const CAL = "https://www.googleapis.com/calendar/v3";
const DRIVE = "https://www.googleapis.com/drive/v3";

export interface GEvent {
  id: string;
  eventType?: string;
  workingLocationProperties?: { type?: string; customLocation?: { label?: string }; officeLocation?: { label?: string } };
  transparency?: string;
  recurringEventId?: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; responseStatus?: string; resource?: boolean; comment?: string; optional?: boolean }[];
  location?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attachments?: { fileId?: string; title?: string; fileUrl?: string }[];
  htmlLink?: string;
  organizer?: { email?: string; self?: boolean };
  attendeesOmitted?: boolean;
  etag?: string;
}

/** Event shape matching ops-mcp's meeting_match input. */
export interface NormalizedEvent {
  id: string;
  series_id?: string;
  title: string;
  start: string;
  end: string;
  timezone?: string;
  all_day: boolean;
  status?: string;
  attendees: { name?: string; email?: string; self?: boolean; response_status?: string }[];
  location?: string;
  meet_link?: string;
  attachments: { file_id?: string; title?: string; url?: string }[];
  html_link?: string;
  /** Google's version tag: calendar_update_event's `etag` refuses the change when the event moved on since it was read. */
  etag?: string;
}

/**
 * start and end rendered in the event's own zone, with that same zone labelled, so the offset and
 * the `timezone` never disagree. An all-day event is a date, not an instant, so it keeps the date
 * Google gave and is not converted.
 */
function eventTimes(e: GEvent): { start: string; end: string; timezone?: string } {
  if (!e.start?.dateTime) return { start: `${e.start?.date}T00:00:00Z`, end: `${e.end?.date}T00:00:00Z`, timezone: e.start?.timeZone };
  const zone = zoneOrUtc(e.start.timeZone ?? e.end?.timeZone);
  return { start: renderInZone(e.start.dateTime, zone), end: renderInZone(e.end?.dateTime ?? e.start.dateTime, zone), timezone: zone };
}

export function normalizeEvent(e: GEvent): NormalizedEvent {
  const allDay = !e.start?.dateTime;
  const meet = e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  const times = eventTimes(e);
  return {
    id: e.id,
    series_id: e.recurringEventId,
    title: e.summary ?? "",
    start: times.start,
    end: times.end,
    timezone: times.timezone,
    all_day: allDay,
    status: e.status,
    attendees: (e.attendees ?? [])
      .filter((a) => !a.resource)
      .map((a) => ({ name: a.displayName, email: a.email, self: a.self, response_status: a.responseStatus })),
    location: e.location,
    meet_link: meet,
    attachments: (e.attachments ?? []).map((a) => ({ file_id: a.fileId, title: a.title, url: a.fileUrl })),
    html_link: e.htmlLink,
    etag: e.etag,
  };
}

/** Who Google emails about a calendar change: everyone (as when the owner does it by hand), outside guests only, or no one. */
export type SendUpdates = "all" | "externalOnly" | "none";
/** An event's own fields an agent sets. A time is a date (`2026-11-24`, all day) or an ISO-8601 date-time. */
export interface EventInput { title?: string; start?: string; end?: string; timezone?: string; description?: string; location?: string }

const when = (t: string, zone?: string) => (/^\d{4}-\d{2}-\d{2}$/.test(t) ? { date: t } : { dateTime: t, ...(zone ? { timeZone: zone } : {}) });
/** The Google fields of `e` that are set. */
function eventFields(e: EventInput): Record<string, unknown> {
  return {
    ...(e.title !== undefined ? { summary: e.title } : {}),
    ...(e.start !== undefined ? { start: when(e.start, e.timezone) } : {}),
    ...(e.end !== undefined ? { end: when(e.end, e.timezone) } : {}),
    ...(e.description !== undefined ? { description: e.description } : {}),
    ...(e.location !== undefined ? { location: e.location } : {}),
  };
}

const EVENT_FIELDS =
  "items(id,recurringEventId,summary,status,start,end,attendees(email,displayName,self,responseStatus,resource),location,hangoutLink,conferenceData(entryPoints(entryPointType,uri)),attachments(fileId,title,fileUrl),htmlLink,etag),nextPageToken";

/** The new time is taken (see Workspace.assertFree): a plain failure the agent reports to the owner. */
export class EventConflict extends Error {}
/** The event changed since the caller read it (Google's ETag no longer matches); read it again and decide again. */
export class EventChanged extends Error {
  constructor() {
    super("The event changed since you read it (Google's version no longer matches). Nothing was changed: read it again with calendar_get_event and decide again");
  }
}

/** An attendee: an email, or with `optional` Google's flag that the guest is optional. */
export type Attendee = string | { email: string; optional?: boolean };
const guest = (a: Attendee) => (typeof a === "string" ? { email: a } : { email: a.email, ...(a.optional ? { optional: true } : {}) });
const emailOf = (a: Attendee) => (typeof a === "string" ? a : a.email);

/** A stable Google event id for (calendar, key): base32hex characters only, so the same key always names the same event. */
export function eventIdFor(calendar: string, key: string): string {
  return createHash("sha256").update(`${calendar}\n${key}`).digest("hex").slice(0, 40);
}

const MAX_RAW_EVENTS = 2500;
const OFFSET = /(?:[zZ]|[+-]\d\d(?::?\d\d)?)$/;
/** [start, end) in epoch ms of a timed change, or null for an all-day one; a time with no offset needs `timezone`. */
function conflictRange(e: { start: string; end: string; timezone?: string }): [number, number] | null {
  if (!e.start.includes("T") || !e.end.includes("T")) return null;
  const at = (t: string) => {
    if (OFFSET.test(t)) return Date.parse(t);
    if (!e.timezone) throw new Error("a time needs its UTC offset (2026-11-24T15:00:00+04:00) or a timezone");
    return wallInstant(t, e.timezone);
  };
  const r: [number, number] = [at(e.start), at(e.end)];
  if (!(r[0] < r[1])) throw new Error("the event must end after it starts");
  return r;
}

export class Workspace {
  constructor(
    private readonly g: GoogleClient,
    private readonly calendarId = "primary",
  ) {}

  async listEvents(start: string, end: string, query?: string, max = 100): Promise<NormalizedEvent[]> {
    const out: NormalizedEvent[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.g.get<{ items?: GEvent[]; nextPageToken?: string }>(`${CAL}/calendars/${encodeURIComponent(this.calendarId)}/events`, {
        timeMin: new Date(start).toISOString(),
        timeMax: new Date(end).toISOString(),
        singleEvents: true, // expand recurring series into occurrences (occurrence IDs)
        orderBy: "startTime",
        maxResults: Math.min(250, max),
        q: query,
        pageToken,
        fields: EVENT_FIELDS,
      });
      out.push(...(page.items ?? []).map(normalizeEvent));
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < max);
    return out.slice(0, max);
  }

  async getEvent(id: string): Promise<NormalizedEvent> {
    return normalizeEvent(await this.rawEvent(id));
  }

  /**
   * The events between two instants as Google holds them (recurring series expanded), with the fields find_times and the
   * conflict check read: type, transparency, the owner's own answer, each side's time zone.
   */
  async rawEvents(start: string, end: string): Promise<{ events: GEvent[]; timeZone: string }> {
    const events: GEvent[] = [];
    let pageToken: string | undefined;
    let timeZone = "UTC";
    do {
      if (events.length >= MAX_RAW_EVENTS) throw new Error("too many events in that period to check availability: ask for a shorter one");
      const page = await this.g.get<{ items?: GEvent[]; nextPageToken?: string; timeZone?: string }>(this.eventUrl(), {
        timeMin: new Date(start).toISOString(),
        timeMax: new Date(end).toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
        pageToken,
        fields: "timeZone,items(id,recurringEventId,summary,status,eventType,transparency,workingLocationProperties(type,customLocation(label),officeLocation(label)),start,end,organizer(self),attendees(email,self,responseStatus,resource)),nextPageToken",
      });
      events.push(...(page.items ?? []));
      if (page.timeZone) timeZone = page.timeZone;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return { events, timeZone };
  }

  /** Other people's busy time (Calendar's freeBusy; needs the optional calendar.events.freebusy scope). `hidden`: a calendar Google would not show. */
  async freeBusy(emails: string[], start: string, end: string): Promise<{ busy: { start: string; end: string }[]; byEmail: Record<string, { start: string; end: string }[]>; hidden: string[] }> {
    const r = await this.g.request<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(
      "POST",
      `${CAL}/freeBusy`,
      {},
      { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), items: emails.map((id) => ({ id })) },
    );
    const busy: { start: string; end: string }[] = [], hidden: string[] = [], byEmail: Record<string, { start: string; end: string }[]> = {};
    for (const email of emails) {
      const c = r.calendars?.[email];
      if (!c || c.errors?.length) hidden.push(email);
      else {
        byEmail[email] = c.busy ?? [];
        busy.push(...byEmail[email]);
      }
    }
    return { busy, byEmail, hidden };
  }

  /** A colleague's working-location entries (their calendar must share events with the owner): date, kind and label per day. */
  async workingLocations(email: string, start: string, end: string): Promise<{ date: string; kind: "home" | "office" | "custom"; label?: string }[]> {
    const page = await this.g.get<{ items?: GEvent[] }>(`${CAL}/calendars/${encodeURIComponent(email)}/events`, {
      timeMin: new Date(start).toISOString(),
      timeMax: new Date(end).toISOString(),
      eventTypes: "workingLocation",
      singleEvents: true,
      maxResults: 100,
      fields: "items(start,workingLocationProperties(type,customLocation(label),officeLocation(label)))",
    });
    return (page.items ?? []).flatMap((e) => {
      const date = e.start?.date ?? (e.start?.dateTime ? dateIn(Date.parse(e.start.dateTime), zoneOrUtc(e.start.timeZone)) : undefined);
      if (!date) return [];
      const t = e.workingLocationProperties?.type;
      const label = (e.workingLocationProperties?.officeLocation?.label ?? e.workingLocationProperties?.customLocation?.label)?.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
      return [{ date, kind: t === "homeOffice" ? ("home" as const) : t === "officeLocation" ? ("office" as const) : ("custom" as const), ...(label ? { label } : {}) }];
    });
  }

  /**
   * Refuses a timed change onto a time another event holds on the owner's calendar, so an owner-named time that filled up since
   * the owner chose it is reported, never silently double-booked. `except`: the event being created or moved (an occurrence's id
   * leaves out just it; a series' id its occurrences too). All-day events are informational and not checked.
   */
  private async assertFree(e: { start: string; end: string; timezone?: string }, except: string, allowConflict?: boolean) {
    const range = conflictRange(e);
    if (!range || allowConflict) return;
    const { events, timeZone } = await this.rawEvents(new Date(range[0]).toISOString(), new Date(range[1]).toISOString());
    const taken = conflictWith(blocksOf(events, timeZone, except), range[0], range[1]);
    if (taken) throw new EventConflict(`${taken.title ? `"${taken.title}"` : "Another event"} already holds ${renderInZone(new Date(taken.start).toISOString(), e.timezone ?? timeZone)} to ${renderInZone(new Date(taken.end).toISOString(), e.timezone ?? timeZone)} on this calendar. Nothing was changed: tell the owner, and offer other times (calendar_find_times) or a deliberate double-booking (allow_conflict)`);
  }

  private eventUrl(id?: string) {
    return `${CAL}/calendars/${encodeURIComponent(this.calendarId)}/events${id ? `/${encodeURIComponent(id)}` : ""}`;
  }

  /** The event as Google holds it, every field: a PATCH of `attendees` replaces the whole list, so it is merged from this. */
  private rawEvent(id: string): Promise<GEvent> {
    return this.g.get<GEvent>(this.eventUrl(id));
  }

  // -------------------------------------------------------------- Calendar writes (each a reviewed tool call)

  /**
   * Creates the event under an id derived from `request_key` (a retried create finds it: Google answers 409, and the existing
   * event is returned), after checking the time is free.
   */
  async createEvent(e: EventInput & { attendees?: Attendee[]; meet?: boolean; request_key: string; allow_conflict?: boolean }, sendUpdates: SendUpdates): Promise<NormalizedEvent> {
    const id = eventIdFor(this.calendarId, e.request_key);
    // A retry finds its own event first: it must not fail as a conflict with itself, nor create a second one.
    const done = await this.rawEvent(id).catch((err) => (err instanceof GoogleApiError && err.status === 404 ? undefined : Promise.reject(err)));
    if (done && done.status !== "cancelled") return normalizeEvent(done);
    if (e.start && e.end) await this.assertFree({ start: e.start, end: e.end, timezone: e.timezone }, id, e.allow_conflict);
    const body = {
      id,
      ...eventFields(e),
      ...(e.attendees?.length ? { attendees: e.attendees.map(guest) } : {}),
      ...(e.meet ? { conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
    };
    try {
      return normalizeEvent(await this.g.request<GEvent>("POST", this.eventUrl(), { sendUpdates, ...(e.meet ? { conferenceDataVersion: 1 } : {}) }, body));
    } catch (err) {
      // The same key already made this event (a concurrent retry), or its cancelled copy still holds the id.
      if (err instanceof GoogleApiError && err.status === 409) {
        const winner = await this.rawEvent(id);
        if (winner.status === "cancelled") throw new Error("A booking made under this request_key was cancelled, so Google keeps its id: nothing was created. Use a new request_key for a new booking");
        return normalizeEvent(winner);
      }
      throw err;
    }
  }

  /**
   * Moves, renames or re-describes an event; attendees are added to and removed from the list Google holds. The change applies
   * only to the version it was checked against (If-Match): `etag` is the one the caller read, else the one just fetched. A
   * move first checks the new time is free.
   */
  async updateEvent(id: string, e: EventInput & { add_attendees?: Attendee[]; remove_attendees?: string[]; etag?: string; allow_conflict?: boolean }, sendUpdates: SendUpdates): Promise<NormalizedEvent> {
    const body: Record<string, unknown> = eventFields(e);
    if (!Object.keys(body).length && !e.add_attendees?.length && !e.remove_attendees?.length) throw new Error("nothing to change: pass a new title, time, description, location or attendees");
    const held = await this.rawEvent(id);
    if (e.etag && held.etag && e.etag !== held.etag) throw new EventChanged();
    // A partial time change is checked as the whole interval it makes with the event's other boundary.
    const [start, end] = [e.start ?? held.start?.dateTime, e.end ?? held.end?.dateTime];
    if ((e.start || e.end) && start && end) await this.assertFree({ start, end, timezone: e.timezone }, held.id, e.allow_conflict);
    if (e.add_attendees?.length || e.remove_attendees?.length) {
      const gone = new Set((e.remove_attendees ?? []).map((a) => a.toLowerCase()));
      // Google left some attendees out of the event it returned (a large event): a PATCH of the list would drop them.
      if (held.attendeesOmitted) throw new Error("Google didn't return this event's full guest list, so attendees can't be changed safely here");
      const kept = (held.attendees ?? []).filter((a) => !gone.has(String(a.email).toLowerCase()));
      const have = new Set(kept.map((a) => String(a.email).toLowerCase()));
      body.attendees = [...kept, ...(e.add_attendees ?? []).filter((a) => !have.has(emailOf(a).toLowerCase())).map(guest)];
    }
    try {
      return normalizeEvent(await this.g.request<GEvent>("PATCH", this.eventUrl(id), { sendUpdates }, body, held.etag));
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 412) throw new EventChanged();
      throw err;
    }
  }

  /** Deletes the event from the calendar; one the owner organises is cancelled for every attendee. */
  async deleteEvent(id: string, sendUpdates: SendUpdates): Promise<{ id: string; deleted: true }> {
    await this.g.request("DELETE", this.eventUrl(id), { sendUpdates });
    return { id, deleted: true };
  }

  /** The owner's own answer to an invite: only his attendee entry changes. */
  async respondToEvent(id: string, response: "accepted" | "declined" | "tentative"): Promise<NormalizedEvent> {
    const self = ((await this.rawEvent(id)).attendees ?? []).find((a) => a.self);
    if (!self) throw new Error("you aren't an attendee of this event (an event you organise needs no answer)");
    // Only the owner's own entry, marked as a partial list, so no other guest is touched.
    const mine = { ...self, responseStatus: response };
    return normalizeEvent(await this.g.request<GEvent>("PATCH", this.eventUrl(id), {}, { attendees: [mine], attendeesOmitted: true }));
  }

  async listFiles(q: string, max = 50): Promise<DriveFile[]> {
    const res = await this.g.get<{ files?: DriveFile[] }>(`${DRIVE}/files`, {
      q,
      pageSize: Math.min(100, max),
      orderBy: "modifiedTime desc",
      fields: "files(id,name,mimeType,modifiedTime,createdTime,version,webViewLink,size,owners(displayName,emailAddress))",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    return res.files ?? [];
  }

  /** One page of files modified at or after `since`, oldest first (src_docs' sync: a cap only delays, never skips). Folders excluded. */
  async changedFiles(since: string, pageToken?: string): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const res = await this.g.get<{ files?: DriveFile[]; nextPageToken?: string }>(`${DRIVE}/files`, {
      q: `modifiedTime >= '${new Date(since).toISOString()}' and mimeType != 'application/vnd.google-apps.folder'`,
      pageSize: 100,
      orderBy: "modifiedTime",
      pageToken,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,version,webViewLink,driveId,parents,trashed,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress))",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    return { files: res.files ?? [], ...(res.nextPageToken ? { nextPageToken: res.nextPageToken } : {}) };
  }

  recentFiles(since: string, max = 50): Promise<DriveFile[]> {
    return this.listFiles(`modifiedTime > '${new Date(since).toISOString()}' and trashed = false`, max);
  }

  /** Google Meet transcripts and Gemini notes modified since a time. */
  meetingDocuments(since: string, nameHints: string[], max = 50): Promise<DriveFile[]> {
    const names = nameHints.map((h) => `name contains '${escapeQ(h)}'`).join(" or ");
    return this.listFiles(
      `modifiedTime > '${new Date(since).toISOString()}' and trashed = false and mimeType = 'application/vnd.google-apps.document' and (${names})`,
      max,
    );
  }

  searchFiles(query: string, max = 25): Promise<DriveFile[]> {
    const q = escapeQ(query);
    return this.listFiles(`trashed = false and (name contains '${q}' or fullText contains '${q}')`, max);
  }

  /**
   * Read a Google Doc with all its tabs (the Drive text export only returns the first tab).
   * Without tab_id: the tab list plus the content of the requested or first tab.
   */
  async readDoc(input: string, tabId?: string, maxChars = 200_000): Promise<{ id: string; title: string; tabs: { id: string; title: string; depth: number }[]; tab: { id: string; title: string; content: string; truncated: boolean } }> {
    const { id, tab: urlTab } = docIdFrom(input);
    let doc: { documentId: string; title: string; tabs?: DocsTab[] };
    try {
      doc = await this.g.get(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}`, { includeTabsContent: true });
    } catch (err) {
      // Docs API not enabled in the Cloud project: fall back to Drive's text export (first tab only).
      if (!/docs\.googleapis\.com|Docs API has not been used|SERVICE_DISABLED/.test(String(err))) throw err;
      const { file, text, truncated } = await this.readFile(id, maxChars);
      return {
        id,
        title: file.name,
        tabs: [{ id: "", title: "(tabs unavailable: enable the Google Docs API for full tab support)", depth: 0 }],
        tab: { id: "", title: "first tab (Drive export)", content: text, truncated },
      };
    }
    const tabs = flattenTabs(doc.tabs);
    const wanted = tabId ?? urlTab;
    const chosen = (wanted && tabs.find((t) => t.id === wanted || t.title.toLowerCase() === wanted.toLowerCase())) || tabs[0];
    const content = chosen ? docsBodyToMarkdown(chosen.tab.documentTab?.body?.content) : "";
    return {
      id: doc.documentId,
      title: doc.title,
      tabs: tabs.map(({ id, title, depth }) => ({ id, title, depth })),
      tab: { id: chosen?.id ?? "", title: chosen?.title ?? "", content: content.slice(0, maxChars), truncated: content.length > maxChars },
    };
  }

  /** Gmail search (Gmail query syntax). Returns message metadata, newest first. */
  async gmailSearch(query: string, max = 20): Promise<Record<string, unknown>[]> {
    const list = await this.g.get<{ messages?: { id: string; threadId: string }[] }>("https://gmail.googleapis.com/gmail/v1/users/me/messages", { q: query, maxResults: Math.min(50, max) });
    const out: Record<string, unknown>[] = [];
    for (const { id } of list.messages ?? []) {
      const full = await this.g.get<GmailMessage>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, { format: "metadata" });
      out.push({
        id: full.id,
        thread_id: full.threadId,
        from: header(full, "From"),
        to: header(full, "To"),
        cc: header(full, "Cc"),
        subject: header(full, "Subject"),
        date: full.internalDate ? new Date(Number(full.internalDate)).toISOString() : header(full, "Date"),
        labels: full.labelIds ?? [],
        snippet: full.snippet,
      });
    }
    return out;
  }

  /**
   * The inbox after `after` (ms), oldest first, category and automated mail dropped and counted (inbox.ts): the newest message
   * of each thread (the owner's own reply included, flagged `replied`), at most `limit` threads. `cursor` is the receipt time
   * everything up to which was read (pass it to the next call once the threads are decided); `more` says threads past the
   * limit wait.
   */
  async gmailInbox(me: string, after: number, limit: number, until = Number.POSITIVE_INFINITY) {
    // The call has a wall-clock budget of its own: a wide window can hold hundreds of messages, and running into the kernel's
    // tool timeout would answer neither threads nor a cursor. Past the budget the rest waits for the next call (`more`).
    // `until` is the deadline the caller set for this account (MultiWorkspace splits one call's budget across its accounts);
    // on its own the call budgets INBOX_BUDGET_MS. The walk takes INBOX_WALK_SHARE of it and the thread enrichment the rest, so
    // neither can starve the other.
    const start = Date.now();
    const finish = Math.min(until, start + INBOX_BUDGET_MS);
    const deadline = Math.min(finish, start + INBOX_BUDGET_MS * INBOX_WALK_SHARE);
    // Every id since the cursor (cheap: 500 a page; the cursor is at most four days back), so the walk below starts at the oldest.
    const ids: string[] = [];
    let pageToken: string | undefined, listedAll = true;
    do {
      // Paging stops at the walk's deadline too: a window that takes more pages than the budget allows is not walked at all
      // (below), because the walk needs the whole listing to serve the oldest mail first and hand back a cursor it can trust.
      if (ids.length && Date.now() >= deadline) {
        listedAll = false;
        break;
      }
      const page = await this.g.get<{ messages?: { id: string }[]; nextPageToken?: string }>(`${GMAIL}/messages`, { q: `${INBOX_QUERY} after:${Math.floor(after / 1000)}`, maxResults: 500, pageToken });
      ids.push(...(page.messages ?? []).map((m) => m.id));
      pageToken = page.nextPageToken;
    } while (pageToken);
    // A partial listing holds only the newest pages: serving them would move the cursor past older mail that was never listed,
    // which no later call could reach. Nothing is served, the cursor stays where it was, and `more` says to call again.
    if (!listedAll) return { threads: [], dropped: {}, cursor: after, more: true };
    const threads = new Map<string, Record<string, unknown>>();
    /** Each kept thread's listed message time: the walk's progress, so a call cut short by the enrichment budget hands back an
     *  honest cursor instead of one past rows it did not serve. */
    const listedAt = new Map<string, number>();
    const dropped: Record<string, number> = {};
    let cursor = after, more = false, reads = 0;
    // Gmail lists newest first: the order below is oldest first, so a call that stops early hands exactly the rest to the next
    // one. Metadata reads overlap (one request each, READS_AT_ONCE in flight), but every message is still decided in that order.
    const order = ids.reverse();
    type Read = { m?: GmailMessage; err?: Error };
    const meta = (id: string): Promise<Read> =>
      this.g.get<GmailMessage>(`${GMAIL}/messages/${encodeURIComponent(id)}`, { format: "metadata" }).then((m) => ({ m }), (err: Error) => ({ err }));
    const inFlight = new Map<number, Promise<Read>>();
    let ahead = 0;
    const fill = (i: number) => {
      while (ahead < order.length && ahead < i + READS_AT_ONCE && Date.now() < deadline) inFlight.set(ahead, meta(order[ahead++]!));
    };
    const read = (i: number) => {
      let p = inFlight.get(i);
      if (!p) inFlight.set(i, (p = meta(order[i]!)));
      return p;
    };
    fill(0);
    for (let i = 0; i < order.length; i++) {
      const { m, err } = await read(i);
      inFlight.delete(i);
      fill(i + 1);
      if (err) {
        if (/^Google API 404:/.test(err.message)) continue; // deleted since the listing
        throw err;
      }
      const at = Number(m!.internalDate ?? 0);
      // `after:` is in whole seconds, so the listing can hold mail at or before the window's start: count it, so a cursor
      // past the mail explains itself instead of looking like an empty inbox. The message exactly at `after` is the one the
      // cursor names (the last one the call that set it decided), so it is skipped without a count: counting it would add a
      // phantom `before-window` on every call.
      if (at < after) {
        dropped["before-window"] = (dropped["before-window"] ?? 0) + 1;
        continue;
      }
      if (at === after) continue;
      const h = (name: string) => header(m!, name);
      // A category comes from this message's own labels: an older promotional message in a thread does not hide the thread.
      const why = category(m!.labelIds) ?? automated(h);
      // A call stops at `limit` threads, MAX_READS messages or the budget, never inside one millisecond (the cursor can't
      // split those: the next call skips the message at the cursor, so an undecided one at that timestamp would be lost).
      // A message that is dropped anyway takes no thread slot, so it is counted instead of ending the call.
      // The budget stops the walk only once this call has decided something (`cursor > after`), so an account whose share of
      // the budget is already spent still makes progress instead of answering nothing with `more: true` forever.
      if (at > cursor && (reads >= MAX_READS || (!why && threads.size >= limit && !threads.has(m!.threadId)) || (Date.now() >= deadline && cursor > after))) {
        more = true;
        break;
      }
      reads++;
      cursor = Math.max(cursor, at);
      if (why) {
        dropped[why] = (dropped[why] ?? 0) + 1;
        continue;
      }
      threads.delete(m!.threadId); // re-inserted: the map stays in arrival order of each thread's newest message
      threads.set(m!.threadId, { thread_id: m!.threadId, id: m!.id, from: h("From"), to: h("To"), cc: h("Cc"), subject: h("Subject"), date: new Date(at).toISOString(), cc_only: ccOnly(me, h("To"), h("Cc")), snippet: m!.snippet, replied: false });
      listedAt.set(m!.threadId, at);
    }
    // The listing holds inbox mail only: a reply the owner sent carries SENT, not INBOX, so it never appears and a thread
    // the owner already answered would still show the other party's message as its newest. Read each kept thread (metadata
    // only) and let its newest message, whoever sent it, be the row; `replied` marks the owner's own. The reads overlap,
    // READS_AT_ONCE at a time, so a page of kept threads costs a few round trips rather than one each in turn.
    const rows = [...threads];
    const fetched = new Map<string, { t?: { messages?: GmailMessage[] }; err?: Error }>();
    // Enrichment is bounded by `limit` and by the rest of the call's budget. A batch that would start past it is not read at
    // all: its rows are dropped and the cursor goes back to the last row actually served, with `more: true`, so a row is never
    // served with a `replied` the call did not read and never lost behind a cursor that already passed it.
    const fetchRows = async (from: number, to: number) => {
      await Promise.all(
        rows.slice(from, to).map(async ([threadId]) => {
          const r = await this.g.get<{ messages?: GmailMessage[] }>(`${GMAIL}/threads/${encodeURIComponent(threadId)}`, { format: "metadata" }).then((t) => ({ t }), (err: Error) => ({ err }));
          fetched.set(threadId, r);
        }),
      );
    };
    let enriched = rows.length;
    for (let i = 0; i < rows.length; i += READS_AT_ONCE) {
      let end = Math.min(i + READS_AT_ONCE, rows.length);
      if (i > 0 && Date.now() >= finish) {
        // The stop must not split a millisecond: the cursor cannot, so every row tied with the last served one is read and
        // served too (at most `limit` rows in all, a few extra batches, still inside the tool timeout).
        const tied = listedAt.get(rows[i - 1]![0]);
        end = i;
        while (end < rows.length && listedAt.get(rows[end]![0]) === tied) end++;
        enriched = end;
      }
      await fetchRows(i, end);
      if (enriched < rows.length) break;
    }
    if (enriched < rows.length) {
      const kept = Math.max(after, ...rows.slice(0, enriched).map(([threadId]) => listedAt.get(threadId) ?? after));
      for (const [threadId] of rows.slice(enriched)) threads.delete(threadId);
      rows.length = enriched;
      // Rows are left over, so the next call has work: `more` says so whether or not the cursor moved back (the tie extension
      // above can leave the last served row at the cursor itself).
      cursor = Math.min(cursor, kept);
      more = true;
    }
    for (const [threadId, row] of rows) {
      const { t, err } = fetched.get(threadId) ?? {};
      if (err) {
        if (/^Google API 404:/.test(err.message)) continue; // deleted since the listing
        throw err;
      }
      // Category and automated mail stays set aside here too: the row is the newest message a person sent (the owner's own
      // included). A thread is kept when its listed message was not categorised, even if an older message in it was.
      const person = (x: GmailMessage) => (x.labelIds ?? []).includes("SENT") || (!category(x.labelIds) && !automated((name) => header(x, name)));
      const newest = (t?.messages ?? []).filter(person).reduce<GmailMessage | undefined>((last, x) => (!last || Number(x.internalDate ?? 0) >= Number(last.internalDate ?? 0) ? x : last), undefined);
      if (!newest) continue;
      const h = (name: string) => header(newest, name);
      const at = Number(newest.internalDate ?? 0);
      threads.set(threadId, {
        ...row,
        id: newest.id,
        from: h("From"),
        to: h("To"),
        cc: h("Cc"),
        subject: h("Subject") ?? row.subject,
        date: at ? new Date(at).toISOString() : row.date,
        cc_only: ccOnly(me, h("To"), h("Cc")),
        snippet: newest.snippet,
        replied: (newest.labelIds ?? []).includes("SENT"),
      });
    }
    return { threads: [...threads.values()], dropped, cursor, more };
  }

  /** A whole thread as text, oldest first; message bodies truncated. */
  async gmailThread(id: string, maxCharsPerMessage = 6000): Promise<Record<string, unknown>> {
    const t = await this.g.get<{ id: string; messages?: GmailMessage[] }>(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}`, { format: "full" });
    const profile = await this.g.get<{ emailAddress: string }>("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    return {
      thread_id: t.id,
      me: profile.emailAddress,
      messages: (t.messages ?? []).map((m) => {
        const text = messageText(m.payload);
        return {
          id: m.id,
          from: header(m, "From"),
          to: header(m, "To"),
          cc: header(m, "Cc"),
          subject: header(m, "Subject"),
          date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m, "Date"),
          labels: m.labelIds ?? [],
          from_me: (m.labelIds ?? []).includes("SENT"),
          attachments: attachments(m.payload),
          text: text.slice(0, maxCharsPerMessage),
          truncated: text.length > maxCharsPerMessage,
        };
      }),
    };
  }

  // -------------------------------------------------------------- Gmail writes (drafts and sends reviewed; labels upkeep)

  /** A new message, or a reply in `thread_id` (threaded by Gmail and by the recipient's mail client). */
  private async outgoing(m: MailInput): Promise<{ raw: string; threadId?: string }> {
    let reply: { inReplyTo?: string; references?: string; subject?: string } = {};
    if (m.thread_id) {
      const t = await this.g.get<{ messages?: GmailMessage[] }>(`${GMAIL}/threads/${encodeURIComponent(m.thread_id)}`, { format: "metadata" });
      const last = t.messages?.at(-1);
      if (!last) throw new Error(`thread ${m.thread_id} has no messages`);
      const id = header(last, "Message-ID");
      reply = { inReplyTo: id, references: [header(last, "References"), id].filter(Boolean).join(" ") || undefined, subject: header(last, "Subject") };
    }
    // Gmail keeps a reply in its thread only when the subject matches, so a reply always takes the thread's own.
    if (m.thread_id && m.subject !== undefined) throw new Error("a reply keeps the thread's subject: leave subject out (or start a new message without thread_id)");
    // A thread whose last message has no subject has nothing to match: refused rather than sent outside the thread.
    if (m.thread_id && !reply.subject) throw new Error(`thread ${m.thread_id}'s last message has no subject, so a reply can't be kept in it: send a new message instead`);
    const subject = m.thread_id ? (/^re:/i.test(reply.subject!) ? reply.subject! : `Re: ${reply.subject}`) : m.subject;
    if (subject === undefined) throw new Error("a new message needs a subject");
    return { raw: mimeMessage({ to: m.to, cc: m.cc, bcc: m.bcc, subject, body: m.body, inReplyTo: reply.inReplyTo, references: reply.references }), ...(m.thread_id ? { threadId: m.thread_id } : {}) };
  }

  async gmailDraft(m: MailInput): Promise<{ draft_id: string; message_id: string; thread_id: string }> {
    const d = await this.g.request<{ id: string; message: { id: string; threadId: string } }>("POST", `${GMAIL}/drafts`, {}, { message: await this.outgoing(m) });
    return { draft_id: d.id, message_id: d.message.id, thread_id: d.message.threadId };
  }

  async gmailSend(m: MailInput): Promise<{ message_id: string; thread_id: string }> {
    const sent = await this.g.request<{ id: string; threadId: string }>("POST", `${GMAIL}/messages/send`, {}, await this.outgoing(m));
    return { message_id: sent.id, thread_id: sent.threadId };
  }

  /**
   * Adds and removes the mailbox's own labels on a thread, by name. Only user labels that already exist: system labels (INBOX,
   * UNREAD, TRASH, SPAM, ...) are never matched, and none is created, so this can't archive, trash or hide mail.
   */
  async gmailLabel(threadId: string, add: string[], remove: string[]): Promise<{ thread_id: string; added: string[]; removed: string[] }> {
    const { labels = [] } = await this.g.get<{ labels?: { id: string; name: string; type?: string }[] }>(`${GMAIL}/labels`);
    const own = new Map(labels.filter((l) => l.type === "user").map((l) => [l.name.toLowerCase(), l.id]));
    const ids = (names: string[]) =>
      names.map((n) => own.get(n.toLowerCase()) ?? (() => { throw new Error(`no label of yours is named "${n}": only your own existing labels can be changed, never system ones (Inbox, Unread, Trash, Spam)`); })());
    if (!add.length && !remove.length) throw new Error("nothing to change: name a label to add or remove");
    await this.g.request("POST", `${GMAIL}/threads/${encodeURIComponent(threadId)}/modify`, {}, { addLabelIds: ids(add), removeLabelIds: ids(remove) });
    return { thread_id: threadId, added: add, removed: remove };
  }

  async readFile(id: string, maxChars = 400_000): Promise<{ file: DriveFile; text: string; truncated: boolean }> {
    const file = await this.g.get<DriveFile>(`${DRIVE}/files/${encodeURIComponent(id)}`, {
      fields: "id,name,mimeType,modifiedTime,createdTime,version,webViewLink,size",
      supportsAllDrives: true,
    });
    let result: { text: string; truncated: boolean };
    if (file.mimeType === "application/vnd.google-apps.document" || file.mimeType === "application/vnd.google-apps.presentation") {
      result = await this.g.getText(`${DRIVE}/files/${encodeURIComponent(id)}/export`, { mimeType: "text/plain" });
    } else if (file.mimeType?.startsWith("text/") || file.mimeType === "application/json") {
      result = await this.g.getText(`${DRIVE}/files/${encodeURIComponent(id)}`, { alt: "media", supportsAllDrives: "true" });
    } else {
      throw new Error(`Unsupported file type ${file.mimeType}; only Google Docs, Slides and text files can be read`);
    }
    return { file, text: result.text.slice(0, maxChars), truncated: result.truncated || result.text.length > maxChars };
  }
}

// ---------------------------------------------------------------- Gmail

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** A message an agent writes: plain text, to named addresses; `thread_id` makes it a reply there. */
export interface MailInput { to: string[]; cc?: string[]; bcc?: string[]; subject?: string; body: string; thread_id?: string }

const FOLD = "\r\n ";
/** Refused if it could end the header (CR or LF). */
function oneLine(name: string, v: string): string {
  if (/[\r\n]/.test(v)) throw new Error(`${name} can't contain a line break`);
  return v;
}
/** Text as RFC 2047 encoded words when not ASCII: whole characters, at most 45 bytes each (under the 75-character word limit), folded. */
function encoded(v: string): string {
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words: string[] = [];
  let cur = "";
  for (const ch of v) {
    if (Buffer.byteLength(cur + ch) > 45) (words.push(cur), (cur = ""));
    cur += ch;
  }
  words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(FOLD);
}

/** The RFC 2822 message Gmail's API takes (`raw`, base64url): plain text, UTF-8. Gmail sets From to the signed-in account. */
export function mimeMessage(m: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; inReplyTo?: string; references?: string }): string {
  // Long headers are folded (a line break then a space) so no line passes the 998-character limit.
  const list = (name: string, xs: string[]) => xs.map((x) => oneLine(name, x)).join(`,${FOLD}`);
  const lines = [
    `To: ${list("To", m.to)}`,
    ...(m.cc?.length ? [`Cc: ${list("Cc", m.cc)}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${list("Bcc", m.bcc)}`] : []),
    `Subject: ${encoded(oneLine("Subject", m.subject))}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine("In-Reply-To", m.inReplyTo)}`] : []),
    ...(m.references ? [`References: ${oneLine("References", m.references).split(/(?<=>)\s+(?=<)/).join(FOLD)}`] : []),
  ];
  const body = Buffer.from(m.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const text = [...lines, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body].join("\r\n");
  return Buffer.from(text, "utf8").toString("base64url");
}

interface GmailPart { mimeType?: string; filename?: string; body?: { data?: string; size?: number }; parts?: GmailPart[]; headers?: { name: string; value: string }[] }
interface GmailMessage { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: GmailPart }

const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

const b64url = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** Plain-text body of a message: text/plain preferred, else HTML with tags stripped. */
export function messageText(part: GmailPart | undefined): string {
  if (!part) return "";
  const walk = (p: GmailPart, type: string): string | undefined => {
    if (p.mimeType === type && p.body?.data) return b64url(p.body.data);
    for (const c of p.parts ?? []) {
      const t = walk(c, type);
      if (t) return t;
    }
    return undefined;
  };
  const plain = walk(part, "text/plain");
  if (plain) return plain;
  const html = walk(part, "text/html");
  return html ? html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n") : "";
}

function attachments(part: GmailPart | undefined): string[] {
  const out: string[] = [];
  const walk = (p: GmailPart) => {
    if (p.filename) out.push(p.filename);
    for (const c of p.parts ?? []) walk(c);
  };
  if (part) walk(part);
  return out;
}

// ---------------------------------------------------------------- Google Docs (tabs)

interface DocsTextRun { content?: string }
interface DocsElement { textRun?: DocsTextRun }
interface DocsParagraph { elements?: DocsElement[]; paragraphStyle?: { namedStyleType?: string }; bullet?: { nestingLevel?: number } }
interface DocsStructural { paragraph?: DocsParagraph; table?: { tableRows?: { tableCells?: { content?: DocsStructural[] }[] }[] } }
interface DocsTab { tabProperties?: { tabId?: string; title?: string }; documentTab?: { body?: { content?: DocsStructural[] } }; childTabs?: DocsTab[] }

function paragraphText(p: DocsParagraph): string {
  return (p.elements ?? []).map((e) => e.textRun?.content ?? "").join("").replace(/\n$/, "");
}

/** Render a Docs body as light markdown: headings, bullets, tables as pipe rows. */
export function docsBodyToMarkdown(content: DocsStructural[] = []): string {
  const out: string[] = [];
  for (const s of content) {
    if (s.paragraph) {
      const text = paragraphText(s.paragraph);
      const style = s.paragraph.paragraphStyle?.namedStyleType ?? "";
      const h = /^HEADING_(\d)$/.exec(style)?.[1] ?? (style === "TITLE" ? "1" : undefined);
      if (h && text.trim()) out.push(`${"#".repeat(Math.min(6, Number(h)))} ${text.trim()}`);
      else if (s.paragraph.bullet) out.push(`${"  ".repeat(s.paragraph.bullet.nestingLevel ?? 0)}- ${text}`);
      else out.push(text);
    } else if (s.table) {
      for (const row of s.table.tableRows ?? []) {
        out.push(`| ${(row.tableCells ?? []).map((c) => docsBodyToMarkdown(c.content).replace(/\n+/g, " ").trim()).join(" | ")} |`);
      }
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function flattenTabs(tabs: DocsTab[] = [], depth = 0): { id: string; title: string; depth: number; tab: DocsTab }[] {
  return tabs.flatMap((t) => [{ id: t.tabProperties?.tabId ?? "", title: t.tabProperties?.title ?? "", depth, tab: t }, ...flattenTabs(t.childTabs, depth + 1)]);
}

export function docIdFrom(input: string): { id: string; tab?: string } {
  const id = /\/document\/d\/([A-Za-z0-9_-]+)/.exec(input)?.[1] ?? input.trim();
  const tab = /[?&#]tab=([A-Za-z0-9._-]+)/.exec(input)?.[1];
  return { id, tab };
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  createdTime?: string;
  version?: string;
  webViewLink?: string;
  size?: string;
  owners?: { displayName?: string; emailAddress?: string }[];
  driveId?: string;
  parents?: string[];
  trashed?: boolean;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
}

function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
