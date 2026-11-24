import { readFileSync } from "node:fs";
import { needsOwner } from "./aidenhq-sdk/needs.js";
import { type AuthStatus, GoogleAuthError, GoogleClient, type StoredCredentials, WRITE_SCOPE } from "./google.js";
import { type DriveFile, type EventInput, type MailInput, type NormalizedEvent, type SendUpdates, Workspace } from "./workspace.js";

/**
 * Credentials file, multi-account:
 *   { client_id, client_secret, primary: "me@work.com",
 *     accounts: { "me@work.com": { refresh_token, scopes, client_id?, client_secret? }, … } }
 * The legacy single-account shape { client_id, client_secret, refresh_token } is accepted too.
 */
export interface CredentialsFile {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  primary?: string;
  accounts?: Record<string, Partial<StoredCredentials>>;
}

const fileText = (path: string | undefined) => {
  try {
    return path ? readFileSync(path, "utf8").trim() : "";
  } catch {
    return "";
  }
};

/**
 * The credentials file, with the client the owner pasted on the board (the google_client_id and google_client_secret
 * secrets) over the one in the file. With those empty, the file's own client stands: instances set up before the guided flow.
 * `forWrite` returns the file as stored, so the pasted secret is never copied into it.
 */
export function readCredentials(path: string, forWrite = false): CredentialsFile {
  let raw: CredentialsFile = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as CredentialsFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const id = fileText(process.env.GOOGLE_CLIENT_ID_FILE);
  if (forWrite || !id) return raw;
  // A sign-in made now stamps its account with the client it used (Reconnect.finish), so a client pasted later leaves it alone.
  return { ...raw, client_id: id, client_secret: fileText(process.env.GOOGLE_CLIENT_SECRET_FILE) || undefined };
}

/** The account's sign-in lacks the scope a write needs (connected before Google writes, or unticked at consent): a reconnect grants it. */
export class ScopeMissing extends Error {
  constructor(readonly scope: string, readonly account: string) {
    super(`Google (${account}) hasn't allowed ${scope === WRITE_SCOPE.calendar ? "calendar changes" : "Gmail drafts, sends and labels"} yet: the owner reconnects Google once to grant it`);
  }
}

/** No account connected yet: Google isn't set up, which differs from a credentials file that won't load. */
export class NoGoogleAccounts extends GoogleAuthError {}

/**
 * The /healthz answer. Without an account, `state: "missing"` (not set up yet), which the apply's live agent check notes
 * rather than fails; any other load error is a plain failure.
 */
export function healthBody(ready: boolean, err?: unknown): { ok: boolean; state?: "missing"; detail?: string } {
  if (ready) return { ok: true };
  return { ok: false, ...(err instanceof NoGoogleAccounts ? { state: "missing" as const } : {}), detail: err instanceof Error ? err.message : undefined };
}

/**
 * A tool's failure as the agent's MCP client gets it: what only the owner can fix (no account, a sign-in Google refused) is the
 * needs_owner answer (needs.ts), which the kernel routes; anything else is a plain error. `loaded`: false when no accounts could be
 * loaded at all (`err` is why).
 */
export function toolFailure(err: unknown, loaded = true, account?: string): { isError: true; content: { type: "text"; text: string }[] } {
  const msg = err instanceof Error ? err.message.slice(0, 300) : "";
  const who = (err instanceof GoogleAuthError ? err.account : undefined) ?? account;
  if (!loaded || err instanceof NoGoogleAccounts) return needsOwner({ cause: "not_connected", detail: `Google isn't connected${msg ? `: ${msg}` : ""}`, ...(who ? { account: who } : {}) });
  if (err instanceof ScopeMissing) return needsOwner({ cause: "scope", scope: err.scope, detail: err.message, account: err.account });
  if (err instanceof GoogleAuthError && err.expired) return needsOwner({ cause: "expired", detail: `Google's sign-in stopped working: ${msg}`, ...(who ? { account: who } : {}) });
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "google_api_error", detail: msg }) }] };
}

