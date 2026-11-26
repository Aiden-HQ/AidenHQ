// Ship's durable state (data/ship/state.json, atomic rename): one record per adoption (a hold, when it has one). Lane A holds the shape and the file;
// the loop (a later lane) writes it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Only a hold is stored: working, waiting, queued and merged are derived from the PR's live state (decide).
export const HOLDS = ["stalled", "handed_back", "stopped"] as const;
export interface Adoption {
  repo: string; number: number; generation: number;
  trigger: { kind: "fleet" | "label" | "comment" | "tool" | "all"; event: string; actor: string };
  task?: string;
  /**
   * Whose PR ship works for, the one place origin shows: a task's (the code host opened it for that task: ship wakes that task,
   * posts no comment, and closes the PR when the task is cancelled, done or superseded) or a member's (the report comment and an
   * assignment on a hold).
   */
  owner?: { kind: "task"; task: string } | { kind: "member"; login: string };
  /** The one sticky state: set on a stall, a hand-back or a stop; only a fresh trusted trigger (a new generation) clears it, and a stalled one also a new head (or, from the gate's decision, a change). */
  hold: { kind: (typeof HOLDS)[number]; reason: string; at?: string; /** A stall from the merge gate's own decision: any pass that no longer decides a stall clears it, not only a new head. */ onChange?: true } | null;
}
const key = (repo: string, n: number) => `${repo.toLowerCase()}#${n}`;

export function openState(file: string) {
  let records: Record<string, Adoption> = {};
  if (existsSync(file)) records = JSON.parse(readFileSync(file, "utf8")).records ?? {};
  const save = () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify({ records })); renameSync(`${file}.tmp`, file); };
  return {
    get: (repo: string, n: number) => records[key(repo, n)],
    put(a: Adoption) { records[key(a.repo, a.number)] = a; save(); },
    all: () => Object.values(records),
  };
}
export type State = ReturnType<typeof openState>;
