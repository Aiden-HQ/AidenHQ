// The one Paperclip HTTP client: a bearer, a timeout, JSON in and out, and a PaperclipError (status, parsed body) on a non-2xx.
// The credential is the caller's, and only the kernel holds a Paperclip key: a module or the board reaches the control plane
// through the kernel with its own token, by lane (kernel/src/cp.ts): "owner" reads at /v1/cp/read and writes at /v1/cp/owner
// (the board's key), "agent" at /v1/cp/agent (a module acting as the job it serves; `headers` carries its assertion). "direct"
// is for a caller that holds a Paperclip key itself (a host script, a module not yet behind the kernel). Domain methods and
// caches stay with the caller. Copied into each caller (scripts/sync-shared.mjs).
export type PaperclipLane = "owner" | "agent" | "direct";

export class PaperclipError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) { super(message); this.status = status; this.body = body; }
}

export interface PaperclipOptions {
  url: string;
  token: string;
  lane: PaperclipLane;
  /** Per call: what a lane adds to the request (the caller's assertion, the signed-in admin of a write). */
  headers?: (method: string) => Record<string, string>;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

/** Paperclip's `error` field, else the start of the body. */
function errorMessage(text: string): string {
  try { return (JSON.parse(text) as { error?: string }).error ?? text.slice(0, 300); } catch { return text.slice(0, 300); }
}

export function paperclipClient({ url, token, lane, headers, timeoutMs = 20_000, fetcher = fetch }: PaperclipOptions) {
  const prefix = (method: string) => (lane === "owner" ? (method === "GET" ? "/v1/cp/read" : "/v1/cp/owner") : lane === "agent" ? "/v1/cp/agent" : "");
  /** The raw response, for a body that isn't JSON (an upload's form, a file's bytes). */
  const send = (method: string, path: string, init: { body?: BodyInit; type?: string; timeoutMs?: number } = {}): Promise<Response> =>
    fetcher(new URL(`${prefix(method)}${path}`, url), {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.type ? { "content-type": init.type } : {}), ...headers?.(method) },
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? timeoutMs),
    });
  const fail = async (res: Response, method: string, path: string): Promise<never> => {
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    throw new PaperclipError(`Paperclip ${method} ${path.split("?")[0]} → ${res.status}: ${errorMessage(text)}`, res.status, body);
  };
  return {
    send,
    async request<T = any>(method: string, path: string, body?: unknown, o: { timeoutMs?: number } = {}): Promise<T> {
      const res = await send(method, path, { ...(body !== undefined ? { body: JSON.stringify(body), type: "application/json" } : {}), ...o });
      if (!res.ok) return fail(res, method, path);
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    },
    /** A multipart upload (`form`), answered as JSON. */
    async upload<T = any>(path: string, form: FormData, o: { timeoutMs?: number } = {}): Promise<T> {
      const res = await send("POST", path, { body: form, ...o });
      if (!res.ok) return fail(res, "POST", path);
      return (await res.json()) as T;
    },
    /** A file's bytes (GET). */
    async bytes(path: string, o: { timeoutMs?: number } = {}): Promise<Buffer> {
      const res = await send("GET", path, o);
      if (!res.ok) return fail(res, "GET", path);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
export type PaperclipClient = ReturnType<typeof paperclipClient>;
