#!/usr/bin/env node
// On-demand CI health report: node scripts/ci-report.ts [--hours 24] [--repo owner/name]
// Reads ci.yml runs and their jobs with `gh api`; writes nothing.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const args = process.argv.slice(2);
const opt = (k: string, d?: string | number) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const hours = Number(opt("--hours", 24));
const repos = opt("--repo") ? [opt("--repo") as string] : ["Aiden-HQ/AidenHQ"];
const now = Date.now();
const since = new Date(now - hours * 3600e3).toISOString().replace(/\.\d+Z/, "Z");
// PR runs from before the window still tell whether a merged PR was ever red.
const prSince = new Date(now - (hours + 7 * 24) * 3600e3).toISOString().replace(/\.\d+Z/, "Z");

const gh = async (path: string, jq: string) => {
  const { stdout } = await run("gh", ["api", "--paginate", path, "--jq", jq], { maxBuffer: 1 << 28 });
  return stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const mins = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 60e3;
const pct = (v: number[], p: number) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(p * (v.length - 1))]! : NaN);
const f = (n: number) => (Number.isNaN(n) ? "-" : n.toFixed(1));
const table = (rows: (string | number)[][]) => {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => "  " + r.map((c, i) => (i ? String(c).padStart(w[i]!) : String(c).padEnd(w[i]!))).join("  ")).join("\n");
};
const pool = async <T, R>(items: T[], fn: (i: T) => Promise<R>, n = 8) => {
  const out: R[] = [];
  await Promise.all(Array.from({ length: n }, async () => { while (items.length) { const i = items.shift()!; out.push(await fn(i)); } }));
  return out;
};

interface Job { name: string; c: string; created: string; started: string; done: string; labels: string; run: { url: string } }

async function report(repo: string) {
  const raw = await gh(`repos/${repo}/actions/workflows/ci.yml/runs?created=>=${prSince}&per_page=100`,
    `.workflow_runs[] | {id, event, branch: .head_branch, status, c: .conclusion, url: .html_url, created: .created_at, sha: .head_sha}`);
  const runs = raw.filter((r) => r.created >= since);
  const done = runs.filter((r) => r.status === "completed");
  const red = done.filter((r) => r.c === "failure" || r.c === "cancelled");
  const prRuns = runs.filter((r) => r.event === "pull_request").length;
  const mainRuns = runs.filter((r) => r.event === "push" && r.branch === "main").length;

  const jobLists = await pool([...runs], async (r) =>
    (await gh(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=100&filter=all`,
      `.jobs[] | {name, c: .conclusion, created: .created_at, started: .started_at, done: .completed_at, labels: (.labels | join(","))}`)).map((j) => ({ ...j, run: r })));
  const jobs = jobLists.flat();

  const walls: number[] = [];
  for (const js of jobLists) {
    const fin = js.filter((j) => j.done);
    if (fin.length) walls.push(mins(js.map((j) => j.created).sort()[0], fin.map((j) => j.done).sort().at(-1)));
  }
  const real = jobs.filter((j) => j.started && j.done && j.c !== "skipped");
  const base = (j: Job) => j.name.split(" (")[0]!;
  const q = (j: Job) => mins(j.created, j.started);
  const queued = jobs.filter((j) => j.started && j.c !== "skipped");
  const kinds = (js: Job[]) => ({ hosted: js.filter((j) => !j.labels.includes("self-hosted")), self: js.filter((j) => j.labels.includes("self-hosted")) });

  const out = [`== ${repo}  (last ${hours}h, ci.yml) ==`];
  out.push(`runs: ${runs.length} (${prRuns} PR, ${mainRuns} main), ${done.length} completed, red ${done.length ? ((100 * red.length) / done.length).toFixed(0) : 0}% (${red.length} failure/cancelled)`);
  out.push(`run wall time (min): p50 ${f(pct(walls, 0.5))}  p90 ${f(pct(walls, 0.9))}`);
  const qrows: (string | number)[][] = [["queue (min)", "jobs", "p50", "p90", "max", ">2min"]];
  for (const [k, js] of [["all", queued] as [string, Job[]], ...Object.entries(kinds(queued))]) {
    const v = js.map(q);
    qrows.push([k, js.length, f(pct(v, 0.5)), f(pct(v, 0.9)), f(pct(v, 1)), v.filter((x) => x > 2).length]);
  }
  out.push(table(qrows));

  const by = (js: Job[]) => { const m = new Map<string, Job[]>(); for (const j of js) m.set(base(j), [...(m.get(base(j)) ?? []), j]); return m; };
  const slow = [...by(real)].map(([n, js]): [string, number, number] => [n, js.length, pct(js.map((j) => mins(j.started, j.done)), 0.9)]).sort((a, b) => b[2] - a[2]).slice(0, 8);
  out.push("slowest jobs (p90 min):", table(slow.map(([n, c, p]) => [n.slice(0, 50), `n=${c}`, f(p)])));
  const bad = [...by(jobs.filter((j) => j.c === "failure" && j.name !== "ci-required"))].sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  out.push("failing jobs:", bad.length ? bad.map(([n, js]) => `  ${String(js.length).padStart(3)}  ${n.slice(0, 50)}  ${js[0]!.run.url}`).join("\n") : "  none");

  const prs = await gh(`search/issues?q=repo:${repo}+is:pr+is:merged+merged:>=${since}&per_page=100`,
    `.items[] | {n: .number, created: .created_at, merged: .pull_request.merged_at}`);
  const redShas = new Set(raw.filter((r) => r.c === "failure").map((r) => r.sha));
  const redPrs = new Set(
    (await pool([...prs], async (p) => [p.n, (await gh(`repos/${repo}/pulls/${p.n}/commits?per_page=100`, ".[] | {sha}")).some((x) => redShas.has(x.sha))]))
      .filter(([, red]) => red).map(([n]) => n));
  const t = prs.map((p) => mins(p.created, p.merged));
  out.push(`merged PRs: ${prs.length}, with a red CI run ${prs.length ? ((100 * prs.filter((p) => redPrs.has(p.n)).length) / prs.length).toFixed(0) : 0}%, open-to-merge (min) p50 ${f(pct(t, 0.5))}  p90 ${f(pct(t, 0.9))}`);
  return out.join("\n");
}

for (const repo of repos) console.log((await report(repo)) + "\n");
