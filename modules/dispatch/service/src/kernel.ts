// Every kernel call the dispatch module makes, with its own module token (roles kernel.jobs and kernel.cp-read): it holds no
// other credential, reads Paperclip only through the kernel's read routes and writes to tasks only through the kernel.
import type { Step } from "./progress.ts";
import { KernelError, kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import type { Agent, Comment, Directory, Issue } from "./thread.ts";

/** An inbox row the module claimed (kernel wakes.ts); `live_job`: a comment for that running job. */
export interface Wake { key: string; task: string; agent: string; cause: string; at: number; live_job?: string }
/** A job as the kernel shows it (jobs.ts JobView, the fields dispatch reads). */
/** `refused`, and a coded refusal's rule code with the kind asked for and that kind's module (kernel/src/jobs.ts JobView. `refusedKind` is the kind, not the module: another of the module's kinds could return the same code). */
export interface JobView { id: string; task: string; agent: string; state: string; exit: number | null; final: string; session: string | null; /** Its profile, frozen at admission (a `session` lives on). */ profile?: string | null; timedOut: boolean; cancelled: boolean; /** The account that stopped it (the owner's Stop); null when the machinery stopped it (or it wasn't stopped). */ stoppedBy: string | null; at: number; ended: number | null; acked: boolean; refused?: string; refusedCode?: string; refusedKind?: string; refusedSource?: string; progress?: { steps?: Step[] } }

/** A connection the owner has to fix (kernel connection-state.ts): `connection` is the agent-facing key, `module` the one the owner connects. */
export interface Down { connection: string; module: string; cause: string; account?: string; since: string }

export interface Kernel {
  claim(limit: number): Promise<Wake[]>;
  drop(key: string, why: string): Promise<void>;
  task(id: string): Promise<Issue>;
  /** A task's comments, oldest first: the newest 200, or with `after` (a comment id; "" for the first) up to 500 from there on. */
  comments(task: string, after?: string): Promise<Comment[]>;
  agent(id: string): Promise<Agent | undefined>;
  directory(): Promise<Directory>;
  /** Admission (F3): one job for the claimed wake (`full_prompt`: what runs when no session is resumed), or busy (429: the wake stays claimed and comes back). */
  start(req: { wake: string; prompt: string; full_prompt?: string; saw?: string }): Promise<{ job: JobView } | { busy: true }>;
  /** This module's jobs the kernel keeps open for it: live, or ended and not yet acknowledged. */
  open(): Promise<JobView[]>;
  /** This module's jobs on a task, newest first. */
  jobsOf(task: string): Promise<JobView[]>;
  /** An ended job is dealt with (its outcome posted, whoever asked told): it leaves the open list. */
  ack(job: string): Promise<void>;
  /** A comment into a running job; the wake is delivered only when `sent`. */
  input(job: string, b: { text: string; from: string; wake: string; comment?: string }): Promise<{ sent: boolean }>;
  /** A job's outcome on its task, posted by the kernel as the agent, once per (job, kind) (F5). */
  post(job: string, b: { kind: "reply" | "notice" | "status"; body: string; status?: string; blocked_by?: string[] }): Promise<void>;
  /** Stop a running job (its task was closed under it). */
  stop(job: string): Promise<void>;
  /** A company's tasks by control-plane query (the open ones of a routine, say). */
  issues(company: string, query: string): Promise<Issue[]>;
  /** Whether the kernel holds a wake for the task still waiting to start a job (routines.ts: a run in flight); `retry`: only that run's own restart (`retry.<job>`); `except`: one being dropped now. */
  wakePending(task: string, o?: { retry?: string; except?: string }): Promise<boolean>;
  /** A routine's definition (its concurrency policy). */
  routine(id: string): Promise<{ concurrencyPolicy?: string }>;
  /** Cancel a routine run's task as its agent: folded into an earlier run (`coalesced`), or overtaken by a later one (`stale`). */
  cancelRoutineRun(task: string, why: "coalesced" | "stale", body: string): Promise<void>;
  /** A task's sub-tasks, any status. */
  children(parent: string, company: string): Promise<Issue[]>;
  /** A labelled wake notice on a task (role kernel.wake): it wakes the task's agent, as a module's words. `id`: the producer's own key, so a retry after a lost answer files it once. */
  wake(task: string, text: string, id?: string): Promise<void>;
  /** A scheduled wake for `agent` (default: the task's assignee) at `at` (role kernel.wake; once per `id`): a run that stopped is tried again. */
  schedule(b: { task: string; agent?: string; at: number; cause: string; id: string }): Promise<void>;
  /** A task of this module's fixed text for an agent (role kernel.tasks), once per source; 409 when it is paused or gone. */
  fileTask(b: { agent: string; title: string; description: string; source: string }): Promise<{ id: string } | void>;
  /**
   * A comment on a task this module filed, as its agent: a card keeps its first words and takes later reasons here. False when the
   * task is closed (it takes no comment and is not reopened), so the caller can say it where the reader already is.
   */
  commentTask(task: string, body: string): Promise<boolean>;
  /** A message for the owner through the one notify (role kernel.owner-notice). */
  notify(b: { kind: "decision"; text: string; task?: string; dedupe_key: string }): Promise<void>;
  /** The connections `agent` is granted that are down now (role kernel.jobs); the prompt lists them. */
  connectionsDown(agent: string): Promise<Down[]>;
  /** A note on a task with no job behind it (a redirect, a missing request), posted as the agent, once per wake. */
  note(wake: string, body: string): Promise<void>;
}

export { KernelError };

export function createKernel(url: string, token: string, fetcher: typeof fetch = fetch): Kernel {
  const { call } = kernelClient(url, token, { fetcher });
  const e = encodeURIComponent;
  return {
    claim: async (limit) => (await call("POST", "/v1/wakes/claim", { limit })).wakes ?? [],
    drop: async (key, why) => void (await call("POST", `/v1/wakes/${e(key)}/drop`, { why })),
    task: (id) => call("GET", `/v1/cp/read/api/issues/${e(id)}`),
    comments: async (task, after) => (after === undefined
      ? ((await call("GET", `/v1/cp/read/api/issues/${e(task)}/comments?order=desc&limit=200`)) as Comment[]).reverse()
      : call("GET", `/v1/cp/read/api/issues/${e(task)}/comments?order=asc&limit=500${after ? `&after=${e(after)}` : ""}`)),
    agent: (id) => call("GET", `/v1/cp/read/api/agents/${e(id)}`).catch((err: KernelError) => (err.status === 404 ? undefined : Promise.reject(err))),
    directory: async () => (await call("GET", "/v1/agents")).agents ?? {},
    start: (req) => call("POST", "/v1/jobs", req).then((job) => ({ job }), (err: KernelError) => (err.status === 429 ? { busy: true as const } : Promise.reject(err))),
    open: async () => (await call("GET", "/v1/jobs?open=1")).jobs ?? [],
    jobsOf: async (task) => (await call("GET", `/v1/jobs?task=${e(task)}`)).jobs ?? [],
    ack: async (job) => void (await call("POST", `/v1/jobs/${e(job)}/ack`, {})),
    input: (job, b) => call("POST", `/v1/jobs/${e(job)}/input`, b),
    post: async (job, b) => void (await call("POST", `/v1/jobs/${e(job)}/post`, b)),
    stop: async (job) => void (await call("DELETE", `/v1/jobs/${e(job)}`)),
    issues: (company, query) => call("GET", `/v1/cp/read/api/companies/${e(company)}/issues?${query}`),
    wakePending: async (task, o) => Boolean((await call("GET", `/v1/wakes/pending?task=${e(task)}${o?.retry ? `&retry=${e(o.retry)}` : ""}${o?.except ? `&except=${e(o.except)}` : ""}`)).pending),
    routine: (id) => call("GET", `/v1/cp/read/api/routines/${e(id)}`),
    cancelRoutineRun: async (task, why, body) => void (await call("POST", "/v1/routines/cancel", { task, why, body })),
    // A child parked in backlog still counts: it is a task of this batch, and a summary that left it out would misreport the batch.
    children: (parent, company) => call("GET", `/v1/cp/read/api/companies/${e(company)}/issues?parentId=${e(parent)}&status=todo,in_progress,in_review,blocked,backlog,done,cancelled&limit=200`).then((l: Issue[]) => l.filter((i) => i.parentId === parent)),
    wake: async (task, text, id) => void (await call("POST", "/v1/wakes", { task, text, ...(id ? { id } : {}) })),
    schedule: async (b) => void (await call("POST", "/v1/wakes", b)),
    fileTask: async (b) => await call("POST", "/v1/tasks", b),
    commentTask: async (task, body) => Boolean((await call("POST", `/v1/tasks/${e(task)}/comment`, { body }))?.comment),
    notify: async (b) => void (await call("POST", "/v1/notify", b)),
    connectionsDown: async (agent) => (await call("GET", `/v1/connections/down?agent=${e(agent)}`)).down ?? [],
    note: async (wake, body) => void (await call("POST", `/v1/wakes/${e(wake)}/note`, { body })),
  };
}
