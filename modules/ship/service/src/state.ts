// Ship's durable state (data/ship/state.json, atomic rename): one record per adoption. Lane A holds the shape and the file;
// the loop (a later lane) writes it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const STATUSES = ["working", "waiting", "stalled", "queued", "merged", "handed_back", "stopped"] as const;
export interface Adoption {
  repo: string; number: number; generation: number;
  trigger: { kind: "fleet" | "label" | "comment" | "tool" | "all"; event: string; actor: string };
  task?: string; status: (typeof STATUSES)[number];
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
