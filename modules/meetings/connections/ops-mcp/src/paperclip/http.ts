import { paperclipClient, type PaperclipClient } from "../aidenhq-sdk/paperclip.js";
import type { CreateIssueInput, IssueComment, IssueRef, PaperclipApi } from "./api.js";

interface Label {
  id: string;
  name: string;
}

/** The Paperclip surface ops-mcp uses, over the SDK's client (this module holds the agent's own key: its scan has no job to act as). */
export class HttpPaperclipApi implements PaperclipApi {
  private labelCache = new Map<string, string>();
  private readonly client: PaperclipClient;

  constructor(
    baseUrl: string,
    private readonly companyId: string,
    apiKey: string,
    timeoutMs = 15_000,
  ) {
    this.client = paperclipClient({ url: baseUrl, token: apiKey, lane: "direct", timeoutMs });
  }

  async createIssue(input: CreateIssueInput): Promise<IssueRef> {
    const labelIds = await Promise.all(input.labels.map((l) => this.labelId(l)));
    const body: Record<string, unknown> = {
      title: input.title,
      description: input.description,
      status: "todo",
      labelIds,
      idempotencyKey: input.idempotency_key,
      allowDuplicate: true, // our own markers handle dedup; titles may legitimately repeat
    };
    // Assign to the user unless an agent is named: Paperclip otherwise assigns issues to the
    // creating agent, and the user's comments would wake that agent instead of reaching ops-mcp.
    if (input.assignee_agent_id) body.assigneeAgentId = input.assignee_agent_id;
    else {
      const user = await this.ownerUserId();
      if (!user) throw new Error("no owner to hold the task: every open task has a holder");
      body.assigneeUserId = user;
    }
    const issue = await this.request<Record<string, unknown>>("POST", `/api/companies/${this.companyId}/issues`, body);
    return toRef(issue);
  }

  private owner?: string | null;

  /** The company's default responsible user (the human owner of this instance). */
  private async ownerUserId(): Promise<string | undefined> {
    if (this.owner === undefined) {
      try {
        this.owner = (await this.request<{ defaultResponsibleUserId?: string }>("GET", `/api/companies/${this.companyId}`)).defaultResponsibleUserId ?? null;
      } catch {
        return undefined;
      }
    }
    return this.owner ?? undefined;
  }

  async getIssue(id: string): Promise<IssueRef> {
    return toRef(await this.request<Record<string, unknown>>("GET", `/api/issues/${encodeURIComponent(id)}`));
  }

  async listComments(issueId: string): Promise<IssueComment[]> {
    const raw = await this.request<unknown>("GET", `/api/issues/${encodeURIComponent(issueId)}/comments?order=asc&limit=200`);
    const list = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
    return list
      .filter((c) => !c.deletedAt)
      .map((c) => ({
        id: String(c.id),
        body: String(c.body ?? ""),
        author: c.authorType === "user" || c.authorType === "agent" ? c.authorType : "system",
        created_at: String(c.createdAt ?? ""),
      }));
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, { body });
  }

  async setStatus(issueId: string, status: string): Promise<void> {
    await this.request("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, { status });
  }

  async runRoutine(title: string): Promise<void> {
    const routines = await this.request<{ id: string; title: string }[]>("GET", `/api/companies/${this.companyId}/routines`);
    const routine = routines.find((r) => r.title === title);
    if (!routine) throw new Error(`routine "${title}" not found`);
    await this.request("POST", `/api/routines/${routine.id}/run`, { source: "api" });
  }

  async ping(): Promise<boolean> {
    try {
      await this.request("GET", `/api/companies/${this.companyId}/labels`);
      return true;
    } catch {
      return false;
    }
  }

  private async labelId(name: string): Promise<string> {
    const cached = this.labelCache.get(name);
    if (cached) return cached;
    const labels = await this.request<Label[]>("GET", `/api/companies/${this.companyId}/labels`);
    for (const l of labels) this.labelCache.set(l.name, l.id);
    const found = this.labelCache.get(name);
    if (found) return found;
    const created = await this.request<Label>("POST", `/api/companies/${this.companyId}/labels`, { name, color: "#6b7280" });
    this.labelCache.set(name, created.id);
    return created.id;
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.client.request<T>(method, path, body);
  }
}

function toRef(issue: Record<string, unknown>): IssueRef {
  const i = (issue.issue as Record<string, unknown> | undefined) ?? issue;
  return { id: String(i.id), identifier: i.identifier ? String(i.identifier) : undefined, status: String(i.status ?? "") };
}
