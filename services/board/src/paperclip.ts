import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The Paperclip REST calls the board makes, as the owner, all through the kernel (kernel/src/cp.ts createBoardCp): reads at
 * /v1/cp/read/<path>, writes at /v1/cp/owner/<path>, with the board's key on the kernel. The board holds no Paperclip key.
 */

/** The signed-in admin a write is for (app.ts sets it per request); sent to the kernel, which logs it with the write. */
export const actingAccount = new AsyncLocalStorage<string>();

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
  /** The agent it reports to (the org chart). */
  reportsTo?: string | null;
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
  metadata?: { setupKey?: string; module?: unknown; trial?: unknown; models?: unknown; persona?: unknown; avatar?: unknown; runnerEngine?: unknown; engine?: unknown; department?: unknown } | null;
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
  /** A recovery hold: Paperclip parks the assignee's wakes for this task until it clears (single-issue reads only). */
  executionBlocker?: { cause: string; runError?: string | null; runId?: string | null; recoveryActionId?: string | null } | null;
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

/** An agent run in progress (Paperclip's live-runs). */
export interface LiveRun {
  id: string;
  status: string;
  agentId: string;
  agentName?: string;
  issueId: string | null;
  startedAt: string | null;
  createdAt: string;
  /** Where its output stream is: it moves as the agent says more. */
  lastOutputSeq?: number | null;
  lastOutputAt?: string | null;
  currentStatusMessage?: string | null;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  outputSilence?: { level?: string } | null;
}

export interface Routine {
  id: string;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
  lastTriggeredAt?: string | null;
  triggers?: { kind?: string; enabled?: boolean; label?: string | null; nextRunAt?: string | null; lastFiredAt?: string | null }[];
}

/** A finished (or failed) agent run, from heartbeat-runs. */
/** Why a cancelled run did nothing, for releasing the recovery hold it left (releaseCancelledRun). */
export interface ReleaseWhy {
  note: string;
  evidence: string;
}
const BRAKE_CANCEL: ReleaseWhy = {
  note: "The board's loop brake cancelled this run as it started; it did nothing.",
  evidence: "Cancelled by the board's loop brake, which only cancels a run it saw still queued; it was stopped as it started, before any action.",
};
/** Paperclip's own disposition repair, cancelled before dispatch because the task already had a disposition. */
export const REPAIR_SUPPRESSED = "legacy_disposition_repair_suppressed";
/** What Paperclip calls a run whose adapter reported an incomplete response (Codex: "Incomplete response returned, reason: max_output_tokens"). */
export const CONFIG_INCOMPLETE = "configuration_incomplete";
export const REPAIR_SUPPRESSED_WHY: ReleaseWhy = {
  note: "Paperclip suppressed its own disposition repair run before dispatch; it did nothing.",
  evidence: "The run ended with legacy_disposition_repair_suppressed: Paperclip cancels it before the adapter starts, so no action ran.",
};

