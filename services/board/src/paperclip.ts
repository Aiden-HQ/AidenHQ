import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { paperclipClient, PaperclipError } from "./aidenhq-sdk/paperclip.js";

export { PaperclipError };

/**
 * The Paperclip REST calls the board makes, as the owner, all through the kernel (kernel/src/cp.ts createBoardCp): reads at
 * /v1/cp/read/<path>, writes at /v1/cp/owner/<path>, with the board's key on the kernel. The board holds no Paperclip key.
 */

/** The signed-in admin a write is for (app.ts sets it per request); sent to the kernel, which logs it with the write. */
export const actingAccount = new AsyncLocalStorage<string>();
/** Set while the board posts the user's own typed words: the kernel then leaves the comment unmarked (kernel cplimit.ts markCode). */
const typedWords = new AsyncLocalStorage<true>();

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Agent {
  id: string;
  companyId?: string;
  name: string;
  /** The agent's one-line routing description (setup writes it from the agent definition). */
  title?: string | null;
  status: string;
  /** Paperclip's lifecycle holds (manual, setup, budget, company archived): what makes an agent paused (aidenhq-sdk/agent-paused.ts). */
  lifecycleHolds?: string[];
  /** The agent it reports to (the org chart). */
  reportsTo?: string | null;
  metadata?: { setupKey?: string; module?: unknown; tier?: unknown; model?: unknown; models?: unknown; avatar?: unknown; runnerEngine?: unknown; engine?: unknown; profile?: unknown; department?: unknown; team?: unknown; memberOf?: unknown; maxParallel?: unknown } | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  descriptionTruncated?: boolean;
  status: string;
  priority: string;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  assigneeAdapterOverrides: { adapterConfig?: Record<string, unknown> } | null;
  labels?: Label[];
  labelIds?: string[];
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  createdByUserId?: string | null;
  createdByAgentId?: string | null;
  projectId?: string | null;
  /** The task this one is a sub-task of: an agent's work on the user's task. */
  parentId?: string | null;
  /** The first-class blockers it waits on while `blocked` (single-issue reads; a list row may leave them out). */
  blockedBy?: { id: string; identifier?: string | null; status: string; updatedAt?: string; completedAt?: string | null; cancelledAt?: string | null }[];
  /** "routine_execution" for a routine's run task. */
  originKind?: string | null;
  /** Paperclip's execution policy; a scheduled monitor is its persisted review path. */
  executionPolicy?: Record<string, unknown> | null;
}

/** Paperclip's own approval: the board mirrors an open kernel card as one so its wait is counted (mirror.ts). */
export interface PaperclipApproval {
  id: string;
  type: string;
  status: string;
  /** Set to the filing user when the board's key files it: what makes an approval the board's own (mirror.ts). */
  requestedByUserId?: string | null;
  requestedByAgentId?: string | null;
  payload?: { [k: string]: unknown } | null;
}

export interface Routine {
  id: string;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
  lastTriggeredAt?: string | null;
  triggers?: { id?: string; kind?: string; enabled?: boolean; label?: string | null; cronExpression?: string | null; timezone?: string | null; nextRunAt?: string | null; lastFiredAt?: string | null }[];
}

export interface Comment {
  id: string;
  body: string;
  authorType: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdByRunId?: string | null;
  createdAt: string;
  deletedAt?: string | null;
}

/** A file on a task (Paperclip stores it; the board uploads the user's). */
export interface Attachment {
  id: string;
  issueId: string;
  originalFilename: string | null;
  contentType: string;
  byteSize: number;
  createdAt: string;
  createdByUserId?: string | null;
  createdByAgentId?: string | null;
}

export const OPEN = "backlog,todo,in_progress,in_review,blocked";
/** A paged list read stops here: past it the board says it shows only the newest (`incomplete`). */
export const LIST_BOUND = 2000;
const PAGE = 500;

/** A company project (read-only: the board's Project filter). */
export interface Project {
  id: string;
  name: string;
}
const ProjectsSchema = z.array(z.object({ id: z.string().min(1), name: z.string() }).loose());

/** A paged list: every row up to LIST_BOUND, and whether the bound cut it short. */
export interface Listed {
  issues: Issue[];
  incomplete: boolean;
}

