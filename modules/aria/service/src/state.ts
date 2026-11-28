// The service's own durable state (ARIA_STATE_FILE): the proposal Aria saved for the page.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Suggestion } from "./prefill.ts";

export interface State {
  suggestion?: Suggestion & { at: string };
}

export function openState(file: string) {
  let state: State = {};
  try { const v = JSON.parse(readFileSync(file, "utf8")); if (v && typeof v === "object" && !Array.isArray(v)) state = v; } catch { /* a first start */ }
  return {
    get: (): State => state,
    set(next: State) {
      state = next;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(state));
      renameSync(`${file}.tmp`, file);
    },
  };
}
export type Store = ReturnType<typeof openState>;
