// Merging one of the user's tasks into another: the duplicate's text joins the task it's merged into,
// word for word, and the duplicate is cancelled. Pure functions; I/O is in app.ts.
import { z } from "zod";
import { displayText, REQUESTED_PARENT_MARKER, SOURCE_MARKERS } from "./board.js";
import type { Issue } from "./paperclip.js";

/** The task to merge into, e.g. PEN-12. */
export const MergeSchema = z.object({ into: z.string().trim().min(1).max(64).transform((s) => (/^[a-z][a-z0-9]*-\d+$/i.test(s) ? s.toUpperCase() : s)) }).strict();

const MAX_DESCRIPTION = 60_000;

/**
 * A merged task's source becomes `merged-source:` on the task it joins: the tasks bridge still finds it
 * by that source (no second task for the same Slack message or email), but the scouts never close the
 * task because of it, since it isn't the task's own source.
 */
export function mergedDescription(target: Pick<Issue, "description">, source: Pick<Issue, "identifier" | "title" | "description">): string {
  const own = String(target.description ?? "").match(SOURCE_MARKERS) ?? [];
  const carried = (String(source.description ?? "").match(SOURCE_MARKERS) ?? []).map((m) => m.replace(/^<!-- source:/, "<!-- merged-source:"));
  // The task's requester (requested-parent.ts) is the target's own routing, never the merged task's: it stays as it is.
  const requester = String(target.description ?? "").match(REQUESTED_PARENT_MARKER) ?? [];
  const markers = [...new Set([...own, ...carried, ...requester])].join("\n");
  const head = displayText(target.description);
  const section = `## Merged from ${source.identifier}: ${source.title}`;
  const room = MAX_DESCRIPTION - head.length - section.length - markers.length - 8;
  const body = displayText(source.description);
  const text = body.length > room ? `${body.slice(0, Math.max(0, room - 40))}\n\n_(cut short: read ${source.identifier})_` : body;
  // The requester marker leads (requested-parent.ts): a list row is cut to 1200 characters, and a marker after a long brief
  // would be the part cut off. The source markers stay at the end.
  return [requester.join("\n"), head, `${section}${text ? `\n\n${text}` : ""}`.trim(), [...new Set([...own, ...carried])].join("\n")].filter(Boolean).join("\n\n");
}
