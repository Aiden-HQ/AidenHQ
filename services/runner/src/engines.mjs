// The runner's side of jobs: the kernel runs them (kernel/src/jobs.ts, the sandbox in kernel/src/sandbox.ts). The runner, as the
// engineering module's dispatcher (role kernel.jobs, its own token), asks for one (POST /v1/jobs) and follows it to its end
// (GET /v1/jobs/:id); a box job's box comes from the computer launcher first (its job routes, computers_runner_key).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export { cowRoot, engineState, jobcapServers, jobcapsFor, jobToken, modelToken, observes, readEngines, removeLayers, viaGateway } from "../../../kernel/src/sandbox.ts";

export const gatewayUrl = (cfg) => cfg.gatewayUrl ?? "http://127.0.0.1:8201";
export const gatewayApi = (cfg) => `${gatewayUrl(cfg)}/api/v1`;

/** The runner's client for the launcher's job routes (bearer computers_runner_key). Rejects with `status` on an error answer. */
export function launcher(cfg) {
  return async (route, body) => {
    let key = "";
    try { key = readFileSync(cfg.computersRunnerKeyFile, "utf8").trim(); } catch {}
    const r = await fetch(`${cfg.launcherUrl}${route}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`launcher ${route}: ${out.error ?? r.status}`), { status: r.status });
    return out;
  };
}

/**
 * Destroy a job's box and wait until Docker says it is gone: killing the `docker exec` client stops nothing inside the box, so
 * nothing may inspect, sign or clean the workspace before this resolves. Retried (launcher down, Docker slow); throws if the box
 * can't be confirmed gone in time (the lease then reaps it within 15 minutes).
 */
export async function releaseBox(call, container, { everyMs = Number(process.env.AIDENHQ_BOX_RELEASE_RETRY_MS) || 2000, forMs = 20 * 60_000 } = {}) {
  let last = "";
  for (const end = Date.now() + forMs; ; ) {
    const r = await call("/job/release", { container }).catch((e) => ({ error: e.message }));
    if (r.state === "missing") return;
    last = r.error ?? `state ${r.state}`;
    if (Date.now() > end) throw new Error(`the job's box ${container} couldn't be confirmed gone (${last}); its workspace stays untouched until it is`);
    await new Promise((res) => setTimeout(res, everyMs));
  }
}

/** The kernel's job routes with the engineering module's own token (vault `engineering_token`). Errors carry `status`. */
export function kernelJobs(cfg) {
  const call = async (method, path, body, timeoutMs = 60_000) => {
    let token = "";
    try { token = readFileSync(join(cfg.secretsDir, "engineering_token"), "utf8").trim(); } catch {}
    const r = await fetch(`${cfg.kernelUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(String(out?.error?.message ?? `the kernel answered ${r.status}`).slice(0, 500)), { status: r.status });
    return out;
  };
  return {
    start: (body) => call("POST", "/v1/jobs", body),
    get: (id, after = -1, waitMs = 0) => call("GET", `/v1/jobs/${id}?after=${after}&wait=${waitMs}`, undefined, waitMs + 30_000),
    stop: (id) => call("DELETE", `/v1/jobs/${id}`),
    /** A comment into the run while it works: true when it went in. */
    input: (id, text) => call("POST", `/v1/jobs/${id}/input`, { text: String(text), from: "owner" }).then((r) => r.sent === true, () => false),
  };
}

/**
 * Follow a kernel job to its end. Resolves with { code, sessionId, lastMessage, timedOut, stalled, stopped, cancelled, usage,
 * lost }, or { detached: true } once `detach` aborts (the runner is restarting: the job goes on, and the next runner follows it).
 * `signal` stops the job. `onProgress({ said, saidAt, plan, steps })` gets the agent's latest words, task list and tool calls.
 * A kernel that doesn't answer (it is restarting too) is asked again; the job doesn't depend on either process.
 */
export function followJob(api, id, { signal, detach, onProgress, log = () => {} }) {
  return new Promise((resolve) => {
    let version = -1;
    let said = "";
    let stopping;
    const asked = () => (stopping ??= (async () => { for (let i = 0; i < 30; i++) { try { return await api.stop(id); } catch { await new Promise((r) => setTimeout(r, 2000)); } } })());
    const onAbort = () => void asked();
    signal?.addEventListener("abort", onAbort);
    const end = (out) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(out);
    };
    (async () => {
      while (true) {
        if (detach?.aborted) return end({ detached: true });
        let v;
        try {
          v = await api.get(id, version, 20_000);
        } catch (err) {
          if (detach?.aborted) return end({ detached: true });
          if (err.status === 404) return end({ code: null, lost: true, lastMessage: "" });
          log("job status unavailable; asking again", { job: id, err: String(err.message ?? err).slice(0, 200) });
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (v.version !== version) {
          version = v.version;
          const p = v.progress ?? {};
          const key = JSON.stringify(p);
          if (key !== said) (said = key), onProgress?.(p);
        }
        if (signal?.aborted) await asked();
        if (v.state !== "running") {
          return end({
            code: v.exit, sessionId: v.session ?? undefined, lastMessage: v.final ?? "", timedOut: v.timedOut, stalled: v.stalled,
            ...(v.stopped ? { stopped: v.stopped } : {}), cancelled: v.cancelled, lost: v.state === "lost",
            ...(v.usage ? { usage: { ...v.usage, costUsd: null } } : {}),
          });
        }
      }
    })();
  });
}
