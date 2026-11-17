/**
 * The host's apply generations (`ops/lib/generations.sh`: `generations.jsonl`, one line per apply, newest last), read for
 * the Maintainer: the current product pin and the last generations, so a fix that rolled back is visible without the
 * host. Read-only, no arguments, and never a guess: a missing or unreadable file is an explicit error, not an empty list.
 */
import { readFileSync } from "node:fs";

export const GENERATIONS_KEPT = 20;
export const generationsFile = (env: NodeJS.ProcessEnv = process.env) => env.AIDENHQ_GENERATIONS_FILE ?? "/generations/generations.jsonl";

export interface Generation {
  n: number | null;
  at: string | null;
  product: string | null;
  health: string | null;
  reason: string | null;
  log: string | null;
  revert_of: number | null;
  lkg: number | null;
  data_versions: Record<string, number> | null;
}

export interface FleetGenerations {
  /** The product commit the newest generation applied; null before the first one. */
  pin: string | null;
  generations: Generation[];
  error?: string;
}

const one = (r: Record<string, unknown>): Generation => ({
  n: typeof r.n === "number" ? r.n : null,
  at: typeof r.at === "string" ? r.at : null,
  product: typeof r.product === "string" ? r.product : null,
  health: typeof r.health === "string" ? r.health : null,
  reason: typeof r.reason === "string" ? r.reason : null,
  log: typeof r.log === "string" ? r.log : null,
  revert_of: typeof r.revert_of === "number" ? r.revert_of : null,
  lkg: typeof r.lkg === "number" ? r.lkg : null,
  data_versions: r.data_versions && typeof r.data_versions === "object" ? (r.data_versions as Record<string, number>) : null,
});

export function fleetGenerationStatus(file = generationsFile()): FleetGenerations {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { pin: null, generations: [], error: `cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  }
  const lines = text.split("\n").filter((l) => l.trim());
  let rows: Record<string, unknown>[];
  try {
    rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch (err) {
    return { pin: null, generations: [], error: `${file} is not JSON lines: ${String(err).slice(0, 200)}` };
  }
  const generations = rows.slice(-GENERATIONS_KEPT).reverse().map(one);
  return { pin: generations[0]?.product ?? null, generations };
}