/** The closed issues the snapshot keeps: those updated in the last 48 hours (the board's Done window). */
export const CLOSED_WINDOW_MS = 48 * 3_600_000;
/** A read reaches the snapshot as it is for this long; then one incremental read (`changedSince`) brings it up to date. */
const SNAP_FRESH_MS = 4_000;
/** The full inventory is read again this often (an issue deleted in Paperclip leaves no change row). */
const SNAP_FULL_MS = 5 * 60_000;
/** An incremental read reaches back this far past the newest change seen, so a write that commits late isn't missed. */
const SNAP_OVERLAP_MS = 5_000;
/** `changedSince` returns at most this many rows: a full page may be a cut-short burst, so the snapshot is read in full. */
const CHANGED_LIMIT = 200;
const CLOSED = new Set(["done", "cancelled"]);

/** The company's open issues and its recent closed ones, kept in memory and brought up to date from `changedSince`. */
interface Snapshot {
  open: Map<string, Issue>;
  closed: Map<string, Issue>;
  incomplete: { open: boolean; closed: boolean };
  /** Every change before this (ms) is in the snapshot: where the next incremental read starts. */
  through: number;
  fullAt: number;
  syncedAt: number;
  /** The board's writes (Paperclip.writes) before the last sync began: a later write makes the next read look again at once. */
  syncedWrites: number;
}

export class Paperclip {
  private cache = new Map<string, { at: number; value: Promise<unknown>; done: boolean }>();
  private snap: Snapshot | undefined;
  private syncing: Promise<void> | undefined;
  /** Counts the board's writes, at their start and at their end (a read that began before either may not show the write). */
  private writes = 0;

  private readonly client;

  /** `kernelUrl`: the kernel's backplane; `key`: the board's key on it (gateway_board_key). */
  constructor(kernelUrl: string, readonly companyId: string, key: string, fetchImpl: typeof fetch = fetch) {
    this.client = paperclipClient({ url: kernelUrl, token: key, lane: "owner", fetcher: fetchImpl, headers: (method): Record<string, string> => { const account = actingAccount.getStore(); return { ...(account && method !== "GET" ? { "x-aidenhq-account": account } : {}), ...(typedWords.getStore() ? { "x-aidenhq-typed": "owner" } : {}) }; } });
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // A write may change the open tasks: a read that starts after it never shares one already on its way.
    if (method !== "GET") {
      this.writes++;
      if (/\/routine/.test(path)) this.cache.delete("routines");
    }
    if (method === "GET") return this.client.request<T>(method, path, body || undefined);
    return this.client.request<T>(method, path, body || undefined).finally(() => void this.writes++);
  }

