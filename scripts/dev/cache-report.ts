#!/usr/bin/env node
// Prompt-cache report from Codex rollouts: per agent and model, how much of the input was served from cache.
//   node scripts/dev/cache-report.ts <codex-home-or-sessions-dir>... [--days 14] [--grants config/grants/grants.json] [--min-input 4000]
// Reads `token_usage_record` events (one per model call; the usage of that call) and `turn_context.model`. Prints
// aggregate numbers only, never message text. Directories are searched for rollout-*.jsonl; the agent is the Paperclip
// agent id in the path (`.../agents/<id>/...`), named through --grants when given.
// "turn 1" = a run's first call. A cache breaker is a later call whose cached tokens are under half of the previous
// call's input, so the shared prefix did not carry over; it is attributed to a time gap (> 5 min: the provider's cache
// expired) or to the tool that ran just before it (e.g. a changed tool list or a rewritten prefix).
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const opt = (n: string, d?: string | number) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const dirs = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--")));
const days = Number(opt("days", 14));
const minInput = Number(opt("min-input", 4000));
const names = opt("grants") ? Object.fromEntries(Object.entries<{ key?: string }>(JSON.parse(readFileSync(opt("grants") as string, "utf8")).agents ?? {}).map(([id, g]) => [id, g.key ?? id])) : {};
const cutoff = Date.now() - days * 86400_000;

function* rollouts(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* rollouts(p);
    else if (/^rollout-.*\.jsonl$/.test(e.name) && statSync(p).mtimeMs >= cutoff) yield p;
  }
}

interface Counters { runs: number; calls: number; input: number; cached: number; in1: number; c1: number; inN: number; cN: number }
const rows = new Map<string, Counters>(); // "agent\tmodel" -> counters
const breakers = new Map<string, { n: number; lost: number }>(); // "model\tcause" -> { n, lost }
const row = (k: string) => rows.get(k) ?? rows.set(k, { runs: 0, calls: 0, input: 0, cached: 0, in1: 0, c1: 0, inN: 0, cN: 0 }).get(k)!;

for (const dir of dirs) for (const file of rollouts(dir)) {
  const agent = names[file.match(/(?:agents|skill-runtimes)\/([0-9a-f-]{36})\//)?.[1]!] ?? file.match(/(?:agents|skill-runtimes)\/([0-9a-f-]{8})/)?.[1] ?? "(other)";
  let model = "?", prev = null, lastTool = "", first = true, ran = false;
  for await (const line of createInterface({ input: createReadStream(file) })) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "turn_context") model = e.payload?.model ?? model;
    else if (e.type === "response_item" && e.payload?.type === "function_call") lastTool = String(e.payload.name ?? "");
    else if (e.type === "token_usage_record") {
      const u = e.payload?.usage; if (!u) continue;
      const r = row(`${agent}\t${model}`);
      if (!ran) { r.runs++; ran = true; }
      const input = u.input_tokens ?? 0, cached = u.cached_input_tokens ?? 0, at = Date.parse(e.timestamp);
      r.calls++; r.input += input; r.cached += cached;
      if (first) { r.in1 += input; r.c1 += cached; first = false; }
      else {
        r.inN += input; r.cN += cached;
        if (prev && prev.input >= minInput && cached < prev.input / 2) {
          const cause = at - prev.at > 300_000 ? "gap over 5 min" : lastTool ? `after tool ${lastTool}` : "no tool (prefix changed)";
          const b = breakers.get(`${model}\t${cause}`) ?? breakers.set(`${model}\t${cause}`, { n: 0, lost: 0 }).get(`${model}\t${cause}`)!;
          b.n++; b.lost += prev.input - cached;
        }
      }
      prev = { input, at }; lastTool = "";
    }
  }
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const tot = new Map<string, Counters>();
console.log("agent\tmodel\truns\tcalls\tinput\tcached\tcached_all\tcached_turn1\tcached_turns2+");
for (const [k, r] of [...rows].sort((a, b) => b[1].input - a[1].input)) {
  console.log([k, r.runs, r.calls, r.input, r.cached, pct(r.cached, r.input), pct(r.c1, r.in1), pct(r.cN, r.inN)].join("\t"));
  const m = k.split("\t")[1]!, t = tot.get(m) ?? tot.set(m, { runs: 0, calls: 0, input: 0, cached: 0, in1: 0, c1: 0, inN: 0, cN: 0 }).get(m)!;
  for (const f of Object.keys(t)) t[f as keyof Counters] += r[f as keyof Counters];
}
console.log("\nper model\truns\tcalls\tinput\tcached\tcached_all\tcached_turn1\tcached_turns2+");
for (const [m, r] of [...tot].sort((a, b) => b[1].input - a[1].input)) console.log([m, r.runs, r.calls, r.input, r.cached, pct(r.cached, r.input), pct(r.c1, r.in1), pct(r.cN, r.inN)].join("\t"));
console.log("\ncache breakers\tcount\tuncached tokens lost");
for (const [k, b] of [...breakers].sort((a, b) => b[1].lost - a[1].lost).slice(0, 15)) console.log(`${k}\t${b.n}\t${b.lost}`);
