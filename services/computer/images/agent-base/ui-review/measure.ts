// Placeholder until lane B's measurements merge (it replaces this file): empty design measurements.
import type { Page as PwPage } from "playwright-core";
import type { Measures } from "./types.ts";

export async function measurePage(_page: PwPage): Promise<Measures> {
  return { fonts: [], colours: [], radii: [], shadows: [], spacing: { values: [], offScale: [] }, nearMisses: [], content: { width: 0, viewport: 0 }, ctas: [], contrastFails: 0, signatures: { button: [], card: [], heading: [], input: [] } };
}
