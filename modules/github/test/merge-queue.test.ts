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
import { withActors } from "./actors.ts";
import { createMerges as mergesWith } from "../service/src/merges.ts";
/** The merge queue with every merge as the owner, through the test's own fake GitHub (github-mcp's actorFor picks it in the service). */
const createMerges = (d: any) => mergesWith({ actorFor: async () => ({ key: "owner", rest: d.gh }), actorByKey: async () => ({ rest: d.gh }), ...d });
import { decide } from "../service/src/merge-gate.ts";
import { createReviewGate } from "../service/src/review-gate.ts";

const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const HEAD = "a".repeat(40);
const check = (name, state, rank) => ({ __typename: "CheckRun", ...(rank === undefined ? {} : { databaseId: rank }), name, status: state === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: state === "PENDING" ? null : state });
/** A rollup: one check per name in `names` with one `state`, or `runs` when they differ ({ name, state, rank }); `rank` is the
 * check run's databaseId, the only thing that says which of two runs of one name is newer. */
const rollup = (state, { names = ["build"], more = false, runs } = {}) => ({ state, contexts: { pageInfo: { hasNextPage: more }, nodes: (runs ?? names.map((n) => ({ name: n, state }))).map((r) => check(r.name, r.state, r.rank)) } });

/** GitHub with one open PR per repo (`prs[repo]`, or `prs["repo#n"]` for one PR of a repo with several); merges and writes are recorded. */
function fakeGitHub(prs) {
  const writes = [];
  const gh = async (method, path, body) => {
    if (method !== "GET" && path !== "/graphql") writes.push({ method, path, body });
    if (path === "/graphql") {
      const v = body.variables;
      const repo = `${v.owner}/${v.repo}`;
      const p = prs[`${repo}#${v.number}`] ?? prs[repo];
      if (!p) return { status: 400, body: { errors: [{ message: `fake GitHub: no PR ${repo}#${v.number}` }] } };
      // A changed file as GitHub lists it: `p.changeTypes` names the paths whose changeType is not MODIFIED.
      const file = (path) => ({ path, changeType: p.changeTypes?.[path] ?? "MODIFIED" });
      // `filePages`: a PR whose file list GitHub cut at 100, answered one page at a time by the cursor ("f1" is page 2).
      if (body.query.includes("after: $after")) {
        const page = p?.filePages?.[Number(String(v.after).replace(/^f/, ""))];
        // The head and base the page was read at: the reader refuses a page from another head than the PR read's.
        return page ? { status: 200, body: { data: { repository: { pullRequest: { headRefOid: p.headAt ?? p.head, baseRefOid: p.baseAt ?? "b".repeat(40), files: { pageInfo: { hasNextPage: page.length >= 100, endCursor: `f${Number(String(v.after).replace(/^f/, "")) + 1}` }, nodes: page.map((path) => file(path)) } } } } } } : { status: 500, body: { errors: [{ message: "fake GitHub: no such file page" }] } };
      }
      if (body.query.includes("pullRequest(number")) {
        // `lag`: GitHub's read still shows the PR open for that many polls (its merge not yet reflected); a repo's allowed
        // methods can change between the PUT and the poll (`squash: false, rebase: true`).
        const stale = (p.lag ?? 0) > 0;
        if (stale) p.lag--;
        return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: p.squash !== false, rebaseMergeAllowed: p.rebase === true, pullRequest: {
          id: "PR_1", number: v.number, url: `https://github.com/${repo}/pull/${v.number}`, state: stale ? "OPEN" : p.state ?? "OPEN", isDraft: false, reviewDecision: p.review ?? null,
          mergedAt: stale ? null : p.mergedAt ?? null, mergeCommit: !stale && p.merged ? { oid: p.merged, message: String(p.message ?? "") } : null,
          mergeStateStatus: p.checks === "SUCCESS" ? "CLEAN" : "BLOCKED", headRefOid: p.head, baseRefOid: "b".repeat(40), headRefName: "feature", isCrossRepository: false, baseRefName: p.base ?? "main",
          files: p.filePages
            ? { pageInfo: { hasNextPage: true, endCursor: "f1" }, nodes: p.filePages[0].map((path) => file(path)) }
            : { pageInfo: { hasNextPage: false }, nodes: (p.files ?? ["lib/x.mjs"]).map((path) => file(path)) }, latestOpinionatedReviews: { nodes: [] },
          commits: { nodes: [{ commit: { statusCheckRollup: p.rollup ?? rollup(p.checks, p) } }] },
          baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40), statusCheckRollup: rollup(p.baseState ?? "SUCCESS", { names: p.baseNames }) } },
        } } } } };
      }
      return { status: 400, body: { errors: [{ message: "fake GitHub: unknown query" }] } };
    }
    if (method !== "GET") {
      const m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge-async$/.exec(path);
      if (m) {
        const p = prs[`${m[1]}#${m[2]}`] ?? prs[m[1]];
        p.state = "MERGED";
        p.merged = p.merged ?? "c".repeat(40);
        // The merge commit carries the message GitHub made. GitHub normalises a squash message: it appends the PR number and keeps
        // the trailer, so the token in the queue's commit_message is still in it, but not as the whole message.
        const sent = String(body?.commit_message ?? "");
        p.message = sent ? `${sent}\n\n(#${m[2]})` : "";
        return { status: 202, body: { status: "merged", details: { sha: p.merged } } };
      }
      return { status: 200, body: {} };
    }
    // Branch rules: a private repo on a plan without them answers 403 "Upgrade to GitHub Pro" (`noRules`); otherwise none are set.
    const rules = /^\/repos\/([^/]+\/[^/]+)\/(rules\/branches\/[^/]+|branches\/[^/]+\/protection\/required_status_checks)$/.exec(path);
    if (rules) {
      const p = prs[rules[1]] ?? Object.entries(prs).find(([k]) => k.startsWith(`${rules[1]}#`))?.[1];
      if (p?.noRules) return { status: 403, body: { message: "Upgrade to GitHub Pro or make this repository public to enable this feature." } };
      return rules[2].startsWith("rules") ? { status: 200, body: [] } : { status: 404, body: { message: "Branch not protected" } };
    }
    // Workflows: a repo has CI unless the PR says `noCi`.
    const wf = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows/.exec(path);
    if (wf) {
      const p = prs[wf[1]] ?? Object.entries(prs).find(([k]) => k.startsWith(`${wf[1]}#`))?.[1];
      return { status: 200, body: { total_count: p?.noCi ? 0 : 1, workflows: [] } };
    }
    // Every check on a head (ship's readiness reads all pages over REST): the PR's rollup, or none when the repo has no PR.
    const runs = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{40})\/(check-runs|statuses)\?/.exec(path);
    if (runs) {
      const p = prs[runs[1]] ?? Object.entries(prs).find(([k]) => k.startsWith(`${runs[1]}#`))?.[1];
      if (!p) return { status: 200, body: runs[3] === "check-runs" ? { check_runs: [] } : [] };
      if (runs[3] === "check-runs") return { status: 200, body: { check_runs: (p.runs ?? (p.names ?? ["build"]).map((name) => ({ name, status: "completed", conclusion: "success" }))) } };
      return { status: 200, body: [] };
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
  return { gh, writes, merges: () => writes.filter((w) => w.method === "PUT" && w.path.endsWith("/merge-async")) };
}

