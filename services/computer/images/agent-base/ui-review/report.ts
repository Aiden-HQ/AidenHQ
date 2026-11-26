// report.json and report.md, review part: the ranked improvements (each with its captures and, when shown, its rendered fix),
// the motion rows, bugs and notes. No scores anywhere.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Improvement, Report } from "./types.ts";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function improvement(i: Improvement): string {
  const w = i.where;
  const lines = [
    `### ${i.rank}. ${w.region} (${i.category})`,
    `Where: \`${w.page}\` at ${w.width}px, ${w.theme}.`,
    `- Weak: ${i.weak}`, `- Change: ${i.change}`, `- Why: ${i.why}`, `- Best in the category: ${i.best}`,
    "", ...i.captures.map((f) => `![${f}](${f})`),
  ];
  const f = i.fix;
  if (f?.status === "shown") {
    lines.push("", `Rendered fix (the pairwise check preferred AFTER ${f.wins?.[0]}/3 and ${f.wins?.[1]}/3 in the two orders):`);
    if (f.before && f.after) lines.push(`![before](${f.before}) ![after](${f.after})`);
    if (f.collateral?.length) lines.push("", `Also changes: ${f.collateral.map((p) => `\`${p}\``).join(", ")}.`);
    if (f.diff) lines.push("", "```diff", f.diff.trim(), "```");
  } else if (f) lines.push("", `Fix ${f.status}${f.why ? `: ${f.why}` : ""}. The improvement stays a description.`);
  return lines.join("\n");
}

export function renderReviewReport(r: Report): string {
  const c = r.coverage;
  const out = [
    `# UI review: ${r.target}`, "",
    `Frozen at ${r.frozenAt}${r.commit ? ` on ${r.commit}` : ""}. ${c.done} of ${c.total} captures done${c.failed ? `, ${c.failed} failed` : ""}${c.deferred ? `, ${c.deferred} deferred` : ""}. Model ${r.model}, $${r.cost_usd.toFixed(2)}.`,
    "", "## Improvements", "",
    ...(r.improvements.length ? r.improvements.map(improvement).flatMap((s) => [s, ""]) : ["None found."]),
  ];
  if (r.motion.length) {
    out.push("## Motion", "", "| Where | Before | After | Why |", "| --- | --- | --- | --- |", ...r.motion.map((m) => `| ${cell(m.where)} | ${cell(m.before)} | ${cell(m.after)} | ${cell(m.why)} |`), "");
  }
  if (r.bugs.length) out.push("## Bugs", "", ...r.bugs.map((b) => `- ${b.title} (\`${b.page}\`, ${b.width}px ${b.theme}${b.verified ? ", verified" : ""}): ${b.evidence}`), "");
  if (r.notes.length) out.push("## Notes", "", ...r.notes.map((n) => `- ${n}`), "");
  return out.join("\n");
}

export function writeReviewReport(dir: string, r: Report): void {
  writeFileSync(join(dir, "report.json"), JSON.stringify(r, null, 1));
  writeFileSync(join(dir, "report.md"), renderReviewReport(r));
}
