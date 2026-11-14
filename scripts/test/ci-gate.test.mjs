// The app CI template's code-review gate (modules/core/templates/ci/.github/codegenie-gate.mjs): what blocks a merge.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { verdict } from "../../modules/core/templates/ci/.github/codegenie-gate.mjs";
import { decide, STATE } from "../../modules/core/templates/ci/.github/codegenie-prior.mjs";

const finding = (severity, title) => ({ severity, title, path: "src/a.ts", anchor: { line: 3 }, finalBody: `${title} body` });
const review = (findings, extra = {}) => JSON.stringify({ findings, summaryOnlyFindings: [], coverage: { partial: false }, health: { status: "completed" }, ...extra });

test("high or critical findings block; the rest are listed as not blocking", () => {
  const v = verdict(0, review([finding("high", "Null deref"), finding("medium", "Slow loop")], { summaryOnlyFindings: [finding("critical", "SQL injection")] }), "abcdef123");
  assert.equal(v.block, true);
  assert.match(v.body, /2 blocking findings on `abcdef1`/);
  assert.match(v.body, /\*\*Not blocking\*\*[\s\S]*Slow loop/);
});

test("only smaller findings pass, and are still posted", () => {
  const v = verdict(0, review([finding("medium", "Slow loop"), finding("low", "Edge case")]));
  assert.equal(v.block, false);
  assert.equal(v.quiet, false);
  assert.match(v.body, /Edge case/);
});

test("no findings pass quietly", () => {
  const v = verdict(0, review([]));
  assert.deepEqual([v.block, v.quiet], [false, true]);
});

test("a partial review with nothing high or critical passes with a note; no coverage at all blocks", () => {
  const partial = verdict(0, review([finding("medium", "Salt default")], { coverage: { partial: true, reasons: ["1 verification incomplete"] }, health: { status: "incomplete" } }));
  assert.equal(partial.block, false);
  assert.match(partial.body, /partly done/);
  const none = verdict(0, review([], { coverage: { unavailable: true, reasons: ["budget stopped"] } }));
  assert.equal(none.block, true);
  assert.match(none.body, /incomplete.*re-run/);
});

test("a failed review, a non-zero exit or unreadable output blocks", () => {
  assert.equal(verdict(1, review([])).block, true);
  assert.equal(verdict(0, "not json").block, true);
  assert.equal(verdict(0, review([], { health: { status: "failed", diagnostics: [{ reason: "no credentials" }] } })).body.includes("no credentials"), true);
});

test("questions the reviewer couldn't settle (health unresolved) don't block: they are listed for a human", () => {
  const v = verdict(0, review([], { health: { status: "unresolved", unresolvedCount: 1 }, needsHumanAttention: [{ question: "Is the cache key per user?", files: ["src/a.ts"], reason: "can't see callers" }] }), "abcdef123");
  assert.equal(v.block, false);
  assert.doesNotMatch(v.body, /incomplete/);
  assert.match(v.body, /Is the cache key per user\?/);
});

