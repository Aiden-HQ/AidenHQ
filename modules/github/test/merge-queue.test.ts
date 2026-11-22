// The merge queue in the code host's service end to end (merges.ts over merge-gate.ts), against a fake GitHub (GraphQL and
// REST) and a fake kernel. The invariants: a PR merges only at the head its record bound, after its named checks are green on
// that head (read again at the merge); and missing evidence (no checks, a truncated page of them, the base's gate check not yet on the head) never counts as passing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../service/src/service.ts";
import { createMerges } from "../service/src/merges.ts";
import { decide } from "../service/src/merge-gate.ts";
import { createReviewGate } from "../service/src/review-gate.ts";

const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const HEAD = "a".repeat(40);
const check = (name, state) => ({ __typename: "CheckRun", name, status: state === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: state === "PENDING" ? null : state });
const rollup = (state, { names = ["build"], more = false } = {}) => ({ state, contexts: { pageInfo: { hasNextPage: more }, nodes: names.map((n) => check(n, state)) } });

/** GitHub with one open PR per repo (`prs[repo]`: { head, checks, names?, more?, baseNames?, files? }); merges and writes are recorded. */
function fakeGitHub(prs) {
  const writes = [];
  const gh = async (method, path, body) => {
    if (method !== "GET" && path !== "/graphql") writes.push({ method, path, body });
    if (path === "/graphql") {
      const v = body.variables;
      const repo = `${v.owner}/${v.repo}`;
      const p = prs[`${repo}#${v.number}`] ?? prs[repo];
      if (!p) return { status: 400, body: { errors: [{ message: `fake GitHub: no PR ${repo}#${v.number}` }] } };
      if (body.query.includes("pullRequest(number")) {
        // `lag`: GitHub's read still shows the PR open for that many polls (its merge not yet reflected); a repo's allowed
        // methods can change between the PUT and the poll (`squash: false, rebase: true`).
        const stale = (p.lag ?? 0) > 0;
        if (stale) p.lag--;
        return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: p.squash !== false, rebaseMergeAllowed: p.rebase === true, pullRequest: {
          id: "PR_1", number: v.number, url: `https://github.com/${repo}/pull/${v.number}`, state: stale ? "OPEN" : p.state ?? "OPEN", isDraft: false, reviewDecision: p.review ?? null,
          mergedAt: stale ? null : p.mergedAt ?? null, mergeCommit: !stale && p.merged ? { oid: p.merged, message: String(p.message ?? "") } : null,
          mergeStateStatus: p.checks === "SUCCESS" ? "CLEAN" : "BLOCKED", headRefOid: p.head, headRefName: "feature", isCrossRepository: false, baseRefName: "main",
          files: { pageInfo: { hasNextPage: false }, nodes: (p.files ?? ["lib/x.mjs"]).map((path) => ({ path })) }, latestOpinionatedReviews: { nodes: [] },
          commits: { nodes: [{ commit: { statusCheckRollup: rollup(p.checks, p) } }] },
          baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40), statusCheckRollup: rollup("SUCCESS", { names: p.baseNames }) } },
        } } } } };
      }
      return { status: 400, body: { errors: [{ message: "fake GitHub: unknown query" }] } };
    }
    if (method !== "GET") {
      const m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(path);
      if (m) {
        const p = prs[`${m[1]}#${m[2]}`] ?? prs[m[1]];
        p.state = "MERGED";
        p.merged = p.merged ?? "c".repeat(40);
        // The merge commit carries the message GitHub made. GitHub normalises a squash message: it appends the PR number and keeps
        // the trailer, so the token in the queue's commit_message is still in it, but not as the whole message.
        const sent = String(body?.commit_message ?? "");
        p.message = sent ? `${sent}\n\n(#${m[2]})` : "";
        return { status: 200, body: { sha: p.merged } };
      }
      return { status: 200, body: {} };
    }
    const commit = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{40})$/.exec(path);
    if (commit) {
      const one = prs[commit[1]] as { message?: string } | undefined;
      const all = Object.entries(prs).filter(([k]) => k.startsWith(`${commit[1]}#`)).map(([, p]) => p) as { message?: string; merged?: string }[];
      const found = all.find((p) => p.merged === commit[2]) ?? one;
      return { status: 200, body: { commit: { message: String(found?.message ?? "") } } };
    }
    return { status: 404, body: { message: "fake GitHub: no route" } };
  };
  return { gh, writes, merges: () => writes.filter((w) => w.method === "PUT" && w.path.endsWith("/merge")) };
}

