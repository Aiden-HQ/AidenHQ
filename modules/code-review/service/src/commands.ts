// `aiden review …` (and `aiden recheck`) in a PR comment: a comment whose first word is `aiden` (with or without an `@`, which old habits write; we
// never write it, as it would ping a GitHub user named aiden). Only the comment's first line counts, and only when it is a
// command whole (prose that starts "aiden review is …" asks nothing), so prose, a quote or a code block never asks for anything; our own posts never count (they carry our markers). A
// comment is a stranger's text: what a command carries is data (a focus is a short text handed to the reviewer as data, never
// put in a title or a log line). Whether the commenter may ask is the engine's (their current permission on the repo).

export type Command =
  | { cmd: "review"; full: boolean }
  | { cmd: "always" | "stop" | "status" | "help" | "recheck" }
  | { cmd: "focus"; text: string };

/** Our own posts' markers (aidenhq-review, -review-run, -review-ack, -finding): a comment or review with one is never a command. */
export const OWN_MARKERS = ["<!-- aidenhq-"];
export const FOCUS_MAX = 300;
// Up to three spaces of indent: four (or a tab) is a Markdown code block, an example, never an ask.
const LINE = /^ {0,3}@?aiden\s+(review|recheck)\b(.*)$/i;

/** The comment's command (its first line, a command whole), or undefined when it holds none. */
export function parseCommand(body: string): Command | undefined {
  if (OWN_MARKERS.some((m) => body.includes(m))) return undefined;
  const m = LINE.exec(body.split(/\r?\n/).find((l) => l.trim()) ?? "");
  if (!m) return undefined;
  const rest = m[2]!.trim();
  // `aiden recheck` takes no argument: one recheck of the earlier findings now.
  if (m[1]!.toLowerCase() === "recheck") return rest ? undefined : { cmd: "recheck" };
  const focus = /^focus\s*:\s*(.*)$/i.exec(rest);
  if (focus) return { cmd: "focus", text: focus[1]!.trim().slice(0, FOCUS_MAX) };
  const words = rest.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { cmd: "review", full: false };
  if (words.length === 1 && ["always", "stop", "status", "help"].includes(words[0]!)) return { cmd: words[0] as "always" };
  if (words.length === 1 && words[0] === "full") return { cmd: "review", full: true };
  return undefined;
}
