// 3b parity: the board's approval store is gone; the same requests through the runner's plan (cards.ts planOf, cardOf) and
// the kernel (writes.ts fileRunner and review, records.ts) give what today's code gave, frozen in fixtures-parity-3b/before.json
// at da6d03cf (generated once from the board store and the runner of that commit; the generator went with the store). The kernel derives floors, new module authority and the owner's veto itself, so a few rows
// are stricter on purpose (DIRECTED below); nothing is looser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecords } from "../../../kernel/src/records.ts";
import { createWrites } from "../../../kernel/src/writes.ts";
import { KERNEL_KINDS, applyCard, raiseCapCard } from "../../../kernel/src/kinds.ts";
import { meritOwner } from "../../../kernel/src/tier.ts";
import { cardOf, planOf } from "../src/cards.ts";
import { CASES, VERDICTS, CARDS, LUNA } from "./fixtures-parity-3b/table.mjs";

const before = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures-parity-3b/before.json"), "utf8"));
// The runner proposes the tier on its merits (classify's meritOwner); the kernel applies the caps (a routine's: `routine`).
const tierOf = (c) => (c.wrap?.[0] === "meritOwner" ? meritOwner(c.t) : c.t);
const routineOf = (c) => (c.wrap?.[0] === "routineCapped" ? { cap: c.wrap[1], routine: "r1" } : undefined);
const ARGS = { only: [{ repo: "acme/app", branch: "feat/x", sha: "a".repeat(40), patch: "b".repeat(64) }] };

function kernel(mode, reviewer = async () => { throw new Error("no reviewer"); }, repos = { product: "acme/aidenhq", instance: "acme-agents/aidenhq-instance", agentsOrg: "acme" }, routine) {
  const records = openRecords(":memory:"); // 540 fresh WAL files took minutes on the self-hosted runners
  const writes = createWrites({ records, registry: () => KERNEL_KINDS, connections: () => ({}), secret: () => "", resolver: {}, autonomy: () => mode, repos: () => repos,
    reviews: { request: reviewer }, onTask: { open: async () => true, notify: async () => {}, routineCap: async () => routine }, replay: async () => ({ ok: true, text: "" }) });
  return { records, writes };
}
const file = (k, t, args = ARGS, kind = "runner.push") => k.writes.fileRunner({ kind, task: "i-1", identifier: "ACME-1", args, plan: { ...planOf(t), card: cardOf(kind.slice(7), args) } });
/** An earlier owner no on the task (another content of the same kind), as the oracle had it. */
async function veto(k) {
  const old = await k.writes.fileRunner({ kind: "runner.push", task: "i-1", args: { only: [{ ...ARGS.only[0], sha: "c".repeat(40), patch: "d".repeat(64) }] }, plan: { tier: 2, card: { sentence: "old" } } });
  assert.equal(typeof k.writes.decide(old.id, { digest: old.digest, decision: "reject", by: "account:owner", via: "web" }), "object");
}
const queue = (r) => (r.state === "claimed" ? "auto" : r.state);
const view = (r) => ({ queue: queue(r), reviewFirst: r.review_first ?? null, panel: r.panel, code: r.rule ?? null, baseTier: r.merit, decidedBy: r.decided_by, reviewCode: r.review_code ?? null, review: r.review?.slice(0, 60) ?? null });
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

/** Stricter than before, on purpose: the owner's veto now holds on every filing (a Tier 0 or direct-to-owner request too). */
const DIRECTED = (row) => row.veto && (row.queue === "auto" || (row.queue === "owner" && row.reviewFirst === null));

