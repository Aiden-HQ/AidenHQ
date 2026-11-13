/** The few Paperclip REST calls the board makes, as the user (board API key). */

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
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
  metadata?: { setupKey?: string; module?: unknown; trial?: unknown; models?: unknown; persona?: unknown; avatar?: unknown; runnerEngine?: unknown } | null;
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
  /** The task this one is a sub-task of: an agent's work on the user's task. */
  parentId?: string | null;
  /** "routine_execution" for a routine's run task. */
  originKind?: string | null;
  /** A recovery hold: Paperclip parks the assignee's wakes for this task until it clears (single-issue reads only). */
  executionBlocker?: { cause: string; runError?: string | null } | null;
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
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly baseUrl: string,
    readonly companyId: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new PaperclipError(`Paperclip ${method} ${path.split("?")[0]} → ${res.status}: ${errorMessage(text)}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** The agent a credential (run JWT or agent key) belongs to; the board uses it to know who is calling. */
  async agentMe(agentKey: string): Promise<Agent> {
    const res = await this.fetchImpl(new URL("/api/agents/me", this.baseUrl), { headers: { authorization: `Bearer ${agentKey}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new PaperclipError(`Paperclip GET /api/agents/me → ${res.status}`, res.status);
    return (await res.json()) as Agent;
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
    return this.list(OPEN);
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
  cancelRun(runId: string): Promise<unknown> {
    this.cache.delete("live-runs");
    return this.request("POST", `/api/heartbeat-runs/${encodeURIComponent(runId)}/cancel`, {});
  }

  closedSince(since: string, limit = "100"): Promise<Issue[]> {
    return this.list("done,cancelled", since, limit);
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

  async comments(id: string): Promise<Comment[]> {
    const list = await this.request<Comment[]>("GET", `/api/issues/${encodeURIComponent(id)}/comments?order=asc&limit=500`);
    return list.filter((c) => !c.deletedAt);
  }

  updateIssue(id: string, body: Record<string, unknown>): Promise<Issue> {
    return this.request<Issue>("PATCH", `/api/issues/${encodeURIComponent(id)}`, body);
  }

  addComment(id: string, body: string): Promise<Comment> {
    return this.request<Comment>("POST", `/api/issues/${encodeURIComponent(id)}/comments`, { body });
  }

  /** Wakes an agent with no task attached (a task-scoped wake goes through that task's execution hold). */
  wakeAgent(agentId: string, reason: string, idempotencyKey: string): Promise<unknown> {
    return this.request("POST", `/api/agents/${encodeURIComponent(agentId)}/wakeup`, { source: "on_demand", triggerDetail: "manual", reason, idempotencyKey });
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
    const path = `/api/companies/${this.companyId}/issues/${encodeURIComponent(issueId)}/attachments`;
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new PaperclipError(`Paperclip POST attachment → ${res.status}: ${errorMessage(text)}`, res.status);
    return JSON.parse(text) as Attachment;
  }

  async attachmentContent(id: string): Promise<Buffer> {
    const res = await this.fetchImpl(new URL(`/api/attachments/${encodeURIComponent(id)}/content`, this.baseUrl), {
      headers: { authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new PaperclipError(`Paperclip GET attachment → ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }
}