  /**
   * `load`, kept for `ttlMs` after it lands; callers that ask while it is on its way share it (several routes and open
   * boards ask for the same lists at once). A failure is never kept.
   */
  private cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && (!hit.done || Date.now() - hit.at < ttlMs)) return hit.value as Promise<T>;
    const entry = { at: Date.now(), done: false, value: undefined as unknown as Promise<unknown> };
    entry.value = load().then(
      (v) => ((entry.at = Date.now()), (entry.done = true), v),
      (err) => {
        if (this.cache.get(key) === entry) this.cache.delete(key);
        throw err;
      },
    );
    this.cache.set(key, entry);
    return entry.value as Promise<T>;
  }

  me(): Promise<string> {
    return this.cached("me", 3_600_000, async () => (await this.request<{ userId: string }>("GET", "/api/cli-auth/me")).userId);
  }

  company(): Promise<{ issuePrefix?: string; name?: string }> {
    return this.cached("company", 3_600_000, () => this.request("GET", `/api/companies/${this.companyId}`));
  }

  /** `fresh` reads the list again (an agent an apply just created is not in the cached one). */
  agents(fresh = false): Promise<Agent[]> {
    if (fresh) this.cache.delete("agents");
    // `fresh` also gets past the kernel's few-seconds cache of this read (cplimit.ts keys it by URL): an agent setup just created is not in it.
    return this.cached("agents", 300_000, () => this.request<Agent[]>("GET", `/api/companies/${this.companyId}/agents${fresh ? `?fresh=${Date.now()}` : ""}`));
  }

  labels(): Promise<Label[]> {
    return this.cached("labels", 300_000, () => this.request<Label[]>("GET", `/api/companies/${this.companyId}/labels`));
  }

  /**
   * All open issues of the company (routine runs left out), paged one request at a time: Paperclip limits concurrent list
   * requests per client, so the board filters by assignee itself.
   */
  async openIssues(): Promise<Issue[]> {
    return (await this.openListed()).issues;
  }

  /**
   * The open issues with whether LIST_BOUND cut them short (the board's inventory), from the snapshot. `strict`: a read that
   * writes follow from; the snapshot is brought up to date just now, never taken as it was.
   */
  async openListed(strict = false): Promise<Listed> {
    const s = await this.snapshot(strict);
    return { issues: [...s.open.values()], incomplete: s.incomplete.open };
  }

  /** The closed issues (routine runs left out) updated after `since` (within the snapshot's 48 hours), newest first, up to LIST_BOUND. */
  async closedListed(since: string, strict = false): Promise<Listed> {
    if (Date.parse(since) < Date.now() - CLOSED_WINDOW_MS - SNAP_OVERLAP_MS) return this.paged("done,cancelled", since);
    const s = await this.snapshot(strict);
    const issues = [...s.closed.values()].filter((i) => i.updatedAt > since).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { issues: issues.slice(0, LIST_BOUND), incomplete: s.incomplete.closed || issues.length > LIST_BOUND };
  }

  /**
   * The snapshot, current to within SNAP_FRESH_MS and no later than the last write the board made: readers share one
   * incremental read, and the full inventory is read again every SNAP_FULL_MS. A refresh that fails fails the read.
   */
  private async snapshot(strict: boolean): Promise<Snapshot> {
    const s = this.snap;
    // A read that writes follow from never takes the shortcut, nor joins a sync that began before it asked (a write may be in it).
    if (strict) await this.syncing?.catch(() => {});
    else if (s && s.syncedWrites === this.writes && Date.now() - s.syncedAt < SNAP_FRESH_MS && Date.now() - s.fullAt < SNAP_FULL_MS) return s;
    this.syncing ??= this.sync().finally(() => (this.syncing = undefined));
    // A failed refresh is the read's failure: the pages that can show their last good response (swr.ts) say so, and no write is
    // validated against inventory that may have changed.
    await this.syncing;
    return this.snap!;
  }

  private async sync(): Promise<void> {
    const old = this.snap;
    const started = Date.now();
    const writes = this.writes;
    if (old && started - old.fullAt < SNAP_FULL_MS) {
      // A burst past the page may have more behind it: read in full then.
      if ((await this.changedSince(new Date(old.through).toISOString(), writes)).length < CHANGED_LIMIT) return;
    }
    const [open, closed] = await Promise.all([this.paged(OPEN), this.paged("done,cancelled", new Date(started - CLOSED_WINDOW_MS).toISOString())]);
    this.snap = { open: new Map(open.issues.map((i) => [i.id, i])), closed: new Map(closed.issues.map((i) => [i.id, i])), incomplete: { open: open.incomplete, closed: closed.incomplete }, through: started - SNAP_OVERLAP_MS, fullAt: started, syncedAt: Date.now(), syncedWrites: writes };
  }

  /** Brings a change into the snapshot (never an older row over a newer one). */
  private ingest(s: Snapshot, i: Issue) {
    const have = s.open.get(i.id) ?? s.closed.get(i.id);
    if (have && have.updatedAt > i.updatedAt) return;
    s.open.delete(i.id);
    s.closed.delete(i.id);
    (CLOSED.has(i.status) ? s.closed : s.open).set(i.id, i);
  }

  /** The company's projects (Paperclip's own list); a reply not shaped `{id, name}[]` is an error, so the filter shows unavailable. */
  projects(): Promise<Project[]> {
    return this.cached("projects", 300_000, async () => ProjectsSchema.parse(await this.request("GET", `/api/companies/${this.companyId}/projects`)).map((p) => ({ id: p.id, name: p.name })));
  }

  /** One status list read page by page, newest update first, until a short page or LIST_BOUND (so the bound cuts the oldest). */
  private async paged(status: string, updatedSince?: string): Promise<Listed> {
    const issues: Issue[] = [];
    for (let offset = 0; offset < LIST_BOUND; offset += PAGE) {
      const page = await this.list(status, updatedSince, String(PAGE), false, offset, true);
      issues.push(...page);
      if (page.length < PAGE) return { issues, incomplete: false };
    }
    return { issues, incomplete: true };
  }

  /** Every task (routine runs left out) updated after `since`, newest first: what the live watch (watch.ts) announces. */
  async changedSince(since: string, writes = this.writes): Promise<Issue[]> {
    const asked = Date.now();
    const rows = await this.list(`${OPEN},done,cancelled`, since, String(CHANGED_LIMIT));
    // Every look at what changed also keeps the snapshot current (the live watch asks every few seconds).
    const s = this.snap;
    if (s) {
      for (const i of rows) this.ingest(s, i);
      const floor = new Date(Date.now() - CLOSED_WINDOW_MS).toISOString();
      for (const [id, i] of s.closed) if (i.updatedAt < floor) s.closed.delete(id);
      // It closes the gap when it began no later than the snapshot's own mark, unless a full page cut it short.
      if (Date.parse(since) <= s.through && rows.length < CHANGED_LIMIT) {
        s.through = Math.max(s.through, asked - SNAP_OVERLAP_MS);
        s.syncedAt = Date.now();
        s.syncedWrites = Math.max(s.syncedWrites, writes);
      }
    }
    return rows;
  }

  /** A task's sub-tasks, open and closed. The list filter isn't trusted, so it's checked here too. */
  async children(parentId: string): Promise<Issue[]> {
    const q = new URLSearchParams({ parentId, status: `${OPEN},done,cancelled`, limit: "200" });
    return (await this.request<Issue[]>("GET", `/api/companies/${this.companyId}/issues?${q}`)).filter((i) => i.parentId === parentId);
  }

  /** The newest comment on a task, for the crew's one-line summaries; cached briefly. */
  latestComment(id: string): Promise<Comment | undefined> {
    return this.cached(`latest:${id}`, 10_000, async () => (await this.comments(id)).at(-1));
  }

  /** Tasks with a label (chats): open ones, or the newest finished ones. */
  async labelled(labelId: string, status: string, limit = "200"): Promise<Issue[]> {
    const q = new URLSearchParams({ labelId, status, limit, excludeRoutineExecutions: "true" });
    return this.request<Issue[]>("GET", `/api/companies/${this.companyId}/issues?${q}`);
  }

  createLabel(name: string, color: string): Promise<Label> {
    this.cache.delete("labels");
    return this.request<Label>("POST", `/api/companies/${this.companyId}/labels`, { name, color });
  }

  pauseAgent(id: string): Promise<unknown> {
    this.cache.clear();
    return this.request("POST", `/api/agents/${encodeURIComponent(id)}/pause`, {});
  }

  /** Clears an agent's `error` status (Paperclip sets it when a run fails with a configuration error). */
  clearAgentError(id: string): Promise<unknown> {
    return this.request("POST", `/api/agents/${encodeURIComponent(id)}/clear-error`, {});
  }

  resumeAgent(id: string): Promise<unknown> {
    this.cache.clear();
    return this.request("POST", `/api/agents/${encodeURIComponent(id)}/resume`, {});
  }

  /** The company's approvals in one status (`pending` for the card mirrors). */
  approvals(status = "pending"): Promise<PaperclipApproval[]> {
    return this.request<PaperclipApproval[]>("GET", `/api/companies/${this.companyId}/approvals?status=${encodeURIComponent(status)}`);
  }

  /** An approval linked to a task: the mirror of an open kernel card (mirror.ts). */
  createApproval(body: { type: string; issueIds: string[]; requestedByAgentId?: string; payload: { [k: string]: unknown } }): Promise<PaperclipApproval> {
    return this.request<PaperclipApproval>("POST", `/api/companies/${this.companyId}/approvals`, body);
  }

  /**
   * Retires a card mirror without waking anyone. Paperclip's reject route wakes the assignee of every linked issue whose
   * review path it finds lost, so a mirror that is a task's last review path would wake that task as it goes: the mirror
   * must not be a wake source of its own. Unlinking first leaves nothing for that wake to name, and the reject then
   * resolves the approval itself, so it stops counting as a pending wait and leaves no orphan in the company's list,
   * without touching the kernel record it stands for. Either half may find the mirror already gone: that is not an error.
   */
  async retireApproval(id: string, task: string, reason: string): Promise<void> {
    await this.request("DELETE", `/api/issues/${encodeURIComponent(task)}/approvals/${encodeURIComponent(id)}`).catch((err) => {
      if (!(err instanceof PaperclipError && err.status === 404)) throw err;
    });
    await this.request("POST", `/api/approvals/${encodeURIComponent(id)}/reject`, { decisionNote: reason });
  }

  closedSince(since: string, limit = "100"): Promise<Issue[]> {
    return this.list("done,cancelled", since, limit);
  }

  /** Every task updated after `since`, routine runs included, newest first (the Flow timeline's titles). */
  tasksSince(since: string): Promise<Issue[]> {
    return this.list(`${OPEN},done,cancelled`, since, "500", true);
  }

  /** One page of an agent's finished tasks, newest first (Paperclip filters, searches and pages; the assignee is checked here too). */
  async closedFor(agentId: string, opts: { q?: string; status?: "done" | "cancelled"; offset?: number; limit?: number } = {}): Promise<Issue[]> {
    const p = new URLSearchParams({ assigneeAgentId: agentId, status: opts.status ?? "done,cancelled", limit: String(opts.limit ?? 30), offset: String(opts.offset ?? 0), excludeRoutineExecutions: "true" });
    if (opts.q?.trim()) p.set("q", opts.q.trim());
    return (await this.request<Issue[]>("GET", `/api/companies/${this.companyId}/issues?${p}`)).filter((i) => i.assigneeAgentId === agentId);
  }

  private list(status: string, updatedSince?: string, limit = "500", routines = false, offset = 0, newest = false): Promise<Issue[]> {
    const q = new URLSearchParams({ status, limit, excludeRoutineExecutions: String(!routines), ...(offset ? { offset: String(offset) } : {}), ...(newest ? { sortField: "updated", sortDir: "desc" } : {}) });
    if (updatedSince) q.set("updatedSince", updatedSince);
    return this.request<Issue[]>("GET", `/api/companies/${this.companyId}/issues?${q}`);
  }

  /** The company's routines (schedules), for the Agents page. */
  routines(): Promise<Routine[]> {
    return this.cached("routines", 60_000, () => this.request<Routine[]>("GET", `/api/companies/${this.companyId}/routines`));
  }

  /** One routine with its triggers, fresh. */
  routine(id: string): Promise<Routine> {
    return this.request<Routine>("GET", `/api/routines/${encodeURIComponent(id)}`);
  }

  /** An issue's title and origin, which rarely change: cached for a minute. */
  issueSummary(id: string): Promise<Issue> {
    return this.cached(`issue:${id}`, 60_000, () => this.issue(id));
  }

  issue(id: string): Promise<Issue> {
    return this.request<Issue>("GET", `/api/issues/${encodeURIComponent(id)}`);
  }

  /** A task's newest 500 comments (Paperclip's most per page), oldest first: the latest word is always in it. */
  async comments(id: string): Promise<Comment[]> {
    const list = await this.request<Comment[]>("GET", `/api/issues/${encodeURIComponent(id)}/comments?order=desc&limit=500`);
    return list.filter((c) => !c.deletedAt).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }

  /** One page of a task's comments (Paperclip's most: 500): oldest first after the comment `after`, or the newest first. */
  commentPage(id: string, opts: { after?: string; newest?: boolean } = {}): Promise<Comment[]> {
    const q = new URLSearchParams({ order: opts.newest ? "desc" : "asc", limit: "500", ...(opts.after ? { after: opts.after } : {}) });
    return this.request<Comment[]>("GET", `/api/issues/${encodeURIComponent(id)}/comments?${q}`);
  }

  updateIssue(id: string, body: Record<string, unknown>): Promise<Issue> {
    return this.request<Issue>("PATCH", `/api/issues/${encodeURIComponent(id)}`, body);
  }

  /**
   * A comment as the owner. `typed`: the user's own words (the compose box, crew instructions, a fast chat); anything else
   * the board writes is marked by the kernel as code's, so it is never read as the owner's words.
   */
  addComment(id: string, body: string, typed = false): Promise<Comment> {
    const post = () => this.request<Comment>("POST", `/api/issues/${encodeURIComponent(id)}/comments`, { body });
    return typed ? typedWords.run(true, post) : post();
  }

  createIssue(body: Record<string, unknown>): Promise<Issue> {
    return this.request<Issue>("POST", `/api/companies/${this.companyId}/issues`, body);
  }

  attachments(id: string): Promise<Attachment[]> {
    return this.request<Attachment[]>("GET", `/api/issues/${encodeURIComponent(id)}/attachments`);
  }

  addAttachment(issueId: string, name: string, type: string, data: Buffer): Promise<Attachment> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type }), name);
    return this.client.upload<Attachment>(`/api/companies/${this.companyId}/issues/${encodeURIComponent(issueId)}/attachments`, form, { timeoutMs: 60_000 });
  }

  attachmentContent(id: string): Promise<Buffer> {
    return this.client.bytes(`/api/attachments/${encodeURIComponent(id)}/content`, { timeoutMs: 60_000 });
  }
}
