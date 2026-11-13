// Default agent avatars: a monogram (initials on a tone picked from the name) for every agent without a portrait, and for
// one whose portrait fails to load. Seeded by the agent's display name, which every view has, so an agent keeps one
// colour everywhere. The tones are CSS classes (styles.css .tone-0…7), each a tinted background with dark text in light
// mode and the reverse in dark mode, all at 7:1 contrast or better.
export const TONES = 8;

/** Up to two letters: the first of the first two words ("Slack Scout" → "SS"), else the first two of one ("Aiden" → "Ai"). */
export function initials(name: string): string {
  const words = name.replace(/^Engineer · /, "").trim().split(/[\s·_-]+/).filter((w) => /\p{L}|\d/u.test(w));
  if (!words.length) return "?";
  if (words.length === 1) {
    const [a = "", b = ""] = [...words[0]!.replace(/[^\p{L}\d]/gu, "")];
    return (a.toUpperCase() + b.toLowerCase()) || "?";
  }
  return words.slice(0, 2).map((w) => [...w.replace(/[^\p{L}\d]/gu, "")][0]?.toUpperCase() ?? "").join("") || "?";
}

/** A steady tone per name (FNV-1a), the same on every reload and device. */
export function tone(name: string): number {
  let h = 0x811c9dc5;
  for (const c of name.replace(/^Engineer · /, "").trim().toLowerCase()) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
  return h % TONES;
}

export type Face = { kind: "portrait"; src: string } | { kind: "monogram"; text: string; tone: number };

/** What to draw: the bundled portrait while it hasn't failed to load, else the monogram. */
export function faceOf(name: string, portrait: string | undefined, failed = false): Face {
  if (portrait && /^[a-z0-9-]{1,40}$/.test(portrait) && !failed) return { kind: "portrait", src: `/crew/${portrait}.svg` };
  return { kind: "monogram", text: initials(name), tone: tone(name) };
}
