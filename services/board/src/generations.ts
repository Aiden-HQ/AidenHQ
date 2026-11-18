/**
 * `fleet_generation_status`: the host's apply generations (`ops/lib/generations.sh`: `generations.jsonl`, one line per
 * apply, newest last), read for the Maintainer: the current product pin and the last generations, so a fix that rolled
 * back is visible without the host, and the release updates (what is available and what changed, the last install). Read-only, no arguments, and never a guess: a missing or unreadable file is an
 * explicit error, not an empty list.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readUpdates, type UpdatesView } from "./settings.js";

export const GENERATIONS_KEPT = 20;
export const generationsFile = (env: NodeJS.ProcessEnv = process.env) => env.AIDENHQ_GENERATIONS_FILE ?? "/generations/generations.jsonl";
/** The release updater's display copy (kernel/src/updates.ts), beside the generations. */
export const updatesFile = (env: NodeJS.ProcessEnv = process.env) => join(dirname(generationsFile(env)), "updates.json");

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
  /** Release updates: the release followed, the one available with what changed, the last install; null without a release. */
  release: UpdatesView | null;
}
/** No answer: the file is missing or unreadable, said plainly instead of an empty history. */
export interface GenerationsError { error: string }

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

export function fleetGenerationStatus(file = generationsFile()): FleetGenerations | GenerationsError {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { error: `cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  }
  const lines = text.split("\n").filter((l) => l.trim());
  let rows: Record<string, unknown>[];
  try {
    rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch (err) {
    return { error: `${file} is not JSON lines: ${String(err).slice(0, 200)}` };
  }
  const generations = rows.slice(-GENERATIONS_KEPT).reverse().map(one);
  // A refused apply switched nothing, so it names no pin: the newest generation that got past validation does.
  const pin = rows.slice().reverse().map(one).find((g) => g.health !== "refused")?.product ?? null;
  return { pin, generations, release: readUpdates(join(dirname(file), "updates.json")) };
}
