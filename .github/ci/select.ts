// Which test suites a change needs (ci.yml's checks job), from the map in areas.json, both read from the tested tree.
// No dependencies: it runs before anything is installed.
//
// A file counts unless it is under docs/ or is Markdown outside the map's `markdown` list (Markdown the tests read). A
// counted file under `everything` (CI's own definition, shared code) or under no suite's paths selects every suite. A
// suite whose paths are "*" runs for any counted file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface Suite { name: string; dir?: string; paths: string[]; ignore?: string[]; main?: boolean; secs?: number; run?: string; job?: string }
export interface AreaMap { markdown: string[]; everything: string[]; suites: Suite[] }
export interface Selection { all: boolean; why?: string; names: string[] }

const under = (f: string, p: string) => f === p || f.startsWith(`${p}/`);
const counted = (map: AreaMap, f: string) => !under(f, "docs") && (!f.endsWith(".md") || map.markdown.some((p) => under(f, p)));

/** { all, why, names }: the suites these changed files need. */
export function suitesFor(map: AreaMap, files: string[]): Selection {
  const every = (why: string) => ({ all: true, why, names: map.suites.map((s) => s.name) });
  const code = files.filter((f) => counted(map, f));
  const ci = code.find((f) => map.everything.some((p) => under(f, p)));
  if (ci) return every(`${ci} changes CI or shared code`);
  const known = map.suites.flatMap((s) => s.paths).filter((p) => p !== "*").concat(map.markdown);
  const stray = code.find((f) => !known.some((p) => under(f, p)));
  if (stray) return every(`${stray} is under no suite`);
  const names = map.suites
    .filter((s) => code.some((f) => !(s.ignore ?? []).includes(f) && s.paths.some((p) => p === "*" || under(f, p))))
    .map((s) => s.name);
  return { all: false, names };
}

/**
 * A test job's shards: enough that each runs in about TARGET seconds (its suites' measured `secs` summed, over how many of
 * them a 4-CPU runner runs side by side: `parallel`), at most MAX_SHARDS, filled heaviest first into the lightest shard so
 * they finish together. The packages job's suites each use every CPU (node --test over many files): one at a time; the
 * modules' small suites overlap about two at a time (measured 2026-11-20: a shard took half its suites' sum).
 */
// At most 3 (owner, 2026-11-22: fewer runner starts after the test trim; each start costs ~20 s of checkout and install).
const MAX_SHARDS = 3, TARGET = 40;
export function shard(tests: { name: string; dir: string; run?: string; secs: number }[], parallel: number) {
  const sorted = [...tests].sort((a, b) => b.secs - a.secs || a.name.localeCompare(b.name));
  if (!sorted.length) return [];
  const total = sorted.reduce((n, t) => n + t.secs, 0);
  const k = Math.min(MAX_SHARDS, Math.ceil(total / (parallel * TARGET)));
  const shards = Array.from({ length: k }, (_, i) => ({ shard: i + 1, load: 0, entries: [] as { name: string; dir: string; run?: string; secs: number }[] }));
  for (const t of sorted) {
    const s = shards.reduce((lo, x) => (x.load < lo.load ? x : lo));
    s.load += t.secs;
    s.entries.push({ name: t.name, dir: t.dir, run: t.run, secs: t.secs });
  }
  return shards;
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
// --no-renames: a moved file lists both its old and its new path, so the suites of both sides run.
const changed = (a: string, b: string) => git("diff", "--name-only", "--no-renames", a, b).split("\n").filter(Boolean);

function main() {
  const env = process.env;
  const map: AreaMap = JSON.parse(readFileSync(".github/ci/areas.json", "utf8"));
  const sel = env.ALL ? { all: true, why: env.ALL, names: map.suites.map((s) => s.name) } : suitesFor(map, changed(env.BASE!, env.HEAD!));
  const names = sel.names;
  if (sel.all) console.error(`Every suite: ${sel.why}`);
  // A slow suite (`main: true`) runs only on a push to main (MAIN): a flake there never holds a PR or a merge train.
  const tests = map.suites
    .filter((s: Suite) => names.includes(s.name) && (!s.main || env.MAIN))
    .map((s: Suite) => ({ name: s.name, dir: s.dir ?? s.name, run: s.run, secs: s.secs ?? 5, ...(s.job ? { job: s.job } : {}) }));
  // The test jobs' shards; heavy: the jobs that may run on our own runners (ci.yml's `runner` step), the packages shards and board.
  const pk = shard(tests.filter((t) => t.job == null), 1), md = shard(tests.filter((t) => t.job === "modules"), 2);
  const plan = { packages: pk, modules: md, heavy: pk.length + (tests.some((t) => t.job === "board") ? 1 : 0) };
  process.stdout.write(`${JSON.stringify({ tests, shards: plan })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
