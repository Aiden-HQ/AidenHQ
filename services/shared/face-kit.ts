// A teammate's face as a character-kit spec (an agent's `teammate.face:` in AGENTS.md or module.yaml): which hair,
// accessory and body mark, and which skin, hair colour and palette by index. One rule for the compiler (the gate) and the
// board (it draws the face: web/src/ui/Face.tsx). Plain TypeScript Node runs as is; the board holds a synced copy
// (scripts/sync-shared.ts).

export const HAIRS = ["short", "spiky", "long", "curly", "bun"] as const;
export const ACCESSORIES = ["none", "headset", "glasses", "round-glasses", "cap", "hard-hat", "earrings", "pencil", "headband"] as const;
export const BODIES = ["none", "tie", "notepad", "badge", "shield"] as const;
/** How many of each colour the kit has (web/src/ui/tokens.css --face-skin-*, --face-hair-*, --face-bg-*). */
export const SKINS = 10;
export const HAIR_COLORS = 9;
export const PALETTES = 10;

export interface FaceKit {
  hair: (typeof HAIRS)[number];
  accessory: (typeof ACCESSORIES)[number];
  body: (typeof BODIES)[number];
  /** 0–9 */
  skin: number;
  /** 0–8; the brow follows. */
  hair_color: number;
  /** 0–9: the background and shirt pair. */
  palette: number;
}

const ENUMS: Record<string, readonly string[]> = { hair: HAIRS, accessory: ACCESSORIES, body: BODIES };
const RANGES: Record<string, number> = { skin: SKINS, hair_color: HAIR_COLORS, palette: PALETTES };

/** Why `v` isn't a face spec, or undefined when it is: exactly these six keys, all required. */
export function faceKitProblem(v: unknown): string | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "a face spec is a map of hair, accessory, body, skin, hair_color and palette";
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(k in ENUMS) && !(k in RANGES)) return `a face spec has no ${k}`;
  for (const [k, values] of Object.entries(ENUMS)) {
    if (!values.includes(o[k] as string)) return `face ${k} is one of ${values.join(", ")}`;
  }
  for (const [k, n] of Object.entries(RANGES)) {
    const x = o[k];
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x >= n) return `face ${k} is a whole number from 0 to ${n - 1}`;
  }
  return undefined;
}