async function setup(t, { prs, connected = { on: true }, cacheDir = mkdtempSync(join(tmpdir(), "codehost-merges-")), clock = { t: Date.now() }, checks, kernelReply, kernelBefore, putFails = () => false, graphql, repo = () => 404, pull = () => 404, remoteUrl = (slug) => join(cacheDir, "no-such-remote", slug), reviewGate = async () => undefined }) {
  const outcomes = [];
  const waits = [];
  const taken = new Set();
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const m = /^\/v1\/writes\/([^/]+)\/outcome$/.exec(req.url);
    // The kernel takes a record's first outcome and answers 409 to a repeat (the executor and the queue both post it).
    if (m && taken.has(m[1])) return res.writeHead(409).end("{}");
    if (m) { taken.add(m[1]); outcomes.push({ id: m[1], ...JSON.parse(body) }); return res.writeHead(200).end("{}"); }
    // A claimed record's live wait (kernel/src/backplane.ts): the task's card reads it while the merge cannot move.
    const w = /^\/v1\/writes\/([^/]+)\/wait$/.exec(req.url);
    if (w) { waits.push({ id: w[1], reason: JSON.parse(body || "{}").reason ?? null }); return res.writeHead(200).end(JSON.stringify({ ok: true, new: true })); }
    // A read the kernel could not answer: the socket is dropped, as an unavailable kernel does (`kernelBefore`).
    if (kernelBefore?.(req)) return req.socket.destroy();
    // A task's work read (the merge queue's link for a PR with no pr-tasks.json row): `checks` and `kernelReply` answer their own
    // reads of the path first, and a task with no records answers otherwise.
    const answer = kernelReply?.(req.method, req.url, body ? JSON.parse(body) : undefined) ?? checks?.(req.method, req.url, body ? JSON.parse(body) : undefined);
    const reply = answer ?? (req.method === "GET" && /^\/v1\/work\?task=/.test(req.url) ? { status: "open", records: [] } : undefined);
    // A read that failed rather than answered: `{ __status: 503 }` makes the fake kernel answer that status (a restarting kernel).
    if (reply?.__status) return res.writeHead(reply.__status).end(JSON.stringify({ error: { message: `fake kernel ${reply.__status}` } }));
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
      if (m === "PUT" && p.endsWith("/merge-async") && putFails()) throw new Error("The operation was aborted due to timeout");
      // The repo read the queue confirms an absent repository with: `repo(slug)` is its status (404: really gone).
      if (m === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(p)) return { status: repo(p.slice("/repos/".length)), body: { full_name: p.slice("/repos/".length) }, headers: new Headers() };
      // The PR read the queue confirms a PR-named NOT_FOUND with (a 404: really gone; a 200: only invisible to this token).
      if (m === "GET" && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(p)) return { status: pull(), body: { number: 1 }, headers: new Headers() };
      if (p === "/graphql" && graphql) return { ...(await graphql()), headers: new Headers() };
      return { ...(await github.gh(m, p, b)), headers: new Headers() };
    },
    graphql: async () => ({}),
  };
  const handle = createService({
    key: "ch-key", kernelUrl: kernel.url, cacheDir, access: withActors(access), fleetOrg: "acme-agents", remoteUrl,
    productRepo: "acme/aidenhq", now: () => new Date(clock.t), reviewGate,
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
  const merge = (id, prsArgs, task = "tsk_0000000000000w9", identifier = "WOR-9", tier = 1) => call("/aidenhq/v1/executor/execute", { id, kind: "github.merge", args: { prs: prsArgs }, digest: "d", idempotency_key: id, tier, ...(task ? { task } : {}), ...(identifier ? { identifier } : {}) });
  const settle = async () => { for (let i = 0; i < 100 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10)); };
  return { handle, github, outcomes, waits, call, merge, settle, cacheDir, clock };
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

test("a deleted repo (GraphQL NOT_FOUND) ends the record as not merged with a reason, instead of waiting forever", async (t) => {
  // GitHub answers with an error whose type is NOT_FOUND (an absent node would do too): the repo or PR is gone for good.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING" } };
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs,
    graphql: async () => ({ status: 200, body: { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository with the name 'acme-agents/widget'." }] } }),
  });
  await merge("k-00000000000000d1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  const o = outcomes[0];
  assert.equal(o?.ok, false, JSON.stringify(outcomes));
  assert.match(String(o?.text), /repository or PR no longer exists/i);
  assert.doesNotMatch(String(o?.text), /GitHub kept failing/, "not the transient-failure wait");
  // The successful-answer form: the repository is there, its PR node is absent (a deleted PR): same definitive end.
  outcomes.length = 0;
  const absent = await setup(t, { prs, graphql: async () => ({ status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, pullRequest: null } } } }) });
  await absent.merge("k-00000000000000d2", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await absent.handle.stepMerges();
  await absent.settle();
  assert.equal(absent.outcomes[0]?.ok, false, JSON.stringify(absent.outcomes));
  assert.match(String(absent.outcomes[0]?.text), /repository or PR no longer exists/i);
  // A token that lost access to a private repo gets the same NOT_FOUND answer, but the repo read says it is there (200): the
  // merge waits and asks again, it is never failed as "gone".
  outcomes.length = 0;
  const blind = await setup(t, { prs, graphql: async () => ({ status: 200, body: { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository with the name 'acme-agents/widget'." }] } }), repo: () => 200 });
  await blind.merge("k-00000000000000d4", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await blind.handle.stepMerges();
  await blind.handle.stepMerges();
  assert.equal(blind.outcomes.length, 0, "a repo the token can't see waits, it is not ended as gone");
  // The same on the null-node shape: the repo read decides, not the null alone.
  const nullNode = await setup(t, { prs, graphql: async () => ({ status: 200, body: { data: { repository: null } } }), repo: () => 403 });
  await nullNode.merge("k-00000000000000d5", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await nullNode.handle.stepMerges();
  await nullNode.handle.stepMerges();
  assert.equal(nullNode.outcomes.length, 0, "a null repository node with no confirmation waits");
  // A NOT_FOUND naming the pull request (not the repository) is the same definitive answer, confirmed by reading that PR: the
  // queued PR never existed, so the record ends instead of waiting out the error window.
  outcomes.length = 0;
  const prGone = await setup(t, { prs, graphql: async () => ({ status: 200, body: { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest with the number of 1." }] } }) });
  await prGone.merge("k-00000000000000d6", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await prGone.handle.stepMerges();
  await prGone.settle();
  assert.equal(prGone.outcomes[0]?.ok, false, JSON.stringify(prGone.outcomes));
  assert.match(String(prGone.outcomes[0]?.text), /repository or PR no longer exists/i);
  // The same answer on a PR that is there but invisible to this token (the PR read answers 200): the merge waits, never "gone".
  outcomes.length = 0;
  const prBlind = await setup(t, { prs, graphql: async () => ({ status: 200, body: { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest with the number of 1." }] } }), pull: () => 200 });
  await prBlind.merge("k-00000000000000d7", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await prBlind.handle.stepMerges();
  await prBlind.handle.stepMerges();
  assert.equal(prBlind.outcomes.length, 0, "a PR the token can't see waits, it is not ended as gone");
  // Any other GraphQL error is not definitive: the record waits (and is not failed), as before.
  outcomes.length = 0;
  const other = await setup(t, { prs, graphql: async () => ({ status: 200, body: { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] } }) });
  await other.merge("k-00000000000000d3", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await other.handle.stepMerges();
  assert.equal(other.outcomes.length, 0, "a non-definitive GraphQL error waits, it does not end the record");
});

test("an explicit null from GitHub is its answer, so the gate ends the record with its own reason instead of asking again", async (t) => {
  // The PR node carries the keys, with null values: GitHub answered that the field is empty, which is not a partial answer.
  // The gate's own reason ends it (a PR with no state), so a queued merge doesn't wait forever on an answer already given.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const { handle, outcomes, merge, settle } = await setup(t, { prs, graphql: async () => ({ status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, pullRequest: { number: 1, state: null, headRefOid: null, baseRefName: null, files: { pageInfo: { hasNextPage: false }, nodes: [] }, commits: { nodes: [] } } } } } }) });
  await merge("k-00000000000000f3", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, false, JSON.stringify(outcomes));
  assert.doesNotMatch(String(outcomes[0]?.text), /kept failing/, "not the transient wait: the answer was read");
});

test("a partial GraphQL answer and an empty 200 are waited on, not taken as a deleted PR", async (t) => {
  // The PR node is there, but a nested lookup answered NOT_FOUND: not the PR being gone, so the approved merge waits.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const nested = await setup(t, { prs, graphql: async () => ({ status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, pullRequest: { number: 1 } } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Ref." }] } }) });
  await nested.merge("k-00000000000000e1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await nested.handle.stepMerges();
  await nested.handle.stepMerges();
  assert.equal(nested.outcomes.length, 0, "a partial answer is retried, not failed");
  // A 200 with data null and no errors (a proxy body) is not evidence the repo is gone either.
  const empty = await setup(t, { prs, graphql: async () => ({ status: 200, body: { data: null } }) });
  await empty.merge("k-00000000000000e2", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await empty.handle.stepMerges();
  await empty.handle.stepMerges();
  assert.equal(empty.outcomes.length, 0, "an empty answer waits");
});

test("a repo with no CI at all merges with no checks (a plan without branch rules included), but the base's CI rule still applies", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", names: [], noRules: true, noCi: true, baseNames: ["build"], baseState: "FAILURE" } };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs });
  await merge("k-00000000000000c0", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  assert.deepEqual(github.merges(), [], "the base is red: the merge waits, as for any PR whose head proved nothing");
  prs["acme-agents/widget"].baseState = "SUCCESS";
  await handle.stepMerges();
  await settle();
  assert.equal(github.merges().length, 1);
  assert.equal(outcomes[0]?.ok, true);
});

test("missing evidence never counts as passing: no checks wait with no time limit where CI exists, a truncated page of checks, the base's gate check not yet on the head", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", names: [] } };
  const { handle, github, outcomes, merge, settle, clock } = await setup(t, { prs });
  await merge("k-00000000000000c1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  clock.t += 7 * 24 * 3600_000;
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes.length, 0, "a repo with workflows and no checks yet: still waiting, never failed for the time");
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
  assert.match(outcomes[0].text, /outside the fleet org, the product repo and the listed repos/);

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

test("a Tier 0 product merge fails at merge once its eligibility is lost: file the merge again", async (t) => {
  const prs = { "acme/aidenhq": { head: HEAD, checks: "SUCCESS", names: ["build", "ci-required"] } };
  const verdict = { v: { pass: true } };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs, reviewGate: async () => verdict.v });
  // Code review unreachable at the merge: it waits for the verdict, never ends the merge.
  verdict.v = { wait: "code review can't be reached: the merge waits until it answers" };
  await merge("k-00000000000000e1", [{ repo: "acme/aidenhq", number: 1, head: HEAD }], undefined, undefined, 0);
  await handle.stepMerges();
  assert.deepEqual([github.merges(), outcomes.length], [[], 0], "waiting, not failed");
  verdict.v = { pass: true, unreviewed: true };
  await handle.stepMerges();
  await settle();
  assert.deepEqual(github.merges(), [], "never merged without the pass it was tiered on");
  assert.match(outcomes[0].text, /eligibility lost at merge: file the merge again/);
});

test("a merge that meets code review's open findings at its head ends, so ship can ask for the fix", async (t) => {
  const prs = { "acme/aidenhq": { head: HEAD, checks: "SUCCESS", names: ["build", "ci-required"] } };
  const verdict = { v: { wait: "code review: classifying: the risk tier of deadbee isn't read yet", unblock: "it resumes by itself within a minute or two" } };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs, reviewGate: async () => verdict.v });
  await merge("k-00000000000000a7", [{ repo: "acme/aidenhq", number: 1, head: HEAD }]);
  await handle.stepMerges();
  assert.deepEqual([github.merges(), outcomes.length], [[], 0], "a classifying head waits, it does not end");
  verdict.v = { wait: "code review: 1 important finding open: look up paths literally (service.ts:200, id f1)", unblock: "fix and push, or record it with code_review_resolve", findings: "code review: 1 important finding open: look up paths literally (service.ts:200, id f1)", findingsKey: "abc123" };
  await handle.stepMerges();
  await settle();
  assert.deepEqual(github.merges(), [], "never merged on findings");
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /open important findings|1 important finding open/);
  // A record ship did not file has no fixer to wake: its text must not claim ship will ask for one.
  assert.match(outcomes[0].text, /nothing wakes a fixer for a merge ship did not file/);
  assert.doesNotMatch(outcomes[0].text, /ship asks for the fix/);
});

test("a merge ship filed ends on findings with ship's fix wake, and a batch keeps the failed PR's findings on its card", async (t) => {
  const prs = {
    "acme-agents/widget": { head: HEAD, checks: "SUCCESS" },
    "acme-agents/gadget": { head: "d".repeat(40), checks: "SUCCESS" },
  };
  const github = fakeGitHub(prs);
  const waits = [];
  const outcomes = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const m = /^\/v1\/writes\/([^/]+)\/(outcome|wait)$/.exec(req.url);
    if (m) {
      const parsed = JSON.parse(body || "{}");
      if (m[2] === "outcome") outcomes.push({ id: m[1], ...parsed });
      else waits.push({ id: m[1], reason: parsed.reason ?? null });
      return res.writeHead(200).end("{}");
    }
    res.writeHead(404).end("{}");
  });
  t.after(() => kernel.s.close());
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-")), gh: github.gh, fleetOrg: "acme-agents", now: () => new Date(),
    report: async () => {}, waiting: async (id, reason) => void waits.push({ id, reason }),
    // The widget's merge is ship's (its args name a generation) and meets findings at its head; the gadget's is still classifying.
    reviewGate: async (repo) => repo === "acme-agents/widget"
      ? { wait: "code review: 1 important finding open (widget.ts:1)", findings: "code review: 1 important finding open (widget.ts:1)", findingsKey: "k1" }
      : { wait: "code review: classifying: the risk tier isn't read yet", unblock: "it resumes by itself" },
  });
  void merges.enqueue("k-00000000000000c3", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }, { repo: "acme-agents/gadget", number: 2, head: "d".repeat(40) }], generation: 2 });
  await merges.step();
  const widget = merges.status("k-00000000000000c3");
  assert.equal(widget.state, "running", "the gadget keeps the batch live");
  const card = waits.at(-1)?.reason;
  assert.match(String(card), /acme-agents\/widget.*important finding/, "the failed PR's findings stay on the live card");
  assert.match(String(card), /acme-agents\/gadget.*classifying/, "and the PR still waiting is named too");
  assert.equal(outcomes.length, 0, "the batch has not ended");
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
  assert.deepEqual(listed, [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the bound head and its real merge commit, the verified merges the record names");
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

test("an unlinked PR already merged by its merge commit's message is evidence only when the message names the record's identifier", async (t) => {
  // A PR the fleet never opened has no pr-tasks.json row, so nothing links it: the merge commit that landed on the default
  // branch is what can credit it, and only when its message names this record's identifier as a whole token.
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-merged-message-"));
  const prs = {
    "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha, message: `Fix the widget\n\nWOR-9` },
    "acme-agents/lib": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha, message: "Fix the lib\n\nNo task named here" },
    "acme-agents/tool": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha, message: "Fix the tool\n\nWOR-95" },
  };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs, cacheDir });
  await merge("k-00000000000000c9", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.deepEqual(github.merges(), [], "it was already merged: the queue calls nothing");
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /was already merged/);
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the merge commit names WOR-9, so the PR is this task's evidence");
  assert.equal(outcomes[0].objects, undefined, "the merge wasn't the queue's, so it names no object as made here");

  // A message naming no identifier: never this task's evidence.
  outcomes.length = 0;
  await merge("k-00000000000000ca", [{ repo: "acme-agents/lib", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, "still a no-op success: the PR did merge at its head");
  assert.match(outcomes[0].text, /^merged-prs: \[\]/, JSON.stringify(outcomes[0].text));

  // A longer identifier sharing the prefix (WOR-95 for WOR-9) names another task: a whole-token match, never a prefix one.
  outcomes.length = 0;
  await merge("k-00000000000000cc", [{ repo: "acme-agents/tool", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true);
  assert.match(outcomes[0].text, /^merged-prs: \[\]/, "WOR-95 is not WOR-9");

  // Merged into a release branch: the commit names WOR-9 but its change never reached the default branch, so it proves nothing.
  prs["acme-agents/release"] = { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha, base: "release", message: "Fix the release\n\nWOR-9" };
  outcomes.length = 0;
  await merge("k-00000000000000cd", [{ repo: "acme-agents/release", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true);
  assert.match(outcomes[0].text, /^merged-prs: \[\]/, "a non-default-branch merge is not evidence");

  // A row that names another task is an answer: a message mentioning WOR-9 in passing must not take the PR over.
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-10", branch: "feature" } }));
  prs["acme-agents/widget"] = { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha, message: "Fix the widget\n\nWOR-9" };
  outcomes.length = 0;
  await merge("k-00000000000000ce", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true);
  assert.match(outcomes[0].text, /^merged-prs: \[\]/, "the row says WOR-10: the message never overrides it");
});

test("a cached merge credit is used only with its default-branch facts; a queue written before them credits nothing", async (t) => {
  // An older queue kept the message alone (or, at the previous head, kept it without recording which branch it merged into): with
  // no proof the merge reached the default branch, the cached row must not credit the task. The same queue with the branches
  // recorded credits the merge only when they agree.
  const mergeSha = "d".repeat(40);
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha, message: "Fix the widget\n\nWOR-9" } };
  const queueWith = async (pr) => {
    const cacheDir = mkdtempSync(join(tmpdir(), "codehost-cached-credit-"));
    mkdirSync(join(cacheDir, "merges"), { recursive: true });
    writeFileSync(join(cacheDir, "merges", "merges.json"), JSON.stringify({ queues: { "k-00000000000000cf": {
      id: "k-00000000000000cf", state: "running", startedAt: new Date().toISOString(), said: [], task: "tsk_0000000000000w9",
      prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD, url: "https://github.com/acme-agents/widget/pull/1", status: "skipped", sha: mergeSha, ...pr }],
    } } }));
    const r = await setup(t, { prs, cacheDir, checks: (m, u) => (m === "GET" && u === "/v1/work?record=k-00000000000000cf" ? { id: "k-00000000000000cf", task: "tsk_0000000000000w9", identifier: "WOR-9" } : undefined) });
    await r.handle.stepMerges();
    await r.settle();
    return r.outcomes[0];
  };

  // A message cached without the branch facts: it is not evidence.
  const legacy = await queueWith({ mergeMessage: "Fix the widget\n\nWOR-9" });
  assert.equal(legacy?.ok, true);
  assert.match(legacy.text, /^merged-prs: \[\]/, "a cached message with no branches is not evidence");

  // A cached credit whose merge went to a release branch is not evidence either.
  const release = await queueWith({ mergeCredit: { message: "Fix the widget\n\nWOR-9", base: "release", defaultBranch: "main" } });
  assert.equal(release?.ok, true);
  assert.match(release.text, /^merged-prs: \[\]/, "a release-branch merge cached as credit is not evidence");

  // The same row with the default branch is evidence: the poll that recorded it proved where it landed.
  const main = await queueWith({ mergeCredit: { message: "Fix the widget\n\nWOR-9", base: "main", defaultBranch: "main" } });
  assert.equal(main?.ok, true);
  assert.deepEqual(JSON.parse(main.text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "verified default-branch credit is evidence");
});

test("an already-merged PR with no pr-tasks.json row is evidence when the task's own pr record names its repo and exact head", async (t) => {
  // The push died before the PR write noted it (a token without workflow scope on a .github/ change), so pr-tasks.json has no row
  // and the owner merged at the bound head. The task's own planned pr record still names the repo and this exact commit: that is
  // the task's attribution (a record in any state, `failed` here), not the merge card's.
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-bound-"));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha } };
  const work = { status: "open", records: [
    { id: "k-00000000000000e1", kind: "github.pr", state: "failed", args: { only: [{ repo: "acme-agents/widget", branch: "feature", sha: "c".repeat(40) }] } },
    { id: "k-00000000000000e2", kind: "github.pr", state: "failed", args: { only: [{ repo: "Acme-Agents/Widget", branch: "feature", sha: HEAD }] } },
  ] };
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs, cacheDir,
    checks: (m, url) => (m === "GET" && url === `/v1/work?task=tsk_0000000000000w9` ? work : undefined),
  });
  await merge("k-00000000000000d7", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /was already merged/);
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the task's own record naming this repo (any case) and this head is the link");
  assert.equal(outcomes[0].objects, undefined, "the merge wasn't the queue's");
});

test("a pr-tasks.json row naming another task is a veto, even when a matching record is on the task", async (t) => {
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-veto-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-other", branch: "feature" } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha } };
  let reads = 0;
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs, cacheDir,
    checks: (m, url) => (m === "GET" && url === "/v1/work?task=tsk_0000000000000w9" ? (reads++, { status: "open", records: [{ kind: "github.pr", state: "failed", args: { only: [{ repo: "acme-agents/widget", sha: HEAD }] } }] }) : undefined),
  });
  await merge("k-00000000000000d8", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /^merged-prs: \[\]/, "a row naming another task is never overridden by a record");
  assert.equal(reads, 0, "the row answers first: no kernel read at all");
});

test("a failed task-binding read holds the queue and is retried, never settled as an empty merge list", async (t) => {
  // The kernel is briefly unavailable while an already-merged PR has no row. The failed read must not become "no binding": the
  // queue waits a poll and asks again, and only then settles with the evidence the record holds.
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-bound-retry-"));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha } };
  let reads = 0;
  // The first work read fails the way an unavailable kernel does: the request is refused (its socket reset), not answered.
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs, cacheDir,
    kernelBefore: (req) => (req.method === "GET" && /^\/v1\/work\?task=/.test(req.url) && ++reads === 1 ? "reset" : undefined),
    kernelReply: (m, url) => (m === "GET" && url === "/v1/work?task=tsk_0000000000000w9" ? { status: "open", records: [{ kind: "github.push", state: "done", args: { only: [{ repo: "acme-agents/widget", sha: HEAD }] } }] } : undefined),
  });
  await merge("k-00000000000000d9", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(outcomes.length, 0, "a failed binding read must not settle the queue");
  await handle.stepMerges();
  await settle();
  assert.equal(reads, 2, "the first read failed, the second answered");
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the retried read kept the merge as evidence");
});

test("a record filed after the first poll is credited when the external merge is seen", async (t) => {
  // The PR is open at the first poll (no row, no record yet), so nothing is settled. The task files its pr record while CI is
  // still running, and the owner merges: the poll that sees the merge reads the record and credits it. A negative answer is never
  // cached, so an earlier miss cannot hide a record filed later for the same head.
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-late-bound-"));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING" } };
  let filed = false;
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs, cacheDir,
    kernelReply: (m, url) => (m === "GET" && url === "/v1/work?task=tsk_0000000000000w9"
      ? { status: "open", records: filed ? [{ kind: "github.pr", state: "failed", args: { only: [{ repo: "acme-agents/widget", sha: HEAD }] } }] : [] }
      : undefined),
  });
  await merge("k-00000000000000da", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(outcomes.length, 0, "still open: no outcome");
  filed = true;
  prs["acme-agents/widget"] = { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha };
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the record filed after the first poll is credited");
});

test("a task-read failure holds the merge instead of landing it, and it lands once the read answers", async (t) => {
  // The queue checks the task is still live right before it sends the merge, so a cancelled task's approved merge never lands
  // (its PR is left for a successor). A read that fails cannot tell live from cancelled: the merge waits, and never guesses.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  let reads = 0, down = true;
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs,
    kernelReply: (m, url) => (m === "GET" && /^\/v1\/work\?task=/.test(url) ? (reads++, down ? { __status: 503 } : { status: "in_progress", records: [] }) : undefined),
  });
  await merge("k-00000000000000dc", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  assert.equal(reads, 1, "the status is read before the merge is sent");
  assert.equal(outcomes.length, 0, "an unreadable task holds the merge rather than landing it");
  assert.equal(prs["acme-agents/widget"].state, undefined, "nothing was sent");
  down = false;
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")).map((p) => [p.head, typeof p.sha]), [[HEAD, "string"]]);
});

test("a cancelled task's approved merge never lands: the PR is left for its successor", async (t) => {
  // An approval can be waiting when its task is cancelled and a successor is assigned. The PR watch never closes that PR, and the
  // queue must not merge it either: landing it would take the handoff from the successor.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs,
    kernelReply: (m, url) => (m === "GET" && /^\/v1\/work\?task=/.test(url) ? { status: "cancelled", records: [] } : undefined),
  });
  await merge("k-00000000000000de", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(prs["acme-agents/widget"].state, undefined, "no merge was sent");
  assert.equal(outcomes[0]?.ok, false, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /cancelled/);
});

test("a merge card for a PR that changed owners does not merge the successor's PR", async (t) => {
  // A done task's PR is handed to a successor, which records itself in pr-tasks.json. A merge approved for the earlier owner must
  // not land on the successor's PR: its card was read against the earlier owner's work, and merging would finish it for them.
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-owner-moved-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-11", branch: "agent/WOR-9/feature" } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const { handle, outcomes, merge, settle } = await setup(t, { prs, cacheDir });
  await merge("k-00000000000000df", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(prs["acme-agents/widget"].state, undefined, "no merge was sent");
  assert.equal(outcomes[0]?.ok, false, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /now belongs to WOR-11, not WOR-9: this merge was approved for the earlier owner/);
});

test("a merge a module filed under its owner's task id lands: pr-tasks.json's identifier is resolved to that task's id", async (t) => {
  // Ship files a task-owned PR's merge on the task's id (a module's record has no identifier); pr-tasks.json names the identifier.
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-owner-id-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "agent/WOR-9/feature" } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs, cacheDir,
    // The kernel's real answer: /v1/work?task= takes the id or the identifier, and its jobs carry the task's id (not its identifier).
    kernelReply: (m, url) => (m === "GET" && /^\/v1\/work\?task=(tsk_0000000000000w9|WOR-9)$/.test(url) ? { status: "in_progress", jobs: [{ id: "j1", task: "tsk_0000000000000w9", state: "done" }], records: [] } : undefined),
  });
  await merge("k-00000000000000e1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }], "tsk_0000000000000w9", "");
  await handle.stepMerges();
  await settle();
  assert.equal(prs["acme-agents/widget"].state, "MERGED", JSON.stringify(outcomes));
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
    checks: (m, url) => (m === "GET" && url === "/v1/work?record=k-00000000000000c0" ? { id: "k-00000000000000c0", task: "tsk_0000000000000w9", identifier: "WOR-9", identifier_pending: false } : undefined),
  });
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the upgraded queue found the identifier and kept the evidence");
});

test("a queue across a kernel upgrade waits for the identifier the reconcile is about to record", async (t) => {
  // The queue was claimed when the kernel went down, so the restart leaves it running (never handed execute again), and its first
  // read is answered before the kernel's own upgrade reconcile has filled the record's identifier in: a null answer at that point
  // is "not yet", not "this record has none". The next poll sees what reconcile recorded, and the merged PR is still credited.
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-upgrade-null-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  mkdirSync(join(cacheDir, "merges"), { recursive: true });
  writeFileSync(join(cacheDir, "merges", "merges.json"), JSON.stringify({ queues: { "k-00000000000000c0": {
    id: "k-00000000000000c0", state: "running", startedAt: new Date().toISOString(), said: [], task: "tsk_0000000000000w9",
    prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD, url: "https://github.com/acme-agents/widget/pull/1", status: "pending" }],
  } } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha } };
  let reads = 0;
  const { handle, outcomes, settle } = await setup(t, {
    prs, cacheDir,
    // Before the kernel's reconcile has recorded it the record has none and is pending; after, it is WOR-9.
    checks: (m, url) => (m === "GET" && url === "/v1/work?record=k-00000000000000c0" ? (++reads === 1 ? { id: "k-00000000000000c0", task: "tsk_0000000000000w9", identifier: null, identifier_pending: true } : { id: "k-00000000000000c0", task: "tsk_0000000000000w9", identifier: "WOR-9", identifier_pending: false }) : undefined),
  });
  await handle.stepMerges();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(outcomes.length, 0, "a null identifier is not yet the record's answer on the first poll");
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the identifier reconcile recorded kept the evidence");
});

