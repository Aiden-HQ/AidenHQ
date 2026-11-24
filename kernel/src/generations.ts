// The host's apply generations (`ops/lib/generations.sh`: `generations.jsonl`, one line per apply, newest last), for the Maintainer's
// and the Fleet Steward's `fleet_generation_status`: the current product pin and the last generations, so a fix that rolled back is
// visible without the host. Read-only, and never a guess: a missing or unreadable file is an explicit error, not an empty list.
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { hostOf } from "./codehost.ts";
import { openFacts } from "./facts.ts";

export const GENERATIONS_KEPT = 20;

export interface Generation {
  n: number | null; at: string | null; product: string | null; health: string | null; reason: string | null; log: string | null;
  revert_of: number | null; lkg: number | null; data_versions: Record<string, number> | null;
}

const num = (v: unknown) => (typeof v === "number" ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);
const one = (r: Record<string, unknown>): Generation => ({
  n: num(r.n), at: str(r.at), product: str(r.product), health: str(r.health), reason: str(r.reason), log: str(r.log),
  revert_of: num(r.revert_of), lkg: num(r.lkg), data_versions: r.data_versions && typeof r.data_versions === "object" ? (r.data_versions as Record<string, number>) : null,
});

/** `pin`: the product commit of the newest generation that got past validation (a refused apply switched nothing). */
export function fleetGenerations(file: string): { pin: string | null; generations: Generation[] } | { error: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { error: `cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  }
  let rows: Record<string, unknown>[];
  try {
    rows = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch (err) {
    return { error: `${file} is not JSON lines: ${String(err).slice(0, 200)}` };
  }
  return { pin: rows.slice().reverse().map(one).find((g) => g.health !== "refused")?.product ?? null, generations: rows.slice(-GENERATIONS_KEPT).reverse().map(one) };
}

/** The product checkout's GitHub repo (owner/name, lowercase) from its origin, or undefined. */
function productRepo(repo: string): string | undefined {
  try {
    const url = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}
const SHA = /^[0-9a-f]{40}$/;
/** The most git runs one look makes (the rest wait for the next look, which finds the earlier answers remembered). */
const CHECKS = 200;
/**
 * Whether commit `a` is in `b` in the product checkout, git run off the event loop; undefined when git could not say (a commit this
 * checkout has not fetched yet: asked again at the next look). An answer git gave (exit 0 or 1) is final, since ancestry between two
 * commits never changes, so it is remembered and costs no run; `runs` counts the runs made.
 */
const known = new Map<string, boolean>();
const contains = (repo: string, a: string, b: string, runs: { n: number }): Promise<boolean | undefined> => {
  if (!SHA.test(a) || !SHA.test(b)) return Promise.resolve(false);
  const key = `${a}:${b}`, hit = known.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  runs.n++;
  return new Promise((resolve) => {
    execFile("git", ["-C", repo, "merge-base", "--is-ancestor", "--end-of-options", a, b], (err) => {
      const code = err ? (err as { code?: unknown }).code : 0;
      if (code === 0 || code === 1) { if (known.size >= 50_000) known.clear(); known.set(key, code === 0); resolve(code === 0); } else resolve(undefined);
    });
  });
};

/**
 * Flow's deploy facts from the host's generations (Task 5): `deploy.applied` for each generation that switched something
 * (good or failed; pending is unsettled, refused switched nothing), and `pr.deployed` for each merged product PR, once, at the
 * first good generation whose product commit contains its merge commit. The file is the shell's, so the kernel calls this at
 * start and then on a timer; every fact's id is deterministic, so a re-run records nothing new. The file is read and its
 * generations recorded again only when its size or mtime changed (the shell rewrites it in place). The PRs are looked at only
 * when a good generation newer than the last look exists (git runs asynchronously, and a look already running is the one a
 * second call waits for). Each call resolves to how many facts it recorded.
 */
export function createDeploys({ db, file, repo, days = 30 }: { db: DatabaseSync; file: string; repo: string; days?: number }): () => Promise<number> {
  const facts = openFacts(db);
  let looked = "", read = "", gens: Generation[] = [], running: Promise<number> | undefined, slug: string | undefined;
  const recorded = new Set<string>(); // the generations whose fact this process wrote or found already there: a rewrite of the file costs only its new lines
  const look = async (): Promise<number> => {
  let st;
  try { st = statSync(file); } catch { return 0; }
  let n = 0;
  const stamp = `${st.size}:${st.mtimeMs}`;
  if (read !== stamp) {
    gens = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [one(JSON.parse(l))]; } catch { return []; } }).filter((g) => g.n !== null && g.at);
    for (const g of gens) {
      if (g.health !== "good" && g.health !== "failed") continue;
      const k = `${g.n}:${g.health}`;
      if (recorded.has(k)) continue;
      if (facts.record({ type: "deploy.applied", subject: `deploy:${g.n}`, version: g.health, at: g.at!, actor: "kernel", source: "poll", data: { generation: g.n, product: g.product, health: g.health, revert_of: g.revert_of } })) n++;
      recorded.add(k);
    }
    read = stamp; // only once every generation is recorded: a failure reads the file again next time
  }
  // What a look covers is the newest good generation and the newest merge fact: merges that arrive after it (a backfill still
  // running, a late poll) are looked at too, not only when the next generation lands.
  const newest = Math.max(-1, ...gens.filter((g) => g.health === "good").map((g) => g.n!));
  const state = `${newest}:${(db.prepare("SELECT max(seq) AS s FROM facts WHERE type = 'pr.merged'").get() as { s: number | null }).s ?? 0}`;
  if (state === looked) return n;
  slug ??= productRepo(repo);
  if (!slug) return (looked = state), n;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  // Only the product repo's own code host may say a PR merged (its name is in the version, POST /v1/facts and localFacts):
  // any module may declare pr.merged, and none other can claim a deploy.
  const host = `${hostOf(slug)}/`;
  const deployed = new Set((db.prepare("SELECT lower(subject) AS s FROM facts WHERE type = 'pr.deployed'").all() as { s: string }[]).map((r) => r.s));
  const merged = (db.prepare("SELECT subject, at, json_extract(data, '$.sha') AS sha FROM facts WHERE type = 'pr.merged' AND substr(version, 1, ?) = ? AND at > ? AND lower(subject) LIKE ? ORDER BY at DESC")
    .all(host.length, host, since, `pr:${slug}#%`) as { subject: string; at: string; sha: unknown }[])
    .filter((m) => typeof m.sha === "string" && SHA.test(m.sha) && !deployed.has(m.subject.toLowerCase()));
  const good = gens.filter((g) => g.health === "good" && g.product && SHA.test(g.product)).sort((a, b) => a.n! - b.n!);
  const runs = { n: 0 };
  let complete = true; // false when a look ran out of runs or git could not answer: the next look goes again
  for (const m of merged) {
    let g: Generation | undefined;
    // A merge no good generation can hold yet (all older than it) costs no run; the cap counts runs, not merges.
    for (const x of good) {
      if (Date.parse(x.at!) < Date.parse(m.at)) continue;
      if (runs.n >= CHECKS) { complete = false; break; }
      const c = await contains(repo, m.sha as string, x.product!, runs);
      if (c === undefined) complete = false;
      else if (c) { g = x; break; }
    }
    if (g && facts.record({ type: "pr.deployed", subject: m.subject, version: "deployed", at: g.at!, actor: "kernel", source: "poll", data: { pr: m.subject.slice(3), generation: g.n } })) n++;
  }
  if (complete) looked = state;
  return n;
  };
  return () => (running ??= look().finally(() => { running = undefined; }));
}
