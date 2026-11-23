// Tool output to raw findings: one SARIF reader (govulncheck, ruff, …) and a small
// adapter each for the tools with their own format (vulture, scc) and for plain `path:line:col: message` lines
// (squawk). A raw finding is what review.ts `clean` takes; tools.ts places it, tags its option and lens and caps
// it. Every adapter throws on output that isn't its format (that is a failed tool, never a clean one).
import type { Option } from "./catalog.ts";

export type Raw = { severity: "important" | "nit"; path: string; line: number; end_line?: number; title: string; why: string; evidence: string; fix_brief: string };
/** The most findings kept from one option; the rest are counted (tools.ts). */
export const MAX_PER_OPTION = 200;

const first = (t: unknown) => String(t ?? "").trim().split("\n")[0]!.trim();
const cut = (t: unknown, n: number) => String(t ?? "").slice(0, n);
/** A path as the checkout names it: a file:// URL or an absolute path inside `root` made relative, `./` dropped. */
export function relPath(p: unknown, root: string) {
  let s = String(p ?? "");
  if (s.startsWith("file://")) { try { s = decodeURIComponent(new URL(s).pathname); } catch { return ""; } }
  const r = root.replace(/\/$/, "");
  if (s.startsWith(`${r}/`)) s = s.slice(r.length + 1);
  return s.replace(/^\.\//, "");
}
/** A line format's findings, or a throw when the text has content but not one line of that format (a crashed tool's message). */
const some = (text: string, out: Raw[], what: string) => { if (!out.length && text.trim()) throw new Error(`no ${what} in it`); return out; };
const num = (v: unknown, fallback = 1) => (Number.isInteger(v) && (v as number) >= 1 ? (v as number) : fallback);

/** SARIF 2.1: each result becomes a finding; level error is important, warning and note are nits. `cap: "nit"` (a tool that marks
 * everything an error) makes them all nits. */
export function readSarif(text: string, root: string, cap?: "nit"): Raw[] {
  const doc = JSON.parse(text);
  if (!doc || !Array.isArray(doc.runs)) throw new Error("not SARIF: no runs");
  const out: Raw[] = [];
  for (const run of doc.runs) {
    const tool = String(run?.tool?.driver?.name ?? "tool");
    const rules = new Map<string, any>(((run?.tool?.driver?.rules ?? []) as any[]).map((r) => [String(r?.id), r]));
    for (const res of Array.isArray(run?.results) ? run.results : []) {
      const rule = String(res?.ruleId ?? res?.rule?.id ?? "?");
      const level = String(res?.level ?? rules.get(rule)?.defaultConfiguration?.level ?? "warning");
      const loc = res?.locations?.[0]?.physicalLocation;
      const path = relPath(loc?.artifactLocation?.uri, root);
      const message = String(res?.message?.text ?? res?.message?.markdown ?? "");
      const snippet = loc?.region?.snippet?.text;
      out.push({
        severity: level === "error" && cap !== "nit" ? "important" : "nit", path, line: num(loc?.region?.startLine), ...(Number.isInteger(loc?.region?.endLine) ? { end_line: loc.region.endLine } : {}),
        title: cut(`${rule}: ${first(message)}`, 120), why: cut(message, 600),
        evidence: cut(`${tool} ${rule} (${level})${snippet ? `\n${snippet}` : ""}`, 600),
        fix_brief: cut(res?.fixes?.[0]?.description?.text ?? rules.get(rule)?.help?.text ?? `Resolve the ${tool} finding ${rule}.`, 400),
      });
    }
  }
  return out;
}

/** vulture's lines: `path:line: unused function 'name' (60% confidence)`, `, 4 lines` inside the brackets with sort_by_size.
 * Empty output is no findings; output with no such line isn't vulture's. */
export function readVulture(text: string): Raw[] {
  const out: Raw[] = [];
  for (const l of text.split("\n")) {
    const m = /^(.+?):(\d+): (.+) \((\d+)% confidence(?:, \d+ lines?)?\)$/.exec(l);
    if (m) out.push({ severity: "nit", path: m[1]!, line: num(Number(m[2])), title: cut(m[3]!, 120), why: `vulture found ${m[3]} at ${m[4]}% confidence.`, evidence: l, fix_brief: "Delete it, after checking nothing reaches it dynamically (reflection, a framework hook, a public API)." });
  }
  return some(text, out, "vulture's lines");
}

/** scc --by-file -f json: [{ Name, Files: [{ Location, Lines, Code, Complexity }] }]. The most complex files, as nits at line 1. */
export const HOTSPOT_COMPLEXITY = 50;
export const HOTSPOTS = 10;
export function readScc(text: string): Raw[] {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc)) throw new Error("not scc's JSON: a list of languages");
  const files = doc.flatMap((l: any) => (Array.isArray(l?.Files) ? l.Files : []));
  return files.filter((f: any) => Number(f?.Complexity) >= HOTSPOT_COMPLEXITY).sort((a: any, b: any) => b.Complexity - a.Complexity).slice(0, HOTSPOTS).map((f: any) => ({
    severity: "nit" as const, path: String(f.Location ?? ""), line: 1, title: cut(`Complexity hotspot: ${f.Complexity} branch points`, 120), why: `${f.Location} has ${f.Complexity} branch points in ${f.Code} lines of code (${f.Lines} lines in all): one of the most complex files in the repository.`,
    evidence: `scc: complexity ${f.Complexity}, ${f.Code} code lines`, fix_brief: "Split it along its responsibilities, starting with the most branching functions.",
  }));
}

/** `path:line:col: message` lines (gcc style; squawk --reporter gcc). `warning:`, `note:` or
 * a trailing `[Warning/…]` makes a nit; anything else is important. Lines of other shapes beside them are ignored (a summary, a
 * message's own lines); empty output is no findings, output with none of these lines isn't the format. */
export function readLines(text: string): Raw[] {
  const out: Raw[] = [];
  for (const l of text.split("\n")) {
    const m = /^([^\s:][^:]*?):(\d+):(?:(\d+):)?\s*(?:(error|warning|note|info):\s*)?(.+)$/i.exec(l);
    if (!m) continue;
    const rest = m[5]!.trim();
    const nit = /^(warning|note|info)$/i.test(m[4] ?? "") || /\[(warning|advice)\b/i.test(rest);
    out.push({ severity: nit ? "nit" : "important", path: m[1]!, line: num(Number(m[2])), title: cut(first(rest), 120), why: cut(rest, 600), evidence: cut(l, 600), fix_brief: "Fix what the message reports." });
  }
  return some(text, out, "path:line: lines");
}

/** A tool's stdout read as its option says. Throws when it isn't that format. */
export function adapt(o: { output: Exclude<Option["output"], "findings">; severity?: "nit" }, text: string, root: string): Raw[] {
  const raw = o.output === "sarif" ? readSarif(text, root, o.severity) : o.output === "vulture" ? readVulture(text) : o.output === "scc" ? readScc(text) : readLines(text);
  return o.severity === "nit" ? raw.map((f) => ({ ...f, severity: "nit" as const })) : raw;
}
