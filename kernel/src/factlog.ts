// How the kernel's writers record a flow fact (facts.ts): never failing, never blocking the change it describes. A fact that
// can't be written is logged and the change goes on.
import type { Fact, Facts } from "./facts.ts";

export type Log = (msg: string, f?: Record<string, unknown>) => void;
export const iso = (ms: number) => new Date(ms).toISOString();
export const factWriter = (facts: Facts | undefined, log: Log = () => {}) => (f: Fact): void => {
  if (!facts) return;
  try { facts.record(f); } catch (e) { log("fact not recorded", { type: f.type, subject: f.subject, err: (e as Error).message }); }
};