test("a PR whose row names the identifier the kernel is still reading waits instead of looking like another task's", async (t) => {
  // A module's record carries the task's UUID, and pr-tasks.json names the identifier. While the record has no identifier yet and
  // none has been read (the kernel's upgrade reconcile is about to fill it in), a row that doesn't match the bare UUID is not
  // proof of another owner: the merge waits, because a fail could never be undone (only a pending PR is polled again).
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-pending-owner-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  let reads = 0;
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs, cacheDir,
    checks: (m, url) => (m === "GET" && url === "/v1/work?record=k-00000000000000c0" ? (++reads === 1 ? { id: "k-00000000000000c0", task: "tsk_0000000000000w9", identifier: null, identifier_pending: true } : { id: "k-00000000000000c0", task: "tsk_0000000000000w9", identifier: "WOR-9", identifier_pending: false }) : undefined),
  });
  await merge("k-00000000000000c0", [{ repo: "acme-agents/widget", number: 1, head: HEAD }], "tsk_0000000000000w9", "");
  await handle.stepMerges();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(outcomes.length, 0, "the merge waits for the identifier, it does not fail as another task's");
  assert.equal(prs["acme-agents/widget"].state, undefined, "nothing was merged on a comparison the identifier was missing from");
  await handle.stepMerges();
  await settle();
  assert.equal(prs["acme-agents/widget"].state, "MERGED", JSON.stringify(outcomes));
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
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

