// A task's canonical identifier for a write record: a module's `POST /v1/writes` naming a task (ship's github.merge, no job)
// has no job row to take it from. One reader for the kernel (main.ts wires it into createWrites) and the filing tests
// (test/helpers.ts), so a test never exercises a copy that can drift from production.
import type { Api } from "./channels.ts";

/**
 * The identifier of the task at `task` (its id), as the control plane answers `GET /api/issues/<id>`. Undefined only when the
 * task is gone (404) or answers with an empty identifier: the record stays without one, so a code host's guard fails closed.
 * Any other failure — a 5xx, a timeout, a dropped connection, a body that isn't JSON, a 2xx with no issue at all — throws a
 * retryable 503 `check_failed`: an answer that only looks empty is no answer, and an identifier-less record the merge queue
 * could never land is worse than a write tried again. The error also carries the control plane's own status (`upstream`) when it
 * answered one, so a caller that must not retry forever can tell a refusal (403, 401, 422) from an outage; see identifierRefused.
 */
export function createTaskIdentifier(read: Api): (task: string) => Promise<string | undefined> {
  return async (task) => {
    const unavailable = (why: string, upstream?: number) => Object.assign(new Error(`control plane GET task ${task} failed (${why}): nothing was filed; try again`), { status: 503, type: "check_failed", ...(upstream ? { upstream } : {}) });
    let body: unknown;
    try {
      const r = await read("GET", `/api/issues/${encodeURIComponent(task)}`);
      if (r.status === 404) return undefined;
      if (r.status < 200 || r.status >= 300) throw unavailable(`it answered ${r.status}`, r.status);
      body = r.json;
    } catch (e) {
      throw (e as { type?: string })?.type === "check_failed" ? e : unavailable(String((e as Error)?.message ?? e).slice(0, 200));
    }
    // A task answers with its issue (its id at least). Anything else — null, a list, an error object — is no issue read, so it
    // is the same retryable refusal, never a silent "no identifier".
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { id?: unknown }).id !== "string") throw unavailable("it answered without an issue");
    const identifier = (body as { identifier?: unknown }).identifier;
    return typeof identifier === "string" && identifier ? identifier : undefined;
  };
}

/**
 * The control plane refused the read rather than failing it: it answered a 4xx that a later try will not fix (a 403, 401 or
 * 422; a 429, 408 or 425 is a rate limit or a timeout). The read is still retryable for a filing, but a record already claimed
 * has no later path — the kernel's reconciliation only reads the claims from before it started — so it must end its lookup
 * instead of promising an identifier that nothing will record.
 */
export const identifierRefused = (e: unknown): boolean => {
  const upstream = Number((e as { upstream?: number })?.upstream);
  return upstream >= 400 && upstream < 500 && ![408, 425, 429].includes(upstream);
};
