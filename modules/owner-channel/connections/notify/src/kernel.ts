// The kernel's routes this router uses, with its own token (its connection's service key): the queued owner messages, the
// send to one channel's transport, control-plane reads, a task's kernel jobs, the loop brake, and an agent's reply posted as that agent.
import { kernelClient as baseClient } from "./aidenhq-sdk/kernel-client.js";
import type { Message } from "./notify.js";

export function kernelClient(url: string, token: string, f: typeof fetch = fetch) {
  const { call, raw, read } = baseClient(url, token, { timeoutMs: 40_000, fetcher: f });
  return {
    read,
    /** The owner messages the kernel, the board and the runner queued: each comes back until it is acknowledged (`id`). */
    take: async (): Promise<any[]> => ((await call("GET", "/v1/notify/take")).messages ?? []) as any[],
    /** The taken messages this router has routed: the kernel drops them. */
    ack: async (ids: number[]): Promise<void> => { if (ids.length) await call("POST", "/v1/notify/ack", { ids }); },
    /** The connection needs confirmed down now, as digest lines (the kernel renders them; a recovered or removed one is absent). */
    connectionNeeds: async (): Promise<string[]> => ((await call("GET", "/v1/connections/needs")).lines ?? []) as string[],
    /** One message to one channel's transport; a channel that isn't installed is off. */
    send: async (to: string, message: Message): Promise<{ sent: boolean; off?: boolean }> => {
      const r = await raw("POST", "/v1/notify/send", { to, message });
      if (r.status === 404) return { sent: false, off: true };
      if (r.status !== 200) throw new Error(`POST /v1/notify/send -> ${r.status}`);
      return { sent: r.json.sent === true, off: r.json.off === true };
    },
    /** A task's kernel jobs, newest first (the job ledger). */
    /** The kernel's running and recently ended jobs (the watcher's health check). */
    activity: async (): Promise<{ recent: { agent: string; task: string; state: string; ended_at: string | null; error: string | null }[] }> => call("GET", "/v1/work"),
    work: async (task: string): Promise<{ jobs: { agent: string; state: string }[] }> => call("GET", `/v1/work?task=${encodeURIComponent(task)}`),
    brake: (task: string, agent: string, decision: boolean): Promise<{ allow: boolean; note?: string }> => call("POST", "/v1/brake/notify", { task, agent, ...(decision ? { decision: true } : {}) }),
    /**
     * The calling job's own task waits on an answer (kernel idle.ts): `question` is recorded, not sent, when it goes to the owner
     * (`to: "owner"`: this message carries it); otherwise the kernel gives it to the chief of staff. It resumes on the answer.
     */
    wait: async (task: string, assertion: string, question: string): Promise<{ to?: string; open?: boolean; since?: string }> => {
      const r = await raw("POST", "/v1/wait", { task, reason: "the answer to my question", on: "the answer", for: "owner", asked: true, question }, { "x-aidenhq-caller": assertion });
      if (r.status !== 200) throw new Error(`POST /v1/wait -> ${r.status}`);
      return { to: typeof r.json?.to === "string" ? r.json.to : undefined, ...(r.json?.asked === false ? { open: true } : {}), ...(typeof r.json?.since === "string" ? { since: r.json.since } : {}) };
    },
    /** A task for the agent holding `role` (the kernel's POST /v1/tasks, role kernel.tasks): one per `source`. */
    fileTask: async (b: { title: string; description: string; role: string; source: string }): Promise<{ id: string; deduplicated: boolean }> => call("POST", "/v1/tasks", b),
    /** A wake notice on a task (the kernel's POST /v1/wakes {task, text}): labelled, never read as the assignee's own words, and it wakes the agent; `closed` when the task is. */
    noticeTask: async (id: string, text: string): Promise<{ closed?: boolean }> => ((r) => (r.closed ? { closed: true } : {}))(await call("POST", "/v1/wakes", { task: id, text })),
    /** The agent's reply on its chat, posted by the kernel as that agent (this call's assertion). */
    postReply: async (issueId: string, body: string, assertion: string): Promise<boolean> => {
      const r = await raw("POST", `/v1/cp/agent/api/issues/${encodeURIComponent(issueId)}/comments`, { body }, { "x-aidenhq-caller": assertion }).catch(() => ({ status: 0 }));
      return r.status >= 200 && r.status < 300;
    },
  };
}
export type Kernel = ReturnType<typeof kernelClient>;