async function setup(t, { prs, connected = { on: true }, cacheDir = mkdtempSync(join(tmpdir(), "codehost-merges-")), clock = { t: Date.now() }, checks, putFails = () => false, remoteUrl = (slug) => join(cacheDir, "no-such-remote", slug) }) {
  const outcomes = [];
  const taken = new Set();
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const m = /^\/v1\/writes\/([^/]+)\/outcome$/.exec(req.url);
    // The kernel takes a record's first outcome and answers 409 to a repeat (the executor and the queue both post it).
    if (m && taken.has(m[1])) return res.writeHead(409).end("{}");
    if (m) { taken.add(m[1]); outcomes.push({ id: m[1], ...JSON.parse(body) }); return res.writeHead(200).end("{}"); }
    const reply = checks?.(req.method, req.url, body ? JSON.parse(body) : undefined);
    if (reply) return res.writeHead(200).end(JSON.stringify(reply));
    res.writeHead(404).end("{}");
  });
  const github = fakeGitHub(prs);
  // GitHub as the owner (client.ts GitHubAccess), faked over the fake GitHub above.
  const access = {
    connected: () => connected.on, token: async () => "tok", scopes: () => [], status: () => ({ scopes: [], problems: [] }),
    identity: async () => ({ login: "owner1", name: "Owner One", email: "1+owner1@users.noreply.github.com" }),
    rest: async (m, p, b) => {
      if (!connected.on) throw Object.assign(new Error("GitHub isn't connected"), { need: { cause: "not_connected" } });
      // A merge call that never answers: GitHub may or may not have merged it (merges.ts mergeCalls).
      if (m === "PUT" && p.endsWith("/merge") && putFails()) throw new Error("The operation was aborted due to timeout");
      return { ...(await github.gh(m, p, b)), headers: new Headers() };
    },
    graphql: async () => ({}),
  };
  const handle = createService({
    key: "ch-key", kernelUrl: kernel.url, cacheDir, access, fleetOrg: "acme-agents", remoteUrl,
    productRepo: "acme/aidenhq", now: () => new Date(clock.t), reviewGate: async () => undefined,
  });
  const svc = await listen((req, res) => void handle(req, res));
  t.after(() => { kernel.s.close(); svc.s.close(); });
  const call = async (path, body) => {
    const r = await fetch(`${svc.url}${path}`, { method: "POST", headers: { authorization: "Bearer ch-key", "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  };
  // The kernel's execute call: the record's own task goes with it (executor@1), so the queue's evidence is bound to it, never to
  // a cache keyed by kind and args (two tasks naming one PR must not take each other's linkage).
  // `task` is the kernel record's task id and `identifier` its human identifier: pr-tasks.json is keyed by the latter, so both
  // must reach the queue (the production shape, where an id and an identifier are never the same string).
  const merge = (id, prsArgs, task = "tsk_0000000000000w9", identifier = "WOR-9") => call("/aidenhq/v1/executor/execute", { id, kind: "github.merge", args: { prs: prsArgs }, digest: "d", idempotency_key: id, ...(task ? { task } : {}), ...(identifier ? { identifier } : {}) });
  const settle = async () => { for (let i = 0; i < 100 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10)); };
  return { handle, github, outcomes, call, merge, settle, cacheDir, clock };
}

test("an approved agents-org merge waits for green, merges at its bound head, and reports its outcome", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING" } };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs });
  assert.deepEqual(await merge("k-00000000000000a1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]), { accepted: true });
  await handle.stepMerges();
  assert.deepEqual(github.merges(), [], "checks still running: not merged");
  assert.equal(outcomes.length, 0, "no outcome while it waits");
  prs["acme-agents/widget"].checks = "SUCCESS";
  await handle.stepMerges();
  await settle();
  // The trailer carries a nonce made for this one call: not the record id (which is knowable), so it cannot be planted in a PR's text.
  const sent = github.merges()[0].body.commit_message;
  assert.equal(github.merges().length, 1);
  assert.match(sent, /^Co-authored-by: AidenHQ merge queue queue-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} <noreply@aidenhq\.ai>$/);
  assert.doesNotMatch(sent, /k-00000000000000a1/, "never the record id, which a PR author can know");
  assert.deepEqual(github.merges()[0].body.merge_method, "squash");
  assert.equal(github.merges()[0].body.sha, HEAD);
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /Merged https:\/\/github.com\/acme-agents\/widget\/pull\/1/);
  const [line] = outcomes[0].text.split("\n");
  assert.deepEqual(JSON.parse(line.replace(/^merged-prs: /, "")).map((p) => [p.repo, p.number, p.head, typeof p.sha]), [["acme-agents/widget", 1, HEAD, "string"]], "the first line lists what it merged, with its merge commit");
});

test("missing evidence never counts as passing: no checks wait with no time limit, a truncated page of checks, the base's gate check not yet on the head", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", names: [] } };
  const { handle, github, outcomes, merge, settle, clock } = await setup(t, { prs });
  await merge("k-00000000000000c1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  clock.t += 7 * 24 * 3600_000;
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes.length, 0, "no checks yet: still waiting, never failed for the time");
  assert.deepEqual(github.merges(), []);
  prs["acme-agents/widget"] = { head: HEAD, checks: "SUCCESS", names: ["build"] };
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, "merged once its checks registered and passed");

  outcomes.length = 0;
  prs["acme-agents/widget"] = { head: HEAD, checks: "SUCCESS", more: true };
  await merge("k-00000000000000c2", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.match(outcomes[0]?.text ?? "", /more than 100 checks/);

  outcomes.length = 0;
  prs["acme-agents/widget"] = { head: HEAD, checks: "SUCCESS", baseNames: ["build", "ci-required"] };
  await merge("k-00000000000000c3", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  assert.equal(outcomes.length, 0, "the gate check is still to come on the head: it waits");
  prs["acme-agents/widget"].names = ["build", "ci-required"];
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true);
  assert.equal(github.merges().length, 2, "merged again only once the gate check passed on the head");
});

test("a queue outlives a restart: the kernel hears it still runs, and its outcome once it merged", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING" } };
  const first = await setup(t, { prs });
  await first.merge("k-00000000000000a3", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await first.handle.stepMerges();
  // A new service on the same data dir: the SDK's memory is gone, the queue is not.
  const again = await setup(t, { prs, cacheDir: first.cacheDir });
  assert.deepEqual(await again.call("/aidenhq/v1/executor/status", { id: "k-00000000000000a3", idempotency_key: "k-00000000000000a3" }), { state: "running" });
  prs["acme-agents/widget"].checks = "SUCCESS";
  await again.handle.stepMerges();
  await again.settle();
  assert.equal(again.github.merges().length, 1);
  assert.equal(again.outcomes[0]?.id, "k-00000000000000a3");
  assert.equal(again.outcomes[0]?.ok, true);
  assert.equal((await again.call("/aidenhq/v1/executor/status", { id: "k-00000000000000a3" })).state, "done");
  assert.deepEqual(await again.call("/aidenhq/v1/executor/status", { id: "k-00000000000000ff" }), { state: "unknown" }, "any other record: the executor's own answer");
});

