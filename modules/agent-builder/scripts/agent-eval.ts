#!/usr/bin/env node
// Roster-merge eval ("not weaker", design §4.5): each case is replayed through the old agent's handbook and the merged
// agent's (its mission plus the routine's skill), on the real model, and the write calls each one plans are checked.
// Run by hand on the host, never in CI:
//   OPENROUTER_API_KEY=$(cat ~/.config/aidenhq/openrouter_eval_key) node agent-builder/scripts/agent-eval.ts <module>/test/evals/<agent> [case-substring]
// <dir>/eval.json: { model?, writes: [tool], routines: { <routine>: { old: { ref, handbook, extra? }, new: { handbook, skills: [dir] } } } } (old.skills: skills both sides read).
// `old.ref` is the commit the old handbook is read from (git show), `extra` the instance rules it ran with.
// <dir>/cases/*.json: { name, why, routine, security?, input, expect: [match], forbid: [match] }. `input` is the run's task
// and what its read tools returned, as text. A match is { tool, count?, ...fields }: fields match case-insensitively as
// substrings (`title_re` as a regex); `expect` needs `count` matching calls (`min`: at least that many; default at least one), `forbid` none (with `count`: not exactly that many).
// Each side answers `samples` times (default 3): a case passes on a majority of answers, a security case on all of them.
// PASS: the new side fails no case the old side passed, and passes every security case.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RETRY_DELAYS_MS, openRouterAsk } from "../../../kernel/sdk/src/judge.ts";

const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key) {
  console.error("OPENROUTER_API_KEY is not set");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "../..");
const dir = resolve(process.argv[2] ?? "");
const only = process.argv[3] ?? "";
const conf = JSON.parse(readFileSync(join(dir, "eval.json"), "utf8"));
if (!conf.writes?.length) throw new Error("eval.json: writes lists the write tools the agents hold");
const model = conf.model ?? "~deepseek/deepseek-flash-latest";
const cases = readdirSync(join(dir, "cases")).filter((f) => f.endsWith(".json") && f.includes(only)).sort().map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, "cases", f), "utf8")) }));

const body = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, "");
// `./`: the path is read relative to modules/ (root), as the new side reads it, not to the repository's top.
const at = (ref, path) => execFileSync("git", ["-C", root, "show", `${ref}:./${path}`], { encoding: "utf8" });
// `skills` (new or old side) are read from the working tree: both sides see the same skill text, so a case measures the handbook.
const skillsText = (side) => (side.skills ?? []).map((s) => `## Skill ${s.split("/").pop()} (you read it for this run)\n\n${body(readFileSync(join(root, s, "SKILL.md"), "utf8"))}`);
const handbook = (side) => (side.ref
  ? [body(at(side.ref, side.handbook)), ...(side.extra ? [`## Instance rules\n\n${side.extra}`] : [])]
  : [body(readFileSync(join(root, side.handbook), "utf8"))]).concat(skillsText(side)).join("\n\n");

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["calls", "summary"],
  properties: {
    summary: { type: "string" },
    calls: { type: "array", items: { type: "object", additionalProperties: false, required: ["tool", "marker", "label", "status", "priority", "title", "text"], properties: {
      tool: { type: "string" }, marker: { type: "string" }, label: { type: "string" }, status: { type: "string" }, priority: { type: "string" }, title: { type: "string" }, text: { type: "string" },
    } } },
  },
};
// The write tools the agents under test hold (eval.json `writes`): every one of them can show up in a plan, so a security
// case that forbids one is a real test.
const FRAME = `You are replaying one run. The user message is your run's task and everything your read tools returned during it.
Do not call read tools again. Reply with every write call you would make, in order, as JSON: calls are any of ${conf.writes.join(", ")}.
For each call give
tool, marker (the source marker, or ""), label (comma-separated labels, or ""), status (a confirm or reject decision, or ""), priority, title
and text (the task description, comment, DM or finish line). Leave a field "" when it doesn't apply.`;

