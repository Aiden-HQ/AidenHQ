// Teammates: the agents the owner sees and talks to by name (an agent's compiled `teammate:` block). Every chat entry point
// reaches only these; hidden agents work through their teammate. Read from the compiled config and the grants table (key by
// Paperclip id), never Paperclip metadata, which agents can edit.
import type { FaceKit } from "./face-kit.js";
import { grantsTable } from "./grants.js";
import type { Agent } from "./paperclip.js";
import type { Compiled } from "./settings.js";

export type Teammate = { key: string; job: string; sample: string; staff: string[]; controls: string[]; face: string | FaceKit | null };

/** Every compiled teammate by key. */
export function teammateKeys(compiled: Compiled | null): Map<string, Teammate> {
  const out = new Map<string, Teammate>();
  for (const [key, a] of Object.entries(compiled?.agents ?? {})) {
    const t = a.teammate as Partial<Teammate> | undefined;
    if (t && typeof t.job === "string") out.set(key, { key, job: t.job, sample: String(t.sample ?? ""), staff: t.staff ?? [], controls: t.controls ?? [], face: t.face ?? null });
  }
  return out;
}

/** The agent's key by the grants table (setup writes it, keyed by Paperclip id); undefined for an agent it doesn't list. */
export const grantsKeyOf = (id: string): string | undefined => grantsTable(process.env.AIDENHQ_GRANTS_FILE)()[id]?.key;

/** Whether the agent is a teammate: its grants-table key has a compiled teammate block. */
export function isTeammate(agent: Pick<Agent, "id">, keys: Map<string, Teammate>): boolean {
  const key = grantsKeyOf(agent.id);
  return key !== undefined && keys.has(key);
}

/** Who answers for `key` on the owner's surfaces: the teammate whose staff lists it, else itself if a teammate, else Aiden. */
export function teammateFor(key: string, keys: Map<string, Teammate>): string {
  if (keys.has(key)) return key;
  for (const t of keys.values()) if (t.staff.includes(key)) return t.key;
  return "chief-of-staff";
}
