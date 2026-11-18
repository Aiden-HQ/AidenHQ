// The leaked-"placeholder" guard: some agents fill a required `text` with the word "placeholder" (the real message in
// `questions`, or after it): it must never reach the owner.
export function stripPlaceholder(text: string): string {
  return text.replace(/^\s*placeholder\b[\s:.\-–—]*/i, "").trim();
}