test("a direct merge is GitHub's async merge: a pending 202 is polled to merged (a PR in a stack included), and its merge commit is the one reported", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const reports = [], sent = [];
  const gh = async (m, p, b) => {
    if (m === "PUT" && String(p).endsWith("/merge-async")) { sent.push(b); return { status: 202, body: { status: "pending", details: { uuid: "u-1" } } }; }
    // The request settles: the fake merges the PR, and the poll reads the merge commit.
    if (m === "GET" && String(p).endsWith("/merge-async/u-1")) return { status: 200, body: (await github.gh("PUT", "/repos/acme-agents/widget/pulls/1/merge-async", sent[0])).body };
    return github.gh(m, p, b);
  };
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-async-")), gh, fleetOrg: "acme-agents", asyncPollMs: 0,
    reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  void merges.enqueue("k-00000000000000cc", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].merge_action, "direct_merge");
  assert.equal(sent[0].sha, HEAD);
  assert.equal(reports[0]?.ok, true, JSON.stringify(reports));
  assert.deepEqual(reports[0].objects, ["github:acme-agents/widget@cccccccccccccccccccccccccccccccccccccccc"]);
});

test("a direct merge request that outlives the poll window is read to its end on the next passes, never asked for again", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const reports = [];
  let puts = 0, reads = 0;
  const gh = async (m, p, b) => {
    if (m === "PUT" && String(p).endsWith("/merge-async")) { puts++; return { status: 202, body: { status: "pending", details: { uuid: "u-slow" } } }; }
    if (m === "GET" && String(p).endsWith("/merge-async/u-slow")) return { status: 200, body: ++reads < 3 ? { status: "pending", details: {} } : { status: "failed", details: { message: "Merge conflict" } } };
    return github.gh(m, p, b);
  };
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-slow-")), gh, fleetOrg: "acme-agents", asyncPolls: 1, asyncPollMs: 0,
    reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  void merges.enqueue("k-00000000000000cd", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step();
  await merges.step();
  assert.equal(puts, 1, "the request outlived the poll window: the next pass reads it, never PUTs again");
  // Its terminal `failed` is the ordinary refusal: one bounded retry (a new request), then the end, in GitHub's words.
  for (let i = 0; i < 6 && !reports.length; i++) { await merges.step(); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(reports[0]?.ok, false);
  assert.match(reports[0].text, /Merge conflict/);
});

test("a 409 refusal of a direct merge ends the record in GitHub's words, never an endless wait", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const reports = [];
  let puts = 0;
  const gh = async (m, p, b) => {
    if (m === "PUT" && String(p).endsWith("/merge-async")) { puts++; return { status: 409, body: { message: "Pull request is not mergeable: required status check is failing" } }; }
    return github.gh(m, p, b);
  };
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-409-")), gh, fleetOrg: "acme-agents", asyncPollMs: 0,
    reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  void merges.enqueue("k-00000000000000ce", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  for (let i = 0; i < 6 && !reports.length; i++) { await merges.step(); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(reports[0]?.ok, false, JSON.stringify(reports));
  assert.match(reports[0].text, /GitHub refused the merge: .*required status check/);
  assert.ok(puts <= 2, `bounded: ${puts} PUTs`);
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
    if (m === "PUT" && String(p).endsWith("/merge-async")) {
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

test("a refusal with no earlier unanswered attempt is still a failure, and a refused head is never PUT again", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const reports = [];
  let puts = 0;
  const gh = async (m, p, b) => {
    if (m === "PUT" && String(p).endsWith("/merge-async")) { puts += 1; throw Object.assign(new Error("HTTP 405: Pull request is not mergeable"), { status: 405 }); }
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
  // Still the task's own record at the bound head, whoever merged it.
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

test("a maximum-size mixed batch keeps the whole evidence line: the queue's merges and linked already-merged PRs, whole JSON under the kernel's cap", async (t) => {
  // The merged-prs reader takes the outcome's first line, and 30 PRs on a long repo name run past the kernel's old 4,000-character cap
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
  // The reader's contract (tasks-mcp mergedEvidence), pinned here without importing it: 40 hex either side.
  const SLUG = /^[\w.-]+\/[\w.-]+$/, SHA = /^[0-9a-f]{40}$/;
  assert.ok(kept.every((p) => SLUG.test(p.repo) && Number.isInteger(p.number) && SHA.test(p.head) && SHA.test(p.sha)), "every row is one the reader keeps");
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

test("a red default branch takes no merge on top, except the PR that already holds its tip; running base CI waits only for a PR behind it", () => {
  const data = (base, behindBy) => ({ repository: { defaultBranchRef: { name: "main" }, pullRequest: {
    number: 1, state: "OPEN", isDraft: false, baseRefName: "main", headRefOid: HEAD, mergeStateStatus: "CLEAN", latestOpinionatedReviews: { nodes: [] },
    files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "lib/x.mjs" }] }, commits: { nodes: [{ commit: { statusCheckRollup: rollup("SUCCESS") } }] },
    baseRef: { compare: { behindBy }, target: { oid: "b".repeat(40), statusCheckRollup: base } },
  } } });
  assert.deepEqual(decide(data(rollup("FAILURE"), 2), HEAD), { do: "wait", why: "`main` is red at `bbbbbbbbbbbb`: merged once it is green again" });
  assert.deepEqual(decide(data(rollup("FAILURE"), 0), HEAD), { do: "merge" }, "the fix for a red base lands");
  assert.equal(decide(data(rollup("PENDING"), 2), HEAD).do, "wait");
  assert.deepEqual(decide(data(rollup("PENDING"), 0), HEAD), { do: "merge" }, "at the tip, its own green checks proved the tree");
  assert.deepEqual(decide(data(rollup("CANCELLED", { names: ["build", "ci-required"] }), 2), HEAD), { do: "merge" }, "a cancelled run never judged the base");
  assert.deepEqual(decide(data(rollup("SUCCESS"), 2), HEAD), { do: "merge" });
  assert.deepEqual(decide(data(rollup("SUCCESS", { names: [] }), 2), HEAD), { do: "merge" }, "a base whose CI runs on PRs only");
  // The base tip is judged by each name's newest run too (baseCi): a cancelled run an edit superseded is not the tip's verdict,
  // while a later red or running run of that name still holds it.
  assert.deepEqual(decide(data(rollup("SUCCESS", { runs: [{ name: "ci-required", state: "CANCELLED", rank: 1 }, { name: "ci-required", state: "SUCCESS", rank: 2 }] }), 2), HEAD), { do: "merge" },
    "a base whose cancelled run was superseded by a green one is green");
  assert.deepEqual(decide(data(rollup("SUCCESS", { runs: [{ name: "build", state: "CANCELLED", rank: 1 }, { name: "build", state: "FAILURE", rank: 2 }] }), 2), HEAD), { do: "wait", why: "`main` is red at `bbbbbbbbbbbb`: merged once it is green again" },
    "a base whose cancelled run was superseded by a red one is red");
  assert.equal(decide(data(rollup("SUCCESS", { runs: [{ name: "build", state: "CANCELLED", rank: 1 }, { name: "build", state: "PENDING", rank: 2 }] }), 2), HEAD).do, "wait",
    "a base whose cancelled run was superseded by a running one waits");
  // Only a cancelled check is no verdict: an unrelated cancelled run never masks a gate or a job that completed red at the tip.
  assert.deepEqual(decide(data(rollup("SUCCESS", { runs: [{ name: "deploy", state: "CANCELLED", rank: 1 }, { name: "ci-required", state: "FAILURE", rank: 2 }] }), 2), HEAD), { do: "wait", why: "`main` is red at `bbbbbbbbbbbb`: merged once it is green again" },
    "an unrelated cancellation does not mask a failed base gate");
  assert.deepEqual(decide(data(rollup("SUCCESS", { runs: [{ name: "build", state: "CANCELLED", rank: 1 }, { name: "lint", state: "FAILURE", rank: 2 }] }), 2), HEAD), { do: "wait", why: "`main` is red at `bbbbbbbbbbbb`: merged once it is green again" },
    "a failing job is red even beside a cancelled one");
  // A truncated base list proves nothing about the tip: a red past the first page must never read as a green base.
  assert.equal(decide(data(rollup("SUCCESS", { more: true }), 2), HEAD).do, "wait", "a base whose check list GitHub truncated waits, never merges on a partial read");
});

test("a PR carrying the ship:stop label waits, for the merge queue and for ship's rounds alike", () => {
  const data = (labels) => ({ repository: { defaultBranchRef: { name: "main" }, pullRequest: {
    number: 1, state: "OPEN", isDraft: false, baseRefName: "main", headRefOid: HEAD, mergeStateStatus: "CLEAN", latestOpinionatedReviews: { nodes: [] },
    labels: { nodes: labels.map((name) => ({ name })) },
    files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "lib/x.mjs" }] }, commits: { nodes: [{ commit: { statusCheckRollup: rollup("SUCCESS") } }] },
    baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40), statusCheckRollup: rollup("SUCCESS") } },
  } } });
  assert.deepEqual(decide(data(["bug"]), HEAD), { do: "merge" });
  assert.equal(decide(data(["bug", "ship:stop"]), HEAD).do, "wait");
  assert.equal(decide(data(["ship:stop"]), HEAD, { queue: false, approve: false, required: ["build"], checks: [] }).do, "wait");
});

