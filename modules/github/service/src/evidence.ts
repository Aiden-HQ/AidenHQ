// A PR description's Evidence section (every Engineer PR ends with `## Evidence`: commands and results, screenshots, numbers,
// or "Not verified: <why>"), as the AI reviewer reads it beside the diff: the author's own words, data.
const EVIDENCE = /^(?:##[^\S\n]+Evidence[^\S\n]*|Evidence: none given)$/im;

/** The Evidence section of a PR description, up to the next heading of its level or above; "none given" without one. */
export function evidenceOf(body: unknown) {
  const m = EVIDENCE.exec(String(body ?? ""));
  return (m ? String(body).slice(m.index + m[0].length) : "").split(/^#{1,2}[^\S\n#]/m)[0]!.trim() || "none given";
}