/**
 * The account a successful answer names (needs.ts SIGNED_IN): the result's own (a read that found its data in another
 * account), else the call's. A sweep: the `served` accounts on the rows (or on a wrapper's `messages`) decide —
 * undefined when every account of several answered (the whole connection is proved), the one that did, null for a mix or
 * none, so a failed account's sign-in never clears behind a working one's.
 */
export function servedBy(account: string | undefined, result: unknown, all?: number): string | null | undefined {
  const r = (result && typeof result === "object" ? result : {}) as { account?: unknown; served?: unknown; messages?: { served?: unknown } };
  if (all !== undefined) {
    const s = r.served ?? r.messages?.served;
    const served = Array.isArray(s) ? (s as string[]) : [];
    return served.length === all && all > 1 ? undefined : served.length === 1 ? served[0] : null;
  }
  // A single read is tagged by firstThat, a list's rows (or the list) by the account that made it.
  const own = Array.isArray(r) ? (r[0] as { account?: unknown } | undefined)?.account : r.account;
  return typeof own === "string" && own ? own : account;
}

export type Check = { ok: true } | { ok: false; message: string; fix?: string };

/** The board's Test: one live Calendar read on the primary account (a refresh and an API call), answered in words. */
export async function checkGoogle(ws: { listEvents(start: string, end: string, query?: string, max?: number): Promise<unknown> } | undefined, err?: unknown): Promise<Check> {
  if (!ws) return { ok: false, message: err instanceof NoGoogleAccounts ? "No Google account is connected." : "Google isn't available.", ...(err instanceof NoGoogleAccounts ? { fix: "Connect" } : {}) };
  const now = Date.now();
  try {
    await ws.listEvents(new Date(now).toISOString(), new Date(now + 3_600_000).toISOString(), undefined, 1); // timeMax must exceed timeMin
    return { ok: true };
  } catch (e) {
    return e instanceof GoogleAuthError
      ? { ok: false, message: "Google no longer accepts the sign-in.", fix: "Reconnect" }
      : { ok: false, message: `Google didn't answer: ${(e as Error).message.slice(0, 200)}` };
  }
}

export function loadAccounts(path: string): { primary: string; accounts: Map<string, StoredCredentials> } {
  const raw = readCredentials(path);
  const accounts = new Map<string, StoredCredentials>();
  for (const [email, a] of Object.entries(raw.accounts ?? {})) {
    const client_id = a.client_id ?? raw.client_id;
    if (!client_id || !a.refresh_token) continue;
    accounts.set(email, { client_id, client_secret: a.client_id ? a.client_secret : raw.client_secret, refresh_token: a.refresh_token, scopes: a.scopes });
  }
  if (!accounts.size && raw.client_id && raw.refresh_token) {
    accounts.set("default", { client_id: raw.client_id, client_secret: raw.client_secret, refresh_token: raw.refresh_token });
  }
  if (!accounts.size) throw new NoGoogleAccounts(`no Google accounts in ${path} (run scripts/google-auth.sh)`);
  const primary = raw.primary && accounts.has(raw.primary) ? raw.primary : [...accounts.keys()][0]!;
  return { primary, accounts };
}

/** Gmail web link that opens in the right account (`u/0` is whichever account signed in first). */
export function gmailLink(threadId: string, account: string): string {
  const user = account.includes("@") ? encodeURIComponent(account) : "0";
  return `https://mail.google.com/mail/u/${user}/#all/${encodeURIComponent(threadId)}`;
}

const notFound = (err: unknown) => /\b(404|403)\b|not found|notFound|insufficient/i.test(String(err));

/**
 * One facade over several Google accounts.
 * Calendar and meeting documents: the primary account (where meetings live) unless `account` is given.
 * Gmail and Drive search: all accounts, each result tagged with its account.
 * Reading a thread/file/doc: the given account, else each account in turn until one has it.
 */
