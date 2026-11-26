// report.json (a version-2 Report) and report.md (read this first) for a capture folder; `review` adds its part to the same two
// files. Blocking findings are split against the baseline's: a finding the base also had is listed under "Already on this base"
// and doesn't fail the run; with no baseline report nothing can be told apart, so every finding blocks. No scores anywhere.
// Page text is quoted, never followed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Capture, Improvement, Page, Report, ShotDiff } from "./types.ts";

// A shot counts as changed when this share (%) of its pixels differ from the baseline's, or at least CHANGED_PX of them (one
// changed word: on a 2560px shot 0.1% is a whole paragraph).
export const CHANGED_PCT = 0.1, CHANGED_PX = 1000;

export const readReport = (dir: string): Report | null => existsSync(join(dir, "report.json")) ? (JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as Report) : null;

/** What a capture was asked for: `capture` writes it to <out>/run.json before its report. */
export type RunInfo = { base: string; commit?: string; tree?: string; frozenAt: string; pages: Page[]; widths: number[]; themes: string[]; states: string[]; baseline?: string };
export const readRun = (dir: string): RunInfo | null => existsSync(join(dir, "run.json")) ? (JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunInfo) : null;

/** Each finding matched by its text, once: a base finding cancels one head finding. */
export function splitPreexisting(found: string[], baseFound?: string[]) {
  const left = new Map<string, number>();
  for (const b of baseFound ?? []) left.set(b, (left.get(b) ?? 0) + 1);
  const introduced: string[] = [], preexisting: string[] = [];
  for (const b of found) { const n = left.get(b) ?? 0; if (n > 0) { left.set(b, n - 1); preexisting.push(b); } else introduced.push(b); }
  return { introduced, preexisting };
}

export type Changed = ShotDiff & { page: string; width: number; theme: string; state: string };
/** Shots that changed against the baseline, per page, the biggest change first (pages ordered by their biggest change). */
export function lookFirst(caps: Capture[]): { page: string; shots: Changed[] }[] {
  const by = new Map<string, Changed[]>();
  for (const c of caps) for (const d of c.diffs ?? []) if (d.diff) {
    const k = c.page + (c.state === "default" ? "" : ` (${c.state})`);
    by.set(k, [...(by.get(k) ?? []), { page: c.page, width: c.width, theme: c.theme, state: c.state, ...d }]);
  }
  return [...by].map(([page, shots]) => ({ page, shots: shots.sort((a, b) => b.pct - a.pct) })).sort((a, b) => b.shots[0].pct - a.shots[0].pct);
}

/** The capture's report: the rule checks' findings split against the baseline's, then report.json and report.md. */
export function writeReport(out: string, r: Report): Report {
  const hits = r.captures.flatMap((c) => c.rules);
  const blocking = [...new Set(hits.filter((h) => h.blocking).map((h) => h.text))];
  const baseline = readRun(out)?.baseline;
  const { introduced, preexisting } = splitPreexisting(blocking, baseline ? readReport(baseline)?.blocking : undefined);
  r.blocking = introduced; r.preexisting = preexisting;
  r.notes = [...new Set([...r.notes, ...hits.filter((h) => !h.blocking).map((h) => h.text)])];
  saveReport(out, r);
  return r;
}

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

/**
 * Writes report.json and the folder's one report.md: coverage, "Look at these first" (with a baseline: the pages whose pictures
 * changed, biggest change first), once `review` has run the ranked improvements (with their rendered fixes) and the motion rows,
 * then the blocking findings, notes and the captures per page.
 */
