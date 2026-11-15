// Sandbox provider worker for agent computers (from the spike). Every call goes to the host launcher,
// which owns images, limits, mounts and run tokens. The SDK is imported from the paperclip image by path (no build, no node_modules).
import { readFileSync } from "node:fs";
import { definePlugin, runWorker } from "/app/packages/plugins/sdk/dist/index.js";
import { leftInProgress } from "./status.js";
import { execute, request as call } from "./client.js";

const TOKEN = readFileSync(process.env.AIDENHQ_LAUNCHER_TOKEN_FILE || "/run/secrets/computer_launcher_token", "utf8").trim();
const cfg = (raw = {}) => ({
  timeoutMs: Number.isFinite(raw.timeoutMs) ? raw.timeoutMs : 3_600_000,
  launcherUrl: raw.launcherUrl || "http://10.231.0.1:8199",
});
// A call's target: the config plus the launcher's key (never in the config Paperclip stores).
const to = (raw) => ({ ...cfg(raw), token: TOKEN });
const meta = (container, extra = {}) => ({ provider: "aidenhq-computer", remoteCwd: "/workspace", container, ...extra });

let ctx;
// Stop: Paperclip marks the run cancelled but never interrupts a box's long exec (the Codex launch), so the box would keep
// working. The run's box is destroyed instead; the exec then fails and the run settles. run id → { container, launcherUrl }.
const runs = new Map();
const plugin = definePlugin({
  async setup(c) {
    ctx = c;
    c.events.on("agent.run.cancelled", async (e) => {
      const runId = e.payload?.runId ?? e.entityId;
      const hit = runs.get(runId);
      if (!hit) return;
      runs.delete(runId);
      await call(hit, "release", { container: hit.container, destroy: true }).catch((err) => c.logger.warn(`stop ${runId}: ${err.message}`));
      c.logger.info(`stop: run ${runId} cancelled; computer ${hit.container} destroyed`);
    });
    c.events.on("agent.run.finished", async (e) => { runs.delete(e.payload?.runId ?? e.entityId); });
    // A failed or timed-out run's exec may still be running in its box (the host only kills its own docker exec client): destroy it.
    c.events.on("agent.run.failed", async (e) => {
      const runId = e.payload?.runId ?? e.entityId;
      const hit = runs.get(runId);
      runs.delete(runId);
      if (hit) await call(hit, "release", { container: hit.container, destroy: true }).catch(() => {});
    });
    c.logger.info("aidenhq-computer provider ready");
  },
  async onHealth() { return { status: "ok", message: "aidenhq-computer ok" }; },
  async onEnvironmentValidateConfig(p) { return { ok: true, normalizedConfig: { reuseLease: p.config?.reuseLease !== false, ...cfg(p.config) } }; },
  async onEnvironmentProbe(p) {
    const r = await fetch(`${cfg(p.config).launcherUrl}/health`).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (!r.ok) throw new Error(`computer launcher unreachable: ${r.error ?? "no answer"}`);
    return { ok: true, summary: `launcher up (${r.computers}/${r.max} computers)`, metadata: { provider: "aidenhq-computer" } };
  },
  // Always a new box: Paperclip itself resumes a warm one for the same agent and task (its lease matching), never across tasks.
  async onEnvironmentAcquireLease(p) {
    const r = await call(to(p.config), "acquire", { agentId: p.agentId });
    return { providerLeaseId: r.container, metadata: meta(r.container, { agentId: p.agentId, image: r.image }) };
  },
  async onEnvironmentResumeLease(p) {
    // A box reaped (idle), evicted (full) or destroyed (Stop) since the last run: report it expired, so Paperclip drops the
    // lease and acquires a fresh box. Throwing instead would fail the run.
    try {
      await call(to(p.config), "resume", { container: p.providerLeaseId });
    } catch (e) {
      if (/: 404 /.test(e.message)) return { providerLeaseId: null, metadata: { expired: true } };
      throw e;
    }
    return { providerLeaseId: p.providerLeaseId, metadata: meta(p.providerLeaseId, { ...p.leaseMetadata, resumedLease: true }) };
  },
  // End of a run: the run token is revoked (the box stays warm for this task). A Stop destroys the box. Then the status check.
  async onEnvironmentReleaseLease(p) {
    if (!p.providerLeaseId) return;
    const c = to(p.config);
    const destroy = Boolean(p.cancelActiveWork) || p.config?.reuseLease === false;
    await call(c, "release", { container: p.providerLeaseId, destroy });
    if (!p.cancelActiveWork) await statusCheck(p).catch((e) => ctx?.logger.warn(`status check failed: ${e.message}`));
    // A warm box returns no receipt, as in the spike (Paperclip then keeps the lease reusable).
    return destroy ? { providerLeaseId: p.providerLeaseId, state: "destroyed" } : undefined;
  },
  async onEnvironmentDestroyLease(p) {
    if (!p.providerLeaseId) return;
    await call(to(p.config), "release", { container: p.providerLeaseId, destroy: true });
    return { providerLeaseId: p.providerLeaseId, state: "destroyed" };
  },
  async onEnvironmentInspectLease(p) {
    const s = await call(to(p.config), "inspect", { container: p.providerLeaseId });
    return { providerLeaseId: p.providerLeaseId, state: s.state === "running" ? "active" : s.state === "missing" ? "destroyed" : s.state === "exited" ? "stopped" : "unknown" };
  },
  async onEnvironmentRealizeWorkspace() {
    return { cwd: "/workspace", metadata: { provider: "aidenhq-computer", remoteCwd: "/workspace" } };
  },
  async onEnvironmentExecute(p) {
    const c = to(p.config);
    const container = p.lease?.providerLeaseId ?? p.providerLeaseId;
    if (p.env?.PAPERCLIP_RUN_ID) runs.set(p.env.PAPERCLIP_RUN_ID, { ...c, container });
    return await execute(c, { container, command: p.command, args: p.args ?? [], cwd: p.cwd, env: p.env ?? {}, stdin: p.stdin ?? null, timeoutMs: p.timeoutMs ?? c.timeoutMs });
  },
});

/**
 * Every computer task (not chat) ends with a status change: a run that left its task in_progress would make Paperclip wake the
 * agent again just to repair the state (~85k tokens). The task goes to blocked, saying why, so a person looks.
 */
async function statusCheck(p) {
  const agentId = p.leaseMetadata?.agentId;
  if (!ctx || !p.issueId || !agentId) return;
  const issue = await ctx.issues.get(p.issueId, p.companyId);
  if (!leftInProgress(issue, agentId)) return;
  await ctx.issues.update(p.issueId, { status: "blocked" }, p.companyId);
  await ctx.issues.createComment(p.issueId, "This run ended with the task still in progress (no status change, or the run failed), so the task is blocked for a look. Agents in a computer finish, hand off or block every run with a reason.", p.companyId);
  ctx.logger.info(`status check: ${p.issueId} was left in_progress; set blocked`);
}

export default plugin;
runWorker(plugin, import.meta.url);