export class MultiWorkspace {
  readonly primary: string;
  private readonly ws = new Map<string, Workspace>();
  private readonly clients = new Map<string, GoogleClient>();
  /** Each account's granted scopes, as stored at its sign-in. */
  private readonly scopes = new Map<string, string[]>();

  constructor(path: string, calendarId = "primary", fetchImpl: typeof fetch = fetch) {
    const { primary, accounts } = loadAccounts(path);
    this.primary = primary;
    for (const [email, creds] of accounts) {
      const client = new GoogleClient(creds, fetchImpl);
      this.clients.set(email, client);
      this.scopes.set(email, creds.scopes ?? []);
      this.ws.set(email, new Workspace(client, calendarId));
    }
  }

  accounts(): string[] {
    return [...this.ws.keys()];
  }

  /**
   * Each account's sign-in, as of its last token refresh. `missing`: the write scopes its sign-in lacks (connected before Google
   * writes): reads work, and the board asks for one reconnect.
   */
  authStatus(): (AuthStatus & { email: string; primary: boolean; missing?: string[] })[] {
    return [...this.clients].map(([email, c]) => {
      const missing = Object.values(WRITE_SCOPE).filter((s) => !this.granted(email, s));
      return { email, primary: email === this.primary, ...c.authStatus(), ...(missing.length ? { missing } : {}) };
    });
  }

  private granted(account: string, scope: string): boolean {
    return (this.scopes.get(account) ?? []).includes(`https://www.googleapis.com/auth/${scope}`);
  }

  /** Refreshes every account's token now (see GoogleClient.checkAuth). */
  async checkAuth() {
    await Promise.all([...this.clients.values()].map((c) => c.checkAuth()));
    return this.authStatus();
  }

  private one(account?: string): [string, Workspace] {
    const name = account ?? this.primary;
    const w = this.ws.get(name);
    if (!w) throw new Error(`unknown account ${name} (known: ${this.accounts().join(", ")})`);
    return [name, w];
  }

  /** Runs one account's call, naming the account on a refused sign-in so the need knows whose it is. */
  private async in(name: string, fn: (w: Workspace) => Promise<unknown>): Promise<unknown> {
    try {
      return await fn(this.ws.get(name)!);
    } catch (err) {
      if (err instanceof GoogleAuthError && err.account === undefined) err.account = name;
      throw err;
    }
  }

  private order(account?: string): [string, Workspace][] {
    if (account) return [this.one(account)];
    return [this.one(), ...[...this.ws].filter(([n]) => n !== this.primary)];
  }

  private async firstThat<T>(account: string | undefined, fn: (w: Workspace) => Promise<T>): Promise<T & { account: string }> {
    let last: unknown;
    for (const [name, w] of this.order(account)) {
      try {
        return { ...((await this.in(name, fn)) as T), account: name };
      } catch (err) {
        if (!notFound(err)) throw err;
        last = err;
      }
    }
    throw last ?? new Error("not found in any account");
  }

  async listEvents(start: string, end: string, query?: string, max = 100, account?: string): Promise<(NormalizedEvent & { account: string })[]> {
    const [name, w] = this.one(account);
    return ((await this.in(name, (x) => x.listEvents(start, end, query, max))) as NormalizedEvent[]).map((e) => ({ ...e, account: name }));
  }

  async getEvent(id: string, account?: string) {
    return this.firstThat(account, (w) => w.getEvent(id));
  }

  async meetingDocuments(since: string, hints: string[], max = 50, account?: string) {
    const [name, w] = this.one(account);
    return ((await this.in(name, (x) => x.meetingDocuments(since, hints, max))) as DriveFile[]).map((f) => ({ ...f, account: name }));
  }

  /** Each account's rows; `served` lists the accounts that answered (an empty answer still proves its sign-in). */
  private async all<T>(account: string | undefined, fn: (w: Workspace) => Promise<T[]>): Promise<(T & { account: string })[] & { served: string[] }> {
    const out: (T & { account: string })[] = [], served: string[] = [];
    for (const [name, w] of account ? [this.one(account)] : [...this.ws]) {
      try {
        out.push(...((await this.in(name, fn)) as T[]).map((x) => ({ ...x, account: name })));
        served.push(name);
      } catch (err) {
        out.push({ account: name, error: String((err as Error).message).slice(0, 200) } as unknown as T & { account: string });
      }
    }
    return Object.assign(out, { served });
  }

