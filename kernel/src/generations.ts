// The host's apply generations (`ops/lib/generations.sh`: `generations.jsonl`, one line per apply, newest last), for the Maintainer's
// and the Fleet Steward's `fleet_generation_status`: the current product pin and the last generations, so a fix that rolled back is
// visible without the host. Read-only, and never a guess: a missing or unreadable file is an explicit error, not an empty list.
import { readFileSync } from "node:fs";

export const GENERATIONS_KEPT = 20;

export interface Generation {
  n: number | null; at: string | null; product: string | null; health: string | null; reason: string | null; log: string | null;
  revert_of: number | null; lkg: number | null; data_versions: Record<string, number> | null;
}

const num = (v: unknown) => (typeof v === "number" ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);
const one = (r: Record<string, unknown>): Generation => ({
  n: num(r.n), at: str(r.at), product: str(r.product), health: str(r.health), reason: str(r.reason), log: str(r.log),
  revert_of: num(r.revert_of), lkg: num(r.lkg), data_versions: r.data_versions && typeof r.data_versions === "object" ? (r.data_versions as Record<string, number>) : null,
});

/** `pin`: the product commit of the newest generation that got past validation (a refused apply switched nothing). */
export function fleetGenerations(file: string): { pin: string | null; generations: Generation[] } | { error: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { error: `cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  }
  let rows: Record<string, unknown>[];
  try {
    rows = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch (err) {
    return { error: `${file} is not JSON lines: ${String(err).slice(0, 200)}` };
  }
  return { pin: rows.slice().reverse().map(one).find((g) => g.health !== "refused")?.product ?? null, generations: rows.slice(-GENERATIONS_KEPT).reverse().map(one) };
}
