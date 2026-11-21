// A report's cited ids (WOR-9047): a report that cites a task, an approval card and an Actions job is graded from what code
// resolves, not from "not shown". An id that resolves to nothing is a real answer ("no such id"), and a genuinely unreadable
// read still waits: a named task's file list is read (kernel-loop.ts otherTask), so only a transient failure is a wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import { citedEvidence, citedIds, MAX_CITED, resolveCitation } from "../service/src/grader/evidence.ts";
import { gather } from "../service/src/grader/grade.ts";

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

test("a report that cites an existing task and a nonexistent one grades the first as existing through gather()", async () => {
  const report = "Done: WOR-101 is done. WOR-999 is not a task.";
  const ev = await gather({ kind: "report", ref: "" }, {
    approvals: async () => [],
    comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: report, createdAt: "2026-11-20T09:00:00Z" }],
    attachments: async () => [],
    assignee: "eng",
    delegator: { agentId: "cos" },
    identifier: "WOR-1",
    ...citeDeps(),
  }, ["the report cites the existing task and no nonexistent one"]);
  const facts = ev.facts.join("\n");
  assert.match(facts, /cited task WOR-101: exists, state done/);
  assert.match(facts, /cited id WOR-999: no such task in this company/);
  assert.equal(ev.awaiting, undefined, "the report exists, so the row is graded rather than waiting");
});

test("an id that appears only in an attached file is not a citation the report made", async () => {
  // The attachment's contents name WOR-101 and a card; the report's own comment names neither.
  const ev = await gather({ kind: "report", ref: "" }, {
    approvals: async () => [],
    comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: "Done; the notes are attached.", createdAt: "2026-11-20T09:00:00Z" }],
    attachments: async () => [{ id: "f1", originalFilename: "notes.txt", contentType: "text/plain", byteSize: 40 }],
    content: async () => Buffer.from("The mockups landed in WOR-101 via k-0123456789abcdef."),
    assignee: "eng",
    delegator: { agentId: "cos" },
    identifier: "WOR-1",
    ...citeDeps(),
  }, ["the report cites the task the mockups landed in"]);
  assert.ok(ev.facts.some((f: string) => f.includes("notes.txt") || f.includes("file_1")), "the attachment is still evidence");
  assert.ok(!ev.facts.some((f: string) => f.startsWith("cited task WOR-101")), "an id only in an attachment is no citation");
  assert.ok(!ev.facts.some((f: string) => f.includes("k-0123456789abcdef")), "nor is a card id found only there");
  assert.equal(ev.data.CITED_IDS, undefined);
  assert.doesNotMatch(ev.version ?? "", /cited:/, "and it does not enter the graded version");
});

test("a cited id is capped so the evidence stays bounded, and a task's own identifier is never a citation", () => {
  const many = Array.from({ length: 30 }, (_, i) => `WOR-${100 + i}`).join(" ");
  const ids = citedIds([`${many} WOR-1`], "WOR-1");
  assert.equal(ids.length, MAX_CITED);
  assert.deepEqual(ids[0], { kind: "task", id: "WOR-100" });
  assert.deepEqual(ids.at(-1), { kind: "task", id: "WOR-119" });
  assert.ok(ids.every((c) => c.kind !== "task" || c.id !== "WOR-1"), "the graded task itself is not cited");
  assert.deepEqual(citedIds(["a job 123456 in acme/app"], "WOR-1"), [{ kind: "job", id: "123456" }]);
  assert.deepEqual(citedIds(["https://github.com/acme/app/actions/runs/9/job/777"], "WOR-1"), [{ kind: "job", repo: "acme/app", id: "777" }]);
});

test("a citation read that fails is a wait, and the card, task and job reads are the only ones used", async () => {
  const ids = citedIds(["WOR-101 kit"], "WOR-1");
  const down = await citedEvidence(ids, citeDeps({ citedTask: async () => { throw new Error("kernel 502"); } }));
  assert.match(down.awaiting, /the cited task WOR-101 could not be read yet/);
  assert.equal(down.facts, undefined, "a failed read never becomes 'no such task'");
});