  recentFiles(since: string, max = 50, account?: string) {
    return this.all(account, (w) => w.recentFiles(since, max));
  }

  searchFiles(query: string, max = 25, account?: string) {
    return this.all(account, (w) => w.searchFiles(query, max));
  }

  /** src_docs' sync: one account's changed files (the primary unless given). */
  changedFiles(since: string, pageToken?: string, account?: string) {
    return this.one(account)[1].changedFiles(since, pageToken);
  }

  readFile(id: string, maxChars?: number, account?: string) {
    return this.firstThat(account, (w) => w.readFile(id, maxChars));
  }

  readDoc(input: string, tabId?: string, maxChars?: number, account?: string) {
    return this.firstThat(account, (w) => w.readDoc(input, tabId, maxChars));
  }

  async gmailSearch(query: string, max = 20, account?: string) {
    const found = await this.all(account, (w) => w.gmailSearch(query, max));
    const results = found.map((m) => (typeof m.thread_id === "string" ? { ...m, link: gmailLink(m.thread_id, m.account) } : m));
    return Object.assign(results.sort((a, b) => String((b as Record<string, unknown>).date ?? "").localeCompare(String((a as Record<string, unknown>).date ?? ""))), { served: found.served });
  }

  /**
   * One write, on exactly one account (the primary unless given): refused before any call when that account's sign-in lacks
   * `scope` (ScopeMissing, the owner's reconnect).
   */
  private write<T>(account: string | undefined, scope: string, fn: (w: Workspace) => Promise<T>): Promise<T & { account: string }> {
    const [name] = this.one(account);
    if (!this.granted(name, scope)) return Promise.reject(new ScopeMissing(scope, name));
    return this.in(name, fn).then((r) => ({ ...(r as T), account: name }));
  }

  createEvent(e: EventInput & { attendees?: string[]; meet?: boolean }, sendUpdates: SendUpdates, account?: string) {
    return this.write(account, WRITE_SCOPE.calendar, (w) => w.createEvent(e, sendUpdates));
  }

  updateEvent(id: string, e: EventInput & { add_attendees?: string[]; remove_attendees?: string[] }, sendUpdates: SendUpdates, account?: string) {
    return this.write(account, WRITE_SCOPE.calendar, (w) => w.updateEvent(id, e, sendUpdates));
  }

  deleteEvent(id: string, sendUpdates: SendUpdates, account?: string) {
    return this.write(account, WRITE_SCOPE.calendar, (w) => w.deleteEvent(id, sendUpdates));
  }

  respondToEvent(id: string, response: "accepted" | "declined" | "tentative", account?: string) {
    return this.write(account, WRITE_SCOPE.calendar, (w) => w.respondToEvent(id, response));
  }

  async gmailDraft(m: MailInput, account?: string) {
    const d = await this.write(account, WRITE_SCOPE.gmail, (w) => w.gmailDraft(m));
    return { ...d, link: gmailLink(d.thread_id, d.account) };
  }

  async gmailSend(m: MailInput, account?: string) {
    const s = await this.write(account, WRITE_SCOPE.gmail, (w) => w.gmailSend(m));
    return { ...s, link: gmailLink(s.thread_id, s.account) };
  }

  gmailLabel(threadId: string, add: string[], remove: string[], account?: string) {
    return this.write(account, WRITE_SCOPE.gmail, (w) => w.gmailLabel(threadId, add, remove));
  }

  async gmailThread(id: string, maxChars?: number, account?: string) {
    const t = await this.firstThat(account, (w) => w.gmailThread(id, maxChars));
    return { ...t, link: gmailLink(String(t.id ?? id), t.account) };
  }
}