test("each check name on a head is judged by its newest run: a cancelled run an edit superseded is not red, and a later red or running one still holds", () => {
  // An edit to a PR body/title while CI runs starts a new run that cancels the old one (ci.yml `edited` +
  // `cancel-in-progress`); the superseded run's CANCELLED checks stay on the head forever. GitHub's branch protection judges a
  // required name by its latest run at the head, and so must the gate: by `databaseId`, never by the order the rollup lists.
  const data = (head) => ({ repository: { defaultBranchRef: { name: "main" }, pullRequest: {
    number: 1, state: "OPEN", isDraft: false, baseRefName: "main", headRefOid: HEAD, mergeStateStatus: "CLEAN", latestOpinionatedReviews: { nodes: [] },
    files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "lib/x.mjs" }] }, commits: { nodes: [{ commit: { statusCheckRollup: head } }] },
    baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40), statusCheckRollup: rollup("SUCCESS") } },
  } } });
  const at = (...runs) => data(rollup("SUCCESS", { runs }));
  assert.deepEqual(decide(at({ name: "build", state: "CANCELLED", rank: 1 }, { name: "build", state: "SUCCESS", rank: 2 }), HEAD), { do: "merge" },
    "a cancelled run followed by a successful run of the same name merges");
  assert.deepEqual(decide(at({ name: "build", state: "SUCCESS", rank: 2 }, { name: "build", state: "CANCELLED", rank: 1 }), HEAD), { do: "merge" },
    "the same, whichever order the rollup lists them in");
  assert.equal(decide(at({ name: "build", state: "SUCCESS", rank: 1 }, { name: "build", state: "FAILURE", rank: 2 }), HEAD).do, "fail",
    "a successful run followed by a failed run does not merge");
  assert.equal(decide(at({ name: "build", state: "FAILURE", rank: 2 }, { name: "build", state: "SUCCESS", rank: 1 }), HEAD).do, "fail",
    "an older pass never hides a later red run");
  assert.deepEqual(decide(at({ name: "build", state: "SUCCESS", rank: 1 }, { name: "build", state: "PENDING", rank: 2 }), HEAD), { do: "wait", why: "checks are still running on its head" },
    "a successful run followed by a pending run waits");
  const cancelledOnly = decide(at({ name: "build", state: "CANCELLED", rank: 1 }), HEAD);
  assert.equal(cancelledOnly.do, "fail", "a name whose only run at the head was cancelled does not pass");
  assert.match(cancelledOnly.why, /1 check\(s\) failed on its head/, "and it is red, never left pending forever");
  assert.equal(decide(at({ name: "build", state: "CANCELLED", rank: 1 }, { name: "lint", state: "SUCCESS", rank: 2 }), HEAD).do, "fail",
    "one name's cancelled run is not rescued by another name's green one");
});

