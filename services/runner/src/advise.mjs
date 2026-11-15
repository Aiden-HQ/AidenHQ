// `aidenhq advise "<brief>"` (bin/aidenhq): an Engineer job consults the advisor. The same tool as the Paperclip agents'
// `advisor_ask` (services/paperclip-tasks-mcp/models.mjs): the gateway's /advisor route with the job's own model credential,
// so each call is billed to the job's run, Engineer and task and counted against their caps; at most ADVISOR_CALLS per job.
import { QUESTION_MAX, modelTools } from "../../paperclip-tasks-mcp/models.mjs";

/** The advisor for one job: `key` is the job's gateway credential (kind agent). Returns advise(brief) → the text to print. */
export function jobAdvisor({ gatewayUrl, key, agentId, fetchFn = fetch }) {
  const { advisor_ask } = modelTools({ grant: async () => ({ id: agentId }), grantsFile: "", gatewayUrl, key, fetchFn });
  return async (brief) => {
    const b = String(brief ?? "").trim();
    // One string from the command line: the question itself when it fits, else the whole brief as the context.
    const r = await advisor_ask.run(b.length <= QUESTION_MAX ? { question: b } : { question: "Answer the question this brief asks.", context: b });
    return `${r.advice}\n\n(${r.model}; ${r.calls_left} advisor calls left this run)`;
  };
}
