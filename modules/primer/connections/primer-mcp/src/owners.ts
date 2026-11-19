// Which task and agent published each Primer document: written when a primer.publish record succeeds (the kernel's requester
// identity, never an agent's word) and read to tier later versions and thread replies on that document.
// The file is `owners.json` in primer-mcp's state dir (PRIMER_STATE_DIR, /state): { [documentId]: { task, agent } }.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Owner = { task: string; agent: string };
export interface Owners { get(documentId: string): Owner | undefined; set(documentId: string, owner: Owner): void; documentsOf(owner: Owner): string[] }

export function fileOwners(dir = process.env.PRIMER_STATE_DIR ?? "/state"): Owners {
  const file = join(dir, "owners.json");
  const read = (): Record<string, Owner> => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  return {
    get: (id) => read()[id],
    set(id, owner) {
      const all = read();
      all[id] = { task: owner.task, agent: owner.agent };
      writeFileSync(`${file}.tmp`, JSON.stringify(all));
      renameSync(`${file}.tmp`, file);
    },
    documentsOf: (o) => Object.entries(read()).filter(([, v]) => v.task === o.task && v.agent === o.agent).map(([id]) => id),
  };
}

const store = () => fileOwners();
/** The task and agent that published this document, or undefined. */
export const getOwner = (documentId: string): Owner | undefined => store().get(documentId);
/** Records who published a document (called when a publish succeeds). */
export const recordOwner = (documentId: string, owner: Owner): void => store().set(documentId, owner);