test("a named task's unreadable file list is a transient wait, while the report's cited ids still resolve", async () => {
  const report = "The mockups are on WOR-101; the card k-0123456789abcdef landed them.";
  const unavailable = async () => { throw Object.assign(new Error("kernel GET → 502: upstream down"), { status: 502 }); };
  const deps = (rubric: string[]) => ({
    approvals: async () => [],
    comments: async () => [{ id: "c1", authorType: "agent", authorAgentId: "eng", body: report, createdAt: "2026-11-20T09:00:00Z" }],
    attachments: async () => [],
    assignee: "eng",
    delegator: { agentId: "cos" },
    identifier: "WOR-9",
    otherTask: unavailable,
    ...citeDeps(),
  });
  // Cited in the report but not named by the rubric: the cited ids are resolved, and the unreadable file list is never touched.
  const citedOnly = await gather({ kind: "report", ref: "" }, deps(["the report cites an existing task and card"]), ["the report cites an existing task and card"]);
  assert.match(citedOnly.facts.join("\n"), /cited task WOR-101: exists/);
  assert.match(citedOnly.facts.join("\n"), /cited card k-0123456789abcdef: exists/);
  assert.equal(citedOnly.awaiting, undefined, "the citation path does not go through the named task's files");

  // Named by the rubric, the same report waits on a read that failed for a transient reason (a 5xx/network error): the wait is
  // for the next look, never "not met", and the file list itself is read from the task through cp-read (kernel-loop.test.ts).
  const rubric = ["the mockup files on WOR-101 are the ones used"];
  const named = await gather({ kind: "report", ref: "" }, deps(rubric), rubric);
  assert.match(named.awaiting, /the files on WOR-101 could not be read yet \(kernel GET +502: upstream down\)/);
  assert.equal(named.facts, undefined, "an unreadable named task is a wait, never evidence");
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

test("a cited repo resolves exactly first, then by dashes and case only when one known repo matches; a bare citation skips an unreadable repo", async () => {
  const seen: string[] = [];
  const deps = citeDeps({
    citedJob: async (repo: string) => {
      seen.push(repo);
      if (repo === "acme/nogrant") throw Object.assign(new Error("no grant"), { status: 403 });
      return { name: "ci", state: "completed", conclusion: "success" };
    },
  });
  const [job] = citedIds(["ci: https://github.com/acme/my.app/actions/runs/1/job/7"], "WOR-9");
  await resolveCitation(job!, deps, ["acme/my_app"]);
  assert.equal(seen.pop(), "acme/my.app", "dots and underscores are different repos: no variant match");
  await resolveCitation(job!, deps, ["acme/my.app", "acme/my_app"]);
  assert.equal(seen.pop(), "acme/my.app", "an exact match wins");
  const [dashed] = citedIds(["ci: https://github.com/AidenHQ/AidenHQ/actions/runs/1/job/7"], "WOR-9");
  await resolveCitation(dashed!, deps, ["Aiden-HQ/AidenHQ", "aiden-hq/aidenhq"]);
  assert.equal(seen.pop(), "AidenHQ/AidenHQ", "two variants are ambiguous: the cited spelling is used");

  const [bare] = citedIds(["ci: job 424242"], "WOR-9");
  const r = await resolveCitation(bare!, deps, ["acme/nogrant", "acme/app"]);
  assert.equal(r.exists, true, "a refused repo does not stall a bare citation");
  assert.equal(r.repo, "acme/app");
});

test("a repo listed twice is not ambiguous; a bare citation refused everywhere is shown once as unreadable", async () => {
  const seen: string[] = [];
  const deps = citeDeps({ citedJob: async (repo: string) => { seen.push(repo); return { name: "ci", state: "completed", conclusion: "success" }; } });
  const [dashed] = citedIds(["ci: https://github.com/AidenHQ/AidenHQ/actions/runs/1/job/7"], "WOR-9");
  await resolveCitation(dashed!, deps, ["Aiden-HQ/AidenHQ", "Aiden-HQ/AidenHQ"]);
  assert.equal(seen.pop(), "Aiden-HQ/AidenHQ");

  const [bare] = citedIds(["ci: job 424242"], "WOR-9");
  const denied = citeDeps({ citedJob: async (repo: string) => { throw Object.assign(new Error(`no grant on ${repo}`), { status: 403 }); } });
  const out = await citedEvidence([bare!], denied, ["acme/a", "acme/b"]);
  assert.equal(out.awaiting, undefined);
  assert.match(out.facts.join("\n"), /could not be read \(no grant on acme\/a\)/);
});