test("filing: the same tier, review-first, panel, reason code and merit as the board's store gave", async () => {
  let directed = 0;
  for (const row of before.filing) {
    const c = CASES.find((x) => x.name === row.case);
    const t = tierOf(c);
    if (row.refused) { assert.ok(t.reject, row.case); continue; }
    const k = kernel(row.mode, undefined, undefined, routineOf(c));
    if (row.veto) await veto(k);
    const got = view(await file(k, t));
    if (DIRECTED(row)) {
      directed++;
      assert.deepEqual(pick(got, ["queue", "reviewFirst", "code"]), { queue: "review", reviewFirst: "owner", code: "owner-veto" }, `${row.case} ${row.mode} veto`);
      continue;
    }
    const keys = row.queue === "auto" ? ["queue"] : ["queue", "reviewFirst", "panel", "code", "baseTier"];
    // The owner's veto is a Tier 2 merit on every path now (tier.ts computeTier), as it is on a module kind's record.
    assert.deepEqual(pick(got, keys), pick({ ...row, ...(row.veto ? { baseTier: 2 } : {}) }, keys), `${row.case} ${row.mode} veto=${row.veto}`);
  }
  assert.equal(directed, 6);
});

test("verdicts: every model verdict on every reviewed card lands where the runner and the board put it", async () => {
  for (const row of before.verdicts) {
    const c = CASES.find((x) => x.name === row.case);
    const t = tierOf(c);
    const raw = VERDICTS[row.verdict];
    const k = kernel(row.mode, async () => (raw.decision === "failed" ? Promise.reject(new Error("x")) : raw), undefined, routineOf(c));
    if (row.veto) await veto(k);
    const r = await file(k, t);
    let out;
    const realNow = Date.now;
    try {
      for (let i = 0; i < 6; i++) {
        Date.now = () => realNow() + i * 3_600_000; // past each failed try's backoff
        out = await k.writes.review(r.id, { input: { ...t, model: LUNA }, request: {} });
        if (!out.deferred) break;
      }
    } finally { Date.now = realNow; }
    const got = view(k.records.get(r.id));
    const keys = ["queue", "reviewFirst", "panel", "decidedBy", "reviewCode", "review"];
    assert.deepEqual({ posted: out.posted?.decision, refused: Boolean(out.refused), ...pick(got, keys) }, { posted: row.posted, refused: Boolean(row.refused), ...pick({ ...row, queue: row.queue }, keys) }, `${row.case} ${row.mode} veto=${row.veto} ${row.verdict}`);
  }
});

test("card text: the same words the board wrote, for every kind", () => {
  for (const [name, [action, args, diff]] of Object.entries(CARDS)) {
    const card = action === "apply" ? applyCard(args, diff) : action === "raise_cap" ? raiseCapCard({ ...args, to: Math.round(args.cap * 200) / 100 }, "Acme Agent", "ACME-1") : cardOf(action, args);
    assert.deepEqual(pick(card, ["target", "sentence", "changes", "reads", "cost", "details"]), before.cards[name], name);
  }
});

