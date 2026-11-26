// A teammate's kit face (`teammate.face` as a map, docs/configuration.md): the character spec a module picks for the board's
// parametric face. One rule for the compiler (scripts/modules.ts imports this file directly) and the board (a synced copy,
// scripts/sync-shared.ts), which draws it.

export const HAIRS = ["short", "spiky", "long", "curly", "bun"] as const;
export const ACCESSORIES = ["none", "headset", "glasses", "round-glasses", "cap", "hard-hat", "earrings", "pencil", "headband"] as const;
export const BODIES = ["none", "tie", "notepad", "badge", "shield"] as const;

export interface FaceKit {
  hair: (typeof HAIRS)[number];
  accessory: (typeof ACCESSORIES)[number];
  body: (typeof BODIES)[number];
  skin: number; // 0–9
  hair_color: number; // 0–8 (brow follows)
  palette: number; // 0–9 (background + shirt pair)
}

const ENUMS: Record<string, readonly string[]> = { hair: HAIRS, accessory: ACCESSORIES, body: BODIES };
const RANGES: Record<string, number> = { skin: 9, hair_color: 8, palette: 9 };
const KEYS = [...Object.keys(ENUMS), ...Object.keys(RANGES)];

/** Why `v` isn't a FaceKit (strict: these six keys, all required), or undefined when it is. */
export function faceKitProblem(v: unknown): string | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return `a face spec is a map of ${KEYS.join(", ")}`;
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !KEYS.includes(k));
  if (extra) return `unknown face field ${extra} (known: ${KEYS.join(", ")})`;
  for (const [k, values] of Object.entries(ENUMS)) if (!values.includes(o[k] as string)) return `face ${k} is one of ${values.join(", ")}`;
  for (const [k, max] of Object.entries(RANGES)) if (!(Number.isInteger(o[k]) && (o[k] as number) >= 0 && (o[k] as number) <= max)) return `face ${k} is a whole number, 0 to ${max}`;
  return undefined;
}