export interface PastRun {
  id: string;
  status: string;
  agentId: string;
  issueId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Why it ended, when Paperclip says (e.g. issue_reassigned: cancelled because the task changed hands). */
  errorCode?: string | null;
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

export interface Model {
  id: string;
  label: string;
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

/** Paperclip's `error` field, else the start of the body. */
function errorMessage(text: string): string {
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export class PaperclipError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class Paperclip {
  private cache = new Map<string, { at: number; value: Promise<unknown>; done: boolean }>();

  /** `kernelUrl`: the kernel's backplane; `key`: the board's key on it (gateway_board_key). */
  constructor(
    private readonly kernelUrl: string,
    readonly companyId: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** A Paperclip path through the kernel: reads and the owner's writes, with the admin a write is for. */
  private call(method: string, path: string, init: { body?: BodyInit; type?: string; timeoutMs?: number } = {}): Promise<Response> {
    const account = actingAccount.getStore();
    return this.fetchImpl(new URL(`/v1/cp/${method === "GET" ? "read" : "owner"}${path}`, this.kernelUrl), {
      method,
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json", ...(init.type ? { "content-type": init.type } : {}), ...(account && method !== "GET" ? { "x-aidenhq-account": account } : {}) },
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // A write may change the open tasks: a read that starts after it never shares one already on its way.
    if (method !== "GET") this.cache.delete("open");
    const res = await this.call(method, path, body ? { body: JSON.stringify(body), type: "application/json" } : {});
    const text = await res.text();
    if (!res.ok) throw new PaperclipError(`Paperclip ${method} ${path.split("?")[0]} → ${res.status}: ${errorMessage(text)}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
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

  agents(): Promise<Agent[]> {
    return this.cached("agents", 300_000, () => this.request<Agent[]>("GET", `/api/companies/${this.companyId}/agents`));
  }

  labels(): Promise<Label[]> {
    return this.cached("labels", 300_000, () => this.request<Label[]>("GET", `/api/companies/${this.companyId}/labels`));
  }

  models(adapterType: string): Promise<Model[]> {
    return this.cached(`models:${adapterType}`, 600_000, () => this.request<Model[]>("GET", `/api/companies/${this.companyId}/adapters/${adapterType}/models`));
  }

  /**
   * All open issues of the company (routine runs left out), in one request: Paperclip limits
   * concurrent list requests per client, so the board filters by assignee itself.
   */
  openIssues(): Promise<Issue[]> {
    // The biggest read the board makes: requests made while one is on its way share it (never a finished one).
    return this.cached("open", 0, () => this.list(OPEN));
  }

  /** Every task (routine runs left out) updated after `since`, newest first: what the live watch (watch.ts) announces. */
  changedSince(since: string): Promise<Issue[]> {
    return this.list(`${OPEN},done,cancelled`, since, "200");
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

  /** Stops a run (live or queued). */
  /** One agent's newest runs, uncached, with the comment that woke each (the loop brake, brake.ts). */
  async agentRuns(agentId: string, limit = 20): Promise<{ id: string; status: string; wakeCommentId: string | null }[]> {
    const raw = await this.request<{ id: string; status: string; contextSnapshot?: { wakeCommentId?: string; commentId?: string } | null }[]>("GET", `/api/companies/${this.companyId}/heartbeat-runs?agentId=${encodeURIComponent(agentId)}&limit=${limit}`);
    return raw.map((r) => ({ id: r.id, status: r.status, wakeCommentId: r.contextSnapshot?.wakeCommentId ?? r.contextSnapshot?.commentId ?? null }));
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

  cancelRun(runId: string): Promise<unknown> {
    this.cache.delete("live-runs");
    return this.request("POST", `/api/heartbeat-runs/${encodeURIComponent(runId)}/cancel`, {});
  }

  /**
   * Clears the recovery hold Paperclip puts on a task when a cancelled run had just started and did nothing (the brake
   * cancels only runs it saw queued; Paperclip's suppressed repair stops before dispatch), so the hold is resolved as
   * restored with no action performed.
   */
  releaseCancelledRun(issue: Pick<Issue, "id" | "status" | "executionBlocker">, runId: string, why = BRAKE_CANCEL): Promise<unknown> {
    const b = issue.executionBlocker;
    if (!b?.recoveryActionId || b.runId !== runId) return Promise.resolve(undefined);
    const status = ["todo", "done", "in_review"].includes(issue.status) ? issue.status : "todo";
    return this.request("POST", `/api/issues/${encodeURIComponent(issue.id)}/recovery-actions/resolve`, {
      actionId: b.recoveryActionId,
      outcome: "restored",
      sourceIssueStatus: status,
      resolutionNote: why.note,
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: why.evidence },
    });
  }

  closedSince(since: string, limit = "100"): Promise<Issue[]> {
    return this.list("done,cancelled", since, limit);
  }

  /** One page of an agent's finished tasks, newest first (Paperclip filters, searches and pages; the assignee is checked here too). */
  async closedFor(agentId: string, opts: { q?: string; status?: "done" | "cancelled"; offset?: number; limit?: number } = {}): Promise<Issue[]> {
    const p = new URLSearchParams({ assigneeAgentId: agentId, status: opts.status ?? "done,cancelled", limit: String(opts.limit ?? 30), offset: String(opts.offset ?? 0), excludeRoutineExecutions: "true" });
    if (opts.q?.trim()) p.set("q", opts.q.trim());
    return (await this.request<Issue[]>("GET", `/api/companies/${this.companyId}/issues?${p}`)).filter((i) => i.assigneeAgentId === agentId);
  }

  private list(status: string, updatedSince?: string, limit = "500"): Promise<Issue[]> {
    const q = new URLSearchParams({ status, limit, excludeRoutineExecutions: "true" });
    if (updatedSince) q.set("updatedSince", updatedSince);
    return this.request<Issue[]>("GET", `/api/companies/${this.companyId}/issues?${q}`);
  }

  /** Agent runs in progress. Polled often, so cached briefly. */
  liveRuns(): Promise<LiveRun[]> {
    return this.cached("live-runs", 3_000, () => this.request<LiveRun[]>("GET", `/api/companies/${this.companyId}/live-runs`));
  }

  /** The company's routines (schedules), for the Agents page. */
  routines(): Promise<Routine[]> {
    return this.cached("routines", 60_000, () => this.request<Routine[]>("GET", `/api/companies/${this.companyId}/routines`));
  }

  /** Each agent's newest run (start time and status), from a long summary list. */
  lastRuns(): Promise<Map<string, { at: string; status: string }>> {
    return this.cached("last-runs", 30_000, async () => {
      const runs = await this.request<{ agentId: string; status: string; startedAt?: string | null; createdAt: string }[]>("GET", `/api/companies/${this.companyId}/heartbeat-runs?summary=true&limit=500`);
      const last = new Map<string, { at: string; status: string }>();
      for (const r of runs) {
        const at = r.startedAt ?? r.createdAt;
        if (at > (last.get(r.agentId)?.at ?? "")) last.set(r.agentId, { at, status: r.status });
      }
      return last;
    });
  }

  /** The newest agent runs, finished or not. */
  recentRuns(limit = 30): Promise<PastRun[]> {
    return this.cached(`runs:${limit}`, 10_000, async () => {
      const raw = await this.request<(PastRun & { contextSnapshot?: { issueId?: string } | null })[]>("GET", `/api/companies/${this.companyId}/heartbeat-runs?limit=${limit}`);
      return raw.map((r) => ({ id: r.id, status: r.status, agentId: r.agentId, issueId: r.contextSnapshot?.issueId ?? null, startedAt: r.startedAt, finishedAt: r.finishedAt, error: r.error ? String(r.error).slice(0, 200) : null, errorCode: r.errorCode ?? null }));
    });
  }

  /** One heartbeat run in full (companyId, session ids, usageJson); a 404 means Paperclip pruned it. */
  heartbeatRun(id: string): Promise<Record<string, any>> {
    return this.request("GET", `/api/heartbeat-runs/${encodeURIComponent(id)}`);
  }

  /** A run's stored log: ndjson {ts, stream, chunk} lines, up to `cap` bytes from the start, in a few pages. */
  async runLog(id: string, cap = 2_000_000): Promise<{ text: string; truncated: boolean }> {
    let offset = 0;
    const parts: string[] = [];
    while (offset < cap) {
      const r = await this.request<{ content?: string; nextOffset?: number }>("GET", `/api/heartbeat-runs/${encodeURIComponent(id)}/log?offset=${offset}&limitBytes=500000`);
      if (!r.content) return { text: parts.join(""), truncated: false };
      parts.push(r.content);
      if (typeof r.nextOffset !== "number" || r.nextOffset <= offset) return { text: parts.join(""), truncated: false };
      offset = r.nextOffset;
    }
    return { text: parts.join(""), truncated: true };
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

  addComment(id: string, body: string): Promise<Comment> {
    return this.request<Comment>("POST", `/api/issues/${encodeURIComponent(id)}/comments`, { body });
  }

  /** Wakes an agent with no task attached (a task-scoped wake goes through that task's execution hold), or on `issueId`. */
  wakeAgent(agentId: string, reason: string, idempotencyKey: string, issueId?: string): Promise<unknown> {
    return this.request("POST", `/api/agents/${encodeURIComponent(agentId)}/wakeup`, { source: "on_demand", triggerDetail: "manual", reason, idempotencyKey, ...(issueId ? { issueId } : {}) });
  }

  createIssue(body: Record<string, unknown>): Promise<Issue> {
    return this.request<Issue>("POST", `/api/companies/${this.companyId}/issues`, body);
  }

  attachments(id: string): Promise<Attachment[]> {
    return this.request<Attachment[]>("GET", `/api/issues/${encodeURIComponent(id)}/attachments`);
  }

  async addAttachment(issueId: string, name: string, type: string, data: Buffer): Promise<Attachment> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type }), name);
    const res = await this.call("POST", `/api/companies/${this.companyId}/issues/${encodeURIComponent(issueId)}/attachments`, { body: form, timeoutMs: 60_000 });
    const text = await res.text();
    if (!res.ok) throw new PaperclipError(`Paperclip POST attachment → ${res.status}: ${errorMessage(text)}`, res.status);
    return JSON.parse(text) as Attachment;
  }

  async attachmentContent(id: string): Promise<Buffer> {
    const res = await this.call("GET", `/api/attachments/${encodeURIComponent(id)}/content`, { timeoutMs: 60_000 });
    if (!res.ok) throw new PaperclipError(`Paperclip GET attachment → ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }
}
