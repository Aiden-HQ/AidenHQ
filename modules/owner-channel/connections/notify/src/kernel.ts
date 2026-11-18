// The kernel's routes this router uses, with its own token (its connection's service key): the queued owner messages, the
// send to one channel's transport, control-plane reads, a task's kernel jobs, the loop brake, and an agent's reply posted as that agent.
import { kernelClient as baseClient } from "./aidenhq-sdk/kernel-client.js";
import type { Message } from "./notify.js";

export function kernelClient(url: string, token: string, f: typeof fetch = fetch) {
  const { call, raw, read } = baseClient(url, token, { timeoutMs: 40_000, fetcher: f });
  return {
    read,
    /** The owner messages the kernel, the board and the runner queued, each handed over once. */
    take: async (): Promise<any[]> => ((await call("GET", "/v1/notify/take")).messages ?? []) as any[],
    /** One message to one channel's transport; a channel that isn't installed is off. */
    send: async (to: string, message: Message): Promise<{ sent: boolean; off?: boolean }> => {
      const r = await raw("POST", "/v1/notify/send", { to, message });
      if (r.status === 404) return { sent: false, off: true };
      if (r.status !== 200) throw new Error(`POST /v1/notify/send -> ${r.status}`);
      return { sent: r.json.sent === true, off: r.json.off === true };
    },
    /** A task's kernel jobs, newest first (the job ledger). */
    /** The kernel's running and recently ended jobs (the watcher's health check). */
    activity: async (): Promise<{ recent: { agent: string; task: string; state: string; ended_at: string | null }[] }> => call("GET", "/v1/work"),
    work: async (task: string): Promise<{ jobs: { agent: string; state: string }[] }> => call("GET", `/v1/work?task=${encodeURIComponent(task)}`),
    brake: (task: string, agent: string, decision: boolean): Promise<{ allow: boolean; note?: string }> => call("POST", "/v1/brake/notify", { task, agent, ...(decision ? { decision: true } : {}) }),
    /** The agent's reply on its chat, posted by the kernel as that agent (this call's assertion). */
    postReply: async (issueId: string, body: string, assertion: string): Promise<boolean> => {
      const r = await raw("POST", `/v1/cp/agent/api/issues/${encodeURIComponent(issueId)}/comments`, { body }, { "x-aidenhq-caller": assertion }).catch(() => ({ status: 0 }));
      return r.status >= 200 && r.status < 300;
    },
  };
}
export type Kernel = ReturnType<typeof kernelClient>;
