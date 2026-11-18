// The one client a module uses to call the kernel (and, through its /v1/cp/read route, the control plane): its own token as
// a bearer, a timeout, JSON in and out. `call` returns the body and throws a KernelError (with the status) on a non-2xx;
// `raw` returns {status, json} for a caller that reads the status itself; `bytes` returns a GET's raw body. Copied into each
// module that calls the kernel (scripts/sync-shared.mjs).
export class KernelError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function kernelClient(url: string, token: string, { timeoutMs = 30_000, fetcher = fetch }: { timeoutMs?: number; fetcher?: typeof fetch } = {}) {
  const base = url.replace(/\/$/, "");
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetcher(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
  const raw = async (method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }> => {
    const r = await send(method, path, body, headers);
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<any> => {
    const r = await raw(method, path, body, headers);
    if (r.status < 200 || r.status >= 300) throw new KernelError(r.status, `kernel ${method} ${path} → ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    return r.json;
  };
  return {
    call, raw,
    /** A read of the control plane (GET only), e.g. read("/api/issues/WOR-1"). */
    read: (path: string): Promise<any> => call("GET", `/v1/cp/read${path}`),
    bytes: async (path: string): Promise<Buffer> => {
      const r = await send("GET", path);
      if (!r.ok) throw new KernelError(r.status, `kernel GET ${path} → ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}
export type KernelClient = ReturnType<typeof kernelClient>;