// The workflow's Review and Verdict steps, run as bash in a scratch repo (npx is a stub that records being called).
test("the Review step skips a tiny PR, never a delta; Verdict runs the gate from the default branch tip; Record needs a review", () => {
  const steps = YAML.parse(readFileSync(new URL("../../modules/core/templates/ci/.github/workflows/ci.yml", import.meta.url), "utf8")).jobs["code-review"].steps;
  const script = (name) => steps.find((s) => s.name === name).run;
  // One scratch repo: main holds the gate as it was at the PR's base, then a newer one; the PR branch is a 5-line change.
  const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir }).toString().trim();
  mkdirSync(join(dir, ".github"));
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".github", "codegenie-gate.mjs"), 'console.log("gate from base"); process.exit(1);\n');
  g("add", ".");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  writeFileSync(join(dir, ".github", "codegenie-gate.mjs"), 'console.log("gate from default branch tip");\n');
  g("commit", "-qam", "new gate");
  g("remote", "add", "origin", ".");
  g("fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
  g("checkout", "-q", base);
  writeFileSync(join(dir, "a.ts"), "1\n2\n3\n4\n5\n");
  g("add", "a.ts");
  g("commit", "-qm", "change");
  const bin = mkdtempSync(join(tmpdir(), "ci-bin-"));
  writeFileSync(join(bin, "npx"), `#!/bin/sh\ntouch "${join(bin, "called")}"\n`);
  writeFileSync(join(bin, "review.json"), "{}");
  chmodSync(join(bin, "npx"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BASE_SHA: base, HEAD_SHA: g("rev-parse", "HEAD"), PR_LABELS: "", GITHUB_ENV: join(bin, "env"), RUNNER_TEMP: bin, GITHUB_TOKEN: "test-token", DEFAULT_BRANCH: "main", PR_NUMBER: "1", GITHUB_REPOSITORY: "x/y" };
  writeFileSync(env.GITHUB_ENV, "");
  execFileSync("bash", ["-e", "-c", script("Review")], { cwd: dir, env });
  assert.ok(readFileSync(env.GITHUB_ENV, "utf8").includes("CODE_REVIEW_SKIPPED=1"), "skipped");
  assert.ok(!existsSync(join(bin, "called")), "the reviewer never ran");
  const verdictStep = (extra) => execFileSync("bash", ["-e", "-c", script("Verdict")], { cwd: dir, env: { ...env, ...extra } }).toString();
  assert.match(verdictStep({ CODE_REVIEW_SKIPPED: "1" }), /not reviewed, and it passes/);
  const out = verdictStep({ HEAD_SHA: base });
  assert.match(out, /gate from default branch tip/);
  assert.doesNotMatch(out, /gate from base/);
  // A tiny delta of a PR is still reviewed (sleep: the stub's empty output gets one retry).
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\n");
  chmodSync(join(bin, "sleep"), 0o755);
  execFileSync("bash", ["-e", "-c", script("Review")], { cwd: dir, env: { ...env, REVIEW_MODE: "delta", REVIEW_FROM: base }, stdio: "pipe" });
  assert.ok(existsSync(join(bin, "called")), "a delta is never skipped");
  // Record marks a head reviewed only when a review came out, never after a skip.
  writeFileSync(join(bin, "curl"), `#!/bin/sh\necho "$*" >> "${join(bin, "posted")}"\n`);
  chmodSync(join(bin, "curl"), 0o755);
  const record = (extra) => execFileSync("bash", ["-e", "-c", script("Record")], { env: { ...env, REVIEW_MODE: "full", REVIEW_N: "0", REVIEW_LINES: "0", REVIEW_MB: base, ...extra } });
  record({ CODE_REVIEW_SKIPPED: "1" });
  assert.ok(!existsSync(join(bin, "posted")), "no state after a skip");
  record({ CODE_REVIEW_DONE: "1" });
  assert.match(readFileSync(join(bin, "posted"), "utf8"), /code-review\/state/);
});

