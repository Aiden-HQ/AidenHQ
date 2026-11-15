import { readFileSync } from "node:fs";
import { RUNNER_MARKER, hasMarker } from "./commands.mjs";

const OPEN_STATUSES = "backlog,todo,in_progress,in_review,blocked";
export const ALL_STATUSES = `${OPEN_STATUSES},done,cancelled`;

/** Paperclip REST client acting as the user (board API key). */
export class Paperclip {
  base: string;
  company: string;
  key: string;
  labels: Map<string, string> | undefined;
  declare agentList: { at: number; list: any[] } | undefined;
  /** Set by the runner: reports each posted comment to the board (the loop brake). */
  declare posted: ((issueId: string, commentId: string) => void) | undefined;
  declare userId: string | undefined;

  constructor(cfg: { paperclipUrl: string; companyId: string; boardKeyFile: string }) {
    this.base = cfg.paperclipUrl;
    this.company = cfg.companyId;
    this.key = readFileSync(cfg.boardKeyFile, "utf8").trim();
    this.labels = undefined;
  }

  async api(method: string, path: string, body?: any): Promise<any> {
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

  async labelId(name: string): Promise<string> {
    this.labels ??= new Map((await this.api("GET", `/api/companies/${this.company}/labels`)).map((l: any) => [l.name, l.id]));
    const id = this.labels.get(name);
    if (!id) throw new Error(`label "${name}" missing in Paperclip (run scripts/paperclip-setup.mjs)`);
    return id;
  }

  /** The company's tasks matching these query parameters (undefined ones left out). */
  issues(params: Record<string, string | undefined>): Promise<any> {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
    return this.api("GET", `/api/companies/${this.company}/issues?${q}`);
  }

  async labelledIssues(label: string, updatedSince?: string) {
    return this.issues({ labelId: await this.labelId(label), status: OPEN_STATUSES, limit: "200", updatedSince });
  }

  /**
   * The Engineer agents (assignment targets for coding jobs, one per engine), refreshed every few
   * minutes so a primary model changed in the Paperclip UI applies. Before the split there was one.
   */
  async engineerAgents(): Promise<any[]> {
    const agents = await this.agents();
    // Paused Engineers (pruned, or their module disabled) are never assignment targets.
    // Runner-dispatched agents (setup marks them runnerEngine), and the older engineer-* keys.
    const list = agents.filter((x: any) => x.status !== "paused" && (x.metadata?.runnerEngine === true || /^aidenhq:(fleet-)?engineer(-|$)/.test(x.metadata?.setupKey ?? "")));
    return list.length ? list : agents.filter((x: any) => x.name === "Engineer");
  }

  /** Every live agent, refreshed every few minutes (personas and primary models change in setup). */
  async agents(): Promise<any[]> {
    if (!this.agentList || Date.now() - this.agentList.at > 300_000) {
      this.agentList = { at: Date.now(), list: (await this.api("GET", `/api/companies/${this.company}/agents`)).filter((x: any) => x.status !== "terminated") };
    }
    return this.agentList!.list;
  }

  /** Show the executor on the task: assign it to an Engineer and set (or clear) its model override. */
  setPicker(issueId: string, fields: any) {
    return this.api("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, fields);
  }

  assignedIssues(agentId: string, updatedSince?: string) {
    return this.issues({ assigneeAgentId: agentId, status: OPEN_STATUSES, limit: "200", updatedSince });
  }

  /** Sub-tasks of a task (open ones unless statuses say otherwise). */
  async children(parentId: string, statuses = OPEN_STATUSES) {
    return (await this.issues({ parentId, status: statuses, limit: "200" })).filter((i: any) => i.parentId === parentId);
  }

  /** Tasks by text and/or assignee agent, any status, newest first; routine runs left out. */
  async searchIssues({ query, assigneeAgentId }: { query?: string; assigneeAgentId?: string }) {
    const list = await this.issues({ status: ALL_STATUSES, limit: "50", excludeRoutineExecutions: "true", q: query || undefined, assigneeAgentId: assigneeAgentId || undefined });
    return list.sort((a: any, b: any) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  myOpenIssues() {
    return this.issues({ assigneeUserId: "me", status: OPEN_STATUSES, limit: "300", excludeRoutineExecutions: "true" });
  }

  /** Routine run tasks in a status (newest first), of one routine when given. */
  routineRuns(status: string, routineId?: string, limit = 200) {
    return this.issues({ originKind: "routine_execution", status, limit: String(limit), originId: routineId || undefined });
  }

  async runRoutine(title: string, variables?: any) {
    const routine = (await this.api("GET", `/api/companies/${this.company}/routines`)).find((r: any) => r.title === title);
    if (!routine) throw new Error(`routine "${title}" not found (run scripts/paperclip-setup.mjs)`);
    return this.api("POST", `/api/routines/${routine.id}/run`, { source: "api", variables });
  }

  issue(id: string) {
    return this.api("GET", `/api/issues/${encodeURIComponent(id)}`);
  }

  /** One heartbeat run (its agentId and the issueId it worked on): an issue's originRunId is the run that created it (origins). */
  run(id: string) {
    return this.api("GET", `/api/heartbeat-runs/${encodeURIComponent(id)}`);
  }

  /** Files on a task. */
  attachments(issueId: string) {
    return this.api("GET", `/api/issues/${encodeURIComponent(issueId)}/attachments`);
  }

  async attachmentContent(id: string) {
    const res = await fetch(new URL(`/api/attachments/${encodeURIComponent(id)}/content`, this.base), {
      headers: { authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Paperclip GET attachment ${id} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Attach a file to a task as the user (what an Engineer made, for the others to read). */
  async addAttachment(issueId: string, name: string, type: string, data: ArrayLike<number>) {
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

  deleteAttachment(id: string) {
    return this.api("DELETE", `/api/attachments/${encodeURIComponent(id)}`);
  }

  async comments(issueId: string) {
    const list = await this.api("GET", `/api/issues/${encodeURIComponent(issueId)}/comments?order=asc&limit=500`);
    return list.filter((c: any) => !c.deletedAt);
  }

  /** Instructions are only ever taken from human-written comments that are not the runner's own. */
  static isUserInstruction(c: any) {
    return c.authorType === "user" && !hasMarker(c.body, RUNNER_MARKER);
  }

  /**
   * The loop brake (board brake.ts): `posted`, when set, reports each comment to the board (not awaited), which cancels the
   * wake it caused once the runner's daily wakes on that task are used up. The comment itself always posts.
   */
  async comment(issueId: string, body: string) {
    const c = await this.api("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, { body: `${body}\n\n${RUNNER_MARKER}` });
    if (this.posted && c?.id) this.posted(issueId, c.id);
    return c;
  }

  async me(): Promise<string> {
    this.userId ??= (await this.api("GET", "/api/cli-auth/me")).userId;
    return this.userId!;
  }

  /**
   * Mark a task in progress, with a comment when there is one. Paperclip requires an assignee for
   * that: tasks assigned to an Engineer keep it; anything else is assigned to the user.
   */
  async startWork(issueId: string, comment?: string) {
    const issue = await this.issue(issueId);
    const engineers = await this.engineerAgents();
    const body: Record<string, any> = { status: "in_progress" };
    if (comment) body.comment = `${comment}\n\n${RUNNER_MARKER}`;
    if (!engineers.some((a: any) => a.id === issue.assigneeAgentId)) Object.assign(body, { assigneeUserId: await this.me(), assigneeAgentId: null });
    return this.api("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, body);
  }

  setStatus(issueId: string, status: string, comment?: string) {
    const body: Record<string, any> = { status };
    if (comment) body.comment = `${comment}\n\n${RUNNER_MARKER}`;
    return this.api("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, body);
  }

  /**
   * setStatus for the end of a job. Another agent may have set the task blocked while the run finished; Paperclip then
   * refuses the status change (422 "blocked by unresolved blockers"). The job's outcome stands: post the receipt as a plain
   * comment instead. Returns true when the status was refused for that reason; anything else throws.
   */
  async finishStatus(issueId: string, status: string, comment?: string) {
    try {
      await this.setStatus(issueId, status, comment);
      return false;
    } catch (err: any) {
      if (!/→ 422:.*blocked by unresolved blockers/i.test(String(err.message))) throw err;
      console.log(JSON.stringify({ t: new Date().toISOString(), msg: "final status refused: task is blocked", issue: issueId, status }));
      if (comment) await this.comment(issueId, comment);
      return true;
    }
  }
}

const ORIGIN_MAX = 24;
/**
 * Every issue a task traces back to, for its routine cap (tiers.mjs routineCap): its parents, and through each one's
 * originRunId (Paperclip records the run that created an issue; agents never set it) the issue that run worked on, then
 * theirs. So a parent the agent picked, or none, can't shed a routine's cap. `runIssue` caches run id → issueId (a run's
 * issue never changes). Past ORIGIN_MAX issues the trace is incomplete (the cap is then the strictest).
 */
export async function origins(pc: Paperclip, full: any, runIssue: Map<string, string | null> = new Map()): Promise<{ issues: any[]; complete: boolean }> {
  const seen = new Map<string, any>();
  const queue: any[] = [full];
  while (queue.length) {
    const i = queue.shift();
    if (!i || seen.has(i.id)) continue;
    if (seen.size >= ORIGIN_MAX) return { issues: [...seen.values()], complete: false };
    seen.set(i.id, i);
    if (i.parentId) queue.push(await pc.issue(i.parentId));
    // A routine run task is the root: its originRunId is the routine run (not a heartbeat run) and nothing created it.
    if (i.originRunId && i.originKind !== "routine_execution") {
      if (!runIssue.has(i.originRunId)) runIssue.set(i.originRunId, (await pc.run(i.originRunId))?.issueId ?? null);
      const from = runIssue.get(i.originRunId);
      if (from && !seen.has(from)) queue.push(await pc.issue(from));
    }
  }
  return { issues: [...seen.values()], complete: true };
}
