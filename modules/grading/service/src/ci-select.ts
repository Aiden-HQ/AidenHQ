export interface Suite { name: string; paths: string[]; ignore?: string[]; main?: boolean; secs?: number; run?: string; job?: string }
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
const MAX_SHARDS = 5, TARGET = 40;
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