// The Review step's one retry when codegenie leaves no verdict (npx and sleep are stubs; each run plays the next response).
test("no verdict: a budget stop retries with double the budget, a provider error after a wait, a permanent error never", () => {
  const steps = YAML.parse(readFileSync(new URL("../../modules/core/templates/ci/.github/workflows/ci.yml", import.meta.url), "utf8")).jobs["code-review"].steps;
  const script = steps.find((s) => s.name === "Review").run;
  const ok = `echo '${review([])}'; exit 0`;
  // The scratch repo (a 50-line change) is built once: the Review step only reads it.
  const dir = mkdtempSync(join(tmpdir(), "ci-retry-"));
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir }).toString().trim();
  g("init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  g("add", ".");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  writeFileSync(join(dir, "a.ts"), Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join(""));
  g("add", ".");
  g("commit", "-qm", "change");
  const head = g("rev-parse", "HEAD");
  const run = (...responses) => {
    const bin = mkdtempSync(join(tmpdir(), "ci-bin-"));
    responses.forEach((r, i) => writeFileSync(join(bin, `resp${i + 1}`), r));
    writeFileSync(join(bin, "npx"), `#!/bin/sh\nn=$(( $(cat "${bin}/count" 2>/dev/null || echo 0) + 1 )); echo $n > "${bin}/count"\necho "$*" >> "${bin}/args"\n. "${bin}/resp$n"\n`);
    writeFileSync(join(bin, "sleep"), `#!/bin/sh\ntouch "${bin}/slept"\n`);
    chmodSync(join(bin, "npx"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BASE_SHA: base, HEAD_SHA: head, PR_LABELS: "", GITHUB_ENV: join(bin, "env"), RUNNER_TEMP: bin };
    writeFileSync(env.GITHUB_ENV, "");
    execFileSync("bash", ["-e", "-c", script], { cwd: dir, env, stdio: "pipe" });
    const out = Object.fromEntries(readFileSync(env.GITHUB_ENV, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const boosts = readFileSync(join(bin, "args"), "utf8").trim().split("\n").map((a) => a.match(/--budget-boost (\d+)/)[1]);
    return { ...out, boosts, slept: existsSync(join(bin, "slept")), stdout: readFileSync(join(bin, "review.json"), "utf8") };
  };
  const budget = run(`echo "llm_call_failed: LLM provider call budget exhausted" >&2; exit 1`, ok);
  assert.deepEqual([budget.boosts, budget.slept, budget.CODEGENIE_EXIT, budget.CODEGENIE_FAILURE], [["1", "2"], false, "0", "ok"]);
  const transient = run(`echo "llm_call_failed: LLM provider call failed" >&2; echo "502 Bad Gateway" >&2; exit 1`, ok);
  assert.deepEqual([transient.boosts, transient.slept, transient.CODEGENIE_EXIT], [["1", "1"], true, "0"]);
  const permanent = run(`echo "llm_call_failed: LLM provider authentication failed" >&2; exit 1`);
  assert.deepEqual([permanent.boosts, permanent.CODEGENIE_EXIT, permanent.CODEGENIE_FAILURE], [["1"], "1", "permanent"]);
  const failed = `echo '${review([], { health: { status: "failed", diagnostics: [{ reason: "x" }] }, coverage: { budgetStopped: true } })}'; exit 1`;
  const twice = run(failed, failed);
  assert.deepEqual([twice.boosts, twice.CODEGENIE_EXIT, twice.CODEGENIE_FAILURE, twice.CODEGENIE_ATTEMPTS], [["1", "2"], "1", "budget", "2"]);
  // #131/#134: the review JSON says only "not captured"; codegenie's telemetry has the real cause.
  const uncaptured = `echo '${review([], { health: { status: "failed", diagnostics: [{ reason: "The underlying cause was not captured." }] } })}'
    mkdir -p "$CODEGENIE_HOME/../codegenie-runs/r1"; grep -q "enabled = true" "$CODEGENIE_HOME/config.toml" &&
    echo '{"level":"warn","message":"packet_review_not_dispatched","data":{"error":"LLM provider call budget exhausted","errorCode":"llm_call_failed","context":{"reason":"budget_exhausted"}}}' > "$CODEGENIE_HOME/../codegenie-runs/r1/events.jsonl"; exit 1`;
  const traced = run(uncaptured, uncaptured);
  assert.deepEqual([traced.boosts, traced.CODEGENIE_FAILURE], [["1", "2"], "budget"]);
  assert.equal(traced.CODEGENIE_CAUSE, "budget (llm_call_failed, budget_exhausted)");
  // #141: exit 0 but stray output around the JSON: cut back to the review, which passes on the first run.
  const stray = run(`echo "some library notice"; echo '${JSON.stringify(JSON.parse(review([])), null, 2)}'; exit 0`);
  assert.deepEqual([stray.boosts, stray.CODEGENIE_FAILURE, stray.CODEGENIE_EXIT], [["1"], "ok", "0"]);
  // Exit 0 with no review at all is no verdict: retried, then named.
  const empty = run("exit 0", "exit 0");
  assert.deepEqual([empty.boosts, empty.slept, empty.CODEGENIE_FAILURE], [["1", "1"], true, "transient"]);
  assert.equal(empty.CODEGENIE_CAUSE, "no-review-output");
  // Provider text can echo a key: it stays in the job log; the PR comment gets only the class and codegenie's codes.
  const leaky = `echo '${review([], { health: { status: "failed", diagnostics: [{ code: "llm_call_failed", reason: "LLM provider call failed: HTTP 502: bad key sk-or-v1-abc123" }] } })}'
    printf 'llm_call_failed: LLM provider call failed\\nHTTP 502: upstream echoed sk-or-v1-abc123\\n' >&2; exit 1`;
  const leak = run(leaky, leaky);
  assert.equal(leak.CODEGENIE_CAUSE, "provider-5xx (llm_call_failed, HTTP 502)");
  const body = verdict(Number(leak.CODEGENIE_EXIT), leak.stdout, "abcdef123", { failure: leak.CODEGENIE_FAILURE, cause: leak.CODEGENIE_CAUSE, attempts: leak.CODEGENIE_ATTEMPTS }).body;
  assert.doesNotMatch(body, /sk-or-v1-abc/);
  assert.match(body, /provider-5xx/);
  // A gate run from an older workflow (no cause) still masks what it posts from the review's diagnostics.
  assert.doesNotMatch(verdict(1, leak.stdout, "abcdef123").body, /sk-or-v1-abc/);
});

test("a review that never came out says what to do next: split the PR after a budget stop, re-run after a provider error", () => {
  const budget = verdict(1, "", "abcdef123", { failure: "budget", attempts: "2" });
  assert.equal(budget.block, true);
  assert.match(budget.body, /\*\*Code review failed on `abcdef1`\*\* \(codegenie exit 1, 2 attempts\)\. .*Split it into stacked PRs/);
  assert.match(verdict(1, "", "abcdef123", { failure: "transient", attempts: "2" }).body, /Re-run the check/);
  assert.match(verdict(2, "", "abcdef123", { failure: "permanent" }).body, /fix the cause and re-run/);
  const named = verdict(1, review([], { health: { status: "failed", diagnostics: [{ reason: "The underlying cause was not captured." }] } }), "abcdef123", { failure: "transient", cause: "llm_call_failed: LLM provider call failed: HTTP 502" });
  assert.match(named.body, /codegenie exit 1: llm_call_failed: LLM provider call failed: HTTP 502\)/);
  const incomplete = verdict(0, review([], { coverage: { unavailable: true, reasons: ["budget exhausted"] } }), "abcdef123", { failure: "budget", attempts: "2" });
  assert.equal(incomplete.block, true);
  assert.match(incomplete.body, /\*\*Code review incomplete on `abcdef1`\.\*\*.*stacked PRs/);
});

// codegenie-prior.mjs on a scratch repo, with GitHub's records of this workflow faked.
test("prior review: delta, reuse of a byte-identical rebase, else full; the guard; only trusted records and CI count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-prior-"));
  const git = (...a) => {
    const opts = typeof a.at(-1) === "object" ? a.pop() : {};
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], ...opts }).trim();
  };
  const commit = (file, text) => { writeFileSync(join(dir, file), text); git("add", "."); git("commit", "-qm", file); return git("rev-parse", "HEAD"); };
  const lines = (k) => Array.from({ length: k }, (_, i) => `line ${i}\n`).join("");
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  for (const f of ["workflows/ci.yml", "codegenie-gate.mjs", "codegenie-prior.mjs"]) writeFileSync(join(dir, ".github", f), `${f}\n`);
  const base = commit("README.md", "x\n");
  git("checkout", "-qb", "pr");
  const green = commit("a.txt", lines(10));
  const pushed = commit("a.txt", lines(15));
  const sneaky = commit(".github/codegenie-gate.mjs", "pass everything\n"); // a push that edits its own CI
  git("checkout", "-q", "main");
  const base2 = commit("other.txt", "y\n");
  git("checkout", "-q", "-b", "rebased", base2);
  git("cherry-pick", green);
  const rebased = git("rev-parse", "HEAD");
  const spaced = commit("a.txt", lines(10).replace("line 0", "line  0")); // the same patch to patch-id, not to the bytes
  git("checkout", "-q", "-b", "ci-moved", base2);
  commit(".github/workflows/ci.yml", "a newer ci.yml\n");

  const decideOn = (head, b, state, { creator = "github-actions[bot]", defaultRef = "main", redAfter = false, setAt = "2026-01-01T00:30:00Z" } = {}) => decide({
    git, repo: "acme/app", pr: 1, headRef: "pr", base: b, head, defaultRef,
    api: async (path) => {
      assert.doesNotMatch(path, /comments/, "PR comments are never read");
      const run = (id) => ({ id, head_sha: green, pull_requests: [{ number: 1 }], run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T01:00:00Z" });
      if (path.includes("/workflows/ci.yml/runs")) return { workflow_runs: [...(redAfter ? [run(8)] : []), run(7)] };
      if (path.includes("/runs/")) return { jobs: [{ name: "code-review", conclusion: path.includes("/runs/8/") ? "failure" : "success" }] };
      return [{ context: STATE, state: "success", creator: { login: creator }, target_url: "https://github.com/acme/app/actions/runs/7", created_at: setAt, description: `${state} mb=${base}` }];
    },
  });
  assert.deepEqual(await decideOn(pushed, base, "full n=0 lines=0"), { mode: "delta", from: green, n: 1, lines: 5, mb: base });
  assert.deepEqual(await decideOn(rebased, base2, "delta n=1 lines=40"), { mode: "reuse", from: green, n: 1, lines: 40, mb: base2 });
  const fulls = [
    [spaced, base2, "full n=0 lines=0", {}], // a rebase that isn't byte-identical
    [pushed, base, "delta n=3 lines=40", {}], // after 3 deltas
    [pushed, base, "delta n=1 lines=1998", {}], // past 2,000 delta lines
    [pushed, base, "full n=0 lines=0", { creator: "acme-agents[bot]" }], // a status anyone else set
    [pushed, base, "full n=0 lines=0", { setAt: "2026-01-01T02:00:00Z" }], // set after its run ended
    [pushed, base, "full n=0 lines=0", { redAfter: true }], // a later failed review of that head
    [sneaky, base, "full n=0 lines=0", {}], // a PR diff that touches .github/
    [pushed, base, "full n=0 lines=0", { defaultRef: "ci-moved" }], // CI that isn't the default branch's
  ];
  for (const [i, c] of fulls.entries()) assert.equal((await decideOn(...c)).mode, "full", `case ${i}`);
  // The PR comment names the mode.
  assert.match(verdict(0, review([]), pushed, { mode: "delta", from: green, n: "1" }).body, new RegExp(`only the changes since \`${green.slice(0, 7)}\``));
  const reused = verdict(1, "", rebased, { mode: "reuse", from: green });
  assert.deepEqual([reused.block, reused.body.includes(`reused on \`${rebased.slice(0, 7)}\`** from \`${green.slice(0, 7)}\``)], [false, true]);
});
