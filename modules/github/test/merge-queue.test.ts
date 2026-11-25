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
      if (body.query.includes("pullRequest(number")) {
        // `lag`: GitHub's read still shows the PR open for that many polls (its merge not yet reflected); a repo's allowed
        // methods can change between the PUT and the poll (`squash: false, rebase: true`).
        const stale = (p.lag ?? 0) > 0;
        if (stale) p.lag--;
        return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: p.squash !== false, rebaseMergeAllowed: p.rebase === true, pullRequest: {
          id: "PR_1", number: v.number, url: `https://github.com/${repo}/pull/${v.number}`, state: stale ? "OPEN" : p.state ?? "OPEN", isDraft: false, reviewDecision: p.review ?? null,
          mergedAt: stale ? null : p.mergedAt ?? null, mergeCommit: !stale && p.merged ? { oid: p.merged, message: String(p.message ?? "") } : null,
          mergeStateStatus: p.checks === "SUCCESS" ? "CLEAN" : "BLOCKED", headRefOid: p.head, headRefName: "feature", isCrossRepository: false, baseRefName: p.base ?? "main",
          files: { pageInfo: { hasNextPage: false }, nodes: (p.files ?? ["lib/x.mjs"]).map((path) => ({ path })) }, latestOpinionatedReviews: { nodes: [] },
          commits: { nodes: [{ commit: { statusCheckRollup: rollup(p.checks, p) } }] },
          baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40), statusCheckRollup: rollup(p.baseState ?? "SUCCESS", { names: p.baseNames }) } },
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
      if (m === "PUT" && p.endsWith("/merge") && putFails()) throw new Error("The operation was aborted due to timeout");
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
    key: "ch-key", kernelUrl: kernel.url, cacheDir, access, fleetOrg: "acme-agents", remoteUrl,
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