test("the owner's veto is content-keyed, replacement is per target, and a card expires after 7 days", async () => {
  const only = (sha, patch, branch = "feat/x") => ({ only: [{ repo: "acme/app", branch, sha, ...(patch ? { patch } : {}) }] });
  // The owner's decision on a card (one the veto sent to the reviewer first is escalated to them).
  const owner = async (k, args, decision, by = "account:owner") => {
    const r = await file(k, { tier: 2, rule: "x", reason: "x" }, args);
    if (r.state === "review") k.records.review(r.id, r.digest, { decision: "escalate", by: "reviewer:~acme/a", note: "x" });
    assert.equal(typeof k.writes.decide(r.id, { digest: r.digest, decision, by, via: "web" }), "object");
  };
  const vetoed = async (k, args) => (await file(k, { tier: 1, rule: "x", reason: "x" }, args)).rule === "owner-veto";
  const want = Object.fromEntries(before.veto.map((v) => [v.name, v.vetoed]));
  let k = kernel("full");
  await owner(k, only("1".repeat(40), "e".repeat(64)), "reject");
  await owner(k, only("2".repeat(40), "f".repeat(64), "feat/y"), "approve");
  assert.equal(await vetoed(k, only("3".repeat(40), "e".repeat(64))), want["same patch rejected, other content approved later"]);
  assert.equal(await vetoed(k, only("4".repeat(40), "9".repeat(64), "feat/z")), want["other content after an owner yes"]);
  assert.equal(await vetoed(k, only("5".repeat(40), undefined, "feat/w")), want["no patch keys after an owner no"]);
  k = kernel("full");
  await owner(k, only("6".repeat(40), "7".repeat(64)), "reject", "stale:watcher");
  assert.equal(await vetoed(k, only("8".repeat(40), "7".repeat(64))), want["a watcher's stale no is no veto"]);
  k = kernel("full");
  await owner(k, only("6".repeat(40), "7".repeat(64)), "reject");
  assert.equal(await vetoed(k, only("8".repeat(40), "a".repeat(64))), want["the latest owner decision is a no"]);

  k = kernel("full");
  const t2 = { tier: 2, rule: "x", reason: "x" };
  const one = await file(k, t2), again = await file(k, t2);
  const two = await file(k, t2, { only: [{ ...ARGS.only[0], sha: "9".repeat(40) }] });
  const other = await file(k, t2, { only: [{ ...ARGS.only[0], branch: "feat/other" }] });
  const [same, changed, another] = before.replace;
  assert.equal(again.id === one.id, same.same);
  assert.deepEqual([k.records.get(one.id).state === "cancelled" ? "expired" : "?", two.replaced], [changed.first, changed.replaced]);
  assert.deepEqual([other.state === "owner" ? "pending" : other.state, other.replaced], [another.other, another.replaced]);

  const db = join(mkdtempSync(join(tmpdir(), "parity-")), "kernel.db");
  const old = openRecords(db, () => new Date(Date.now() - 8 * 86_400_000));
  const r = old.file({ kind: "runner.push", module: "runner", args: ARGS, targets: {}, executor: { module: "runner" }, policy: "", tier: 2, panel: false, card: { sentence: "", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "", key: "", name: "", roles: [], kind: "runner" }, task: "i-1", state: "owner" });
  assert.equal(typeof openRecords(db).decide(r.id, r.digest, "approve", "account:owner", "web") !== "string", before.expiry.decided);
});

