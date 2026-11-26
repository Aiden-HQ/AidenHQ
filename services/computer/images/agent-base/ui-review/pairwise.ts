// The fix confirmation: is the page with the change better than before, at the width where the change shows? Six calls: AFTER shown
// second and AFTER shown first, three samples each. A fix is shown only when AFTER wins at least 2 of 3 in each order, so a model's
// position bias never passes a fix.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ask, DEFAULT_MODEL } from "./model.ts";

const file = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8").trim();
const rules = `${file("./prompts/pairwise.md")}\n\n## Design rules\n\n${file("./rules/taste-never.md")}`;
const schema = {
  type: "object", additionalProperties: false, required: ["better", "reasons", "regression"],
  properties: { better: { type: "string", enum: ["A", "B"] }, reasons: { type: "array", maxItems: 3, items: { type: "string" } }, regression: { type: "string" } },
};

export type FixCheck = { wins: [number, number]; accepted: boolean };

export async function fixCheck(o: { before: string; after: string; width: number; model: string; samples?: 3; taste?: string; base?: string; key?: string }): Promise<FixCheck> {
  const k = o.samples ?? 3;
  const system = o.taste ? `${rules}\n\n## The owner's taste\n\n${o.taste}` : rules;
  const wins: [number, number] = [0, 0];
  const calls = ([0, 1] as const).flatMap((order) => Array.from({ length: k }, async () => {
    // order 0: AFTER is image B (second); order 1: AFTER is image A (first)
    const images = order === 0 ? [o.before, o.after] : [o.after, o.before];
    const a = await ask({
      model: o.model, system, images, schema, base: o.base, key: o.key,
      text: `Two versions of the same page at ${o.width}px wide: image 1 is version A, image 2 is version B.`,
      validate: (x) => { if (!["A", "B"].includes((x as { better?: string })?.better ?? "")) throw new Error('"better" must be "A" or "B"'); },
    }) as { better: "A" | "B" };
    if (a.better === (order === 0 ? "B" : "A")) wins[order]++;
  }));
  await Promise.all(calls);
  return { wins, accepted: wins[0] >= 2 && wins[1] >= 2 };
}

/** `ui-review fix-check <before.png> <after.png> --width <w> [--model id] [--taste file]`: prints the FixCheck JSON. */
export async function fixCheckCommand(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { width: { type: "string" }, model: { type: "string" }, taste: { type: "string" } } });
  if (positionals.length !== 2 || !v.width) { console.error("usage: ui-review fix-check <before.png> <after.png> --width <w> [--model id] [--taste file]"); return 2; }
  try {
    const r = await fixCheck({ before: positionals[0], after: positionals[1], width: Number(v.width), model: v.model ?? DEFAULT_MODEL, taste: v.taste ? readFileSync(v.taste, "utf8").trim() : undefined });
    console.log(JSON.stringify(r));
    return 0;
  } catch (e) { console.error(`ui-review fix-check: ${(e as Error).message}`); return 1; }
}
