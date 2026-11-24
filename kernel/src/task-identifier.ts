// A task's canonical identifier for a write record: a module's `POST /v1/writes` naming a task (ship's github.merge, no job)
// has no job row to take it from. One reader for the kernel (main.ts wires it into createWrites) and the filing tests
// (test/helpers.ts), so a test never exercises a copy that can drift from production.
import type { Api } from "./channels.ts";

/**
 * The identifier of the task at `task` (its id), as the control plane answers `GET /api/issues/<id>`. Undefined when the task
 * answers with none (404, or an empty identifier): the record stays without one, so a code host's guard fails closed. Any
 * other failure — a 5xx, a timeout, a dropped connection, a body that isn't JSON — throws a retryable 503 `check_failed`: an
 * identifier-less record the merge queue can never land is worse than a write tried again.
 */
export function createTaskIdentifier(read: Api): (task: string) => Promise<string | undefined> {
  return async (task) => {
    const unavailable = (why: string) => Object.assign(new Error(`control plane GET task ${task} failed (${why}): nothing was filed; try again`), { status: 503, type: "check_failed" });
    let body: unknown;
    try {
      const r = await read("GET", `/api/issues/${encodeURIComponent(task)}`);
      if (r.status === 404) return undefined;
      if (r.status < 200 || r.status >= 300) throw unavailable(`it answered ${r.status}`);
      body = r.json;
    } catch (e) {
      throw (e as { type?: string })?.type === "check_failed" ? e : unavailable(String((e as Error)?.message ?? e).slice(0, 200));
    }
    // A body that isn't an issue (null, a list) names no identifier: the task answered, without one.
    const identifier = body && typeof body === "object" && !Array.isArray(body) ? (body as { identifier?: unknown }).identifier : undefined;
    return typeof identifier === "string" && identifier ? identifier : undefined;
  };
}
