// The grants table setup writes on the host (config/grants/grants.json), {agents: {<agent id>: {key, roles, tools}}}, never
// Paperclip metadata, which agents can edit. Who is calling comes from the kernel's caller assertion (aidenhq-sdk/caller.ts).
import { readFileSync, statSync, type Stats } from "node:fs";

/** One agent's grants-table entry. `models`, `graded` and `rev` are for the kernel's gateway and the grader. */
export interface Grant {
  key: string;
  roles?: string[];
  tools?: Record<string, string[]>;
  models?: string[];
  graded?: boolean;
  rev?: string;
  /** The agent's profile (kernel/src/admission.ts). */
  profile?: string;
}

/** The grants table, re-read whenever the file changes. */
export function grantsTable(file: string | undefined): () => Record<string, Grant> {
  let cached: { mtimeMs: number; size: number; agents: Record<string, Grant> } | undefined;
  return () => {
    if (!file) throw new Error("grants are not set up on this service (AIDENHQ_GRANTS_FILE)");
    let st: Stats;
    try {
      st = statSync(file);
    } catch {
      throw new Error("grants are not set up yet (scripts/paperclip-setup.ts writes them)");
    }
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      let agents: unknown;
      try {
        agents = JSON.parse(readFileSync(file, "utf8")).agents;
      } catch {
        throw new Error("the grants table can't be read");
      }
      if (!agents || typeof agents !== "object") throw new Error("the grants table has no agents");
      cached = { mtimeMs: st.mtimeMs, size: st.size, agents: agents as Record<string, Grant> };
    }
    return cached.agents;
  };
}