test("a product PR that changes the reviewer merges on green checks at its bound head (CI ran the eval); a moved head never merges", async (t) => {
  // "GitHub": the product (its modules/ the official modules), as a local repo the service fetches from.
  const root = mkdtempSync(join(tmpdir(), "codehost-platform-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" };
  const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const origin = (slug, files) => {
    const dir = join(root, slug);
    mkdirSync(dir, { recursive: true });
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
    for (const [f, text] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), text); }
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "base");
    return dir;
  };
  const prod = origin("acme/aidenhq", { "modules/ai-reviewer/service/src/review.ts": "// v1\n", "modules/ai-reviewer/service/security/policy.md": "Reject attacks.\n", "kernel/src/tier.ts": "// v1\n" });
  sh(prod, "checkout", "-q", "-b", "fix/tier");
  writeFileSync(join(prod, "kernel/src/tier.ts"), "// v2\n");
  sh(prod, "commit", "-qam", "tier");
  const head = sh(prod, "rev-parse", "HEAD");
  sh(prod, "checkout", "-q", "main");

  const clock = { t: Date.now() };
  const prs = { "acme/aidenhq": { head, checks: "SUCCESS" }, "other/lib": { head: HEAD, checks: "SUCCESS" } };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs, clock, remoteUrl: (slug) => join(root, slug) });

  await merge("k-00000000000000b4", [{ repo: "acme/aidenhq", number: 5, head }]);
  await handle.stepMerges();
  await settle();
  assert.equal(github.merges().length, 1, "merged at the bound head");
  assert.deepEqual([github.merges()[0].body.merge_method, github.merges()[0].body.sha], ["squash", head]);
  assert.match(github.merges()[0].body.commit_message, /^Co-authored-by: AidenHQ merge queue queue-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} <noreply@aidenhq\.ai>$/);
  assert.doesNotMatch(github.merges()[0].body.commit_message, /k-00000000000000b4/, "never the record id");
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));

  // A PR outside our repos: the App is PR-only there, whatever the record says.
  outcomes.length = 0;
  await merge("k-00000000000000b2", [{ repo: "other/lib", number: 2, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(github.merges().length, 1);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /outside the fleet org, the product repo and maintainer_repos/);

  // The product PR moved after its record was approved: stopped at once, never merged.
  prs["acme/aidenhq"] = { head: "e".repeat(40), checks: "SUCCESS" };
  outcomes.length = 0;
  await merge("k-00000000000000b3", [{ repo: "acme/aidenhq", number: 6, head }]);
  await handle.stepMerges();
  await settle();
  assert.equal(github.merges().length, 1);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /head moved since the merge was approved/);
});

test("a UI head waiting on its design review gets the UI Reviewer's task beside its checks, asked once more past its time", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING", files: ["web/app.css"] } };
  const tasks = [];
  const checks = (method, url, b) => method === "POST" && url === "/v1/tasks" ? (tasks.push(b), { id: `t${tasks.length}`, identifier: `T-${tasks.length}` }) : undefined;
  const { handle, github, outcomes, merge, settle, clock } = await setup(t, { prs, checks });
  await merge("k-00000000000000d1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await handle.stepMerges();
  assert.deepEqual(tasks.map((x) => [x.role, x.source]), [["design-review", `design-review:acme-agents/widget/1@${HEAD}`]], "asked once for the head, while its checks still run");
  prs["acme-agents/widget"].checks = "SUCCESS";
  await handle.stepMerges();
  clock.t += 121 * 60_000;
  await handle.stepMerges();
  assert.equal(tasks[1]?.source, `design-review:acme-agents/widget/1@${HEAD}#again`, "no verdict in time: asked once more");
  assert.deepEqual(github.merges(), [], "never merged without the design review's pass");
  assert.equal(outcomes.length, 0);
  clock.t += 121 * 60_000;
  await handle.stepMerges();
  assert.equal(github.merges().length, 1, "still no verdict after the second ask: the design review is advisory for this head");
  await settle();
});

test("a merge-queue wait and its end become waiting and resumed facts with the reason", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING" } };
  const facts = [];
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-flow-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  const { handle, merge, settle, clock } = await setup(t, { prs, cacheDir, checks: (m, u, b) => (u === "/v1/facts" ? (facts.push(...b.facts), { recorded: b.facts.length }) : undefined) });
  await merge("k-00000000000000f1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await handle.flushFacts();
  const waiting = facts.find((f) => f.type === "work.waiting");
  assert.deepEqual([waiting.subject, waiting.task, waiting.data], ["pr:acme-agents/widget#1", "WOR-9", { reason: "checks" }]);
  assert.equal(facts.some((f) => f.type === "work.resumed"), false, "still waiting");
  clock.t += 60_000;
  prs["acme-agents/widget"].checks = "SUCCESS";
  await handle.stepMerges();
  await settle();
  await handle.flushFacts();
  const resumed = facts.find((f) => f.type === "work.resumed");
  assert.deepEqual([resumed.version, resumed.data], [waiting.version, { reason: "checks" }], "the end pairs with its wait by version");
  assert.deepEqual(facts.filter((f) => f.type === "pr.merged").map((f) => [f.task, f.data.head]), [["WOR-9", HEAD]]);
  assert.deepEqual(facts.filter((f) => f.type === "pr.checks_completed").map((f) => [f.subject, f.data.conclusion]), [[`pr:acme-agents/widget#1@${HEAD}`, "success"]]);
});

