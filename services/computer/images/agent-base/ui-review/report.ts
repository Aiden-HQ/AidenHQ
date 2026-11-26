// report.json (a version-2 Report) and report.md (read this first) for a run. The capture part: coverage, blocking findings
// (split against the baseline's: a finding the base also had is listed under "Already on this base" and doesn't fail the run;
// with no baseline report nothing can be told apart, so every finding blocks), "Look at these first" (with --baseline: the
// pages whose pictures changed, biggest change first), notes, and the captures per page. Page text is quoted, never followed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGED_PCT } from "./capture.ts";
import type { Capture, Report, ShotDiff } from "./types.ts";

export const readReport = (dir: string): Report | null => existsSync(join(dir, "report.json")) ? (JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as Report) : null;

/** Each finding matched by its text, once: a base finding cancels one head finding. */
export function splitPreexisting(found: string[], baseFound?: string[]) {
  const left = new Map<string, number>();
  for (const b of baseFound ?? []) left.set(b, (left.get(b) ?? 0) + 1);
  const introduced: string[] = [], preexisting: string[] = [];
  for (const b of found) { const n = left.get(b) ?? 0; if (n > 0) { left.set(b, n - 1); preexisting.push(b); } else introduced.push(b); }
  return { introduced, preexisting };
}

export type Changed = { page: string; width: number; theme: string; state: string } & Required<Pick<ShotDiff, "shot" | "pct">> & ShotDiff;
/** Shots that changed against the baseline, per page, the biggest change first (pages ordered by their biggest change). */
export function lookFirst(caps: Capture[]): { page: string; shots: Changed[] }[] {
  const by = new Map<string, Changed[]>();
  for (const c of caps) for (const d of c.diffs ?? []) if (d.pct >= CHANGED_PCT) {
    const k = c.page + (c.state === "default" ? "" : ` (${c.state})`);
    by.set(k, [...(by.get(k) ?? []), { page: c.page, width: c.width, theme: c.theme, state: c.state, ...d }]);
  }
  return [...by].map(([page, shots]) => ({ page, shots: shots.sort((a, b) => b.pct - a.pct) })).sort((a, b) => b.shots[0].pct - a.shots[0].pct);
}

/** Writes report.json and report.md; returns the report. `baseline` is the baseline run's folder, when there is one. */
export function writeReport(out: string, r: Report, o: { widths: number[]; themes: string[]; states: string[]; baseline?: string; shows?: Record<string, string> }): Report {
  const hits = r.captures.flatMap((c) => c.rules);
  const blocking = [...new Set(hits.filter((h) => h.blocking).map((h) => h.text))];
  const base = o.baseline ? readReport(o.baseline) : null;
  const { introduced, preexisting } = splitPreexisting(blocking, base?.blocking);
  r.blocking = introduced; r.preexisting = preexisting;
  r.notes = [...new Set([...r.notes, ...hits.filter((h) => !h.blocking).map((h) => h.text)])];
  writeFileSync(join(out, "report.json"), JSON.stringify(r, null, 2));

  const cv = r.coverage;
  const lines = [`# UI review of ${r.target}`, "", `${r.frozenAt} (the pages' clock) · widths ${o.widths.join("/")} · themes ${o.themes.join("/")} · states ${o.states.join("/")}${o.baseline ? ` · baseline ${o.baseline}` : ""}${r.commit ? ` · commit ${r.commit}` : ""}`, "",
    `Coverage: ${cv.done} of ${cv.total} captures done${cv.failed ? `, ${cv.failed} failed` : ""}${cv.deferred ? `, ${cv.deferred} deferred (run again with --resume to take the next pages)` : ""}.`, ""];
  if (o.baseline) {
    const changed = lookFirst(r.captures);
    lines.push("## Look at these first", "", changed.length ? "Pages whose pictures changed, biggest change first (before|after is the comparison picture, diff the pixel diff):" : `No page changed by ${CHANGED_PCT}% or more of its pixels.`, "");
    for (const { page, shots } of changed) lines.push(`- ${page}`, ...shots.map((s) => `  - ${s.width}px ${s.theme}: ${s.pct}% changed · before|after: ${s.compare ?? "–"} · diff: ${s.diff ?? "–"}`));
    lines.push("");
  }
  lines.push(introduced.length ? `## Blocking (${introduced.length})` : "## Blocking: none found by the automated checks", "", ...introduced.map((b) => `- ${b}`), "");
  if (preexisting.length) lines.push(`## Already on this base (${preexisting.length}): not this change's`, "", ...preexisting.map((b) => `- ${b}`), "");
  if (r.notes.length) lines.push(`## Notes (${r.notes.length}): not failures`, "", ...r.notes.map((n) => `- ${n}`), "");
  lines.push("## Pages", "");
  const pages = [...new Set(r.captures.map((c) => c.page))];
  for (const p of pages) {
    const shows = o.shows?.[p];
    lines.push(`### ${p}${shows ? ` — ${shows}` : ""}`, "", "Screenshots (open each one):", ...r.captures.filter((c) => c.page === p).flatMap((c) => c.shots.map((s) => `- ${s}${c.settled || c.state === "loading" ? "" : " (not settled)"}`)), "");
  }
  lines.push("Automated checks find maybe a third of what matters. Now look at every screenshot against the review checklist.");
  writeFileSync(join(out, "report.md"), lines.join("\n"));
  return r;
}
