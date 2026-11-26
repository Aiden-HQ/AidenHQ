// GitHub issue bodies for a UI testing pass, from its report.json: the app's one "design improvements" issue (refreshed in place
// on every pass) and one issue per verified bug. Each body opens with its marker, which is the issue's identity: the app's name for
// the design issue, and for a bug a hash of its page, kind and its repro's last step's selector, never the model's title, so a
// reworded title is the same issue. Images stay on the board (GitHub takes none from the fleet): each body names the run and links
// the UI testing page. Text from the model and the app is quoted as data: no marker, mention or fence can be smuggled in.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Bug, Improvement, Report } from "./types.ts";

export type Issue = { marker: string; title: string; body: string };
export type IssueOptions = { app: string; runUrl: string; run: string };

/** A body stays under github_issue_create's 60,000 characters with room for the AidenHQ footer. */
export const BODY_MAX = 55_000;
const DIFF_MAX = 6_000;

export const designMarker = (app: string) => `aidenhq-ui:design:${app}`;
export const bugMarker = (app: string, b: Pick<Bug, "page" | "kind" | "selector">) =>
  `aidenhq-ui:bug:${app}:${createHash("sha256").update(`${b.page}\n${b.kind ?? "bug"}\n${b.selector ?? ""}`).digest("hex").slice(0, 12)}`;

/** Model or app text on one line: no HTML comment (a second marker), no @mention, no line breaks. */
const quote = (s: unknown, max = 600) => String(s ?? "").replace(/<!--|-->/g, "").replace(/@(?=[\w-])/g, "@​").replace(/\s+/g, " ").trim().slice(0, max);
/** A fenced block that no backtick run inside can close. */
const fenced = (text: string, lang = "") => {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}${lang}\n${text.replace(/<!--|-->/g, "")}\n${ticks}`;
};
const runLine = (o: IssueOptions) => `Images, before|after pairs and recordings: ${o.runUrl} (run \`${o.run}\`).`;

function improvement(i: Improvement, n: number): string {
  const w = i.where, f = i.fix;
  const lines = [
    `${n}. **${quote(w.region, 120)}** (${i.category}): \`${quote(w.page, 200)}\` at ${w.width}px, ${w.theme}`,
    `   Change: ${quote(i.change)}`,
    `   - Weak: ${quote(i.weak)}`,
    `   - Why: ${quote(i.why)}`,
    `   - Best in the category: ${quote(i.best)}`,
  ];
  if (f?.status === "shown") {
    lines.push(`   - Rendered fix, preferred by the pairwise check ${f.wins?.[0] ?? "?"}/3 and ${f.wins?.[1] ?? "?"}/3${f.collateral?.length ? `; also changes ${f.collateral.map((p) => `\`${quote(p, 200)}\``).join(", ")}` : ""}.`);
    if (f.diff) {
      const diff = f.diff.length > DIFF_MAX ? `${f.diff.slice(0, DIFF_MAX)}\n… (${f.diff.length - DIFF_MAX} more characters on the board)` : f.diff;
      lines.push("", "   <details><summary>The fix's diff</summary>", "", fenced(diff.trim(), "diff"), "", "   </details>");
    }
  } else if (f) lines.push(`   - Fix ${f.status}${f.why ? `: ${quote(f.why, 300)}` : ""}.`);
  return lines.join("\n");
}

/** The design issue's body: marker, ranked improvements with their fixes' diffs, the run link, coverage and date. */
function designBody(r: Report, o: IssueOptions): string {
  const cv = r.coverage, date = (r.frozenAt || new Date().toISOString()).slice(0, 10);
  const head = [
    `<!-- ${designMarker(o.app)} -->`,
    `## Design improvements: ${o.app}`,
    "",
    `UI review pass of ${quote(r.target, 300)} on ${date}. Coverage: ${cv.done} of ${cv.total} captures${cv.deferred ? `, ${cv.deferred} deferred (the next passes take them)` : ""}${cv.failed ? `, ${cv.failed} failed` : ""}.`,
    runLine(o),
    "",
    "This issue is refreshed in place by each pass: it always shows the latest ranked list.",
    "",
  ].join("\n");
  const items = r.improvements.length ? r.improvements.map((i, n) => improvement(i, n + 1)) : ["No improvements found on this pass."];
  let body = head;
  for (const [n, it] of items.entries()) {
    if (body.length + it.length + 200 > BODY_MAX) { body += `\n${items.length - n} more improvements are on the board (${o.runUrl}, run \`${o.run}\`).\n`; break; }
    body += `${it}\n\n`;
  }
  return body.trimEnd() + "\n";
}

/** A verified bug's body: marker, where, steps, expected, saw, the run link. */
function bugBody(b: Bug, o: IssueOptions): string {
  const saw = b.saw ?? b.evidence, expected = b.expected ?? "";
  return [
    `<!-- ${bugMarker(o.app, b)} -->`,
    `**${quote(b.title, 200)}** on \`${quote(b.page, 200)}\` at ${b.width}px, ${b.theme}. Reproduced twice in fresh browsers by the UI review.`,
    "",
    "Steps:",
    ...(b.repro ?? []).map((s, i) => `${i + 1}. \`${quote(s, 300).replace(/`/g, "'")}\``),
    "",
    ...(expected ? [`Expected: ${quote(expected)}`] : []),
    `Saw: ${quote(saw)}`,
    "",
    runLine(o),
  ].join("\n").slice(0, BODY_MAX) + "\n";
}

/** The issues of the capture folder `dir`'s report.json: the design issue and one per verified bug (one per marker). */
export function issueBodies(dir: string, o: IssueOptions): { design: Issue; bugs: Issue[] } {
  const r = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as Report;
  const seen = new Set<string>(), bugs: Issue[] = [];
  for (const b of r.bugs ?? []) {
    if (!b.verified || (b.kind ?? "bug") !== "bug") continue;
    const marker = bugMarker(o.app, b);
    if (seen.has(marker)) continue;
    seen.add(marker);
    bugs.push({ marker, title: `UI bug (${o.app}): ${quote(b.title, 180)}`, body: bugBody(b, o) });
  }
  return { design: { marker: designMarker(o.app), title: `UI design improvements: ${o.app}`, body: designBody(r, o) }, bugs };
}

/** `ui-review issue-body <dir> --app <app> --run-url <url> --run <id>`: prints { design, bugs } as JSON, each { marker, title, body }. */
export async function issueBodyCommand(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { app: { type: "string" }, "run-url": { type: "string" }, run: { type: "string" } } });
  if (!positionals[0] || !v.app || !v["run-url"] || !v.run || !/^[a-z][a-z0-9-]{1,30}$/.test(v.app)) { console.error("usage: ui-review issue-body <dir> --app <app> --run-url <url> --run <id>"); return 2; }
  try {
    console.log(JSON.stringify(issueBodies(positionals[0], { app: v.app, runUrl: v["run-url"], run: v.run }), null, 2));
    return 0;
  } catch (e) { console.error(`ui-review issue-body: ${(e as Error).message}`); return 1; }
}
