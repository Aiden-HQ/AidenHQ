// The character kit's drawing tables (Face.tsx): each spec value's SVG paths on a 0 0 100 100 canvas, ported verbatim
// from the home mockup, and a face derived from a seed
// for an agent whose module picks none. Colours are tokens (ui/tokens.css --face-*).
import { ACCESSORIES, BODIES, HAIR_COLORS, HAIRS, PALETTES, SKINS, type FaceKit } from "../../../src/face-kit";

export type { FaceKit };
export type FaceState = "idle" | "working" | "needs";

const NONE = "M0 0";
const SHORT_TOP = "M25 44 C24 26 37 18 51 18 C66 18 77 27 75 44 C71 34 61 29 50 30 C39 30 30 35 25 44 Z";
const LONG_BACK = "M23 46 C20 70 22 80 30 84 L70 84 C78 80 80 70 77 46 Z";

/** Hair: the part over the forehead, and the part behind the head (long and curly hair fall past the ears). */
export const HAIR: Record<FaceKit["hair"], { top: string; back: string }> = {
  short: { top: SHORT_TOP, back: NONE },
  spiky: { top: "M25 43 L26 25 L35 31 L38 15 L47 27 L53 12 L60 26 L69 17 L70 31 L78 27 L75 43 C69 33 60 29 50 30 C40 30 31 35 25 43 Z", back: NONE },
  long: { top: "M25 46 C23 25 37 17 51 17 C66 17 78 26 76 46 C72 33 62 28 51 29 C46 37 36 42 25 46 Z", back: LONG_BACK },
  curly: {
    top: "M24 47 C17 40 21 29 29 27 C28 18 39 13 46 18 C51 11 62 12 65 19 C73 16 82 24 78 33 C84 39 80 47 76 47 C72 37 62 31 50 31 C38 31 29 37 24 47 Z",
    back: "M22 46 C14 58 20 72 28 74 C26 82 36 86 42 80 L58 80 C64 86 74 82 72 74 C80 72 86 58 78 46 Z",
  },
  bun: { top: "M25 45 C23 26 37 18 51 18 C66 18 77 27 75 45 C71 33 61 29 50 30 C39 30 30 35 25 45 Z M41 13 C41 5 59 5 59 13 C59 20 41 20 41 13 Z", back: NONE },
};

interface Mark { d: string; fill: string; stroke: string; width: number }
const v = (name: string) => `var(--face-${name})`;

/** Accessories, drawn over the face: headset (Tess), pencil (Nora), glasses (Max), cap (Sam), earrings (Iris), hard hat
 *  (Archie), headband (Vik), round glasses (Rhea). */
export const ACCESSORY: Record<Exclude<FaceKit["accessory"], "none">, Mark> = {
  headset: { d: "M24 46 C24 20 76 20 76 46 M22 42 L22 54 M78 42 L78 54 M23 54 C23 64 32 68 42 66", fill: "none", stroke: v("headset"), width: 3.4 },
  pencil: { d: "M70 24 L80 44", fill: "none", stroke: v("pencil"), width: 4 },
  glasses: { d: "M34 48 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0 M52 48 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0 M48 48 L52 48", fill: "none", stroke: v("glasses"), width: 2.4 },
  cap: { d: "M24 37 C25 18 75 18 76 37 Z M70 35 L90 39 L74 41 Z", fill: v("cap"), stroke: v("cap-line"), width: 1.5 },
  earrings: { d: "M27 56 a2.5 2.5 0 1 0 0.1 0 M73 56 a2.5 2.5 0 1 0 0.1 0", fill: v("earrings"), stroke: v("earrings-line"), width: 1 },
  "hard-hat": { d: "M23 37 C23 14 77 14 77 37 Z M18 36 L82 36 L82 41 L18 41 Z M47 16 L53 16 L53 36 L47 36 Z", fill: v("hard-hat"), stroke: v("hard-hat-line"), width: 1.5 },
  headband: { d: "M22 30 C30 12 70 12 78 30", fill: "none", stroke: v("headband"), width: 4 },
  "round-glasses": { d: "M33 48 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0 M51 48 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0 M49 48 L51 48", fill: "none", stroke: v("round-glasses"), width: 2.4 },
};

/** Body marks, on the shirt: tie (Aiden), notepad (Nora), badge (Mia), shield (Vik). Stroke width 2. */
export const BODY: Record<Exclude<FaceKit["body"], "none">, Mark> = {
  tie: { d: "M50 72 L45 77 L50 99 L55 77 Z", fill: v("tie"), stroke: "none", width: 2 },
  notepad: { d: "M36 84 L48 84 L48 98 L36 98 Z", fill: v("notepad"), stroke: v("notepad-line"), width: 2 },
  badge: { d: "M58 84 L64 84 L64 92 L58 92 Z", fill: v("badge"), stroke: v("badge-line"), width: 2 },
  shield: { d: "M50 78 L59 81 L59 88 C59 93 55 96 50 97 C45 96 41 93 41 88 L41 81 Z", fill: v("shield"), stroke: v("shield-line"), width: 2 },
};

/** What changes with the state: the brows rise and the mouth opens when the teammate needs you; it presses flat while working. */
export const EXPRESSION: Record<FaceState, { browL: string; browR: string; mouth: string; open: boolean }> = {
  idle: { browL: "M35 39 Q41 36 46 38", browR: "M54 38 Q59 36 65 39", mouth: "M43 58 Q50 64 57 58", open: false },
  working: { browL: "M35 39 Q41 36 46 38", browR: "M54 38 Q59 36 65 39", mouth: "M44 59 Q50 61 56 59", open: false },
  needs: { browL: "M35 36 Q41 32 46 35", browR: "M54 35 Q59 32 65 36", mouth: "M46 60 Q50 57 54 60 Q50 64 46 60 Z", open: true },
};

/** FNV-1a, 32-bit. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** A stable face for an agent its module gave none: each feature from its own hash of the seed (the agent's key), so a
 *  rename never changes it. About 40% of faces wear no accessory and 40% no body mark; a hat never sits on a bun. */
export function kitFromSeed(seed: string): FaceKit {
  const pick = (field: string, n: number) => fnv(`${seed}:${field}`) % n;
  const mark = <T,>(field: string, all: readonly T[]): T => {
    const roll = fnv(`${seed}:${field}`);
    return roll % 100 < 40 ? all[0]! : all[1 + ((roll >>> 8) % (all.length - 1))]!;
  };
  const accessory = mark("accessory", ACCESSORIES);
  const hair = HAIRS[pick("hair", HAIRS.length)]!;
  return {
    hair: hair === "bun" && (accessory === "cap" || accessory === "hard-hat") ? "short" : hair,
    accessory,
    body: mark("body", BODIES),
    skin: pick("skin", SKINS),
    hair_color: pick("hair_color", HAIR_COLORS),
    palette: pick("palette", PALETTES),
  };
}

/** How long one blink cycle takes, from the seed (4.3 s or 5.1 s), so a row of faces never blinks in step. */
export const blinkSeconds = (seed: string) => (fnv(seed) & 1 ? 4.3 : 5.1);
