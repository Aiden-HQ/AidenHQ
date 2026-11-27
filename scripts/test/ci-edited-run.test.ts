// An edited PR run (`pull_request` `edited`: a title or body edit, e.g. a republish with no new commit) must not join the
// `ci-<ref>` concurrency group of a running suite, must not plan or re-run the suites, and must not post a `ci-required`
// check. The data is the product's own `.github/workflows/ci.yml`; each `if` expression is evaluated with GitHub's
// truthiness (only false, 0, -0, NaN, null, undefined and "" are falsy: the string "false" is truthy) against the
// payloads named here, so an equivalent rewrite of a condition still passes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const root = join(import.meta.dirname, "../..");
type Job = { if?: unknown; needs?: string | string[]; steps?: { run?: string }[] };
type Workflow = { concurrency: { group: string; "cancel-in-progress": unknown }; jobs: Record<string, Job> };
const workflow = () => parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as Workflow;

const ctx = (over: { action?: string; event?: string; ref?: string; run?: number; cancelled?: boolean } = {}) => ({
  github: {
    event_name: over.event ?? "pull_request",
    ref: over.ref ?? "refs/pull/42/merge",
    run_id: String(over.run ?? 100),
    event: { action: over.action ?? "synchronize" },
  },
  cancelled: over.cancelled ?? false,
});
type Context = ReturnType<typeof ctx>;

// GitHub's falsy set, not JavaScript's: "false" reads as true.
const truthy = (v: unknown) => !(v === false || v === 0 || v === -0 || v === "" || v == null || (typeof v === "number" && Number.isNaN(v)));

// The expression subset the workflow's conditions use: `!`, `&&`, `||` (returning an operand, as GitHub does), `==`,
// `!=`, parentheses, context paths, `cancelled()`/`always()`, quoted strings, numbers and booleans.
function evaluate(expression: unknown, context: Context): unknown {
  if (typeof expression === "boolean") return expression;
  if (typeof expression !== "string") throw new Error(`not an expression: ${String(expression)}`);
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(expression.trim());
  const text = (wrapped ? wrapped[1]! : expression).trim();
  let i = 0;
  const take = (want: string) => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (!text.startsWith(want, i)) return false;
    i += want.length;
    return true;
  };
  const atEnd = () => i >= text.length;
  const readPath = (name: string) => name.split(".").reduce<unknown>((v, key) => (v == null ? undefined : (v as Record<string, unknown>)[key]), context);
  const primary = (): unknown => {
    if (take("(")) { const v = disjunction(); if (!take(")")) throw new Error(`missing ) in ${text}`); return v; }
    while (i < text.length && /\s/.test(text[i]!)) i++;
    const quote = text[i];
    if (quote === "'" || quote === '"') {
      let out = "";
      for (i++; i < text.length; i++) {
        if (text[i] === quote) { if (text[i + 1] === quote) { out += quote; i++; continue; } i++; return out; }
        out += text[i];
      }
      throw new Error(`unterminated string in ${text}`);
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(text.slice(i))?.[0];
    if (word) {
      i += word.length;
      if (take("(")) { if (!take(")")) throw new Error(`unsupported call in ${text}`); return word === "cancelled" ? context.cancelled : word === "always" || word === "success" ? !context.cancelled : false; }
      if (word === "true") return true;
      if (word === "false") return false;
      if (word === "null") return null;
      return readPath(word);
    }
    const number = /^-?\d+(?:\.\d+)?/.exec(text.slice(i))?.[0];
    if (number) { i += number.length; return Number(number); }
    throw new Error(`cannot read ${JSON.stringify(text.slice(i))} in ${text}`);
  };
  const comparison = (): unknown => {
    const left = primary();
    for (const op of ["==", "!="]) {
      if (take(op)) {
        const right = primary();
        const numeric = typeof left === "number" || typeof right === "number";
        const [a, b] = numeric ? [Number(left), Number(right)] : [String(left).toLowerCase(), String(right).toLowerCase()];
        return op === "==" ? a === b : a !== b;
      }
    }
    return left;
  };
  const negation = (): unknown => (take("!") ? !truthy(negation()) : comparison());
  const conjunction = (): unknown => { let v = negation(); while (take("&&")) { const r = negation(); v = truthy(v) ? r : v; } return v; };
  const disjunction = (): unknown => { let v = conjunction(); while (take("||")) { const r = conjunction(); v = truthy(v) ? v : r; } return v; };
  const value = disjunction();
  if (!atEnd()) throw new Error(`unread ${JSON.stringify(text.slice(i))} in ${text}`);
  return value;
}

