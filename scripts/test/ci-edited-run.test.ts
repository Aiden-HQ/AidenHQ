// A cancelled run must post no red `ci-required`: an edited PR run cancels the run before it, and that superseded run's jobs
// are `cancelled`, not failed, so an `always()` aggregate turned that into a red check on a head no test condemned (issue
// #1935). The fix is `if: ${{ !cancelled() }}`: a run cancelled by a newer one posts nothing, while a run with a genuinely
// failed job still posts `failure`. The data is the product's own `.github/workflows/ci.yml`; each `if` expression is
// evaluated with GitHub's truthiness (only false, 0, -0, NaN, null, undefined and "" are falsy: the string "false" is
// truthy) against the payloads named here, so an equivalent rewrite of a condition still passes.
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
      if (take("(")) {
        if (!take(")")) throw new Error(`unsupported call in ${text}`);
        // GitHub's status functions: always() runs a job whatever happened, cancelled() only on a cancelled run, success() on a
        // run that was not cancelled (a failed job's needs are judged by `needs`, not by success()).
        return word === "always" ? true : word === "cancelled" ? context.cancelled : word === "success" ? !context.cancelled : false;
      }
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

test("ci-required stops on a cancelled run and still runs after a synchronize or an edited run", () => {
  const job = workflow().jobs["ci-required"]!;
  assert.equal(runs(job, ctx({ action: "synchronize" })), true, "an ordinary PR run posts its verdict");
  assert.equal(runs(job, ctx({ action: "edited" })), true, "an edited run still posts the verdict for the head it re-ran");
  assert.equal(runs(job, ctx({ action: "synchronize", cancelled: true })), false, "a cancelled run judged nothing: no red aggregate");
  assert.equal(runs(job, ctx({ action: "edited", cancelled: true })), false);
  assert.equal(runs(job, ctx({ event: "push", ref: "refs/heads/main" })), true, "a push to main still posts");
  assert.equal(runs(job, ctx({ event: "push", ref: "refs/heads/main", cancelled: true })), false, "a cancelled merge train posts nothing");
});

test("no job is guarded off an edited event, so the head ends on a full real verdict", () => {
  const { jobs } = workflow();
  // No job carries an action guard: an edit re-runs the whole suite, so a retarget re-plans against its new base and a title
  // edit still runs `policy`'s check (an invalid new title posts red through `ci-required`). Asserting on the expressions, not
  // on every job's other conditions (a suite's `needs.checks` output is evaluated by GitHub, not here).
  for (const [name, job] of Object.entries(jobs)) {
    const condition = typeof job.if === "string" ? job.if : "";
    assert.doesNotMatch(condition, /event\.action|['"]edited['"]/i, `${name} must not be guarded off an edited event`);
  }
  // The plan and the title check run on an edit like any other: neither is conditional at all.
  assert.equal(jobs.checks!.if, undefined, "checks plans on an edit");
  assert.equal(jobs.policy!.if, undefined, "policy checks the edited title");
});

test("an edited run keeps the ci-<ref> group and cancels the run before it; main and merge trains keep their own group", () => {
  const ref = "refs/pull/42/merge";
  const edited = ctx({ action: "edited", ref, run: 101 });
  const synchronize = ctx({ action: "synchronize", ref, run: 102 });
  assert.equal(group(edited), group(synchronize), "an edit joins the PR's group, so one verdict is the head's newest");
  assert.equal(group(synchronize), `ci-${ref}`);
  assert.equal(cancelInProgress(edited), true, "an edit cancels the run before it, as any newer PR run does");
  assert.equal(cancelInProgress(synchronize), true);
  // A push to main and a merge train run to the end: a newer one joins a different group.
  for (const branch of ["refs/heads/main", "refs/heads/merge-train/7"]) {
    assert.notEqual(group(ctx({ event: "push", ref: branch, run: 200 })), group(ctx({ event: "push", ref: branch, run: 201 })));
    assert.equal(cancelInProgress(ctx({ event: "push", ref: branch, run: 200 })), false);
  }
});

test("ci-required's gate still fails a genuinely failed suite and still passes skipped ones", () => {
  // The gate script, run as CI runs it: a skipped job is fine (the change doesn't touch it), a failed one is not. That is why
  // a cancelled run is kept off it by the `if` above, never by relaxing the gate.
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
  assert.equal(gate(results({ policy: { result: "failure" } })), 1, "an invalid edited title still posts red");
});
