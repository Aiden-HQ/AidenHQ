// A steady colour per item (an agent, a module): one of eight curated hues (ui/tokens.css --hue-0…7, each at 3:1 or better on
// the board's surfaces in both themes), and the monogram's tone (ui/tokens.css .tone-0…7) from the same seed.
const TONES = 8;

/** A steady tone per name (FNV-1a), the same on every reload and device. */
export function tone(name: string): number {
  let h = 0x811c9dc5;
  for (const c of name.replace(/^Engineer · /, "").trim().toLowerCase()) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
  return h % TONES;
}

/** The class that sets `--hue` for everything inside it. */
export const hueClass = (name: string) => `hue-${tone(name)}`;
