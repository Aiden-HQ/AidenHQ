// Every kernel call the dispatch module makes, with its own module token (roles kernel.jobs and kernel.cp-read): it holds no
// other credential, reads Paperclip only through the kernel's read routes and writes to tasks only through the kernel.
import type { Step } from "./progress.ts";
import { KernelError, kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import type { Agent, Comment, Directory, Issue } from "./thread.ts";

/** An inbox row the module claimed (kernel wakes.ts); `live_job`: a comment for that running job. */
export interface Wake { key: string; task: string; agent: string; cause: string; at: number; live_job?: string }
/** A job as the kernel shows it (jobs.ts JobView, the fields dispatch reads). */
export interface JobView { id: string; task: string; agent: string; state: string; exit: number | null; final: string; session: string | null; timedOut: boolean; at: number; ended: number | null; acked: boolean; progress?: { steps?: Step[] } }

export interface Kernel {
  claim(limit: number): Promise<Wake[]>;
  drop(key: string, why: string): Promise<void>;
  task(id: string): Promise<Issue>;
  comments(task: string): Promise<Comment[]>;
  agent(id: string): Promise<Agent | undefined>;
  directory(): Promise<Directory>;
  /** Admission (F3): one job for the claimed wake (`full_prompt`: what runs when no session is resumed), or busy (429: the wake stays claimed and comes back). */
  start(req: { wake: string; prompt: string; full_prompt?: string }): Promise<{ job: JobView } | { busy: true }>;
  /** This module's jobs the kernel keeps open for it: live, or ended and not yet acknowledged. */
  open(): Promise<JobView[]>;
  /** This module's jobs on a task, newest first. */
  jobsOf(task: string): Promise<JobView[]>;
  /** An ended job is dealt with (its outcome posted, whoever asked told): it leaves the open list. */
  ack(job: string): Promise<void>;
  /** A comment into a running job; the wake is delivered only when `sent`. */
  input(job: string, b: { text: string; from: string; wake: string }): Promise<{ sent: boolean }>;
  /** A job's outcome on its task, posted by the kernel as the agent, once per (job, kind) (F5). */
  post(job: string, b: { kind: "reply" | "notice"; body: string }): Promise<void>;
  /** Stop a running job (its task was closed under it). */
  stop(job: string): Promise<void>;
  /** A task's sub-tasks, any status. */
  children(parent: string, company: string): Promise<Issue[]>;
  /** A labelled wake notice on a task (role kernel.wake): it wakes the task's agent, as a module's words. */
  wake(task: string, text: string): Promise<void>;
  /** A task of this module's fixed text for an agent (role kernel.tasks), once per source; 409 when it is paused or gone. */
  fileTask(b: { agent: string; title: string; description: string; source: string }): Promise<void>;
  /** A message for the owner through the one notify (role kernel.owner-notice). */
  notify(b: { kind: "decision"; text: string; task: string; dedupe_key: string }): Promise<void>;
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
    comments: async (task) => ((await call("GET", `/v1/cp/read/api/issues/${e(task)}/comments?order=desc&limit=200`)) as Comment[]).reverse(),
    agent: (id) => call("GET", `/v1/cp/read/api/agents/${e(id)}`).catch((err: KernelError) => (err.status === 404 ? undefined : Promise.reject(err))),
    directory: async () => (await call("GET", "/v1/agents")).agents ?? {},
    start: (req) => call("POST", "/v1/jobs", req).then((job) => ({ job }), (err: KernelError) => (err.status === 429 ? { busy: true as const } : Promise.reject(err))),
    open: async () => (await call("GET", "/v1/jobs?open=1")).jobs ?? [],
    jobsOf: async (task) => (await call("GET", `/v1/jobs?task=${e(task)}`)).jobs ?? [],
    ack: async (job) => void (await call("POST", `/v1/jobs/${e(job)}/ack`, {})),
    input: (job, b) => call("POST", `/v1/jobs/${e(job)}/input`, b),
    post: async (job, b) => void (await call("POST", `/v1/jobs/${e(job)}/post`, b)),
    stop: async (job) => void (await call("DELETE", `/v1/jobs/${e(job)}`)),
    children: (parent, company) => call("GET", `/v1/cp/read/api/companies/${e(company)}/issues?parentId=${e(parent)}&status=todo,in_progress,in_review,blocked,done,cancelled&limit=200`).then((l: Issue[]) => l.filter((i) => i.parentId === parent)),
    wake: async (task, text) => void (await call("POST", "/v1/wakes", { task, text })),
    fileTask: async (b) => void (await call("POST", "/v1/tasks", b)),
    notify: async (b) => void (await call("POST", "/v1/notify", b)),
    note: async (wake, body) => void (await call("POST", `/v1/wakes/${e(wake)}/note`, { body })),
  };
}
