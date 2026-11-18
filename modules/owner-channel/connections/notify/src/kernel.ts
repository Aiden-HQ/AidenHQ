// The kernel's routes this router uses, with its own token (its connection's service key): the queued owner messages, the
// send to one channel's transport, control-plane reads, the loop brake, and an agent's reply posted as that agent.
import type { Message } from "./notify.js";

export function kernelClient(url: string, token: string, f: typeof fetch = fetch) {
  const base = url.replace(/\/$/, "");
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(40_000),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} -> ${r.status}`);
    return r.json;
  };
  return {
    /** A read of the control plane (GET only), e.g. read("/api/issues/WOR-1"). */
    read: (path: string): Promise<any> => ok("GET", `/v1/cp/read${path}`),
    /** The owner messages the kernel, the board and the runner queued, each handed over once. */
    take: async (): Promise<any[]> => ((await ok("GET", "/v1/notify/take")).messages ?? []) as any[],
    /** One message to one channel's transport; a channel that isn't installed is off. */
    send: async (to: string, message: Message): Promise<{ sent: boolean; off?: boolean }> => {
      const r = await call("POST", "/v1/notify/send", { to, message });
      if (r.status === 404) return { sent: false, off: true };
      if (r.status !== 200) throw new Error(`POST /v1/notify/send -> ${r.status}`);
      return { sent: r.json.sent === true, off: r.json.off === true };
    },
    brake: (task: string, agent: string, decision: boolean): Promise<{ allow: boolean; note?: string }> => ok("POST", "/v1/brake/notify", { task, agent, ...(decision ? { decision: true } : {}) }),
    /** The agent's reply on its chat, posted by the kernel as that agent (this call's assertion). */
    postReply: async (issueId: string, body: string, assertion: string): Promise<boolean> => {
      const r = await call("POST", `/v1/cp/agent/api/issues/${encodeURIComponent(issueId)}/comments`, { body }, { "x-aidenhq-caller": assertion }).catch(() => ({ status: 0 }));
      return r.status >= 200 && r.status < 300;
    },
  };
}
export type Kernel = ReturnType<typeof kernelClient>;
