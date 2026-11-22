import { GitHubNeed } from "./client.js";

// Whether a bearer is the named module's own token, asked of the kernel (GET /v1/whoami): the issue read for the Maintainer's
// watcher is opened to that module alone, so no secret is shared with it. undefined: the kernel couldn't answer now (a restart,
// a timeout, a 5xx), which a caller answers as 503 (try again), never as the 401 of a token the kernel refused.
export async function isModule(kernelUrl: string, authorization: string, module: string, fetcher: typeof fetch = fetch): Promise<boolean | undefined> {
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return false;
  try {
    const r = await fetcher(new URL("/v1/whoami", kernelUrl), { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return r.status === 401 || r.status === 403 ? false : undefined;
    const who = (await r.json()) as { kind?: string; module?: string };
    return who.kind === "module" && who.module === module;
  } catch {
    return undefined;
  }
}

/**
 * A GitHub need only the owner can fix, met outside a tool call (code review's post reaches this process directly), told to the
 * kernel as the connection's need (POST /v1/connections/need) so it is routed like any tool call's. Never throws: true when the
 * kernel took it (or there was nothing to report), false when the report failed and has to be sent again.
 */
export async function reportNeed(kernelUrl: string, key: string, err: unknown, log: { warn: (o: object, m: string) => void } = { warn: () => {} }, fetcher: typeof fetch = fetch, timeoutMs = 5_000): Promise<boolean> {
  if (!(err instanceof GitHubNeed) || !err.ownerFixable) return true;
  const n = err.need;
  const need = { cause: n.cause, detail: err.message, ...(n.cause === "scope" ? { scope: n.scope } : {}), ...(n.cause === "sso" || n.cause === "restricted" ? { org: n.org, url: n.url } : {}) };
  try {
    const r = await fetcher(new URL("/v1/connections/need", kernelUrl), { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ connection: "github", need }), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) { log.warn({ status: r.status, cause: n.cause }, "the kernel refused a connection need report"); return false; }
    return true;
  } catch (e) {
    log.warn({ err: (e as Error).message, cause: n.cause }, "a connection need report failed");
    return false;
  }
}

/** How long a reply waits for the kernel to take a need: the route answers within its 1 s even when the kernel is slow. */
const NEED_WAIT_MS = 1_000;
const PENDING_MAX = 20;
const needKey = (n: GitHubNeed["need"]) => { const f = n as { scope?: string; org?: string; account?: string }; return [n.cause, f.scope ?? "", f.org ?? "", f.account ?? ""].join("\u0000"); };

/**
 * The needs this process has to report outside a tool call. `tell` waits NEED_WAIT_MS for the kernel and keeps one it didn't take;
 * `flush` (the start of every request) retries the kept ones, so an apply recreating the container in that window loses nothing.
 * In memory only: a need is retried seconds after it was met, so a process that dies before then is the only gap left.
 */
export function needQueue(o: { kernelUrl: string; key: () => string; log: { warn: (o: object, m: string) => void }; fetcher?: typeof fetch; waitMs?: number }) {
  const waitMs = o.waitMs ?? NEED_WAIT_MS;
  const pending = new Map<string, GitHubNeed>();
  let flushing = false;
  const flush = async (): Promise<void> => {
    if (flushing || !pending.size) return;
    flushing = true;
    try {
      for (const [k, err] of pending) {
        pending.delete(k);
        const ok = await reportNeed(o.kernelUrl, o.key(), err, o.log, o.fetcher, 5_000).catch(() => false);
        if (!ok) pending.set(k, err);
      }
    } finally { flushing = false; }
  };
  return {
    /** Report now, bounded; a report that failed or timed out is kept for `flush`. */
    tell: async (err: unknown): Promise<void> => {
      if (!(err instanceof GitHubNeed) || !err.ownerFixable) return;
      const ok = await reportNeed(o.kernelUrl, o.key(), err, o.log, o.fetcher, waitMs).catch(() => false);
      if (ok) return;
      pending.set(needKey(err.need), err);
      while (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value!);
    },
    flush,
    pending: () => pending.size,
  };
}
