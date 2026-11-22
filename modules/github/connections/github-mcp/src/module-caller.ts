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
 * kernel as the connection's need (POST /v1/connections/need) so it is routed like any tool call's. Never throws.
 */
export async function reportNeed(kernelUrl: string, key: string, err: unknown, log: { warn: (o: object, m: string) => void } = { warn: () => {} }, fetcher: typeof fetch = fetch): Promise<void> {
  if (!(err instanceof GitHubNeed) || !err.ownerFixable) return;
  const n = err.need;
  const need = { cause: n.cause, detail: err.message, ...(n.cause === "scope" ? { scope: n.scope } : {}), ...(n.cause === "sso" || n.cause === "restricted" ? { org: n.org, url: n.url } : {}) };
  try {
    const r = await fetcher(new URL("/v1/connections/need", kernelUrl), { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ connection: "github", need }), signal: AbortSignal.timeout(5_000) });
    if (!r.ok) log.warn({ status: r.status, cause: n.cause }, "the kernel refused a connection need report");
  } catch (e) {
    log.warn({ err: (e as Error).message, cause: n.cause }, "a connection need report failed");
  }
}