test("ship's judged path applies the same newest-run rule to the required checks", () => {
  const H = "a".repeat(40);
  const data = (head) => ({ repository: { defaultBranchRef: { name: "main" }, pullRequest: {
    state: "OPEN", headRefOid: H, baseRefName: "main", mergeStateStatus: "CLEAN", reviewDecision: null, isDraft: false, isInMergeQueue: false,
    commits: { nodes: [{ commit: { statusCheckRollup: head } }] }, baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40) } }, latestOpinionatedReviews: { nodes: [] },
  } } });
  const ctx = (checks) => ({ queue: false, approve: false, required: ["build"], checks });
  const status = (s) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s) ? { ok: true, success: s === "SUCCESS", pending: false } : s === "CANCELLED" || s === "FAILURE" ? { ok: false, success: false, pending: false } : { ok: false, success: false, pending: true };
  const run = (state, rank) => ({ name: "build", kind: "run", rank, ...status(state) });
  assert.equal(decide(data(rollup("SUCCESS")), H, ctx([run("CANCELLED", 1), run("SUCCESS", 2)])).do, "merge", "cancelled then green: ship merges");
  assert.equal(decide(data(rollup("SUCCESS")), H, ctx([run("SUCCESS", 1), run("FAILURE", 2)])).do, "fix_ci", "green then red: ship fixes CI");
  assert.deepEqual(decide(data(rollup("SUCCESS")), H, ctx([run("SUCCESS", 1), run("PENDING", 2)])), { do: "wait", why: "required checks are still running on its head" }, "green then pending: ship waits");
  assert.equal(decide(data(rollup("SUCCESS")), H, ctx([run("CANCELLED", 1)])).do, "fix_ci", "a required name whose only run was cancelled does not pass");
});

test("a skipped or cancelled aggregate is no verdict: ship reads the run that judged the head, never a skip as a pass", () => {
  const H = "a".repeat(40);
  const data = () => ({ repository: { defaultBranchRef: { name: "main" }, pullRequest: {
    state: "OPEN", headRefOid: H, baseRefName: "main", mergeStateStatus: "CLEAN", reviewDecision: null, isDraft: false, isInMergeQueue: false,
    commits: { nodes: [{ commit: { statusCheckRollup: {} } }] }, baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40) } }, latestOpinionatedReviews: { nodes: [] },
  } } });
  // The shape service.ts checksAt / merges.ts allChecks produce for a required check: `status` is GitHub's conclusion exactly.
  const gate = (state, rank, name = "ci-required") => {
    const s = String(state).toUpperCase();
    return { name, kind: "run", rank, status: s, skipped: s === "SKIPPED", ok: ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s), success: s === "SUCCESS", pending: false };
  };
  const ctx = (checks) => ({ queue: false, approve: false, required: ["ci-required"], checks });
  // The masking case: a genuine failure, then a body edit whose skipped aggregate sits newest at the same head.
  assert.deepEqual(decide(data(), H, ctx([gate("FAILURE", 1), gate("SKIPPED", 2)])), { do: "fix_ci", why: "1 required check(s) failed on its head" },
    "skipped over failure is still the failure, never a pass");
  // Only a skipped aggregate at the head judged nothing: wait for the run that replaces it, never merge on it.
  assert.deepEqual(decide(data(), H, ctx([gate("SKIPPED", 5)])), { do: "wait", why: "the aggregate that judged its head was superseded; waiting for the run that replaces it (`ci-required`)" });
  // A cancelled aggregate is no verdict either: GitHub reports `cancelled` for a job an in-flight run cancelled before it started.
  assert.deepEqual(decide(data(), H, ctx([gate("CANCELLED", 6)])), { do: "wait", why: "the aggregate that judged its head was superseded; waiting for the run that replaces it (`ci-required`)" },
    "a cancelled gate waits, so a superseded run posts no false red and no false green");
  // Unchanged from #1812: a newest green over an older cancelled run merges.
  assert.equal(decide(data(), H, ctx([gate("CANCELLED", 1), gate("SUCCESS", 2)])).do, "merge");
  // A suite's own skipped result is legitimate (the change didn't touch it): only the gate's skip is no verdict.
  assert.equal(decide(data(), H, { queue: false, approve: false, required: ["packages (2)"], checks: [gate("SKIPPED", 3, "packages (2)"), gate("SUCCESS", 4)] }).do, "merge",
    "a skipped suite is a pass, as before");
});

test("an edit that skipped every job never turns a red head green, and an invalid edited title still blocks", () => {
  // The shape an `edited` run posts (ci.yml): the run plans no suite, so `checks` and `ci-required` are skipped and every suite
  // is skipped with them, all newer than the run that tested the head. GitHub counts a skipped check as a pass; this gate must
  // not, or a body edit after a real failure would make the head mergeable (Aiden-HQ/AidenHQ#1935 follow-up).
  const H = "a".repeat(40);
  const run = (name, state, rank) => ({ name, kind: "run", rank, status: state, ok: ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(state), success: state === "SUCCESS", pending: state === "PENDING" });
  const data = (runs) => ({ repository: { defaultBranchRef: { name: "main" }, pullRequest: {
    number: 1, state: "OPEN", headRefOid: H, baseRefName: "main", mergeStateStatus: "CLEAN", reviewDecision: null, isDraft: false, isInMergeQueue: false,
    labels: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "lib/x.mjs" }] },
    commits: { nodes: [{ commit: { statusCheckRollup: rollup(runs.at(-1)?.status ?? "SKIPPED", { runs: runs.map((r) => ({ name: r.name, state: r.status, rank: r.rank })) }) } }] },
    baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40), statusCheckRollup: rollup("SUCCESS", { names: ["ci-required"] }) } },
  } } });
  const ship = (runs) => ({ queue: false, approve: false, required: ["ci-required"], checks: runs });
  // The brief's reproduction: a `skipped` `ci-required` over an older `failure` of the same name. Before this change `decide`
  // read the newest run, the skip, as a pass and returned `merge`; a red head must stay red after an edit.
  const failedThenEdit = [run("ci-required", "FAILURE", 2), run("ci-required", "SKIPPED", 3)];
  assert.equal(decide(data(failedThenEdit), H).do, "fail", "the merge queue reads the real failure, never the edit's skip");
  assert.deepEqual(decide(data(failedThenEdit), H, ship(failedThenEdit)), { do: "fix_ci", why: "1 required check(s) failed on its head" },
    "ship reads the real failure, never the edit's skip");
  // A genuinely failed suite, then a body edit: still a fix, not a merge (the edit skipped that suite's own check too).
  const failedSuite = [run("packages (2)", "FAILURE", 1), run("ci-required", "FAILURE", 2), run("ci-required", "SKIPPED", 3), run("packages (2)", "SKIPPED", 4)];
  assert.equal(decide(data(failedSuite), H).do, "fail");
  assert.equal(decide(data(failedSuite), H, ship(failedSuite)).do, "fix_ci");
  // A green head, then an edit to an invalid title: the edit's `policy` run is the newest title check and it is red, so the
  // head is no pass even though the aggregate that would roll it up was skipped.
  const badTitle = [run("ci-required", "SUCCESS", 1), run("policy", "SUCCESS", 2), run("policy", "FAILURE", 3), run("ci-required", "SKIPPED", 4)];
  assert.equal(decide(data(badTitle), H).do, "fail", "an invalid edited title blocks the merge queue");
  assert.equal(decide(data(badTitle), H, ship(badTitle)).do, "fix_ci", "and blocks ship, with the title fix");
  // A green head, then a body edit that changed nothing about the code: still a merge.
  const cleanEdit = [run("ci-required", "SUCCESS", 1), run("policy", "SUCCESS", 2), run("ci-required", "SKIPPED", 3), run("policy", "SKIPPED", 4)];
  assert.deepEqual(decide(data(cleanEdit), H), { do: "merge" });
  assert.equal(decide(data(cleanEdit), H, ship(cleanEdit)).do, "merge");
  // The title check the edit re-ran is still running: wait, never merge on a check in flight.
  const titleRunning = [run("ci-required", "SUCCESS", 1), run("policy", "PENDING", 3), run("ci-required", "SKIPPED", 4)];
  assert.equal(decide(data(titleRunning), H).do, "wait");
  assert.equal(decide(data(titleRunning), H, ship(titleRunning)).do, "wait");
  // A suite skipped by the run that tested the head is still a pass: only a newer edit's skips are dropped.
  const suiteSkipped = [run("modules (1)", "SKIPPED", 1), run("ci-required", "SUCCESS", 2)];
  assert.equal(decide(data(suiteSkipped), H).do, "merge");
  // The edit's `ci-required` posts a real verdict, not a skip: the trigger cannot be "the newest gate skipped". Its skipped suite
  // is still newer than the failure that run recorded, and must not become that name's newest result. The gate itself is red,
  // as the workflow posts it when the suite failed, so both paths refuse the head.
  const editWithRealGate = [run("packages (2)", "FAILURE", 1), run("ci-required", "FAILURE", 2), run("packages (2)", "SKIPPED", 3), run("ci-required", "FAILURE", 4)];
  assert.equal(decide(data(editWithRealGate), H).do, "fail", "a newer skip never replaces an older failure of the same name");
  assert.equal(decide(data(editWithRealGate), H, ship(editWithRealGate)).do, "fix_ci");
  // Ship requires only the gate, so a green gate merges past a non-required red: the rule it is owed is that the skip still does
  // not become the suite's newest result, which the queue above reads. The gate alone decides ship.
  const gateGreenSuiteRed = [run("packages (2)", "FAILURE", 1), run("ci-required", "FAILURE", 2), run("packages (2)", "SKIPPED", 3), run("ci-required", "SUCCESS", 4)];
  assert.equal(decide(data(gateGreenSuiteRed), H).do, "fail", "the queue still reads the suite's real failure");
  assert.equal(decide(data(gateGreenSuiteRed), H, ship(gateGreenSuiteRed)).do, "merge", "ship answers to its required names only");
  // The cutoff is a check run's rank, never a commit status's timestamp (contextRank ranks the two differently): a successful
  // `ci-required` status must not lift the cutoff above the edit's skipped runs, or the failure it sits beside would hide.
  const withStatus = [run("ci-required", "FAILURE", 2), run("ci-required", "SKIPPED", 3)];
  const statusRanked = { state: "SKIPPED", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", databaseId: 2, name: "ci-required", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", databaseId: 3, name: "ci-required", status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "StatusContext", context: "ci-required", state: "SUCCESS", createdAt: "2026-01-01T00:00:00Z" },
  ] } };
  const dataWithStatus = data(withStatus);
  dataWithStatus.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup = statusRanked;
  assert.equal(decide(dataWithStatus, H).do, "fail", "a status's timestamp is not a check run's rank");
});

