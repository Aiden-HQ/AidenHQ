#!/usr/bin/env node
// A fork's pull request must never reach a self-hosted runner (a PR can edit the workflow that runs it). Fails when a job
// in a workflow triggered by pull_request or pull_request_target can name a runner that is not GitHub-hosted:
//   - pull_request_target: every job must be `ubuntu-latest` and must not check out the PR head;
//   - pull_request: a job with a non-hosted runner needs the fork guard, either in runs-on
//     (`<fork test> && 'ubuntu-latest' || <ours>`) or as an `if:` that skips forks.
//   node fork-lint.ts [workflows-dir]     (needs `yaml`: run where scripts/node_modules is installed)
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import YAML from "yaml";

const HOSTED = /^(ubuntu|windows|macos)-(latest|\d[\w.-]*)$/;
const FORK_IN_RUNS_ON = /head\.repo\.full_name != github\.repository && '(ubuntu|windows|macos)-/;
const FORK_SKIPPED_BY_IF = /head\.repo\.full_name == github\.repository/;

interface Job { "runs-on"?: unknown; runs_on?: unknown; if?: unknown; steps?: { with?: unknown }[] }
interface Workflow { on?: Record<string, unknown>; true?: Record<string, unknown>; jobs?: Record<string, Job> }

export function lint(text: string, file = "workflow"): string[] {
  const wf = YAML.parse(text) as Workflow;
  const triggers = Object.keys(wf.on ?? wf[true as unknown as "true"] ?? {}); // YAML 1.1 reads a bare `on` key as true
  const target = triggers.includes("pull_request_target");
  if (!target && !triggers.includes("pull_request")) return [];
  const problems: string[] = [];
  for (const [name, job] of Object.entries(wf.jobs ?? {})) {
    const runs = JSON.stringify(job["runs-on"] ?? job.runs_on ?? "");
    const hosted = HOSTED.test(String(job["runs-on"]));
    if (target) {
      if (!hosted) problems.push(`${file}/${name}: pull_request_target must run on a GitHub-hosted runner (${runs})`);
      for (const s of job.steps ?? []) if (/head\.(sha|ref)/.test(JSON.stringify(s.with ?? {}))) problems.push(`${file}/${name}: never check out the PR head under pull_request_target`);
    } else if (!hosted && !FORK_IN_RUNS_ON.test(runs) && !FORK_SKIPPED_BY_IF.test(String(job.if ?? ""))) {
      problems.push(`${file}/${name}: a fork PR can reach a self-hosted runner (${runs}); guard runs-on or add an if that skips forks`);
    }
  }
  return problems;
}

export function lintDir(dir: string): string[] {
  return readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).flatMap((f) => lint(readFileSync(join(dir, f), "utf8"), f));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? ".github/workflows";
  const problems = lintDir(dir);
  for (const p of problems) console.log(`::error::${p}`);
  process.exit(problems.length ? 1 : 0);
}
