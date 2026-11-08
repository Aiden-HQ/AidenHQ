import { readFileSync } from "node:fs";
import { RUNNER_MARKER, hasMarker } from "./commands.mjs";

const OPEN_STATUSES = "backlog,todo,in_progress,in_review,blocked";
export const ALL_STATUSES = `${OPEN_STATUSES},done,cancelled`;

/** Paperclip REST client acting as the user (board API key). */
export class Paperclip {
  constructor(cfg) {
    this.base = cfg.paperclipUrl;
    this.company = cfg.companyId;
    this.key = readFileSync(cfg.boardKeyFile, "utf8").trim();
    this.labels = undefined;
  }

  async api(method, path, body) {
    const res = await fetch(new URL(path, this.base), {
      method,
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Paperclip ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  async labelId(name) {
    this.labels ??= new Map((await this.api("GET", `/api/companies/${this.company}/labels`)).map((l) => [l.name, l.id]));
    const id = this.labels.get(name);
    if (!id) throw new Error(`label "${name}" missing in Paperclip (run scripts/paperclip-setup.mjs)`);
    return id;
  }

  /** The company's tasks matching these query parameters (undefined ones left out). */
  issues(params) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined));
    return this.api("GET", `/api/companies/${this.company}/issues?${q}`);
  }

  async labelledIssues(label, updatedSince) {
    return this.issues({ labelId: await this.labelId(label), status: OPEN_STATUSES, limit: "200", updatedSince });
  }

  /**
   * The Engineer agents (assignment targets for coding jobs, one per engine), refreshed every few
   * minutes so a primary model changed in the Paperclip UI applies. Before the split there was one.
   */
  async engineerAgents() {
    const agents = await this.agents();
    // Paused Engineers (pruned, or their module disabled) are never assignment targets.
    const list = agents.filter((x) => x.status !== "paused" && /^aidenhq:(fleet-)?engineer(-|$)/.test(x.metadata?.setupKey ?? ""));
    return list.length ? list : agents.filter((x) => x.name === "Engineer");
  }

  /** Every live agent, refreshed every few minutes (personas and primary models change in setup). */
  async agents() {
    if (!this.agentList || Date.now() - this.agentList.at > 300_000) {
      this.agentList = { at: Date.now(), list: (await this.api("GET", `/api/companies/${this.company}/agents`)).filter((x) => x.status !== "terminated") };
    }
    return this.agentList.list;
  }

  /** Show the executor on the task: assign it to an Engineer and set (or clear) its model override. */
  setPicker(issueId, fields) {
    return this.api("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, fields);
  }

  assignedIssues(agentId, updatedSince) {
    return this.issues({ assigneeAgentId: agentId, status: OPEN_STATUSES, limit: "200", updatedSince });
  }

  /** Sub-tasks of a task (open ones unless statuses say otherwise). */
  async children(parentId, statuses = OPEN_STATUSES) {
    return (await this.issues({ parentId, status: statuses, limit: "200" })).filter((i) => i.parentId === parentId);
  }

  /** Tasks by text and/or assignee agent, any status, newest first; routine runs left out. */
  async searchIssues({ query, assigneeAgentId }) {
    const list = await this.issues({ status: ALL_STATUSES, limit: "50", excludeRoutineExecutions: "true", q: query || undefined, assigneeAgentId: assigneeAgentId || undefined });
    return list.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  myOpenIssues() {
    return this.issues({ assigneeUserId: "me", status: OPEN_STATUSES, limit: "300", excludeRoutineExecutions: "true" });
  }

  /** Routine run tasks in a status (newest first), of one routine when given. */
  routineRuns(status, routineId, limit = 200) {
    return this.issues({ originKind: "routine_execution", status, limit: String(limit), originId: routineId || undefined });
  }

  async runRoutine(title, variables) {
    const routine = (await this.api("GET", `/api/companies/${this.company}/routines`)).find((r) => r.title === title);
    if (!routine) throw new Error(`routine "${title}" not found (run scripts/paperclip-setup.mjs)`);
    return this.api("POST", `/api/routines/${routine.id}/run`, { source: "api", variables });
  }

  issue(id) {
    return this.api("GET", `/api/issues/${encodeURIComponent(id)}`);
  }

  /** Files on a task. */
  attachments(issueId) {
    return this.api("GET", `/api/issues/${encodeURIComponent(issueId)}/attachments`);
  }

  async attachmentContent(id) {
    const res = await fetch(new URL(`/api/attachments/${encodeURIComponent(id)}/content`, this.base), {
      headers: { authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Paperclip GET attachment ${id} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Attach a file to a task as the user (what an Engineer made, for the others to read). */
  async addAttachment(issueId, name, type, data) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type }), name);
    const res = await fetch(new URL(`/api/companies/${this.company}/issues/${encodeURIComponent(issueId)}/attachments`, this.base), {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Paperclip POST attachment → ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  deleteAttachment(id) {
    return this.api("DELETE", `/api/attachments/${encodeURIComponent(id)}`);
  }

  async comments(issueId) {
    const list = await this.api("GET", `/api/issues/${encodeURIComponent(issueId)}/comments?order=asc&limit=500`);
    return list.filter((c) => !c.deletedAt);
  }

  /** Instructions are only ever taken from human-written comments that are not the runner's own. */
  static isUserInstruction(c) {
    return c.authorType === "user" && !hasMarker(c.body, RUNNER_MARKER);
  }

  comment(issueId, body) {
    return this.api("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, { body: `${body}\n\n${RUNNER_MARKER}` });
  }

  async me() {
    this.userId ??= (await this.api("GET", "/api/cli-auth/me")).userId;
    return this.userId;
  }

  /**
   * Mark a task in progress, with a comment when there is one. Paperclip requires an assignee for
   * that: tasks assigned to an Engineer keep it; anything else is assigned to the user.
   */
  async startWork(issueId, comment) {
    const issue = await this.issue(issueId);
    const engineers = await this.engineerAgents();
    const body = { status: "in_progress" };
    if (comment) body.comment = `${comment}\n\n${RUNNER_MARKER}`;
    if (!engineers.some((a) => a.id === issue.assigneeAgentId)) Object.assign(body, { assigneeUserId: await this.me(), assigneeAgentId: null });
    return this.api("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, body);
  }

  setStatus(issueId, status, comment) {
    const body = { status };
    if (comment) body.comment = `${comment}\n\n${RUNNER_MARKER}`;
    return this.api("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, body);
  }
}