test("the kernel decides what the plan only proposes: new module authority, the veto, floors, refusals and the runner's key", async () => {
  const k = kernel("full", undefined, { product: "acme/aidenhq", instance: "acme-agents/aidenhq-instance", agentsOrg: "acme-agents" });
  const apply = { repo: "acme-agents/aidenhq-instance", branch: "fleet/x", sha: "1".repeat(40), files: ["instance.yaml"], authority: ["engine-claude: secrets anthropic_key (owner)"], ownerRequired: true };
  // A plan claiming Tier 0 for an apply with new module authority: Tier 2, the reviewer first, and its approve never decides it.
  const a = await k.writes.fileRunner({ kind: "kernel.apply", task: "i-1", args: apply, plan: { tier: 0, card: applyCard(apply, "diff") } });
  assert.deepEqual([a.state, a.tier, a.review_first], ["review", 2, "final"]);
  assert.match(k.records.review(a.id, a.digest, { decision: "approve", by: "reviewer:~acme/a+~acme/b", note: "ok" }), /the owner decides/);
  // A plain apply and a merge are read by the reviewer at least, whatever the plan says.
  const plain = await k.writes.fileRunner({ kind: "kernel.apply", task: "i-1", args: { repo: apply.repo, branch: apply.branch, sha: "2".repeat(40), files: apply.files }, plan: { tier: 0, card: { sentence: "x" } } });
  assert.deepEqual([plain.state, plain.tier], ["review", 1]);
  // A merge runs at once only in the agents org (its checks the merge queue holds at execution); outside it, the reviewer's.
  const mergeIn = (repo, n) => k.writes.fileRunner({ kind: "runner.merge", task: "i-1", args: { prs: [{ repo, number: n, url: `https://github.com/${repo}/pull/${n}` }] }, plan: { tier: 0, card: { sentence: "x" } } });
  assert.equal((await mergeIn("acme-agents/app", 1)).state, "claimed");
  assert.equal((await mergeIn("acme/web", 3)).state, "review");
  assert.equal((await mergeIn("acme/aidenhq", 4)).state, "review");
  // A push outside the agents org: at least the reviewer, whatever the plan says.
  assert.equal((await k.writes.fileRunner({ kind: "runner.push", task: "i-1", args: { only: [{ repo: "acme/web", branch: "feat/o", sha: "6".repeat(40) }] }, plan: { tier: 0, card: { sentence: "x" } } })).state, "review");
  // The product repo and a main branch: at least the reviewer; the instance repo: never by push.
  for (const only of [[{ repo: "acme/aidenhq", branch: "fix/y", sha: "3".repeat(40) }], [{ repo: "acme-agents/app", branch: "main", sha: "4".repeat(40) }]]) assert.equal((await k.writes.fileRunner({ kind: "runner.push", task: "i-1", args: { only }, plan: { tier: 0, card: { sentence: "x" } } })).state, "review");
  await assert.rejects(() => k.writes.fileRunner({ kind: "runner.push", task: "i-1", args: { only: [{ repo: "acme-agents/aidenhq-instance", branch: "x", sha: "5".repeat(40) }] }, plan: { tier: 0, card: { sentence: "x" } } }), /only through apply/);
  // An ordinary branch the plan calls Tier 0 runs at once; after the owner's no on the kind it is theirs, the plan's Tier 0 aside.
  const push = (sha) => k.writes.fileRunner({ kind: "runner.push", task: "i-2", args: { only: [{ repo: "acme-agents/app", branch: "feat/a", sha, patch: sha.repeat(2).slice(0, 64) }] }, plan: { tier: 0, card: { sentence: "x" } } });
  assert.equal((await push("6".repeat(40))).state, "claimed");
  const no = await k.writes.fileRunner({ kind: "runner.push", task: "i-2", args: { only: [{ repo: "acme-agents/app", branch: "feat/b", sha: "7".repeat(40) }] }, plan: { tier: 2, card: { sentence: "x" } } });
  k.writes.decide(no.id, { digest: no.digest, decision: "reject", by: "account:owner", via: "web" });
  assert.deepEqual([await push("8".repeat(40))].map((r) => [r.state, r.review_first, r.rule])[0], ["review", "owner", "owner-veto"]);
  // A merge whose PR URL names another repo, a merge on the instance repo, a repository over the product's name: refused.
  const mergeOf = (repo, url) => k.writes.fileRunner({ kind: "runner.merge", task: "i-1", args: { prs: [{ repo, number: 2, url }] }, plan: { tier: 0, card: { sentence: "x" } } });
  await assert.rejects(() => mergeOf("acme-agents/app", "https://github.com/acme/aidenhq/pull/2"), /another repository/);
  await assert.rejects(() => mergeOf("acme-agents/aidenhq-instance", "https://github.com/acme-agents/aidenhq-instance/pull/2"), /only through apply/);
  await assert.rejects(() => k.writes.fileRunner({ kind: "runner.create_repo", task: "i-1", args: { repo: "acme/aidenhq" }, plan: { tier: 0, card: { sentence: "x" } } }), /already exists/);
  // The veto binds to each patch: a request that adds another patch, or reorders them, is still the owner's.
  const two = (sha, patches) => k.writes.fileRunner({ kind: "runner.push", task: "i-4", args: { only: patches.map((p, i) => ({ repo: "acme-agents/app", branch: `feat/${i}`, sha, patch: p.repeat(64) })) }, plan: { tier: 0, card: { sentence: "x" } } });
  const first = await two("a".repeat(40), ["1"]);
  assert.equal(first.state, "claimed");
  const vetoedOne = await k.writes.fileRunner({ kind: "runner.push", task: "i-4", args: { only: [{ repo: "acme-agents/app", branch: "feat/v", sha: "b".repeat(40), patch: "2".repeat(64) }] }, plan: { tier: 2, card: { sentence: "x" } } });
  k.writes.decide(vetoedOne.id, { digest: vetoedOne.digest, decision: "reject", by: "account:owner", via: "web" });
  const ok = await k.writes.fileRunner({ kind: "runner.push", task: "i-4", args: { only: [{ repo: "acme-agents/app", branch: "feat/w", sha: "c".repeat(40), patch: "3".repeat(64) }] }, plan: { tier: 2, card: { sentence: "x" } } });
  k.records.review(ok.id, ok.digest, { decision: "escalate", by: "reviewer:~acme/a", note: "x" });
  k.writes.decide(ok.id, { digest: ok.digest, decision: "approve", by: "account:owner", via: "web" }); // the latest owner decision is a yes
  assert.equal((await two("d".repeat(40), ["4", "2"])).rule, "owner-veto");
  assert.equal((await two("e".repeat(40), ["2", "5", "6"])).rule, "owner-veto");
  assert.equal((await two("f".repeat(40), ["5"])).state, "claimed");
  // However a repository is written, it is one repository to every rule: case, `.git` and a trailing slash change nothing, and
  // the args schema takes owner/name only.
  const pushTo = (repo, branch = "feat/s") => () => k.writes.fileRunner({ kind: "runner.push", task: "i-6", args: { only: [{ repo, branch, sha: "a".repeat(40) }] }, plan: { tier: 0, card: { sentence: "x" } } });
  for (const repo of ["Acme-Agents/AidenHQ-Instance", "acme-agents/aidenhq-instance.git", "acme-agents/aidenhq-instance/", "acme-agents/aidenhq-instance.git/"]) await assert.rejects(pushTo(repo), /only through apply|args\.only\[0\]\.repo/, repo);
  for (const repo of ["acme/aidenhq.git", "acme/aidenhq/", "acme/aidenhq/x"]) await assert.rejects(pushTo(repo), /args\.only\[0\]\.repo/, repo);
  assert.equal((await pushTo("ACME/AidenHQ")()).state, "review"); // the product repo, in any case: at least the reviewer
  for (const url of ["https://github.com/acme-agents/aidenhq-instance.git/pull/2", "https://github.com/Acme-Agents/AidenHQ-Instance/pull/2"]) await assert.rejects(() => mergeOf("acme-agents/aidenhq-instance", url), /only through apply|args\.prs/, url);
  await assert.rejects(() => mergeOf("ACME-AGENTS/AIDENHQ-INSTANCE", "https://github.com/acme-agents/aidenhq-instance/pull/2"), /only through apply/);
  // An unknown product or instance repo: every runner write is the owner's after the reviewer (fails closed).
  const blind = await kernel("full", undefined, {}).writes.fileRunner({ kind: "runner.push", task: "i-5", args: { only: [{ repo: "acme-agents/app", branch: "feat/c", sha: "9".repeat(40) }] }, plan: { tier: 0, card: { sentence: "x" } } });
  assert.deepEqual([blind.state, blind.review_first, blind.rule], ["review", "owner", "unknown-repos"]);
  // Autonomy off: the plan's Tier 0 waits for the owner.
  assert.equal((await kernel("off").writes.fileRunner({ kind: "runner.push", task: "i-3", args: { only: [{ repo: "acme/app", branch: "feat/c", sha: "9".repeat(40) }] }, plan: { tier: 0, card: { sentence: "x" } } })).state, "owner");
});