test("a PR already merged at its bound head before the queue polled it is merged evidence with its merge commit", async (t) => {
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-merged-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha }, "acme-agents/lib": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha } };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs, cacheDir });
  await merge("k-00000000000000c4", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.deepEqual(github.merges(), [], "it was already merged: the queue calls nothing");
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /was already merged/);
  const [line] = outcomes[0].text.split("\n");
  const listed = JSON.parse(line.replace(/^merged-prs: /, ""));
  assert.deepEqual(listed, [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the bound head and its real merge commit, what the grader reads as verified merges");
  assert.match(listed[0].head, /^[0-9a-f]{40}$/);
  assert.match(listed[0].sha, /^[0-9a-f]{40}$/);
  assert.equal(outcomes[0].objects, undefined, "the merge wasn't the queue's, so it names no object as made here");

  // Already merged at the bound head, but hyphenated with no task (an unrelated historical PR): never this task's evidence.
  outcomes.length = 0;
  await merge("k-00000000000000c6", [{ repo: "acme-agents/lib", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, "still a no-op success: the PR did merge at its head");
  assert.match(outcomes[0].text, /was already merged/);
  assert.match(outcomes[0].text, /^merged-prs: \[\]/, JSON.stringify(outcomes[0].text));

  // The queue's own record task id is not the PR row's identifier: a row naming a different identifier is not this task, so the
  // id half of the comparison alone must never pull another task's landed PR in.
  outcomes.length = 0;
  await merge("k-00000000000000c8", [{ repo: "acme-agents/widget", number: 1, head: HEAD }], "tsk_0000000000000xx", "WOR-other");
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true);
  assert.match(outcomes[0].text, /^merged-prs: \[\]/, "an identifier that isn't the row's is another task's evidence");

  // Merged by someone else at another head: never evidence for this record's bound head.
  outcomes.length = 0;
  prs["acme-agents/widget"] = { head: "e".repeat(40), checks: "SUCCESS", state: "MERGED", merged: mergeSha };
  await merge("k-00000000000000c5", [{ repo: "acme-agents/widget", number: 2, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /^merged-prs: \[\]/);
  assert.match(outcomes[0].text, /merged by someone else at/);
});

test("a queue persisted before the identifier was kept recovers it from the record, so its already-merged PR is still evidence", async (t) => {
  // A service upgraded mid-queue: merges.json holds the record's task id but not the task's identifier (the version before it
  // kept one), and a running queue is never handed execute again. The first poll reads the identifier from the record.
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-upgrade-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  mkdirSync(join(cacheDir, "merges"), { recursive: true });
  writeFileSync(join(cacheDir, "merges", "merges.json"), JSON.stringify({ queues: { "k-00000000000000c0": {
    id: "k-00000000000000c0", state: "running", startedAt: new Date().toISOString(), said: [], task: "tsk_0000000000000w9",
    prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD, url: "https://github.com/acme-agents/widget/pull/1", status: "pending" }],
  } } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha } };
  // The kernel's work read: the record keeps the task's identifier, which the queue written before this change never stored.
  const { handle, outcomes, settle } = await setup(t, {
    prs, cacheDir,
    checks: (m, url) => (m === "GET" && url === "/v1/work?record=k-00000000000000c0" ? { id: "k-00000000000000c0", task: "tsk_0000000000000w9", identifier: "WOR-9" } : undefined),
  });
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the upgraded queue found the identifier and kept the evidence");
});

test("an owner's merge at the bound head after an unanswered merge call stays skipped: it is no commit this queue made", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-owner-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", merged: "f".repeat(40), message: "Owner's own squash merge" } };
  // The first merge PUT times out (GitHub merged nothing), then the owner merges it at the bound head before the next poll: the
  // commit carries no queue trailer, so the queue must not claim it, name it as its object, or call it "Merged".
  let timeouts = 1;
  const { handle, outcomes, merge, settle } = await setup(t, { prs, cacheDir, putFails: () => timeouts-- > 0 });
  await merge("k-00000000000000c7", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges(); // the PUT went unanswered: it waits

  prs["acme-agents/widget"].state = "MERGED";
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /was already merged/, "the owner merged it, not the queue");
  assert.doesNotMatch(outcomes[0].text, /Merged https:/, "never credited to the queue");
  // The PR is the task's own and merged at its bound head, so it is evidence all the same (an owner merge at the bound head is
  // what the already-merged path is for); what must not happen is the queue claiming the commit as its own.
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")), [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: "f".repeat(40) }], "the owner's merge commit, listed as evidence");
  assert.equal(outcomes[0].objects, undefined, "no object of the owner's merge is named as made here");
});

test("an unanswered PUT whose merge lands is still credited when the retry is refused while GitHub's read lags", async () => {
  // The first PUT merges on GitHub's side and never answers. The next poll still reads the PR open (a lag), so the queue sends a
  // retry; GitHub refuses it because the PR is in fact merged, and its re-read now shows the merge. The merge commit carries the
  // first call's nonce, so it is this queue's even though the retry's nonce is not in it: attempts, not the last attempt alone.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", lag: 2 } };
  const github = fakeGitHub(prs);
  const reports = [];
  let puts = 0;
  const gh = async (m, p, b) => {
    if (m === "PUT" && String(p).endsWith("/merge")) {
      puts += 1;
      if (puts === 1) { await github.gh(m, p, b); throw new Error("The operation was aborted due to timeout"); }
      throw Object.assign(new Error("HTTP 405: Pull request is not mergeable"), { status: 405 });
    }
    return github.gh(m, p, b);
  };
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-retry-")), gh, fleetOrg: "acme-agents",
    reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  void merges.enqueue("k-00000000000000cb", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step(); // the PUT merges it and goes unanswered: its nonce is kept
  assert.equal(puts, 1);
  await merges.step(); // the stale read says open: a retry goes out and is refused; the re-read shows the merge
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(puts, 2, "the queue did try again, and the refusal was not taken as the end of the merge");
  assert.equal(merges.status("k-00000000000000cb").state, "done");
  assert.match(reports[0].text, /Merged https:\/\/github.com\/acme-agents\/widget\/pull\/1/, "the first call's merge is the queue's");
  assert.deepEqual(reports[0].objects, ["github:acme-agents/widget@cccccccccccccccccccccccccccccccccccccccc"], "named as made here");
});

test("a refused retry whose re-read still lags keeps the earlier call's nonce, so the merge it made is not lost", async () => {
  // The first PUT merges on GitHub's side and never answers. A later poll's read still lags, so a retry goes out and GitHub refuses
  // it (the PR is in fact merged). That refusal answers the retry only: the first call's nonce must survive, and the PR must be
  // looked at again rather than failed, or a merge this queue made lands with no evidence at all.
  const mergeSha = "c".repeat(40);
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", lag: 3 } };
  const github = fakeGitHub(prs);
  const reports = [];
  let puts = 0;
  const gh = async (m, p, b) => {
    if (m === "PUT" && String(p).endsWith("/merge")) {
      puts += 1;
      if (puts === 1) { await github.gh(m, p, b); throw new Error("The operation was aborted due to timeout"); }
      throw Object.assign(new Error("HTTP 405: Pull request is not mergeable"), { status: 405 });
    }
    return github.gh(m, p, b);
  };
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-refused-lag-")), gh, fleetOrg: "acme-agents",
    reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  void merges.enqueue("k-00000000000000cd", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step(); // the PUT merges it and goes unanswered
  await merges.step(); // the stale read says open: the retry is refused, and the re-read lags too
  assert.equal(puts, 2, "the queue retried once");
  assert.equal(merges.status("k-00000000000000cd").state, "running", "a lagging re-read is not yet a refusal to fail on");
  for (let i = 0; i < 6 && merges.status("k-00000000000000cd").state === "running"; i++) await merges.step();
  await new Promise((r) => setTimeout(r, 20));
  const done = merges.status("k-00000000000000cd");
  assert.equal(done.state, "done", JSON.stringify(done));
  assert.deepEqual(done.objects, [`github:acme-agents/widget@${mergeSha}`], "the first call's merge is still named as the queue's");
  assert.deepEqual(JSON.parse(done.text.split("\n")[0].replace(/^merged-prs: /, "")), [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "and it is on the evidence line");
});

test("a refusal with no earlier unanswered attempt is still a failure, and a refused head is never PUT again", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const reports = [];
  let puts = 0;
  const gh = async (m, p, b) => {
    if (m === "PUT" && String(p).endsWith("/merge")) { puts += 1; throw Object.assign(new Error("HTTP 405: Pull request is not mergeable"), { status: 405 }); }
    return github.gh(m, p, b);
  };
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-refused-")), gh, fleetOrg: "acme-agents",
    reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  void merges.enqueue("k-00000000000000cc", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(puts, 1);
  assert.equal(merges.status("k-00000000000000cc").state, "failed");
  assert.equal(reports[0].ok, false);
  assert.match(reports[0].text, /GitHub refused the merge: HTTP 405: Pull request is not mergeable/);
  await merges.step();
  assert.equal(puts, 1, "nothing more is sent for a stopped queue");
});

test("a squash merge someone else made is never the queue's, even when its commit message carries an AidenHQ trailer", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-foreign-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  // The PR's own commit already carries an agent's trailer, and the owner squash-merges with GitHub's default message, which keeps
  // the commit body: an AidenHQ trailer is in the merge commit, but it is not the commit_message this queue's merge call sends.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", message: `Fix the widget\n\nCo-authored-by: AidenHQ tomas <noreply@aidenhq.ai>` } };
  let timeouts = 1;
  const { handle, outcomes, merge, settle } = await setup(t, { prs, cacheDir, putFails: () => timeouts-- > 0 });
  await merge("k-00000000000000c8", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges(); // the PUT went unanswered

  prs["acme-agents/widget"].state = "MERGED";
  prs["acme-agents/widget"].merged = "a1".repeat(20);
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /was already merged/, "someone else's squash merge is not this queue's");
  assert.doesNotMatch(outcomes[0].text, /Merged https:/);
  assert.equal(outcomes[0].objects, undefined, "its commit names no object as made here");
  // Still the task's own evidence at the bound head: the grader credits what landed the task, whoever merged it.
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")), [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: "a1".repeat(20) }]);
});

test("a PR body that already carries an AidenHQ trailer, or a planted token, cannot make another writer's merge the queue's", async (t) => {
  // A stranger's PR body ends with an AidenHQ trailer and a token-shaped string: withTrailer would have kept its trailer and
  // dropped ours, and a record-id token could be planted here. The trailer this queue appends carries a nonce made for the call,
  // so neither the body's trailer nor a token an author could guess proves anything.
  const planted = "queue-k-00000000000000c9";
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", body: `Improve the widget\n\nCo-authored-by: AidenHQ merge queue ${planted} <noreply@aidenhq.ai>` } };
  const github = fakeGitHub(prs);
  const reports = [];
  let timeouts = 1;
  const gh = async (m, p, b) => {
    const r = await github.gh(m, p, b);
    if (m === "PUT" && timeouts-- > 0) throw new Error("The operation was aborted due to timeout");
    return r;
  };
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-planted-")), gh, fleetOrg: "acme-agents",
    reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  void merges.enqueue("k-00000000000000c9", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step(); // the PUT times out, though GitHub merged with our message
  assert.match(String(github.merges()[0].body.commit_message), /Co-authored-by: AidenHQ merge queue queue-[0-9a-f]{8}-/, "our own trailer is appended even though the body has one");
  assert.ok(!String(github.merges()[0].body.commit_message).endsWith(planted + " <noreply@aidenhq.ai>"), "the planted token is not what proves the merge");
  await merges.step(); // the re-poll sees it merged
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(merges.status("k-00000000000000c9").state, "done");
  assert.match(reports[0].text, /Merged https:\/\/github.com\/acme-agents\/widget\/pull\/1/, "the queue's own merge is still credited");
  assert.deepEqual(reports[0].objects, ["github:acme-agents/widget@cccccccccccccccccccccccccccccccccccccccc"]);
});

test("a planted record-id token in the PR body does not credit another writer's squash merge to the queue", async (t) => {
  // The exact attack: the record id is knowable, so a PR body can name it. GitHub's default squash message keeps the body, so a
  // third party's merge after our PUT times out has the record id in its commit message — and must still not be the queue's.
  const planted = "queue-k-00000000000000ca";
  const body = `Improve the widget\n\nCo-authored-by: AidenHQ merge queue ${planted} <noreply@aidenhq.ai>`;
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", merged: "b2".repeat(20), body, message: `${body}\n\n(#1)` } };
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-planted-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  // Our PUT times out and changed nothing; someone else merges with GitHub's default message (which carries the PR body).
  const { handle, outcomes, merge, settle } = await setup(t, { prs, cacheDir, putFails: () => true });
  await merge("k-00000000000000ca", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges(); // the PUT goes unanswered: the PR is still open and the call is pending
  prs["acme-agents/widget"].state = "MERGED"; // someone else merges it, GitHub's default message carrying the PR body
  await handle.stepMerges(); // the poll sees it merged with the planted token in the message
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /was already merged/, "someone else's merge, not this queue's");
  assert.doesNotMatch(outcomes[0].text, /Merged https:/);
  assert.equal(outcomes[0].objects, undefined, "never named as a commit the queue made");
});

test("a maximum-size mixed batch keeps the whole evidence line: the queue's merges and linked already-merged PRs, whole JSON under the kernel's cap", async (t) => {
  // The grading reader takes the outcome's first line, and 30 PRs on a long repo name run past the kernel's old 4,000-character cap
  // by themselves: the line must stay whole JSON inside what the kernel now keeps (records.ts OUTCOME_MAX), not cut mid-entry.
  // Two PRs were merged before the queue polled them, 28 it merges itself: the line carries both kinds, its own first.
  const repo = "acme-agents/widget";
  const prs = {}, tasks = {}, heads = new Map(), already = [];
  for (let n = 1; n <= 30; n++) {
    const head = String(n % 10).repeat(40);
    heads.set(n, head);
    const pre = n > 28;
    if (pre) already.push({ repo, number: n, head, sha: String(n).repeat(40).slice(0, 40) });
    prs[`${repo}#${n}`] = { head, checks: "SUCCESS", ...(pre ? { state: "MERGED", merged: String(n).repeat(40).slice(0, 40), message: "Someone else's merge" } : {}) };
    tasks[`https://github.com/${repo}/pull/${n}`] = { task: "WOR-9", branch: "feature" };
  }
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-size-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify(tasks));
  const { handle, outcomes, merge, settle } = await setup(t, { prs, cacheDir });
  const args = Array.from({ length: 30 }, (_, i) => ({ repo, number: i + 1, head: heads.get(i + 1)! }));
  await merge("k-00000000000000d1", args);
  // One merge per repository per poll (the queue's own pace): 28 polls land its 28, the last two were merged already.
  for (let i = 0; i < 40 && !outcomes.length; i++) { await handle.stepMerges(); await new Promise((r) => setTimeout(r, 5)); }
  await settle();
  assert.equal(outcomes[0]?.ok, true, String(outcomes[0]?.text ?? "").slice(0, 600));
  const [line] = outcomes[0].text.split("\n");
  const OUTCOME_MAX = 6000; // kernel/src/records.ts
  assert.ok(line.length <= OUTCOME_MAX, `the evidence line fits the kernel's outcome cap; it is ${line.length}`);
  // 30 merges each say so, and that summary is trimmed to the room left: the whole outcome, not just the line, fits the cap.
  assert.ok(outcomes[0].text.length <= OUTCOME_MAX, `the whole outcome fits the kernel's cap; it is ${outcomes[0].text.length}`);
  const kept = JSON.parse(line.replace(/^merged-prs: /, ""));
  assert.equal(kept.length, 30, `every PR of the batch is on the line, not truncated; it has ${kept.length}`);
  assert.deepEqual(kept.map((p) => p.number), [...Array(28)].map((_, i) => i + 1).concat([29, 30]), "the queue's own merges first, then the ones already merged");
  assert.deepEqual(kept.slice(28), already, "the already-merged rows carry their own merge commits");
  // The grading reader's contract, pinned here without importing it (verifiedMerges, kernel-loop.ts: 40 hex either side).
  const SLUG = /^[\w.-]+\/[\w.-]+$/, SHA = /^[0-9a-f]{40}$/;
  assert.ok(kept.every((p) => SLUG.test(p.repo) && Number.isInteger(p.number) && SHA.test(p.head) && SHA.test(p.sha)), "every row is one the grading reader keeps");
});

test("a merge call that times out after GitHub merged is reported merged, and an outcome the kernel didn't take is delivered again", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  let timeouts = 1;
  // The fake's PUT merges the PR with the queue's commit_message (the merge queue trailer), as GitHub does; only the answer is lost.
  const gh = async (m, p, b) => {
    const r = await github.gh(m, p, b);
    if (m === "PUT" && timeouts-- > 0) throw new Error("The operation was aborted due to timeout");
    return r;
  };
  const reports = [];
  let refuse = 1;
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-")), gh, fleetOrg: "acme-agents",
    reviewGate: async () => undefined, report: async (id, o) => { reports.push({ id, ...o }); if (refuse-- > 0) throw new Error("the kernel answered 503"); },
  });
  void merges.enqueue("k-00000000000000e1", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step(); // the PUT times out, though GitHub merged
  assert.equal(merges.status("k-00000000000000e1").state, "running", "an unanswered merge call is no refusal");
  await merges.step(); // the re-poll sees it merged at its head
  const tick = () => new Promise((r) => setTimeout(r, 20));
  await tick();
  assert.equal(merges.status("k-00000000000000e1").state, "done");
  assert.match(reports[0].text, /^merged-prs: \[\{"repo":"acme-agents\/widget","number":1/, "listed as merged by this queue");
  // GitHub normalised the squash message (the fake appends `(#1)`), so an exact-message check would have lost this: the record's
  // token in the trailer is what proves the commit is this queue's, and the merge is credited to it.
  assert.match(reports[0].text, /Merged https:\/\/github.com\/acme-agents\/widget\/pull\/1/);
  assert.deepEqual(reports[0].objects, ["github:acme-agents/widget@cccccccccccccccccccccccccccccccccccccccc"], "its own merge commit, named as made here");
  await merges.step(); // the kernel refused the first delivery: delivered again
  await tick();
  assert.equal(reports.length, 2);
  await merges.step();
  await tick();
  assert.equal(reports.length, 2, "taken: not delivered a third time");
});

test("a merge call is credited by the merge method it was made with, even after the repo's methods change", async () => {
  // The repo allowed squash when the PUT was made; by the next poll only rebase is allowed. The old check re-read the repo's
  // config at poll time and would judge the call by "rebase", drop the queue's own merge, and lose both the credit and the object.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", lag: 2 } };
  const github = fakeGitHub(prs);
  const reports = [];
  let timeouts = 1;
  const gh = async (m, p, b) => {
    const r = await github.gh(m, p, b);
    if (m === "PUT" && timeouts-- > 0) throw new Error("The operation was aborted due to timeout");
    return r;
  };
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-method-")), gh, fleetOrg: "acme-agents",
    reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  void merges.enqueue("k-00000000000000d2", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step(); // the PUT goes unanswered: GitHub squash-merged it with our message
  assert.equal(github.merges()[0].body.merge_method, "squash");
  prs["acme-agents/widget"].squash = false;
  prs["acme-agents/widget"].rebase = true;
  await merges.step(); // the poll still reads it open: the call is kept while the PR is open at the bound head
  await merges.step(); // now it reads merged
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(merges.status("k-00000000000000d2").state, "done");
  assert.match(reports[0].text, /Merged https:\/\/github.com\/acme-agents\/widget\/pull\/1/, "the squash call this queue made is still its merge");
  assert.deepEqual(reports[0].objects, ["github:acme-agents/widget@cccccccccccccccccccccccccccccccccccccccc"], "and its commit is still named as made here");
});

test("a merge call is persisted before the PUT, so a restart mid-call still proves the merge it made", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const dir = mkdtempSync(join(tmpdir(), "merges-persist-"));
  const github = fakeGitHub(prs);
  let reports = [];
  // The PUT merges on GitHub's side and then never answers: the service dies while the call is still open.
  const gh = async (m, p, b) => {
    const r = await github.gh(m, p, b);
    if (m === "PUT") await new Promise(() => {});
    return r;
  };
  const merges = createMerges({
    dir, gh, fleetOrg: "acme-agents", reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  void merges.enqueue("k-00000000000000d3", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  void merges.step(); // hangs in the PUT, after the token was saved
  for (let i = 0; i < 50 && !github.merges().length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(github.merges().length, 1, "the PUT was made");
  const saved = JSON.parse(readFileSync(join(dir, "merges.json"), "utf8"));
  const call = saved.queues["k-00000000000000d3"].prs[0].mergeCalls?.at(-1);
  assert.equal(typeof call?.token, "string", "the nonce is on disk before GitHub answers");
  assert.equal(call.method, "squash");
  // A new service on the same dir (the old one died mid-PUT): the token is still there, and the merge the PUT made is its own.
  reports = [];
  const again = createMerges({
    dir, gh: github.gh, fleetOrg: "acme-agents", reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  await again.step();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(again.status("k-00000000000000d3").state, "done");
  assert.match(reports[0]?.text ?? "", /Merged https:\/\/github.com\/acme-agents\/widget\/pull\/1/, "the restart still proves the merge its own call made");
});

test("the stored outcome's first line is whole inside the kernel's cap whenever any line can be, and the summary is what is cut", async (t) => {
  // The first line is the grading reader's evidence; the kernel keeps OUTCOME_MAX characters and cuts only the end. The summary
  // after it is sized to the room left, so the line's end is never what the kernel cuts.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: "d".repeat(40) } };
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-cap-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  const { handle, outcomes, merge, settle } = await setup(t, { prs, cacheDir });
  await merge("k-00000000000000d4", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  const text = outcomes[0].text;
  const [line] = text.split("\n");
  assert.ok(line.length < 6000, "the evidence line alone fits the cap");
  assert.deepEqual(JSON.parse(line.replace(/^merged-prs: /, "")), [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: "d".repeat(40) }], "parses whole");
  assert.ok(text.length <= 6000, `the outcome fits the kernel's cap; it is ${text.length}`);
  assert.ok(text.includes("was already merged"), "the summary is kept, short here");
  const { OUTCOME_MAX } = await import("../service/src/merges.ts");
  assert.equal(OUTCOME_MAX, 6000, "the queue caps its summary by the kernel's own OUTCOME_MAX");
});

test("a red default branch takes no merge on top, except the PR that already holds its tip; running base CI waits only for a PR behind it", () => {
  const data = (base, behindBy) => ({ repository: { defaultBranchRef: { name: "main" }, pullRequest: {
    number: 1, state: "OPEN", isDraft: false, baseRefName: "main", headRefOid: HEAD, mergeStateStatus: "CLEAN", latestOpinionatedReviews: { nodes: [] },
    files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "lib/x.mjs" }] }, commits: { nodes: [{ commit: { statusCheckRollup: rollup("SUCCESS") } }] },
    baseRef: { compare: { behindBy }, target: { oid: "b".repeat(40), statusCheckRollup: base } },
  } } });
  assert.deepEqual(decide(data(rollup("FAILURE"), 2), HEAD, { uiReview: false }), { do: "wait", why: "`main` is red at `bbbbbbbbbbbb`: merged once it is green again" });
  assert.deepEqual(decide(data(rollup("FAILURE"), 0), HEAD, { uiReview: false }), { do: "merge" }, "the fix for a red base lands");
  assert.equal(decide(data(rollup("PENDING"), 2), HEAD, { uiReview: false }).do, "wait");
  assert.deepEqual(decide(data(rollup("PENDING"), 0), HEAD, { uiReview: false }), { do: "merge" }, "at the tip, its own green checks proved the tree");
  assert.deepEqual(decide(data(rollup("CANCELLED", { names: ["build", "ci-required"] }), 2), HEAD, { uiReview: false }), { do: "merge" }, "a cancelled run never judged the base");
  assert.deepEqual(decide(data(rollup("SUCCESS"), 2), HEAD, { uiReview: false }), { do: "merge" });
  assert.deepEqual(decide(data(rollup("SUCCESS", { names: [] }), 2), HEAD, { uiReview: false }), { do: "merge" }, "a base whose CI runs on PRs only");
});

test("a maintained repo merges as the owner; once it leaves maintainer_repos its approved merge is refused at queue time", async () => {
  const prs = { "globex/payments": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const dir = mkdtempSync(join(tmpdir(), "merges-"));
  const reports = [];
  const queue = (maintained) => createMerges({
    dir, gh: github.gh, fleetOrg: "acme-agents", productRepo: "acme/aidenhq", maintained,
    reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const listed = queue(["Globex/Payments"]);
  void listed.enqueue("k-00000000000000f1", { prs: [{ repo: "globex/payments", number: 1, head: HEAD }] });
  await listed.step();
  await tick();
  assert.deepEqual(github.merges().map((w) => [w.path, w.body.sha]), [["/repos/globex/payments/pulls/1/merge", HEAD]]);
  assert.equal(listed.status("k-00000000000000f1").state, "done");

  // Approved while listed, then the owner took the repo off the list (the service restarts with the new setting).
  prs["globex/payments"] = { head: HEAD, checks: "SUCCESS" };
  void listed.enqueue("k-00000000000000f2", { prs: [{ repo: "globex/payments", number: 2, head: HEAD }] });
  const unlisted = queue([]);
  await unlisted.step();
  await tick();
  assert.equal(github.merges().length, 1, "not merged");
  assert.equal(unlisted.status("k-00000000000000f2").state, "failed");
  assert.match(reports.find((r) => r.id === "k-00000000000000f2").text, /outside the fleet org, the product repo and maintainer_repos/);
});

test("merge queue waits while disconnected", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const facts = [];
  const connected = { on: false };
  const { handle, github, merge, settle, outcomes } = await setup(t, { prs, connected, checks: (m, u, b) => (u === "/v1/facts" ? (facts.push(...b.facts), { recorded: b.facts.length }) : undefined) });
  await merge("k-00000000000000b9", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await handle.flushFacts();
  assert.deepEqual(github.merges(), [], "nothing merges while GitHub is signed out");
  assert.deepEqual(facts.filter((f) => f.type === "work.waiting").map((f) => [f.subject, f.data.reason]), [["pr:acme-agents/widget#1", "github"]]);
  connected.on = true;
  await handle.stepMerges();
  assert.equal(github.merges().length, 1, "merged once connected again");
  await settle();
  await handle.flushFacts();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(facts.filter((f) => f.type === "work.resumed").map((f) => f.data.reason), ["github"]);
});

test("a repo code review gates merges only on its pass for the bound head; a wait keeps the merge queued with no time limit; unreachable over 10 minutes lets it go, recorded; other repos never ask", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" }, "acme-agents/other": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const asked = [];
  let answer = { status: 200, body: { verdict: "wait", reasons: [{ code: "findings", text: "1 important finding open: t (a.ts:3)", unblock: "fix and push" }] } };
  const fetchFn = async (url, init) => {
    asked.push([String(url), init.headers.authorization]);
    if (answer === "down") throw new Error("connect ECONNREFUSED");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const clock = { t: Date.now() };
  const logs = [], bypassed = [];
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-")), gh: github.gh, fleetOrg: "acme-agents", now: () => new Date(clock.t),
    report: async () => {}, log: (msg, f) => logs.push([msg, f]),
    flow: { reviewBypassed: (...a) => bypassed.push(a), checksCompleted: () => {}, waiting: () => {}, resumed: () => {}, merged: () => {} },
    reviewGate: createReviewGate({ gated: ["Acme-Agents/Widget"], url: "http://code-review:8098", key: () => "github-module-token", fetchFn, now: () => clock.t }),
  });
  void merges.enqueue("k-00000000000000g1", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  void merges.enqueue("k-00000000000000g2", { prs: [{ repo: "acme-agents/other", number: 2, head: HEAD }] });
  await merges.step();
  assert.deepEqual(asked, [[`http://code-review:8098/v1/verdict?repo=acme-agents%2Fwidget&pr=1&head=${HEAD}`, "Bearer github-module-token"]], "only the gated repo asks");
  assert.deepEqual(github.merges().map((w) => w.path), ["/repos/acme-agents/other/pulls/2/merge"]);
  assert.match(logs.find(([m]) => m === "merge waits for code review")[1].why, /1 important finding open: t \(a\.ts:3\) \(fix and push\)/);
  clock.t += 7 * 24 * 3600_000; // a week of waiting on findings: still waiting
  await merges.step();
  assert.equal(merges.status("k-00000000000000g1").state, "running");
  answer = "down"; // the service goes down: a wait, until it has been down over 10 minutes (the queue asks every 30 s)
  await merges.step();
  for (let i = 0; i < 18; i++) { clock.t += 30_000; await merges.step(); }
  assert.equal(github.merges().length, 1);
  for (let i = 0; i < 3; i++) { clock.t += 30_000; await merges.step(); }
  assert.deepEqual(github.merges().map((w) => [w.path, w.body.sha]), [["/repos/acme-agents/other/pulls/2/merge", HEAD], ["/repos/acme-agents/widget/pulls/1/merge", HEAD]]);
  assert.deepEqual(bypassed.map(([repo, n, head]) => [repo, n, head]), [["acme-agents/widget", 1, HEAD]], "recorded as pr.review_bypassed");
});

test("the outage timer counts only one continuous streak of failures: an answer or a quiet spell starts it over", async () => {
  let down = true;
  const clock = { t: 0 };
  const gate = createReviewGate({ gated: ["acme-agents/widget"], url: "http://code-review:8098", key: () => "k", now: () => clock.t,
    fetchFn: async () => (down ? new Response("", { status: 503 }) : new Response(JSON.stringify({ verdict: "wait" }), { status: 200 })) });
  const ask = () => gate("acme-agents/widget", 1, HEAD);
  await ask(); // one blip, then hours with no merge waiting
  clock.t += 3 * 3600_000;
  assert.ok("wait" in (await ask()), "a single failure after a quiet spell is a new outage, not a 3-hour one");
  for (let i = 0; i < 18; i++) { clock.t += 30_000; await ask(); }
  down = false; // one answer ends the streak
  clock.t += 30_000; await ask();
  down = true;
  clock.t += 30_000;
  assert.ok("wait" in (await ask()), "the streak starts over after an answer");
  for (let i = 0; i < 21; i++) { clock.t += 30_000; await ask(); }
  assert.ok("bypass" in (await ask()), "over 10 minutes of continuous failure lets the merge go");
});

test("the review gate's findings key follows the whole set of reasons, not the cut text", async () => {
  const body = (b: string) => ({ ok: true, status: 200, json: async () => ({ verdict: "wait", reasons: [{ code: "findings", text: "a".repeat(700) + b, unblock: "fix and push" }] }) }) as Response;
  const gate = (b: string) => createReviewGate({ gated: ["acme/x"], url: "http://cr", key: () => "k", fetchFn: async () => body(b) });
  const one = await gate("1")("acme/x", 1, "h"), two = await gate("2")("acme/x", 1, "h");
  assert.ok(one && "findingsKey" in one && two && "findingsKey" in two && one.findingsKey !== two.findingsKey);
});

test("a bypass recorded on a merge confirmed by a later poll (the PUT went unanswered) still emits reviewBypassed, once", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  let timeouts = 1;
  const gh = async (m, p, b) => {
    const r = await github.gh(m, p, b);
    const pull = r.body?.data?.repository?.pullRequest;
    // The PR merged by this queue's own PUT: its commit carries the message the PUT sent, so the queue's nonce is in it. (Keep it:
    // an empty message would be a merge no call of ours can prove, which is the foreign-merge case, not this one.)
    if (pull?.state === "MERGED") pull.mergeCommit = { oid: "c".repeat(40), message: String(prs["acme-agents/widget"].message ?? "") };
    if (m === "PUT" && timeouts-- > 0) throw new Error("The operation was aborted due to timeout");
    return r;
  };
  const clock = { t: Date.now() };
  const fetchFn = async () => { throw new Error("connect ECONNREFUSED"); };
  const bypassed = [];
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-")), gh, fleetOrg: "acme-agents", now: () => new Date(clock.t),
    report: async () => {},
    flow: { reviewBypassed: (...a) => bypassed.push(a), checksCompleted: () => {}, waiting: () => {}, resumed: () => {}, merged: () => {} },
    reviewGate: createReviewGate({ gated: ["Acme-Agents/Widget"], url: "http://code-review:8098", key: () => "github-module-token", fetchFn, now: () => clock.t }),
  });
  void merges.enqueue("k-00000000000000h1", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  // Code review is unreachable: a wait, until it has been down over 10 minutes (the queue asks every 30 s).
  await merges.step();
  for (let i = 0; i < 21; i++) { clock.t += 30_000; await merges.step(); }
  assert.equal(merges.status("k-00000000000000h1").state, "running", "an unanswered merge call is no refusal");
  assert.deepEqual(bypassed, [], "nothing is recorded before the merge is confirmed");
  assert.equal(github.merges().length, 1, "the merge PUT went out once and was unanswered");
  await merges.step(); // the re-poll sees it merged at its head: the done path
  assert.equal(merges.status("k-00000000000000h1").state, "done");
  assert.deepEqual(bypassed.map(([repo, n, head, why]) => [repo, n, head, /unreachable/.test(why)]), [["acme-agents/widget", 1, HEAD, true]], "recorded once, on the done path");
  assert.equal(github.merges().length, 1, "the confirmation poll sends no second merge PUT");
  await merges.step();
  assert.equal(bypassed.length, 1, "not emitted again");
});
