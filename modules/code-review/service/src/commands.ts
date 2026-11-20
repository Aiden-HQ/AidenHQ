// `@aiden review …` in a PR comment. A comment is a stranger's text: only a command line counts (never a quoted line or one inside
// a code block), our own posts never count (they list the commands), and what a command carries is data (a focus is a short text
// handed to the reviewer as data, never put in a title or a log line). Whether the commenter may ask is the engine's (their
// current permission on the repo).

export type Command =
  | { cmd: "review"; full: boolean }
  | { cmd: "always" | "stop" | "status" | "help" }
  | { cmd: "focus"; text: string }
  | { cmd: "unknown"; word: string };

/** Our own posts' markers (aidenhq-review, -review-run, -review-ack, -finding): a comment or review with one is never a command. */
export const OWN_MARKERS = ["<!-- aidenhq-"];
export const FOCUS_MAX = 300;
const LINE = /^\s*@aiden\s+review\b(.*)$/i;


/** The comment's command, or undefined when it holds none. The first command line wins. */
export function parseCommand(body: string): Command | undefined {
  if (OWN_MARKERS.some((m) => body.includes(m))) return undefined;
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^\s*>/.test(line)) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const rest = m[1]!.trim();
    const focus = /^focus\s*:\s*(.*)$/i.exec(rest);
    if (focus) return { cmd: "focus", text: focus[1]!.trim().slice(0, FOCUS_MAX) };
    const words = rest.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { cmd: "review", full: false };
    if (words.length === 1 && ["always", "stop", "status", "help"].includes(words[0]!)) return { cmd: words[0] as "always" };
    if (words.length === 1 && words[0] === "full") return { cmd: "review", full: true };
    return { cmd: "unknown", word: words.find((w) => w !== "full")!.slice(0, 40) };
  }
  return undefined;
}