export function saveReport(out: string, r: Report): void {
  writeFileSync(join(out, "report.json"), JSON.stringify(r, null, 2));
  const o = readRun(out) ?? { widths: [], themes: [], states: [], pages: [] as Page[], baseline: undefined };
  const cv = r.coverage, introduced = r.blocking ?? [], preexisting = r.preexisting ?? [];
  const lines = [`# UI review of ${r.target}`, "", `${r.frozenAt} (the pages' clock) · widths ${o.widths.join("/")} · themes ${o.themes.join("/")} · states ${o.states.join("/")}${o.baseline ? ` · baseline ${o.baseline}` : ""}${r.commit ? ` · commit ${r.commit}` : ""}${r.model ? ` · model ${r.model}, $${r.cost_usd.toFixed(2)}` : ""}`, "",
    `Coverage: ${cv.done} of ${cv.total} captures done${cv.failed ? `, ${cv.failed} failed` : ""}${cv.deferred ? `, ${cv.deferred} deferred (run again with --resume to take the next pages)` : ""}.`, ""];
  if (o.baseline) {
    const changed = lookFirst(r.captures);
    lines.push("## Look at these first", "", changed.length ? "Pages whose pictures changed, biggest change first (before|after is the comparison picture, diff the pixel diff):" : `No page changed (${CHANGED_PCT}% of a picture's pixels or ${CHANGED_PX} of them).`, "");
    for (const { page, shots } of changed) lines.push(`- ${page}`, ...shots.map((s) => `  - ${s.width}px ${s.theme}: ${s.pct}% changed · before|after: ${s.compare ?? "–"} · diff: ${s.diff ?? "–"}`));
    lines.push("");
  }
  if (r.model) lines.push("## Improvements", "", ...(r.improvements.length ? r.improvements.flatMap((i) => [improvement(i), ""]) : ["None found.", ""]));
  if (r.motion.length) lines.push("## Motion", "", "| Where | Before | After | Why |", "| --- | --- | --- | --- |", ...r.motion.map((m) => `| ${cell(m.where)} | ${cell(m.before)} | ${cell(m.after)} | ${cell(m.why)} |`), "");
  lines.push(introduced.length ? `## Blocking (${introduced.length})` : "## Blocking: none found by the automated checks", "", ...introduced.map((b) => `- ${b}`), "");
  if (preexisting.length) lines.push(`## Already on this base (${preexisting.length}): not this change's`, "", ...preexisting.map((b) => `- ${b}`), "");
  if (r.bugs.length) lines.push("## Bugs", "", ...r.bugs.map((b) => `- ${b.title} (\`${b.page}\`, ${b.width}px ${b.theme}${b.verified ? ", verified" : ""}): ${b.evidence}`), "");
  if (r.session) lines.push("## Session", "", `Signed in (${r.session.rung})${r.session.relogins ? `, signed in again ${r.session.relogins} time${r.session.relogins > 1 ? "s" : ""} after the session ended` : ""}.`, "");
  if (r.blocked?.length) {
    const by = new Map<string, number>();
    for (const b of r.blocked) { const k = `${b.method} ${b.origin}${b.path} (from \`${b.page}\`)`; by.set(k, (by.get(k) ?? 0) + 1); }
    lines.push(`## Blocked requests (${r.blocked.length})`, "", "The live-app guard refused these (the app's mode doesn't allow them); each page was captured as it stood.", "", ...[...by].map(([k, n]) => `- ${k}${n > 1 ? ` x${n}` : ""}`), "");
  }
  if (r.notes.length) lines.push(`## Notes (${r.notes.length}): not failures`, "", ...r.notes.map((n) => `- ${n}`), "");
  lines.push("## Pages", "");
  const shows = new Map(o.pages.filter((p) => p.shows).map((p) => [p.path, p.shows as string]));
  for (const p of [...new Set(r.captures.map((c) => c.page))]) {
    lines.push(`### ${p}${shows.has(p) ? ` — ${shows.get(p)}` : ""}`, "", "Screenshots (open each one):", ...r.captures.filter((c) => c.page === p).flatMap((c) => c.shots.map((s) => `- ${s}${c.settled || c.state === "loading" ? "" : " (not settled)"}`)), "");
  }
  if (!r.model) lines.push("Automated checks find maybe a third of what matters. Now look at every screenshot against the review checklist, or run `ui-review review` on this folder.");
  writeFileSync(join(out, "report.md"), lines.join("\n"));
}