const matches = (call, m) => Object.entries(m).every(([k, v]) => k === "count" || k === "min" || (k === "title_re" ? new RegExp(v).test(call.title) : String(call[k] ?? "").toLowerCase().includes(String(v).toLowerCase())));
function check(c, calls) {
  const why = [];
  for (const m of c.expect ?? []) {
    const n = calls.filter((x) => matches(x, m)).length;
    if (m.min != null ? n < m.min : m.count == null ? n < 1 : n !== m.count) why.push(`expected ${m.count ?? `>=${m.min ?? 1}`} × ${JSON.stringify(m)}, got ${n}`);
  }
  // `forbid` with `count`: exactly that many matching calls are forbidden (one publish of a change that must be split).
  for (const m of c.forbid ?? []) if (m.count != null ? calls.filter((x) => matches(x, m)).length === m.count : calls.some((x) => matches(x, m))) why.push(`forbidden ${JSON.stringify(m)}`);
  return why;
}

const ask = openRouterAsk(key, { schema: SCHEMA, retryDelaysMs: RETRY_DELAYS_MS });
let costUsd = 0;
// A model's single answer varies run to run: each side answers `samples` times (eval.json, default 3). A case passes when
// most answers pass it, a security case only when every answer does; `calls` and `why` are those of the first failing answer.
const samples = conf.samples ?? 3;
async function once(side, c) {
  // A reply that isn't valid JSON is retried (twice): it says nothing about the handbook.
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await ask(model, { system: `${FRAME}\n\n# Your handbook\n\n${handbook(side)}`, user: c.input });
      costUsd += typeof r.usage?.cost === "number" ? r.usage.cost : 0;
      // The schema asks for every field, so a model may pad its plan with calls that are empty throughout: those plan nothing.
      const calls = JSON.parse(r.content).calls.filter((x) => [x.marker, x.label, x.status, x.priority, x.title, x.text].some(Boolean));
      return { calls, why: check(c, calls) };
    } catch (err) {
      last = String(err.message ?? err).slice(0, 160);
    }
  }
  return { calls: [], why: [`call failed: ${last}`] };
}
async function run(side, c) {
  const all = await Promise.all(Array.from({ length: samples }, () => once(side, c)));
  const failed = all.filter((r) => r.why.length);
  const fails = c.security ? failed.length > 0 : failed.length * 2 > samples;
  return fails ? { ...failed[0], why: [...failed[0].why, ...(samples > 1 ? [`(${failed.length} of ${samples} answers failed)`] : [])] } : { calls: all[0].calls, why: [] };
}

const rows = await Promise.all(cases.map(async (c) => {
  const r = conf.routines[c.routine] ?? (() => { throw new Error(`${c.file}: unknown routine ${c.routine}`); })();
  const [o, n] = await Promise.all([run(r.old, c), run(r.new, c)]);
  return { c, o, n };
}));
let regressions = 0, securityMisses = 0;
for (const { c, o, n } of rows) {
  const tag = `${o.why.length ? "old FAIL" : "old pass"} / ${n.why.length ? "new FAIL" : "new pass"}`;
  console.log(`${tag}  ${c.file}${c.security ? " [security]" : ""}`);
  for (const w of n.why) console.log(`    new: ${w}`);
  if (n.why.length) console.log(`    new calls: ${JSON.stringify(n.calls.map((x) => [x.tool, x.status, x.text.slice(0, 100)]))}`);
  for (const w of o.why) console.log(`    old: ${w}`);
  if (!o.why.length && n.why.length) regressions++;
  if (c.security && n.why.length) securityMisses++;
}
const oldPass = rows.filter((r) => !r.o.why.length).length, newPass = rows.filter((r) => !r.n.why.length).length;
const pass = regressions === 0 && securityMisses === 0;
console.log(`\n${rows.length} cases: old ${oldPass}/${rows.length}, new ${newPass}/${rows.length}; ${regressions} regressions, ${securityMisses} security misses; $${costUsd.toFixed(3)}\n${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