test("the card contract: every field the runner's card args carry is one the kernel's schema takes", async () => {
  const { validate } = await import("../../../kernel/src/writes.ts");
  const { BRANCH_CARD_FIELDS, applyCardArgs, branchCardArgs } = await import("../src/cards.ts");
  const branch = Object.fromEntries(BRANCH_CARD_FIELDS.map((k) => [k, k === "repo" ? "acme/app" : k === "branch" ? "feat/x" : k === "patch" ? "c".repeat(64) : "a".repeat(40)]));
  validate(KERNEL_KINDS["runner.pr"].args, branchCardArgs([branch], { text: { title: "t", body: "b" }, merge: true }));
  validate(KERNEL_KINDS["runner.push"].args, branchCardArgs([branch]));
  validate(KERNEL_KINDS["runner.merge"].args, { prs: [{ repo: "acme/app", number: 4, url: "https://github.com/acme/app/pull/4", head: "f".repeat(40), noReview: true, patch: "c".repeat(64) }], gap: 5 });
  validate(KERNEL_KINDS["kernel.apply"].args, applyCardArgs({ r: { repo: "acme-agents/aidenhq-instance", branch: "fleet/x" }, sha: "1".repeat(40), files: ["instance.yaml"] }, ["engine-claude: secrets x (owner)"], true));
  assert.throws(() => validate(KERNEL_KINDS["runner.push"].args, { only: [{ ...branch, extra: 1 }] }), /has no field extra/);
  // A local change request (codehost-local): its URL is one the kernel takes, and its cards say "this server" and
  // "change request" in the words the planted reviewer cases use (modules/ai-reviewer/test/reviewer-cases/*local*).
  const local = { prs: [{ repo: "local/expense-tracker", number: 3, url: "codehost:local/expense-tracker/change/3", head: "f".repeat(40) }] };
  validate(KERNEL_KINDS["runner.merge"].args, local);
  assert.deepEqual(pick(cardOf("merge", local), ["target", "sentence"]), { target: "codehost:local/expense-tracker/change/3", sentence: "Merge 1 change request, one at a time." });
  const lb = [{ ...branch, repo: "local/expense-tracker" }];
  assert.equal(cardOf("push", branchCardArgs(lb)).sentence, "Push 1 branch to this server.");
  assert.equal(cardOf("pr", branchCardArgs(lb)).sentence, "Push and open (or update) a draft change request for 1 branch.");
  assert.equal(cardOf("create_repo", { repo: "local/expense-tracker" }).sentence, "Create the repository local/expense-tracker.");
  assert.equal(cardOf("push", branchCardArgs([branch])).sentence, "Push 1 branch to GitHub.");
});

