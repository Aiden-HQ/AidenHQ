// Candidate bugs: one judging call per page over its captures (before|after pictures when the run had a baseline). The answer
// goes to candidates.json, never to the report: a candidate has no steps, so it is a lead for the clicking pass to turn into
// steps in clicks.json, which `repro` replays. Only a bug `repro` verified is reported.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ask, DEFAULT_MODEL, spend } from "./model.ts";
import { readReport, readRun } from "./report.ts";
import type { Capture, Theme } from "./types.ts";

export type Candidate = { page: string; width: number; theme: Theme; title: string; evidence: string; capture: string };
const system = readFileSync(new URL("./prompts/bugs.md", import.meta.url), "utf8").trim();
const fence = (s: string) => `<untrusted>\n${s.replace(/<\/?untrusted>/gi, "")}\n</untrusted>`;
const schema = {
  type: "object", additionalProperties: false, required: ["candidates"],
  properties: { candidates: { type: "array", maxItems: 6, items: {
    type: "object", additionalProperties: false, required: ["title", "evidence", "width", "theme", "capture"],
    properties: { title: { type: "string" }, evidence: { type: "string" }, width: { type: "integer" }, theme: { type: "string", enum: ["light", "dark"] }, capture: { type: "string" } },
  } } },
};
const WIDTHS = [1512, 390]; // the desktop and the phone view of a page are what a judging call is shown

/** The pictures one page's call is shown: per width, the default light capture's first shot, as its before|after when it changed. */
function shown(caps: Capture[]): { file: string; cite: string; compared: boolean }[] {
  return WIDTHS.flatMap((w) => {
    const c = caps.find((k) => k.width === w && k.theme === "light" && k.state === "default") ?? caps.find((k) => k.width === w && k.state === "default");
    if (!c?.shots[0]) return [];
    const d = c.diffs?.find((x) => x.shot === c.shots[0] && x.compare);
    return [{ file: d?.compare ?? c.shots[0], cite: c.shots[0], compared: !!d }];
  });
}

export async function bugs(dir: string, o: { model?: string; base?: string; key?: string } = {}): Promise<{ candidates: Candidate[]; usd: number }> {
  const report = readReport(dir);
  if (!report) throw new Error(`${dir} has no report.json: capture first`);
  const shows = new Map((readRun(dir)?.pages ?? []).filter((p) => p.shows).map((p) => [p.path, p.shows as string]));
  spend.usd = 0;
  const byPage = new Map<string, Capture[]>();
  for (const c of report.captures) byPage.set(c.page, [...(byPage.get(c.page) ?? []), c]);
  const known = new Set(report.captures.flatMap((c) => c.shots));
  const all: Candidate[] = [];
  const pages = [...byPage];
  const worker = async () => {
    for (let item = pages.shift(); item; item = pages.shift()) {
      const [page, caps] = item;
      const pics = shown(caps).filter((p) => existsSync(join(dir, p.file)));
      if (!pics.length) continue;
      const facts = caps.filter((c) => pics.some((p) => p.cite === c.shots[0])).map((c) => `${c.width}px: content ${c.measures.content.width}px of ${c.measures.content.viewport}px; ${c.settled ? "settled" : "not settled"}; checks: ${c.rules.map((r) => r.text).join(" | ") || "none"}`);
      const a = await ask({
        model: o.model ?? DEFAULT_MODEL, system, base: o.base, key: o.key, schema, images: pics.map((p) => join(dir, p.file)),
        text: `Page: ${fence(page)}${shows.has(page) ? `\nIt should show: ${fence(shows.get(page) as string)}` : ""}\n${pics.map((p) => `Capture: ${p.cite}${p.compared ? "\n  (the picture shown for it is its before|after comparison)" : ""}`).join("\n")}\nMeasured:\n${fence(facts.join("\n"))}`,
        validate: (x) => { if (!Array.isArray((x as { candidates?: unknown })?.candidates)) throw new Error('"candidates" must be an array'); },
      }) as { candidates: Omit<Candidate, "page">[] };
      const cited = new Set(pics.map((p) => p.cite));
      for (const c of a.candidates) if (known.has(c.capture) && cited.has(c.capture)) all.push({ ...c, page });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  writeFileSync(join(dir, "candidates.json"), JSON.stringify(all, null, 2));
  return { candidates: all, usd: spend.usd };
}

/** `ui-review bugs <capture dir> [--model id]`: candidates.json beside the report, never in it. */
export async function bugsCommand(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { model: { type: "string" } } });
  if (!positionals[0]) { console.error("usage: ui-review bugs <capture dir> [--model id]"); return 2; }
  try {
    const r = await bugs(positionals[0], { model: v.model });
    console.log(`${join(positionals[0], "candidates.json")}: ${r.candidates.length} candidates (leads to turn into clicks.json steps, never bugs yet), $${r.usd.toFixed(2)}`);
    return 0;
  } catch (e) { console.error(`ui-review bugs: ${(e as Error).message}`); return 1; }
}
