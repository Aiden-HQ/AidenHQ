// The one client a module uses to call the kernel (and, through its /v1/cp/read route, the control plane): its own token as
// a bearer, a timeout, JSON in and out. `call` returns the body and throws a KernelError (with the status) on a non-2xx;
// `raw` returns {status, json} for a caller that reads the status itself; `bytes` returns a GET's raw body and `upload` POSTs
// raw bytes (a JSON answer back). Copied into each
// module that calls the kernel (scripts/sync-shared.ts).
/** The kernel's own error body (`error.type`, `error.message`), when it sent one (admission.ts names each refusal). */
export type KernelRefusal = { type?: string; message?: string };
export class KernelError extends Error {
  status: number;
  body?: KernelRefusal;
  constructor(status: number, message: string, body?: KernelRefusal) { super(message); this.status = status; this.body = body; }
}

export function kernelClient(url: string, token: string, { timeoutMs = 30_000, fetcher = fetch }: { timeoutMs?: number; fetcher?: typeof fetch } = {}) {
  const base = url.replace(/\/$/, "");
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetcher(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
  const raw = async (method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }> => {
    const r = await send(method, path, body, headers);
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  // The kernel answers a refusal as {error: {code, type, message}} (backplane.ts): keep its type and words for the caller.
  const refusalBody = (j: any): KernelRefusal | undefined => (j?.error && typeof j.error === "object" ? { ...(typeof j.error.type === "string" ? { type: j.error.type } : {}), ...(typeof j.error.message === "string" ? { message: j.error.message } : {}) } : undefined);
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<any> => {
    const r = await raw(method, path, body, headers);
    if (r.status < 200 || r.status >= 300) throw new KernelError(r.status, `kernel ${method} ${path} → ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`, refusalBody(r.json));
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
    upload: async (path: string, data: Buffer): Promise<any> => {
      const r = await fetcher(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: new Uint8Array(data), signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new KernelError(r.status, `kernel POST ${path} → ${r.status}: ${JSON.stringify(j).slice(0, 200)}`, refusalBody(j));
      return j;
    },
  };
}
export type KernelClient = ReturnType<typeof kernelClient>;

/** A fact a module sends the kernel (POST /v1/facts, docs/design/flow.md §2). The kernel sets the actor; never send one. */
export type FactIn = { type: string; subject: string; version: string; at: string; task?: string | null; source?: "live" | "backfill"; data?: Record<string, unknown> };

/**
 * A module's fact emitter: `emit` queues and returns at once; the queue is sent every `everyMs` (≤ 500 per call); a batch the
 * kernel refuses (4xx) is dropped and logged, and one it couldn't take (5xx, network) is kept on a
 * failure for the next flush, so emitting never fails or slows the module's own work. Deterministic ids make resends harmless.
 * `flush` sends now (tests, shutdown); `stop` clears the timer.
 */
export function factEmitter(client: KernelClient, log: (msg: string, f?: Record<string, unknown>) => void, { everyMs = 5_000, max = 10_000 } = {}) {
  let queue: FactIn[] = [];
  let busy = false;
  async function flush() {
    if (busy || !queue.length) return;
    busy = true;
    try {
      while (queue.length) {
        const batch = queue.slice(0, 500);
        try {
          await client.call("POST", "/v1/facts", { facts: batch });
        } catch (e) {
          // The kernel refused the batch (a fact it won't take): resending can't help, so it is dropped, once, loudly.
          const status = (e as KernelError).status;
          if (!(status >= 400 && status < 500)) throw e;
          log("facts: the kernel refused a batch, dropped", { status, dropped: batch.length, error: String((e as Error).message).slice(0, 200) });
        }
        // emit() may have trimmed the queue's head during the await: drop exactly what was sent, not the first N.
        const sent = new Set(batch);
        queue = queue.filter((f) => !sent.has(f));
      }
    } catch (e) {
      log("facts: send failed, kept for the next flush", { queued: queue.length, error: String((e as Error).message).slice(0, 200) });
    } finally { busy = false; }
  }
  const timer = setInterval(() => void flush(), everyMs);
  timer.unref?.();
  return {
    /** `at` is queued as UTC (`Z`): offsets from a source never reach the log (an unparsable one is left for the kernel to refuse). */
    emit(f: FactIn) { const ms = Date.parse(f.at); queue.push(Number.isNaN(ms) ? { ...f } : { ...f, at: new Date(ms).toISOString() }); if (queue.length > max) queue = queue.slice(-max); },
    flush,
    stop: () => clearInterval(timer),
  };
}
export type FactEmitter = ReturnType<typeof factEmitter>;