test("a replay is carried only by an approval of the same change: same kind, target, merge flag and patch", async () => {
  const k = kernel("full", undefined, { product: "acme/aidenhq", instance: "acme-agents/aidenhq-instance", agentsOrg: "acme-agents" });
  const only = (sha, patch) => ({ only: [{ repo: "acme/aidenhq", branch: "fix/a", sha, patch: patch.repeat(64) }] });
  const approved = await k.writes.fileRunner({ kind: "runner.pr", task: "i-7", args: { ...only("1".repeat(40), "a"), merge: true }, plan: { tier: 2, card: { sentence: "x" } } });
  k.records.review(approved.id, approved.digest, { decision: "escalate", by: "reviewer:~acme/a", note: "x" });
  k.writes.decide(approved.id, { digest: approved.digest, decision: "approve", by: "account:owner", via: "web" });
  const replay = (args, kind = "runner.pr") => () => k.writes.fileRunner({ kind, task: "i-7", args, plan: { tier: 0, card: { sentence: "x" }, carries: [approved.id] } });
  assert.equal((await replay({ ...only("2".repeat(40), "a"), merge: true })()).state, "claimed", "the product PR's approved change, rebased: runs on its approval");
  await assert.rejects(replay({ ...only("3".repeat(40), "b"), merge: true }), /don't carry/, "another change on the same branch");
  await assert.rejects(replay(only("4".repeat(40), "a")), /don't carry/, "the same change without its merge");
  await assert.rejects(replay(only("5".repeat(40), "a"), "runner.push"), /don't carry/, "another kind");
  // A new repository is the panel's, whatever the plan says, and only in the agents org.
  const repo = await k.writes.fileRunner({ kind: "runner.create_repo", task: "i-7", args: { repo: "acme-agents/new-app" }, plan: { tier: 0, card: { sentence: "x" } } });
  assert.deepEqual([repo.state, repo.panel], ["review", true]);
  await assert.rejects(() => k.writes.fileRunner({ kind: "runner.create_repo", task: "i-7", args: { repo: "acme/new-app" }, plan: { tier: 0, card: { sentence: "x" } } }), /only in the agents org/);
});
