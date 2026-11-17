// Pause and Resume from an agent's page (web/src/AgentPage.tsx): immediate, not a settings change. The board pauses the
// agent in Paperclip as a signed-in admin; "stop it now" also cancels its live runs. setup resumes only agents it paused
// itself (metadata.pausedBy "setup"), so an owner's pause survives every apply.
import { z } from "zod";
import type { Agent, Issue, LiveRun } from "./paperclip.js";

export const PauseSchema = z.object({ paused: z.boolean(), stop: z.boolean().optional() }).strict();

interface PauseApi {
  pauseAgent(id: string): Promise<unknown>;
  resumeAgent(id: string): Promise<unknown>;
  liveRuns(): Promise<LiveRun[]>;
  cancelRun(runId: string): Promise<unknown>;
  issue(id: string): Promise<Issue>;
  releaseCancelledRun(issue: Pick<Issue, "id" | "status" | "executionBlocker">, runId: string): Promise<unknown>;
}

/** Pauses or resumes the agent; with `stop`, its live Paperclip runs are cancelled (runner-dispatched Engineer jobs are not Paperclip runs: they finish). */
export async function setAgentPaused(pc: PauseApi, agent: Agent, { paused, stop }: z.infer<typeof PauseSchema>): Promise<{ status: string; stopped: number }> {
  if (!paused) {
    await pc.resumeAgent(agent.id);
    return { status: "idle", stopped: 0 };
  }
  await pc.pauseAgent(agent.id);
  let stopped = 0;
  if (stop) {
    for (const run of (await pc.liveRuns()).filter((r) => r.agentId === agent.id)) {
      await pc.cancelRun(run.id);
      stopped++;
      // The recovery hold a just-started cancelled run leaves on its task parks every later wake; clear it.
      if (run.issueId) await pc.releaseCancelledRun(await pc.issue(run.issueId), run.id);
    }
  }
  return { status: "paused", stopped };
}
