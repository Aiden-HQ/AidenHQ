// Pause and Resume from an agent's page (web/src/AgentPage.tsx): immediate, not a settings change. The board pauses the
// agent in Paperclip as a signed-in admin. setup never resumes an agent, so an owner's pause survives every apply.
import { z } from "zod";
import type { Agent } from "./paperclip.js";

export const PauseSchema = z.object({ paused: z.boolean() }).strict();

interface PauseApi {
  pauseAgent(id: string): Promise<unknown>;
  resumeAgent(id: string): Promise<unknown>;
}

/** Pauses or resumes the agent. */
export async function setAgentPaused(pc: PauseApi, agent: Agent, { paused }: z.infer<typeof PauseSchema>): Promise<{ status: string }> {
  if (paused) await pc.pauseAgent(agent.id);
  else await pc.resumeAgent(agent.id);
  return { status: paused ? "paused" : "idle" };
}