test("a listed repo merges as the owner; once it leaves the listed repos its approved merge is refused at queue time", async () => {
  const prs = { "globex/payments": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const dir = mkdtempSync(join(tmpdir(), "merges-"));
  const reports = [];
  const queue = (listed) => createMerges({
    dir, gh: github.gh, fleetOrg: "acme-agents", productRepo: "acme/aidenhq", listed,
    reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const listed = queue(["Globex/Payments"]);
  void listed.enqueue("k-00000000000000f1", { prs: [{ repo: "globex/payments", number: 1, head: HEAD }] });
  await listed.step();
  await tick();
  assert.deepEqual(github.merges().map((w) => [w.path, w.body.sha]), [["/repos/globex/payments/pulls/1/merge-async", HEAD]]);
  assert.equal(listed.status("k-00000000000000f1").state, "done");

  // Approved while listed, then the owner took the repo off the list (the service restarts with the new setting).
  prs["globex/payments"] = { head: HEAD, checks: "SUCCESS" };
  void listed.enqueue("k-00000000000000f2", { prs: [{ repo: "globex/payments", number: 2, head: HEAD }] });
  const unlisted = queue([]);
  await unlisted.step();
  await tick();
  assert.equal(github.merges().length, 1, "not merged");
  assert.equal(unlisted.status("k-00000000000000f2").state, "failed");
  assert.match(reports.find((r) => r.id === "k-00000000000000f2").text, /outside the fleet org, the product repo and the listed repos/);
});

test("merge queue waits while disconnected", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const facts = [];
  const connected = { on: false };
  const { handle, github, merge, settle, outcomes, waits } = await setup(t, { prs, connected, checks: (m, u, b) => (u === "/v1/facts" ? (facts.push(...b.facts), { recorded: b.facts.length }) : undefined) });
  await merge("k-00000000000000b9", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await handle.flushFacts();
  assert.deepEqual(github.merges(), [], "nothing merges while GitHub is signed out");
  assert.deepEqual(facts.filter((f) => f.type === "work.waiting").map((f) => [f.subject, f.data.reason]), [["pr:acme-agents/widget#1", "github"]]);
  // The claimed merge card carries the reconnect reason too, not only the queue's own fact: otherwise it reads as a card running
  // with no reason at all. The card is the record's, so the reason is the record's: what it waits on, not a line per PR.
  assert.deepEqual(waits.map((w) => [w.id, w.reason]), [["k-00000000000000b9", "GitHub is signed out: waiting for the owner to reconnect it"]]);
  // Another pass while still signed out posts nothing new (the kernel deduplicates, and the queue does not poll it).
  await handle.stepMerges();
  assert.equal(waits.length, 1, "the same reason is not re-posted every poll");
  connected.on = true;
  await handle.stepMerges();
  assert.equal(github.merges().length, 1, "merged once connected again");
  await settle();
  await handle.flushFacts();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(facts.filter((f) => f.type === "work.resumed").map((f) => f.data.reason), ["github"]);
});

test("a code review wait posts its reason to the kernel once per distinct reason, never per poll, and keeps its no-time-limit wait", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  let verdict = { status: 200, body: { verdict: "wait", reasons: [{ code: "running", text: "the review is running", unblock: "it resumes by itself" }] } };
  const fetchFn = async () => new Response(JSON.stringify(verdict.body), { status: verdict.status });
  const waits = [];
  const clock = { t: Date.now() };
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-")), gh: github.gh, fleetOrg: "acme-agents", now: () => new Date(clock.t),
    evalGate: async () => undefined, report: async () => {}, waiting: async (id, reason) => void waits.push({ id, reason }),
    reviewGate: createReviewGate({ gated: ["Acme-Agents/Widget"], url: "http://code-review:8098", key: () => "github-module-token", fetchFn }),
  });
  void merges.enqueue("k-00000000000000h1", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step();
  await merges.step();
  await merges.step();
  assert.deepEqual(waits.map((w) => w.reason), ["code review: the review is running (it resumes by itself)"], "once per distinct reason, not per poll");
  assert.equal(merges.status("k-00000000000000h1").state, "running");
  // A week later the same reason: still no second post, and the gate's Infinity limit never stops the wait.
  clock.t += 7 * 24 * 3600_000;
  await merges.step();
  assert.equal(waits.length, 1);
  assert.equal(merges.status("k-00000000000000h1").state, "running");
  // A materially changed reason is posted once more.
  verdict = { status: 200, body: { verdict: "wait", reasons: [{ code: "classifying", text: "the risk tier of deadbee isn't read yet", unblock: "it resumes by itself within a minute or two" }] } };
  await merges.step();
  await merges.step();
  assert.deepEqual(waits.map((w) => w.reason), [
    "code review: the review is running (it resumes by itself)",
    "code review: the risk tier of deadbee isn't read yet (it resumes by itself within a minute or two)",
  ]);
  assert.equal(github.merges().length, 0, "never merged while the gate waits");
  verdict = { status: 200, body: { verdict: "pass", reasons: [] } };
  await merges.step();
  assert.deepEqual(github.merges().map((w) => w.body.sha), [HEAD]);
  assert.deepEqual(waits.map((w) => w.id), ["k-00000000000000h1", "k-00000000000000h1", "k-00000000000000h1"]);
  // The wait ended (review passed): the record's reason is cleared, so no stale "code review: …" sits on a merging record.
  assert.equal(waits.at(-1).reason, null);
});

test("a PR left unpolled behind another of its repository is never published as a wait of its own", async (t) => {
  // One merge per repository per poll: the second PR of the repo is skipped this pass and has no reason of its own, so nothing
  // about it reaches the kernel (it merges on the next poll, with no blocker in between).
  const prs = { "acme-agents/widget#1": { head: HEAD, checks: "SUCCESS" }, "acme-agents/widget#2": { head: HEAD, checks: "SUCCESS" } };
  const { handle, github, outcomes, waits, merge, settle } = await setup(t, { prs });
  await merge("k-00000000000000d1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }, { repo: "acme-agents/widget", number: 2, head: HEAD }]);
  await handle.stepMerges();
  assert.deepEqual(github.merges().map((w) => w.path), ["/repos/acme-agents/widget/pulls/1/merge-async"], "the first PR merged, the second waited its turn");
  assert.deepEqual(waits.map((w) => w.reason), [], "the second PR has no reason, so no wait is published for it");
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(github.merges().map((w) => w.path), ["/repos/acme-agents/widget/pulls/1/merge-async", "/repos/acme-agents/widget/pulls/2/merge-async"]);
});

test("a repo code review gates merges only on its pass for the bound head; wait (unreachable too) keeps the merge queued with no time limit; other repos never ask", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" }, "acme-agents/other": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const asked = [];
  let answer = { status: 200, body: { verdict: "wait", reasons: [{ code: "running", text: "the review is running", unblock: "it resumes by itself" }] } };
  const fetchFn = async (url, init) => {
    asked.push([String(url), init.headers.authorization]);
    if (answer === "down") throw new Error("connect ECONNREFUSED");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const clock = { t: Date.now() };
  const logs = [];
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-")), gh: github.gh, fleetOrg: "acme-agents", now: () => new Date(clock.t),
    report: async () => {}, log: (msg, f) => logs.push([msg, f]),
    flow: { checksCompleted: () => {}, waiting: () => {}, resumed: () => {}, merged: () => {} },
    reviewGate: createReviewGate({ gated: ["Acme-Agents/Widget"], url: "http://code-review:8098", key: () => "github-module-token", fetchFn }),
  });
  void merges.enqueue("k-00000000000000g1", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  void merges.enqueue("k-00000000000000g2", { prs: [{ repo: "acme-agents/other", number: 2, head: HEAD }] });
  await merges.step();
  assert.deepEqual(asked, [[`http://code-review:8098/v1/verdict?repo=acme-agents%2Fwidget&pr=1&head=${HEAD}&base=main`, "Bearer github-module-token"]], "only the gated repo asks, with its live base branch");
  assert.deepEqual(github.merges().map((w) => w.path), ["/repos/acme-agents/other/pulls/2/merge-async"]);
  assert.match(logs.find(([m]) => m === "merge waits for code review")[1].why, /the review is running \(it resumes by itself\)/);
  clock.t += 7 * 24 * 3600_000; // a week of waiting on the review: still waiting
  await merges.step();
  assert.equal(merges.status("k-00000000000000g1").state, "running");
  answer = "down"; // the service goes down: a wait for as long as it lasts, never a merge without its verdict
  for (let i = 0; i < 24 * 120; i++) { clock.t += 30_000; await merges.step(); }
  assert.deepEqual(github.merges().map((w) => w.path), ["/repos/acme-agents/other/pulls/2/merge-async"], "a day unreachable: still not merged");
  assert.equal(merges.status("k-00000000000000g1").state, "running");
  assert.match(logs.filter(([m]) => m === "merge waits for code review").at(-1)[1].why, /code review can't be reached: the merge waits until it answers/);
  answer = { status: 200, body: { verdict: "pass" } };
  await merges.step();
  assert.deepEqual(github.merges().map((w) => [w.path, w.body.sha]), [["/repos/acme-agents/other/pulls/2/merge-async", HEAD], ["/repos/acme-agents/widget/pulls/1/merge-async", HEAD]], "merged once code review passes it");
});

test("a review reason is cleared when another gate takes the PR over, not only when the review passes", async () => {
  // The card's reason belongs to the gate that actually holds the merge: a required check rerun on the same head takes the PR
  // over from code review, so "code review: …" must not sit on a card that is now waiting on CI.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const waits = [];
  let review = { wait: "code review: 1 important finding open: t (a.ts:3)" };
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-")), gh: github.gh, fleetOrg: "acme-agents", now: () => new Date(Date.now()),
    report: async () => {}, waiting: async (id, reason) => void waits.push({ id, reason }),
    reviewGate: async () => review,
  });
  void merges.enqueue("k-00000000000000c1", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step();
  assert.deepEqual(waits.map((w) => w.reason), ["code review: 1 important finding open: t (a.ts:3)"]);
  // A required check is rerun on the same head: CI holds the merge now, so the review reason is no longer the record's wait.
  prs["acme-agents/widget"].checks = "PENDING";
  await merges.step();
  assert.equal(waits.at(-1).reason, "checks are still running on its head", "the review reason gives way to the checks' own when they take over");
  assert.equal(merges.status("k-00000000000000c1").state, "running");
  // The checks come back green and the review passes: nothing is republished, nothing stale is left.
  prs["acme-agents/widget"].checks = "SUCCESS";
  review = undefined;
  await merges.step();
  assert.equal(waits.at(-1).reason, null, "no reason is left once nothing waits");
  assert.equal(github.merges().length, 1);
});

test("the record's wait is the whole queue's: one PR leaving its wait never clears another PR's reason", async () => {
  // Both PRs of one merge record wait on code review. The second passes and merges; the first is still blocked, and its reason
  // must stay on the card (it never changes, so it is not republished: the record must not have been cleared for it).
  const prs = {
    "acme-agents/widget": { head: HEAD, checks: "SUCCESS" },
    "acme-agents/gadget": { head: "d".repeat(40), checks: "SUCCESS" },
  };
  const github = fakeGitHub(prs);
  const waits = [];
  const passing = new Set();
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-")), gh: github.gh, fleetOrg: "acme-agents", now: () => new Date(Date.now()),
    report: async () => {}, waiting: async (id, reason) => void waits.push({ id, reason }),
    reviewGate: async (repo) => (passing.has(repo) ? undefined : { wait: `code review: 1 important finding open: ${repo}` }),
  });
  void merges.enqueue("k-00000000000000c2", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }, { repo: "acme-agents/gadget", number: 2, head: "d".repeat(40) }] });
  await merges.step();
  // One record, two waiting PRs: one reason naming both, not whichever PR was polled last.
  const first = waits.at(-1).reason;
  assert.match(first, /acme-agents\/widget/);
  assert.match(first, /acme-agents\/gadget/);
  // The gadget's review passes: it merges, and the widget is still waiting on its own review.
  passing.add("acme-agents/gadget");
  await merges.step();
  await merges.step();
  assert.equal(github.merges().length, 1, "the gadget merged");
  assert.equal(merges.status("k-00000000000000c2").state, "running", "the widget still waits");
  const last = waits.at(-1).reason;
  assert.equal(typeof last, "string", "the widget's reason is still on the record, never cleared by the other PR");
  assert.match(last, /acme-agents\/widget/);
  assert.doesNotMatch(last, /gadget/);
});

