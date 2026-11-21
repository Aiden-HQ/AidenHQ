// A repo review's report: the verdict and the markdown document (Primer's, and the board's GET /reviews/:batch/report), made by
// code from the batch's stored reviews, never by a model. Findings stay stored per option observation; display() groups the same
// lens, file and overlapping lines for the reader only. Repo-derived text (titles, evidence, fix briefs: a model's or a tool's
// words about the repo's code) is flattened to plain lines, and evidence and the fix prompt go in fences it can't close.
import type { Finding, Review } from "./seams.ts";

/** Primer's limit is 80,000 characters; the report keeps under it with room for its header. */
export const REPORT_MAX = 78_000;
export type Verdict = "blocked" | "concerns" | "incomplete" | "clean";
export type Shown = Finding & { option: string; lens: string };
export type Coverage = { ran: string[]; failed: { id: string; why: string }[]; skipped: { id: string; why: string }[]; partial: { id: string; why: string }[] };
/** One run of a repo review as the report reads it: its option (the tools run: `tools`, with its tool options), its lens, its end and its review. */
export type ReportRun = { option: string; options?: string[]; lens: string | null; status: string; why: string | null; cost_usd: number; review: Review | null };
export type ReportBatch = { repo: string; sha: string; created: string; run_usd: number; runs: ReportRun[]; lensOf: (option: string) => string };

const RANK: Record<string, number> = { important: 0, nit: 1, pre_existing: 2 };

/** blocked: an important security finding; concerns: any other important one; incomplete: none, but coverage was partial; else clean. */
export function verdict({ findings, coverage }: { findings: Pick<Shown, "severity" | "lens">[]; coverage: Coverage }): Verdict {
  const important = findings.filter((f) => f.severity === "important");
  if (important.some((f) => f.lens === "security")) return "blocked";
  if (important.length) return "concerns";
  if (coverage.failed.length || coverage.skipped.length || coverage.partial.length) return "incomplete";
  return "clean";
}

/** Every option's end: ran, failed (a tool the tools run reports failed too), skipped, or ran with partial coverage. */
export function coverageOf(runs: ReportRun[]): Coverage {
  const c: Coverage = { ran: [], failed: [], skipped: [], partial: [] };
  for (const r of runs) {
    const ids = r.options ?? [r.option];
    if (r.status === "skipped") { for (const id of ids) c.skipped.push({ id, why: r.why ?? "skipped" }); continue; }
    if (r.status !== "done" || !r.review) { for (const id of ids) c.failed.push({ id, why: r.why ?? r.status }); continue; }
    const failed = new Map((r.review.coverage?.failed ?? []).map((f) => [f.id, f.why]));
    for (const id of ids) failed.has(id) ? c.failed.push({ id, why: failed.get(id)! }) : c.ran.push(id);
    if (r.review.coverage?.incomplete) c.partial.push({ id: r.option, why: r.review.coverage.incomplete });
  }
  return c;
}

/** The batch's findings, each tagged with the option that found it and its lens. */
export function findingsOf(b: Pick<ReportBatch, "runs" | "lensOf">): Shown[] {
  return b.runs.flatMap((r) => (r.status === "done" && r.review ? r.review.findings : []).map((f) => {
    const option = f.option ?? r.option;
    return { ...f, option, lens: f.lens ?? r.lens ?? b.lensOf(option) };
  }));
}

/** For display only: findings in the same lens and file whose lines overlap are one entry, keeping every option that found it. */
export function display(findings: Shown[]) {
  type Group = { lens: string; path: string; line: number; end: number; severity: Finding["severity"]; items: Shown[]; options: string[] };
  const groups: Group[] = [];
  for (const f of [...findings].sort((a, b) => a.lens.localeCompare(b.lens) || a.path.localeCompare(b.path) || a.line - b.line)) {
    const end = Math.max(f.line, f.end_line ?? f.line);
    const g = groups.find((x) => x.lens === f.lens && x.path === f.path && f.line <= x.end && end >= x.line);
    if (!g) { groups.push({ lens: f.lens, path: f.path, line: f.line, end, severity: f.severity, items: [f], options: [f.option] }); continue; }
    g.items.push(f);
    g.end = Math.max(g.end, end);
    if (RANK[f.severity]! < RANK[g.severity]!) g.severity = f.severity;
    if (!g.options.includes(f.option)) g.options.push(f.option);
  }
  return groups.sort((a, b) => RANK[a.severity]! - RANK[b.severity]!);
}

/** Repo-derived text as one plain line: no control characters, no markup that renders. */
const flat = (s: unknown, max: number) => String(s ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›")).replace(/\s+/g, " ").trim().slice(0, max);
/** Text in a code fence longer than any backtick run inside it, so it can't close the fence. */
const fence = (text: string, info = "") => { const f = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1))); return `${f}${info}\n${text}\n${f}`; };
const usd = (n: number) => `$${n.toFixed(2)}`;
const LENS_ORDER = ["security", "correctness", "maintainability", "performance"];

/**
 * The report's markdown, at most REPORT_MAX characters: the verdict, findings by lens (most severe first), coverage (failed and
 * skipped options too), cost and a fix prompt to paste into Claude Code or Codex. Too long: nits are left out first (counted),
 * then pre-existing findings, then the least of the important ones; the whole is cut at the limit as a last resort.
 */
