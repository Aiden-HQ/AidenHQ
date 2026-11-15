// `aidenhq advise "<brief>"` (bin/aidenhq): an Engineer job consults the advisor. The same tool as the Paperclip agents'
// `advisor_ask` (services/paperclip-tasks-mcp/models.mjs): the gateway's /advisor route with the job's own model credential,
// so each call is billed to the job's run, Engineer and task and counted against their caps; at most ADVISOR_CALLS per job.
import { QUESTION_MAX, modelTools } from "../../paperclip-tasks-mcp/models.mjs";
import { gatewayUrl, jobToken } from "./engines.mjs";

/**
 * One `advise` for a job's helper context: `ctx.agentId` (its Engineer), `ctx.issue`, `ctx.run` (its record in the runner's
 * state: `startedAt`, and `advised`, the calls used so far). The credential is minted again from the job's agent, task and
 * start time, so it is the job's own token, and a runner that adopted the job after a restart uses the same run key and
 * carries on the same count. `save(ctx)` persists the count (main.mjs saveTools). Resolves with the text to print.
 */
export async function jobAdvise(ctx, brief, { cfg, save = () => {}, fetchFn = fetch }) {
  if (!ctx.agentId || !ctx.run?.startedAt) throw new Error("the advisor isn't available on this run (it has no Engineer on record); it is again from your next turn");
  ctx.advised ??= { advisor: ctx.run.advised ?? 0 };
  ctx.advisor ??= modelTools({
    grant: async () => ({ id: ctx.agentId }), grantsFile: "", gatewayUrl: gatewayUrl(cfg), fetchFn, used: ctx.advised,
    key: jobToken(cfg, { agentId: ctx.agentId, issueId: ctx.issue.id, at: ctx.run.startedAt }),
  }).advisor_ask;
  const b = String(brief ?? "").trim();
  try {
    // One string from the command line: the question itself when it fits, else the whole brief as the context.
    const r = await ctx.advisor.run(b.length <= QUESTION_MAX ? { question: b } : { question: "Answer the question this brief asks.", context: b });
    return `${r.advice}\n\n(${r.model}; ${r.calls_left} advisor calls left this run)`;
  } finally {
    save(ctx);
  }
}