test("a wait is recorded only after the kernel takes it: a restart mid-delivery republishes, never assumes it arrived", async () => {
  // The save used to run before the call, so a restart between them left `waitSent` on disk for a reason the kernel never got and
  // every later poll skipped it: a merge blocked indefinitely with no reason on its card. Read the file from inside the delivery —
  // the moment a restart could land — and it must not yet say delivered.
  const dir = mkdtempSync(join(tmpdir(), "merges-"));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const onDisk = [];
  const waits = [];
  let calls = 0;
  const merges = createMerges({
    dir, gh: github.gh, fleetOrg: "acme-agents", now: () => new Date(),
    report: async () => {},
    waiting: async (id, reason) => {
      calls++;
      const q = JSON.parse(readFileSync(join(dir, "merges.json"), "utf8")).queues[id];
      onDisk.push(q.waitSent);
      // The first delivery is a process that dies mid-call: the kernel never got it.
      if (calls === 1) throw new Error("process restarted mid-delivery");
      waits.push({ id, reason });
    },
    reviewGate: async () => ({ wait: "code review: 1 important finding open" }),
  });
  void merges.enqueue("k-00000000000000d2", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step();
  assert.deepEqual(onDisk, [null], "mid-delivery the file says the record has no wait, never that this one was delivered");
  // The restart's next poll sends the same reason again: it was never recorded as delivered.
  await merges.step();
  assert.deepEqual(waits.map((w) => w.reason), ["code review: 1 important finding open"], "a delivery that never landed is retried, not assumed delivered");
  // And once the kernel took it, the file does say so (the next poll stays quiet).
  const after = JSON.parse(readFileSync(join(dir, "merges.json"), "utf8")).queues["k-00000000000000d2"];
  assert.equal(after.waitSent, "code review: 1 important finding open");
  await merges.step();
  assert.equal(waits.length, 1, "once acknowledged, the same reason is not re-posted");
});

test("a PR cut at 100 files is read page by page: non-image files with a skipped image scan merge, an image on a later page does not", async (t) => {
  // Aiden-HQ/AidenHQ#1955: a PR over 100 files is truncated by `files(first: 100)`, and the truncation alone used to read as
  // "changes an image". The gate now reads every page first, so a skip over ordinary files is no image change and an image
  // definition past the first page is caught.
  const plain = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
  const skipped = { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [check("image-scan", "SKIPPED"), check("build", "SUCCESS")] } };
  const runs = [{ name: "image-scan", status: "completed", conclusion: "skipped" }, { name: "build", status: "completed", conclusion: "success" }];
  const files = ["lib/x.mjs"];
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", filePages: [plain, files], rollup: skipped, runs } };
  const { handle, outcomes, merge, settle } = await setup(t, { prs });
  await merge("k-00000000000000f9", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));

  // The same cut list with a Dockerfile on the second page is an image change with a skipped scan: the merge fails for that reason.
  const second = { head: HEAD, checks: "SUCCESS", filePages: [plain, ["deploy/Dockerfile"]], rollup: skipped, runs };
  const other = await setup(t, { prs: { "acme-agents/widget": second } });
  await other.merge("k-00000000000000fa", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await other.handle.stepMerges();
  await other.settle();
  assert.equal(other.outcomes[0]?.ok, false);
  assert.match(String(other.outcomes[0]?.text), /changes an image but its image-scan check was skipped/);
});

test("a PR that only retires a service's Dockerfile merges on a skipped image scan; changing one still blocks", async (t) => {
  // The workflow selects Dockerfiles from the head's tree, so deleting the last one skips the scan for a real reason and no
  // commit could unskip it. Adding or editing one is what the skip cannot cover.
  const skipped = { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [check("image-scan", "SKIPPED"), check("build", "SUCCESS")] } };
  const runs = [{ name: "image-scan", status: "completed", conclusion: "skipped" }, { name: "build", status: "completed", conclusion: "success" }];
  const pr = (changeTypes) => ({ head: HEAD, checks: "SUCCESS", files: ["services/x/Dockerfile"], changeTypes, rollup: skipped, runs });
  const gone = await setup(t, { prs: { "acme-agents/widget": pr({ "services/x/Dockerfile": "DELETED" }) } });
  await gone.merge("k-00000000000000fe", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await gone.handle.stepMerges();
  await gone.settle();
  assert.equal(gone.outcomes[0]?.ok, true, JSON.stringify(gone.outcomes));
  const edited = await setup(t, { prs: { "acme-agents/widget": pr({ "services/x/Dockerfile": "MODIFIED" }) } });
  await edited.merge("k-00000000000000ff", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await edited.handle.stepMerges();
  await edited.settle();
  assert.equal(edited.outcomes[0]?.ok, false);
  assert.match(String(edited.outcomes[0]?.text), /changes an image but its image-scan check was skipped/);
});

test("a file page from a head other than the first read's is no answer: two heads' files are never one list", async (t) => {
  // A push between the first read and the page request: the PR's metadata and checks describe the old head, the page the new
  // one. Reading them as one list could hide a Dockerfile the new head added, so the poll waits and reads again.
  const headMoved = { head: HEAD, checks: "SUCCESS", filePages: [Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`), ["deploy/Dockerfile"]], headAt: "d".repeat(40) };
  const one = await setup(t, { prs: { "acme-agents/widget": headMoved } });
  await one.merge("k-00000000000000fc", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await one.handle.stepMerges();
  assert.equal(one.outcomes.length, 0, "a list spanning two heads is retried, never merged");
  // A base that advanced does the same: GitHub's file list is the diff against the merge base, so a page read after it is
  // another diff than the one whose checks were read.
  const baseMoved = { head: HEAD, checks: "SUCCESS", filePages: [Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`), ["deploy/Dockerfile"]], baseAt: "e".repeat(40) };
  const two = await setup(t, { prs: { "acme-agents/widget": baseMoved } });
  await two.merge("k-00000000000000fd", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await two.handle.stepMerges();
  assert.equal(two.outcomes.length, 0, "a list spanning two base tips is retried, never merged");
});

test("a file page that can't be read throws, so the gate never answers from the pages it happens to have", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", filePages: [Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`), ["deploy/Dockerfile"]] } };
  const github = fakeGitHub(prs);
  // The first read answers the cut page; the page read then fails.
  const gh = async (method, path, body) => (String(body?.query ?? "").includes("after: $after")
    ? { status: 502, body: {} }
    : github.gh(method, path, body));
  const merges = createMerges({ dir: mkdtempSync(join(tmpdir(), "codehost-files-")), gh, fleetOrg: "acme-agents", reviewGate: async () => ({ pass: true }), report: async () => {} });
  void merges.enqueue("k-00000000000000fb", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step();
  assert.deepEqual(github.merges(), [], "a partial file list is never a merge");
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