export function render(b: ReportBatch): { markdown: string; verdict: Verdict; counts: Record<string, number> } {
  const findings = findingsOf(b);
  const coverage = coverageOf(b.runs);
  const v = verdict({ findings, coverage });
  const groups = display(findings);
  const counts = { important: 0, nit: 0, pre_existing: 0 } as Record<string, number>;
  for (const g of groups) counts[g.severity]!++;
  const cost = b.runs.reduce((n, r) => n + r.cost_usd, 0);
  const entry = (g: (typeof groups)[number]) => {
    const f = g.items[0]!;
    const lines = g.end > g.line ? `${g.line}-${g.end}` : `${g.line}`;
    return [`#### ${flat(f.title, 200)}`, `${g.severity} · \`${flat(g.path, 300).replace(/`/g, "'")}:${lines}\` · found by ${g.options.map((o) => flat(o, 80)).join(", ")}`, "",
      ...(f.why ? [flat(f.why, 1500), ""] : []), ...(f.evidence ? [fence(String(f.evidence).slice(0, 1500)), ""] : []), ...(f.fix_brief ? [`Fix: ${flat(f.fix_brief, 1000)}`, ""] : [])].join("\n");
  };
  const texts = groups.map(entry);
  const shown = groups.map(() => true);
  const dropped = { important: 0, nit: 0, pre_existing: 0 } as Record<string, number>;
  const HEADLINE: Record<Verdict, string> = {
    blocked: "Blocked: an important security finding is open.",
    concerns: "Concerns: important findings are open.",
    incomplete: "Incomplete: no important finding, but not every option ran in full.",
    clean: "Clean: every option ran in full and found nothing important.",
  };
  const build = () => {
    const out = [`# Repo review: ${b.repo}`, "", `Commit \`${b.sha}\` · ${b.created.slice(0, 10)} · ${usd(cost)} of a ${usd(b.run_usd)} cap`, "", `## Verdict`, "", HEADLINE[v], "",
      `${counts.important} important · ${counts.nit} nits · ${counts.pre_existing} pre-existing`, "", "## Findings by lens", ""];
    const lenses = [...new Set(groups.map((g) => g.lens))].sort((a, z) => (LENS_ORDER.indexOf(a) + 1 || 99) - (LENS_ORDER.indexOf(z) + 1 || 99));
    if (!groups.length) out.push("No findings.", "");
    for (const lens of lenses) {
      out.push(`### ${lens[0]!.toUpperCase()}${lens.slice(1)}`, "");
      groups.forEach((g, i) => { if (g.lens === lens && shown[i]) out.push(texts[i]!); });
    }
    const left = Object.entries(dropped).filter(([, n]) => n).map(([s, n]) => `${n} ${s === "nit" ? "nits" : s === "pre_existing" ? "pre-existing findings" : "important findings"}`);
    if (left.length) out.push(`_Not shown, to keep the report within Primer's size: ${left.join(", ")}. Every finding is on the board's Reviews page._`, "");
    out.push("## Coverage", "");
    for (const id of coverage.ran) out.push(`- ${flat(id, 80)}: ran`);
    for (const f of coverage.failed) out.push(`- ${flat(f.id, 80)}: **failed**: ${flat(f.why, 400)}`);
    for (const f of coverage.skipped) out.push(`- ${flat(f.id, 80)}: skipped: ${flat(f.why, 300)}`);
    for (const f of coverage.partial) out.push(`- ${flat(f.id, 80)}: partial: ${flat(f.why, 300)}`);
    out.push("", "## Cost", "");
    for (const r of b.runs) out.push(`- ${flat(r.option, 80)}: ${usd(r.cost_usd)}`);
    out.push(`- Total: ${usd(cost)} of ${usd(b.run_usd)}`, "");
    const fix = groups.filter((g, i) => shown[i] && g.severity === "important").map((g) => `- ${flat(g.path, 300)}:${g.line}: ${flat(g.items[0]!.title, 200)}. ${flat(g.items[0]!.fix_brief, 600)}`);
    out.push("## Fix prompt", "", "Paste into Claude Code or Codex, in a checkout of this commit:", "",
      fence([`Fix these findings from a code review of ${b.repo} at ${b.sha}. For each, confirm it in the code first; fix it with a test if it holds, or say why it doesn't.`, "", ...(fix.length ? fix : ["(no important findings)"])].join("\n")), "");
    return out.join("\n");
  };
  // Each entry's length is known, so the cut is counted, then built once (room kept for the "not shown" line).
  let size = build().length + 200;
  for (const sev of ["nit", "pre_existing", "important"])
    for (let i = groups.length - 1; i >= 0 && size > REPORT_MAX; i--) {
      if (groups[i]!.severity !== sev || !shown[i]) continue;
      shown[i] = false;
      dropped[sev]!++;
      size -= texts[i]!.length + 1;
    }
  let md = build();
  if (md.length > REPORT_MAX) md = `${md.slice(0, REPORT_MAX - 40)}\n\n_The report was cut at its size limit._`;
  return { markdown: md, verdict: v, counts };
}
