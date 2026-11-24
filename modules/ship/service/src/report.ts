// The report (spec §7): one comment per adopted PR, edited in place, written by code from the adoption and this round's facts, so
// a code owner can approve from it without opening the diff. The model writes none of it. Posted through the code host's
// `comment` op (POST /v1/codehost/comment, edit by id), which adds the "via AidenHQ" footer.
import type { Kept, PrView } from "./handoff.ts";

export const MARKER = "<!-- aidenhq-ship -->";

/** What a round knows beyond the adoption: the state it derived, what the PR waits on, and its risk facts. */
export interface Facts {
  /** working, waiting, ready, merging, merged (derived from decide), or the hold's reason. */
  state: string;
  /** What it waits on, and who can unblock it (decide's reason). */
  waits?: string;
  /** Substantive changed lines and files (generated, lock, test and docs files not counted), and the areas' code owners. */
  lines?: number; files?: number; owners?: string[];
  /** The safe-class verdict and why (safe.ts), and the App's approval line under the repo's `approve`. */
  safe?: { safe: boolean; why: string };
  approval?: string;
  /** Protected or denied paths the PR touches. */
  protectedHit?: string[];
  /** Code review's verdict on the head, and its open important findings. */
  review?: { verdict: string; open: number };
  /** Failing required checks, and which of them fail on the target branch too (likely pre-existing). */
  failing?: string[]; onBase?: string[];
  /** The repo's own regenerate commands or workflows discovery found, as `actions` steps to configure (none enabled). */
  suggest?: string[];
  /** The repo's stop label (its `stop_label` setting). */
  stopLabel?: string;
}

const list = (xs: string[]) => xs.map((x) => `\`${x.replace(/`/g, "")}\``).join(", ");

export function renderReport(a: Kept, pr: PrView, f: Facts): string {
  const lines = [MARKER, `**Ship** · generation ${a.generation} · head \`${pr.head.slice(0, 12)}\``, ""];
  const held = a.hold && f.state !== "merged";
  lines.push(`**State:** ${held ? `on hold (${a.hold!.kind}): ${a.hold!.reason}` : f.state}`);
  if (f.waits && !a.hold) lines.push(`**Waiting on:** ${f.waits}`);
  // Code owners stay human: the App's approval never stands for theirs, so the report is what they approve from.
  if (f.waits && !a.hold && /code owner/.test(f.waits)) lines.push("A code owner approves it on GitHub: the risk facts below are written by code from the PR's change, and code review's verdict is on its head.");
  if (f.approval) lines.push(`**Approval:** ${f.approval}`);
  const handed = a.trigger.kind === "fleet" ? "opened by the fleet" : a.trigger.kind === "all" ? `adopted (handoff: all, author @${a.trigger.actor})` : `handed over by @${a.trigger.actor} (${a.trigger.kind === "comment" ? "/ship" : "ship label"})`;
  lines.push(`**Hand-off:** ${handed}${pr.fork ? `; a fork${pr.canModify ? " that allows maintainer edits" : " without maintainer edits (ship can't push to it)"}` : ""}`);
  if (a.did?.length) lines.push("", "**What ship did**", ...a.did.slice(-10).map((d) => `- ${d}`));
  const risk: string[] = [];
  if (f.lines !== undefined || f.files !== undefined) risk.push(`- ${f.lines ?? "?"} substantive lines in ${f.files ?? "?"} files (generated, lock, test and docs files not counted)`);
  if (f.owners?.length) risk.push(`- Areas touched (code owners): ${f.owners.map((o) => `@${o.replace(/^@/, "")}`).join(", ")}`);
  if (f.safe) risk.push(`- Safe class: ${f.safe.safe ? "inside" : "outside"} (${f.safe.why})`);
  if (f.protectedHit?.length) risk.push(`- Protected or denied paths: ${list(f.protectedHit)}`);
  if (f.review) risk.push(`- Code review: ${f.review.verdict}${f.review.open ? `, ${f.review.open} open important finding(s)` : ", no open important findings"}`);
  if (f.failing?.length) risk.push(`- Failing required checks: ${list(f.failing)}${f.onBase?.length ? `; also failing on \`${pr.defaultBranch}\`: ${list(f.onBase)}` : ""}`);
  if (risk.length) lines.push("", "**Risk facts**", ...risk);
  if (f.suggest?.length) lines.push("", "**Suggested** (not enabled: set it in ship's settings for this repo)", ...f.suggest.map((x) => `- ${x}`));
  if (a.counters) lines.push("", `<sub>rounds ${a.counters.rounds} · CI fixes ${a.counters.ci} · review fixes ${a.counters.review}</sub>`);
  lines.push("", `<sub>Stop with the \`${f.stopLabel ?? "ship:stop"}\` label; hand back by removing the \`ship\` label.</sub>`);
  return lines.join("\n");
}