// A job with no `if` runs; with one, it runs when that condition is truthy.
const runs = (job: Job, context: Context) => job.if === undefined || truthy(evaluate(job.if, context));

// The concurrency `group` with each `${{ … }}` filled in, as GitHub fills it.
const group = (context: Context, wf = workflow()) =>
  wf.concurrency.group.replace(/\$\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => String(evaluate(expr, context)));
const cancelInProgress = (context: Context, wf = workflow()) => truthy(evaluate(wf.concurrency["cancel-in-progress"], context));

test("an edited run has its own concurrency group and cancels nothing; synchronize keeps ci-<ref> and cancels", () => {
  const ref = "refs/pull/42/merge";
  const edited = ctx({ action: "edited", ref, run: 101 });
  const synchronize = ctx({ action: "synchronize", ref, run: 102 });
  assert.notEqual(group(edited), group(synchronize), "an edited run must not join the in-flight synchronize run's group");
  assert.equal(cancelInProgress(edited), false, "an edited run must not cancel the in-flight run");
  assert.equal(group(synchronize), `ci-${ref}`, "a synchronize run still shares the PR's group");
  assert.equal(cancelInProgress(synchronize), true, "a newer push still cancels the older run");
  // A push to main and a merge train keep their own per-run group, so a newer one never cancels the run the merge queue reads.
  for (const branch of ["refs/heads/main", "refs/heads/merge-train/7"]) {
    assert.notEqual(group(ctx({ event: "push", ref: branch, run: 200 })), group(ctx({ event: "push", ref: branch, run: 201 })));
    assert.equal(cancelInProgress(ctx({ event: "push", ref: branch, run: 200 })), false);
  }
});

test("an edited run skips checks and its suites, and still runs policy's title check", () => {
  const { jobs } = workflow();
  // `checks` plans the suites; without it packages, modules, board, image-scan and reviewer-eval skip on `needs.checks`,
  // and post-checks on `needs.checks.result`.
  assert.equal(runs(jobs.checks!, ctx({ action: "edited" })), false, "checks must not plan on an edited event");
  assert.equal(runs(jobs.checks!, ctx({ action: "synchronize" })), true, "checks must still plan on a push to the PR");
  // policy is the title check `:18` says the edit exists for: no `needs`, so it runs on an edit too.
  assert.equal(jobs.policy!.needs, undefined);
  assert.equal(runs(jobs.policy!, ctx({ action: "edited" })), true, "policy must still check the edited title");
});

test("ci-required is skipped for a cancelled or edited run, and runs after a synchronize run", () => {
  const job = workflow().jobs["ci-required"]!;
  assert.equal(runs(job, ctx({ action: "synchronize" })), true);
  assert.equal(runs(job, ctx({ action: "synchronize", cancelled: true })), false, "a cancelled run posts no check for its cancelled jobs");
  assert.equal(runs(job, ctx({ action: "edited" })), false, "an edited run posts no check: its suites never ran");
  assert.equal(runs(job, ctx({ action: "edited", cancelled: true })), false);
});

test("ci-required's gate still fails a genuinely failed suite and still passes skipped ones", () => {
  // The gate script, run as CI runs it: a skipped job is fine (the change doesn't touch it), a failed one is not. That is
  // why the cancelled/edited case above has to be the `if`, not a relaxed gate.
  const run = workflow().jobs["ci-required"]!.steps![0]!.run!;
  const results = (over: Record<string, { result: string }>) => ({
    checks: { result: "success" }, policy: { result: "success" }, packages: { result: "skipped" },
    modules: { result: "skipped" }, board: { result: "skipped" }, "reviewer-eval": { result: "skipped" }, ...over,
  });
  const gate = (needs: unknown) => {
    try { execFileSync("bash", ["-c", run], { env: { ...process.env, RESULTS: JSON.stringify(needs) }, stdio: "pipe" }); return 0; }
    catch (error) { return (error as { status?: number }).status; }
  };
  assert.equal(gate(results({})), 0, "all passed or skipped");
  assert.equal(gate(results({ checks: { result: "failure" } })), 1, "a failed suite fails the gate");
  assert.equal(gate(results({ "reviewer-eval": { result: "failure" } })), 1);
});