test("an answer that omits the fields the gate reads is waited on, not taken as the PR being gone", async (t) => {
  // A repository node with a PR node that answers none of the fields the gate reads (a truncated or proxied body): nothing
  // says the PR is gone, so the queue asks again instead of ending an approved merge.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const { handle, outcomes, merge } = await setup(t, { prs, graphql: async () => ({ status: 200, body: { data: { repository: { pullRequest: { number: 1 } } } } }) });
  await merge("k-00000000000000f1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  assert.equal(outcomes.length, 0, "a PR answer missing state/head/base is retried");
  // A repository node that answered none of the requested repository fields is the same: no evidence the PR is absent.
  const bare = await setup(t, { prs, graphql: async () => ({ status: 200, body: { data: { repository: {} } } }) });
  await bare.merge("k-00000000000000f2", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await bare.handle.stepMerges();
  assert.equal(bare.outcomes.length, 0, "an answer with no requested fields is retried");
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

test("a UI PR merges with no design review", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", files: ["web/app.css"] } };
  const tasks = [];
  const checks = (method, url, b) => method === "POST" && url === "/v1/tasks" ? (tasks.push(b), { id: `t${tasks.length}`, identifier: `T-${tasks.length}` }) : undefined;
  const { handle, github, merge, settle } = await setup(t, { prs, checks });
  await merge("k-00000000000000d1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  assert.equal(github.merges().length, 1, "merged on its green checks: the design review is advisory");
  assert.equal(tasks.length, 0, "the queue asks no design review");
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

test("a permanent refusal on the task work read settles the queue instead of retrying forever", async (t) => {
  // The kernel answers 404 (it no longer holds the task): that is its answer, no binding, so the queue finishes rather than
  // retrying a permanent refusal on every poll.
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-bound-404-"));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha } };
  let reads = 0;
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs, cacheDir,
    kernelReply: (m, url) => (m === "GET" && url === "/v1/work?task=tsk_0000000000000w9" ? (reads++, { __status: 404 }) : undefined),
  });
  await merge("k-00000000000000db", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(reads, 1, "the permanent refusal is not retried");
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /^merged-prs: \[\]/, "no binding, so the PR is not evidence");
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

test("a PR the merge commit's message already credits is not also read from the kernel", async (t) => {
  // The message path and the record path are two proofs of the same link: once the message answers, the kernel is not asked.
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-message-no-read-"));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha, message: "Fix the widget\n\nWOR-9" } };
  let reads = 0;
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs, cacheDir,
    kernelReply: (m, url) => (m === "GET" && /^\/v1\/work\?task=/.test(url) ? (reads++, { __status: 503 }) : undefined),
  });
  await merge("k-00000000000000dd", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(reads, 0, "the message already names the task");
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }]);
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

test("a queue that cached a null identifier before the upgrade reads it again once the kernel has it", async (t) => {
  // The version before this one took a record's first "no identifier" as final and kept the queue settled with none. The kernel's
  // upgrade reconcile has recorded it since: the queue must read again, or a PR merged at its bound head is credited to nobody.
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-upgrade-recached-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  mkdirSync(join(cacheDir, "merges"), { recursive: true });
  writeFileSync(join(cacheDir, "merges", "merges.json"), JSON.stringify({ queues: { "k-00000000000000c0": {
    id: "k-00000000000000c0", state: "running", startedAt: new Date().toISOString(), said: [], task: "tsk_0000000000000w9", recovered: true,
    prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD, url: "https://github.com/acme-agents/widget/pull/1", status: "pending" }],
  } } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha } };
  const { handle, outcomes, settle } = await setup(t, {
    prs, cacheDir,
    checks: (m, url) => (m === "GET" && url === "/v1/work?record=k-00000000000000c0" ? { id: "k-00000000000000c0", task: "tsk_0000000000000w9", identifier: "WOR-9", identifier_pending: false } : undefined),
  });
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the re-read found the identifier and kept the evidence");
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

test("a settled none is cached, not read from the kernel on every poll", async (t) => {
  // The kernel answered: this task has no identifier (gone, or none). That is the answer, so the queue holds the merge without
  // asking again on each poll, and an already-merged PR still credits only what it can prove.
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-settled-none-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING" } };
  let reads = 0;
  const { handle, merge } = await setup(t, {
    prs, cacheDir,
    checks: (m, url) => (m === "GET" && url === "/v1/work?record=k-00000000000000c0" ? (reads++, { id: "k-00000000000000c0", task: "tsk_0000000000000w9", identifier: null, identifier_pending: false }) : undefined),
  });
  await merge("k-00000000000000c0", [{ repo: "acme-agents/widget", number: 1, head: HEAD }], "tsk_0000000000000w9", "");
  await handle.stepMerges();
  await handle.stepMerges();
  await handle.stepMerges();
  assert.equal(reads, 1, "the settled answer is kept, never re-read");
});

test("a legacy queue waits out a failed identifier read instead of settling without the evidence", async (t) => {
  // The kernel is briefly unavailable on the first poll after an upgrade, while the PR is already merged at its bound head. The
  // failed read must not be taken for "the record has no identifier": the queue holds, retries, and only settles once the read
  // answers, so the merge that landed is still credited rather than lost for good.
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-upgrade-retry-"));
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
    // The first read fails (a 503 while the kernel restarts), the next answers: the queue must retry, not settle.
    checks: (m, url) => (m === "GET" && url === "/v1/work?record=k-00000000000000c0" ? (++reads === 1 ? { __status: 503 } : { id: "k-00000000000000c0", task: "tsk_0000000000000w9", identifier: "WOR-9", identifier_pending: false }) : undefined),
  });
  await handle.stepMerges();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(outcomes.length, 0, "a failed identifier read must not settle the queue");
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the retried read kept the merge as evidence");
});

test("a queue an older version settled with none waits out a failed re-read instead of settling without the evidence", async (t) => {
  // The version before this one took a record's first "no identifier" as final and kept the queue marked recovered with none. This
  // version reads it again (the kernel's upgrade reconcile may have recorded it since), and that read fails on the first poll while
  // the PR is already merged: the old flag is not an answer, so the queue must hold and retry rather than finish without the merge.
  const mergeSha = "d".repeat(40);
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-settled-none-retry-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  mkdirSync(join(cacheDir, "merges"), { recursive: true });
  writeFileSync(join(cacheDir, "merges", "merges.json"), JSON.stringify({ queues: { "k-00000000000000c0": {
    id: "k-00000000000000c0", state: "running", startedAt: new Date().toISOString(), said: [], task: "tsk_0000000000000w9", recovered: true,
    prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD, url: "https://github.com/acme-agents/widget/pull/1", status: "pending" }],
  } } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", state: "MERGED", merged: mergeSha } };
  let reads = 0;
  const { handle, outcomes, settle } = await setup(t, {
    prs, cacheDir,
    checks: (m, url) => (m === "GET" && url === "/v1/work?record=k-00000000000000c0" ? (++reads === 1 ? { __status: 503 } : { id: "k-00000000000000c0", task: "tsk_0000000000000w9", identifier: "WOR-9", identifier_pending: false }) : undefined),
  });
  await handle.stepMerges();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([outcomes.length, reads], [0, 1], "an old recovered flag is no answer: the failed re-read holds the queue");
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(JSON.parse(outcomes[0].text.split("\n")[0].replace(/^merged-prs: /, "")),
    [{ repo: "acme-agents/widget", number: 1, head: HEAD, sha: mergeSha }], "the retried re-read kept the merge as evidence");
});

test("an open PR with its identifier read failing waits for it instead of refusing it as another task's", async (t) => {
  // The record's task id is the bare UUID, the pr-tasks.json row names WOR-9, and the recovery read fails (the kernel restarting).
  // The row is no proof of another owner while the identifier is owed, and a fail could never be undone: the merge waits, then lands
  // once the read answers with the identifier the row names.
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-pending-failed-read-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  let reads = 0;
  const { handle, outcomes, merge, settle } = await setup(t, {
    prs, cacheDir,
    checks: (m, url) => (m === "GET" && url === "/v1/work?record=k-00000000000000c0" ? (++reads === 1 ? { __status: 503 } : { id: "k-00000000000000c0", task: "tsk_0000000000000w9", identifier: "WOR-9", identifier_pending: false }) : undefined),
  });
  await merge("k-00000000000000c0", [{ repo: "acme-agents/widget", number: 1, head: HEAD }], "tsk_0000000000000w9", "");
  await handle.stepMerges();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(outcomes.length, 0, "the merge waits for the identifier; it is not refused as another task's");
  assert.equal(prs["acme-agents/widget"].state, undefined, "nothing was merged or failed on a comparison the identifier was missing from");
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

test("a merge waiting on its checks publishes why to the record", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING" } };
  const github = fakeGitHub(prs);
  const waits = [];
  const merges = createMerges({ dir: mkdtempSync(join(tmpdir(), "merges-")), gh: github.gh, fleetOrg: "acme-agents", now: () => new Date(), evalGate: async () => undefined, report: async () => {}, waiting: async (id, reason) => void waits.push({ id, reason }) });
  void merges.enqueue("k-00000000000000h9", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step();
  await merges.step();
  assert.equal(waits.length, 1, "once, not per poll");
  assert.match(String(waits[0].reason), /check/i);
});

test("a code review wait posts its reason to the kernel once per distinct reason, never per poll, and keeps its no-time-limit wait", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  let verdict = { status: 200, body: { verdict: "wait", reasons: [{ code: "findings", text: "1 important finding open: t (a.ts:3)", unblock: "fix and push" }] } };
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
  assert.deepEqual(waits.map((w) => w.reason), ["code review: 1 important finding open: t (a.ts:3) (fix and push)"], "once per distinct reason, not per poll");
  assert.equal(merges.status("k-00000000000000h1").state, "running");
  // A week later the same reason: still no second post, and the gate's Infinity limit never stops the wait.
  clock.t += 7 * 24 * 3600_000;
  await merges.step();
  assert.equal(waits.length, 1);
  assert.equal(merges.status("k-00000000000000h1").state, "running");
  // A materially changed reason is posted once more.
  verdict = { status: 200, body: { verdict: "wait", reasons: [{ code: "findings", text: "2 important findings open: t, u", unblock: "fix and push" }] } };
  await merges.step();
  await merges.step();
  assert.deepEqual(waits.map((w) => w.reason), [
    "code review: 1 important finding open: t (a.ts:3) (fix and push)",
    "code review: 2 important findings open: t, u (fix and push)",
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
  assert.deepEqual(github.merges().map((w) => w.path), ["/repos/acme-agents/widget/pulls/1/merge"], "the first PR merged, the second waited its turn");
  assert.deepEqual(waits.map((w) => w.reason), [], "the second PR has no reason, so no wait is published for it");
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(github.merges().map((w) => w.path), ["/repos/acme-agents/widget/pulls/1/merge", "/repos/acme-agents/widget/pulls/2/merge"]);
});

test("a repo code review gates merges only on its pass for the bound head; wait (unreachable too) keeps the merge queued with no time limit; other repos never ask", async () => {
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
  assert.deepEqual(github.merges().map((w) => w.path), ["/repos/acme-agents/other/pulls/2/merge"]);
  assert.match(logs.find(([m]) => m === "merge waits for code review")[1].why, /1 important finding open: t \(a\.ts:3\) \(fix and push\)/);
  clock.t += 7 * 24 * 3600_000; // a week of waiting on findings: still waiting
  await merges.step();
  assert.equal(merges.status("k-00000000000000g1").state, "running");
  answer = "down"; // the service goes down: a wait for as long as it lasts, never a merge without its verdict
  for (let i = 0; i < 24 * 120; i++) { clock.t += 30_000; await merges.step(); }
  assert.deepEqual(github.merges().map((w) => w.path), ["/repos/acme-agents/other/pulls/2/merge"], "a day unreachable: still not merged");
  assert.equal(merges.status("k-00000000000000g1").state, "running");
  assert.match(logs.filter(([m]) => m === "merge waits for code review").at(-1)[1].why, /code review can't be reached: the merge waits until it answers/);
  answer = { status: 200, body: { verdict: "pass" } };
  await merges.step();
  assert.deepEqual(github.merges().map((w) => [w.path, w.body.sha]), [["/repos/acme-agents/other/pulls/2/merge", HEAD], ["/repos/acme-agents/widget/pulls/1/merge", HEAD]], "merged once code review passes it");
});

test("the review gate's findings key follows the whole set of reasons, not the cut text", async () => {
  const body = (b: string) => ({ ok: true, status: 200, json: async () => ({ verdict: "wait", reasons: [{ code: "findings", text: "a".repeat(700) + b, unblock: "fix and push" }] }) }) as Response;
  const gate = (b: string) => createReviewGate({ gated: ["acme/x"], url: "http://cr", key: () => "k", fetchFn: async () => body(b) });
  const one = await gate("1")("acme/x", 1, "h"), two = await gate("2")("acme/x", 1, "h");
  assert.ok(one && "findingsKey" in one && two && "findingsKey" in two && one.findingsKey !== two.findingsKey);
});

test("the gate keeps how a wait unblocks apart from the wait itself, which is what ship's decision carries", async () => {
  const body = { ok: true, status: 200, json: async () => ({ verdict: "wait", reasons: [{ code: "findings", text: "1 important finding open: t (a.ts:3)", unblock: "record each outcome with the code_review_resolve tool" }] }) } as Response;
  const g = await createReviewGate({ gated: ["acme/x"], url: "http://cr", key: () => "k", fetchFn: async () => body })("acme/x", 1, "h");
  assert.ok(g && "wait" in g);
  assert.equal(g.wait, "code review: 1 important finding open: t (a.ts:3)");
  assert.equal(g.unblock, "record each outcome with the code_review_resolve tool");
});

test("a sign-out still says signed out, and is cleared when GitHub reconnects", async (t) => {
  // The other half of the split: `connected` false is a sign-out, and its reason is the reconnect's.
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const connected = { on: false };
  const { handle, merge, waits } = await setup(t, { prs, connected });
  await merge("k-00000000000000bb", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  assert.deepEqual(waits.map((w) => w.reason), ["GitHub is signed out: waiting for the owner to reconnect it"]);
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

test("a queue written by the previous implementation republishes its reason on the first poll, not trusting an absent one", async () => {
  // The old queue kept the reason per PR and never a `waitSent`. Its record may still carry a stale "code review: …" while CI
  // holds the merge, so a queue loaded without the field must reconcile: unknown delivery, not "already cleared".
  const dir = mkdtempSync(join(tmpdir(), "merges-"));
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING" } };
  const github = fakeGitHub(prs);
  // What the old implementation left on disk: a running queue with a per-PR note and no `waitSent`.
  writeFileSync(join(dir, "merges.json"), JSON.stringify({ queues: { "k-00000000000000d1": { id: "k-00000000000000d1", state: "running", startedAt: new Date().toISOString(), said: [], prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD, url: "https://github.com/acme-agents/widget/pull/1", status: "pending", note: "code review: 1 important finding open" }] } } }));
  const waits = [];
  const merges = createMerges({
    dir, gh: github.gh, fleetOrg: "acme-agents", now: () => new Date(),
    report: async () => {}, waiting: async (id, reason) => void waits.push({ id, reason }),
    reviewGate: async () => undefined,
  });
  await merges.step();
  // CI holds the merge now, so the stale review reason must be cleared rather than assumed already delivered.
  assert.deepEqual(waits.map((w) => w.reason), ["checks are still running on its head"], "the stale reason is replaced on the first poll after the upgrade");
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
