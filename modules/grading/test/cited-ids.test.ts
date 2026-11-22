// A report's cited ids (WOR-9047): a report that cites a task, an approval card and an Actions job is graded from what code
// resolves, not from "not shown". An id that resolves to nothing is a real answer ("no such id"), and a genuinely unreadable
// read still waits: a named task's file list is read (kernel-loop.ts otherTask), so only a transient failure is a wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import { citedEvidence, citedIds, resolveCitation } from "../service/src/grader/evidence.ts";

const TASKS = {
  "WOR-101": { identifier: "WOR-101", title: "Ship the parser", state: "done", exists: true },
  "WOR-202": { identifier: "WOR-202", title: "Audit the schema", state: "in_progress", exists: true },
};
const CARDS = {
  "k-0123456789abcdef": { id: "k-0123456789abcdef", state: "done", ok: true, outcome_text: "merged acme/app#12" },
};
const JOBS = {
  "acme/app#424242": { id: 424242, name: "tests (node 24)", state: "completed", conclusion: "success" },
};

/** The three reads the grader holds, over the fixtures above: a miss is null, and a read that fails throws. */
const citeDeps = (over: any = {}) => ({
  citedTask: async (id: string) => TASKS[id] ?? { exists: false },
  citedCard: async (id: string) => CARDS[id] ?? null,
  citedJob: async (repo: string, id: string) => JOBS[`${repo}#${id}`] ?? null,
  ...over,
});

test("a report citing an existing task and a nonexistent id resolves each: the first exists, the second does not", async () => {
  const report = "I closed WOR-101 (see k-0123456789abcdef); WOR-999 was never a task. The failing job was job 424242 in acme/app.";
  const ids = citedIds([report], "WOR-1");
  assert.deepEqual(ids, [
    { kind: "task", id: "WOR-101" },
    { kind: "card", id: "k-0123456789abcdef" },
    { kind: "task", id: "WOR-999" },
    { kind: "job", id: "424242" },
  ]);

  const ev = await citedEvidence(ids, citeDeps(), ["acme/app"]);
  const facts = ev.facts.join("\n");
  assert.match(facts, /cited task WOR-101: exists, state done/);
  assert.match(facts, /cited id WOR-999: no such task in this company/, "an unknown id is a real answer");
  assert.match(facts, /cited card k-0123456789abcdef: exists, state done, outcome ok/);
  assert.match(facts, /cited Actions job 424242 in acme\/app: exists, state completed, conclusion success/);
  assert.match(ev.data.CITED_IDS, /WOR-101 \(task\): title Ship the parser/);
  assert.match(ev.data.CITED_IDS, /k-0123456789abcdef \(card\): outcome merged acme\/app#12/);
  assert.match(ev.data.CITED_IDS, /424242 \(Actions job in acme\/app\): name tests/);
  assert.ok(ev.version.startsWith("cited:"), "the resolved set is part of the graded version");

  // The per-id resolver: what it returns is what the evidence states.
  assert.deepEqual(await resolveCitation({ kind: "task", id: "WOR-999" }, citeDeps()), { citation: { kind: "task", id: "WOR-999" }, id: "WOR-999", exists: false });
  assert.equal((await resolveCitation({ kind: "card", id: "k-ffffffffffffffff" }, citeDeps())).exists, false);
  assert.equal((await resolveCitation({ kind: "job", id: "1", repo: "acme/app" }, citeDeps())).exists, false);
});

test("a job cited under a misspelled owner resolves to the graded PR's real owner/name; a refused repo is answered once", async () => {
  const [job] = citedIds(["ci: https://github.com/AidenHQ/AidenHQ/actions/runs/1/job/424242"], "WOR-9");
  const deps = citeDeps({
    citedJob: async (repo: string, id: string) => {
      if (repo !== "Aiden-HQ/AidenHQ") throw Object.assign(new Error(`grading has no read grant on ${repo}`), { status: 403 });
      return { name: "ci-required", state: "completed", conclusion: "success" };
    },
  });
  const real = await resolveCitation(job!, deps, ["Aiden-HQ/AidenHQ"]);
  assert.equal(real.exists, true);
  assert.equal(real.repo, "Aiden-HQ/AidenHQ");

  const denied = await citedEvidence([job!], deps, ["acme/app"]);
  assert.equal(denied.awaiting, undefined, "a refusal is never a retry every minute");
  assert.match(denied.facts.join("\n"), /could not be read \(grading has no read grant on AidenHQ\/AidenHQ\)/);

  const limited = citeDeps({ citedJob: async () => { throw Object.assign(new Error("API rate limit exceeded"), { status: 403 }); } });
  assert.match((await citedEvidence([job!], limited, [])).awaiting, /could not be read yet/, "a rate-limit 403 is retried");
  const secondary = citeDeps({ citedJob: async () => { throw Object.assign(new Error("forbidden"), { status: 403, headers: { "retry-after": "60" } }); } });
  assert.match((await citedEvidence([job!], secondary, [])).awaiting, /could not be read yet/, "a retry-after 403 is retried");
  const integration = citeDeps({ citedJob: async () => { throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 }); } });
  const refused = await citedEvidence([job!], integration, []);
  assert.equal(refused.awaiting, undefined, "any other 403 is final");
  assert.match(refused.facts.join("\n"), /could not be read \(Resource not accessible by integration\)/);
});

