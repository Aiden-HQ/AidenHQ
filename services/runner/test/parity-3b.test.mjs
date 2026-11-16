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
import { autonomyCap, meritOwner, routineCapped } from "../../../kernel/src/tier.ts";
import { cardOf, planOf } from "../src/cards.ts";
import { CASES, VERDICTS, CARDS, LUNA } from "./fixtures-parity-3b/table.mjs";

const before = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures-parity-3b/before.json"), "utf8"));
const TIERS = { meritOwner, routineCapped };
const tierOf = (c, mode) => autonomyCap(c.wrap ? TIERS[c.wrap[0]](c.t, c.wrap[1]) : c.t, mode);
const ARGS = { only: [{ repo: "acme/app", branch: "feat/x", sha: "a".repeat(40), patch: "b".repeat(64) }] };

function kernel(mode, reviewer = async () => { throw new Error("no reviewer"); }, repos = { product: "acme/aidenhq", instance: "acme-agents/aidenhq-instance", agentsOrg: "acme" }) {
  const records = openRecords(join(mkdtempSync(join(tmpdir(), "parity-")), "kernel.db"));
  const writes = createWrites({ records, registry: () => KERNEL_KINDS, connections: () => ({}), secret: () => "", resolver: {}, autonomy: () => mode, repos: () => repos,
    reviews: { request: reviewer }, onTask: { open: async () => true, notify: async () => {} }, replay: async () => ({ ok: true, text: "" }) });
  return { records, writes };
}
const file = (k, t, args = ARGS, kind = "runner.push") => k.writes.fileRunner({ kind, task: "i-1", identifier: "ACME-1", args, plan: { ...planOf(t), card: cardOf(kind.slice(7), args) } });
/** An earlier owner no on the task (another content of the same kind), as the oracle had it. */
function veto(k) {
  const old = k.writes.fileRunner({ kind: "runner.push", task: "i-1", args: { only: [{ ...ARGS.only[0], sha: "c".repeat(40), patch: "d".repeat(64) }] }, plan: { tier: 2, card: { sentence: "old" } } });
  assert.equal(typeof k.writes.decide(old.id, { digest: old.digest, decision: "reject", by: "account:owner", via: "web" }), "object");
}
const queue = (r) => (r.state === "claimed" ? "auto" : r.state);
const view = (r) => ({ queue: queue(r), reviewFirst: r.review_first ?? null, panel: r.panel, code: r.rule ?? null, baseTier: r.merit, decidedBy: r.decided_by, reviewCode: r.review_code ?? null, review: r.review?.slice(0, 60) ?? null });
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

/** Stricter than before, on purpose: the owner's veto now holds on every filing (a Tier 0 or direct-to-owner request too). */
const DIRECTED = (row) => row.veto && (row.queue === "auto" || (row.queue === "owner" && row.reviewFirst === null));

test("filing: the same tier, review-first, panel, reason code and merit as the board's store gave", () => {
  let directed = 0;
  for (const row of before.filing) {
    const c = CASES.find((x) => x.name === row.case);
    const t = tierOf(c, row.mode);
    if (row.refused) { assert.ok(t.reject, row.case); continue; }
    const k = kernel(row.mode);
    if (row.veto) veto(k);
    const got = view(file(k, t));
    if (DIRECTED(row)) {
      directed++;
      assert.deepEqual(pick(got, ["queue", "reviewFirst", "code"]), { queue: "review", reviewFirst: "owner", code: "owner-veto" }, `${row.case} ${row.mode} veto`);
      continue;
    }
    const keys = row.queue === "auto" ? ["queue"] : ["queue", "reviewFirst", "panel", "code", "baseTier"];
    assert.deepEqual(pick(got, keys), pick(row, keys), `${row.case} ${row.mode} veto=${row.veto}`);
  }
  assert.equal(directed, 6);
});

test("verdicts: every model verdict on every reviewed card lands where the runner and the board put it", async () => {
  for (const row of before.verdicts) {
    const c = CASES.find((x) => x.name === row.case);
    const t = tierOf(c, row.mode);
    const raw = VERDICTS[row.verdict];
    const k = kernel(row.mode, async () => (raw.decision === "failed" ? Promise.reject(new Error("x")) : raw));
    if (row.veto) veto(k);
    const r = file(k, t);
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

test("the owner's veto is content-keyed, replacement is per target, and a card expires after 7 days", () => {
  const only = (sha, patch, branch = "feat/x") => ({ only: [{ repo: "acme/app", branch, sha, ...(patch ? { patch } : {}) }] });
  // The owner's decision on a card (one the veto sent to the reviewer first is escalated to them).
  const owner = (k, args, decision, by = "account:owner") => {
    const r = file(k, { tier: 2, rule: "x", reason: "x" }, args);
    if (r.state === "review") k.records.review(r.id, r.digest, { decision: "escalate", by: "reviewer:~acme/a", note: "x" });
    assert.equal(typeof k.writes.decide(r.id, { digest: r.digest, decision, by, via: "web" }), "object");
  };
  const vetoed = (k, args) => file(k, { tier: 1, rule: "x", reason: "x" }, args).rule === "owner-veto";
  const want = Object.fromEntries(before.veto.map((v) => [v.name, v.vetoed]));
  let k = kernel("full");
  owner(k, only("1".repeat(40), "e".repeat(64)), "reject");
  owner(k, only("2".repeat(40), "f".repeat(64), "feat/y"), "approve");
  assert.equal(vetoed(k, only("3".repeat(40), "e".repeat(64))), want["same patch rejected, other content approved later"]);
  assert.equal(vetoed(k, only("4".repeat(40), "9".repeat(64), "feat/z")), want["other content after an owner yes"]);
  assert.equal(vetoed(k, only("5".repeat(40), undefined, "feat/w")), want["no patch keys after an owner no"]);
  k = kernel("full");
  owner(k, only("6".repeat(40), "7".repeat(64)), "reject", "stale:watcher");
  assert.equal(vetoed(k, only("8".repeat(40), "7".repeat(64))), want["a watcher's stale no is no veto"]);
  k = kernel("full");
  owner(k, only("6".repeat(40), "7".repeat(64)), "reject");
  assert.equal(vetoed(k, only("8".repeat(40), "a".repeat(64))), want["the latest owner decision is a no"]);

  k = kernel("full");
  const t2 = { tier: 2, rule: "x", reason: "x" };
  const one = file(k, t2), again = file(k, t2);
  const two = file(k, t2, { only: [{ ...ARGS.only[0], sha: "9".repeat(40) }] });
  const other = file(k, t2, { only: [{ ...ARGS.only[0], branch: "feat/other" }] });
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
  const a = k.writes.fileRunner({ kind: "kernel.apply", task: "i-1", args: apply, plan: { tier: 0, card: applyCard(apply, "diff") } });
  assert.deepEqual([a.state, a.tier, a.review_first], ["review", 2, "final"]);
  assert.match(k.records.review(a.id, a.digest, { decision: "approve", by: "reviewer:~acme/a+~acme/b", note: "ok" }), /the owner decides/);
  // A plain apply and a merge are read by the reviewer at least, whatever the plan says.
  const plain = k.writes.fileRunner({ kind: "kernel.apply", task: "i-1", args: { repo: apply.repo, branch: apply.branch, sha: "2".repeat(40), files: apply.files }, plan: { tier: 0, card: { sentence: "x" } } });
  assert.deepEqual([plain.state, plain.tier], ["review", 1]);
  // A merge runs at once only in the agents org (its checks the merge queue holds at execution); outside it, the reviewer's.
  const mergeIn = (repo, n) => k.writes.fileRunner({ kind: "runner.merge", task: "i-1", args: { prs: [{ repo, number: n, url: `https://github.com/${repo}/pull/${n}` }] }, plan: { tier: 0, card: { sentence: "x" } } });
  assert.equal(mergeIn("acme-agents/app", 1).state, "claimed");
  assert.equal(mergeIn("acme/web", 3).state, "review");
  assert.equal(mergeIn("acme/aidenhq", 4).state, "review");
  // A push outside the agents org: at least the reviewer, whatever the plan says.
  assert.equal(k.writes.fileRunner({ kind: "runner.push", task: "i-1", args: { only: [{ repo: "acme/web", branch: "feat/o", sha: "6".repeat(40) }] }, plan: { tier: 0, card: { sentence: "x" } } }).state, "review");
  // The product repo and a main branch: at least the reviewer; the instance repo: never by push.
  for (const only of [[{ repo: "acme/aidenhq", branch: "fix/y", sha: "3".repeat(40) }], [{ repo: "acme-agents/app", branch: "main", sha: "4".repeat(40) }]]) assert.equal(k.writes.fileRunner({ kind: "runner.push", task: "i-1", args: { only }, plan: { tier: 0, card: { sentence: "x" } } }).state, "review");
  assert.throws(() => k.writes.fileRunner({ kind: "runner.push", task: "i-1", args: { only: [{ repo: "acme-agents/aidenhq-instance", branch: "x", sha: "5".repeat(40) }] }, plan: { tier: 0, card: { sentence: "x" } } }), /only through apply/);
  // An ordinary branch the plan calls Tier 0 runs at once; after the owner's no on the kind it is theirs, the plan's Tier 0 aside.
  const push = (sha) => k.writes.fileRunner({ kind: "runner.push", task: "i-2", args: { only: [{ repo: "acme-agents/app", branch: "feat/a", sha, patch: sha.repeat(2).slice(0, 64) }] }, plan: { tier: 0, card: { sentence: "x" } } });
  assert.equal(push("6".repeat(40)).state, "claimed");
  const no = k.writes.fileRunner({ kind: "runner.push", task: "i-2", args: { only: [{ repo: "acme-agents/app", branch: "feat/b", sha: "7".repeat(40) }] }, plan: { tier: 2, card: { sentence: "x" } } });
  k.writes.decide(no.id, { digest: no.digest, decision: "reject", by: "account:owner", via: "web" });
  assert.deepEqual([push("8".repeat(40))].map((r) => [r.state, r.review_first, r.rule])[0], ["review", "owner", "owner-veto"]);
  // A merge whose PR URL names another repo, a merge on the instance repo, a repository over the product's name: refused.
  const mergeOf = (repo, url) => k.writes.fileRunner({ kind: "runner.merge", task: "i-1", args: { prs: [{ repo, number: 2, url }] }, plan: { tier: 0, card: { sentence: "x" } } });
  assert.throws(() => mergeOf("acme-agents/app", "https://github.com/acme/aidenhq/pull/2"), /another repository/);
  assert.throws(() => mergeOf("acme-agents/aidenhq-instance", "https://github.com/acme-agents/aidenhq-instance/pull/2"), /only through apply/);
  assert.throws(() => k.writes.fileRunner({ kind: "runner.create_repo", task: "i-1", args: { repo: "acme/aidenhq" }, plan: { tier: 0, card: { sentence: "x" } } }), /already exists/);
  // The veto binds to each patch: a request that adds another patch, or reorders them, is still the owner's.
  const two = (sha, patches) => k.writes.fileRunner({ kind: "runner.push", task: "i-4", args: { only: patches.map((p, i) => ({ repo: "acme-agents/app", branch: `feat/${i}`, sha, patch: p.repeat(64) })) }, plan: { tier: 0, card: { sentence: "x" } } });
  const first = two("a".repeat(40), ["1"]);
  assert.equal(first.state, "claimed");
  const vetoedOne = k.writes.fileRunner({ kind: "runner.push", task: "i-4", args: { only: [{ repo: "acme-agents/app", branch: "feat/v", sha: "b".repeat(40), patch: "2".repeat(64) }] }, plan: { tier: 2, card: { sentence: "x" } } });
  k.writes.decide(vetoedOne.id, { digest: vetoedOne.digest, decision: "reject", by: "account:owner", via: "web" });
  const ok = k.writes.fileRunner({ kind: "runner.push", task: "i-4", args: { only: [{ repo: "acme-agents/app", branch: "feat/w", sha: "c".repeat(40), patch: "3".repeat(64) }] }, plan: { tier: 2, card: { sentence: "x" } } });
  k.records.review(ok.id, ok.digest, { decision: "escalate", by: "reviewer:~acme/a", note: "x" });
  k.writes.decide(ok.id, { digest: ok.digest, decision: "approve", by: "account:owner", via: "web" }); // the latest owner decision is a yes
  assert.equal(two("d".repeat(40), ["4", "2"]).rule, "owner-veto");
  assert.equal(two("e".repeat(40), ["2", "5", "6"]).rule, "owner-veto");
  assert.equal(two("f".repeat(40), ["5"]).state, "claimed");
  // However a repository is written, it is one repository to every rule: case, `.git` and a trailing slash change nothing, and
  // the args schema takes owner/name only.
  const pushTo = (repo, branch = "feat/s") => () => k.writes.fileRunner({ kind: "runner.push", task: "i-6", args: { only: [{ repo, branch, sha: "a".repeat(40) }] }, plan: { tier: 0, card: { sentence: "x" } } });
  for (const repo of ["Acme-Agents/AidenHQ-Instance", "acme-agents/aidenhq-instance.git", "acme-agents/aidenhq-instance/", "acme-agents/aidenhq-instance.git/"]) assert.throws(pushTo(repo), /only through apply|args\.only\[0\]\.repo/, repo);
  for (const repo of ["acme/aidenhq.git", "acme/aidenhq/", "acme/aidenhq/x"]) assert.throws(pushTo(repo), /args\.only\[0\]\.repo/, repo);
  assert.equal(pushTo("ACME/AidenHQ")().state, "review"); // the product repo, in any case: at least the reviewer
  for (const url of ["https://github.com/acme-agents/aidenhq-instance.git/pull/2", "https://github.com/Acme-Agents/AidenHQ-Instance/pull/2"]) assert.throws(() => mergeOf("acme-agents/aidenhq-instance", url), /only through apply|args\.prs/, url);
  assert.throws(() => mergeOf("ACME-AGENTS/AIDENHQ-INSTANCE", "https://github.com/acme-agents/aidenhq-instance/pull/2"), /only through apply/);
  // An unknown product or instance repo: every runner write is the owner's after the reviewer (fails closed).
  const blind = kernel("full", undefined, {}).writes.fileRunner({ kind: "runner.push", task: "i-5", args: { only: [{ repo: "acme-agents/app", branch: "feat/c", sha: "9".repeat(40) }] }, plan: { tier: 0, card: { sentence: "x" } } });
  assert.deepEqual([blind.state, blind.review_first, blind.rule], ["review", "owner", "unknown-repos"]);
  // Autonomy off: the plan's Tier 0 waits for the owner.
  assert.equal(kernel("off").writes.fileRunner({ kind: "runner.push", task: "i-3", args: { only: [{ repo: "acme/app", branch: "feat/c", sha: "9".repeat(40) }] }, plan: { tier: 0, card: { sentence: "x" } } }).state, "owner");
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
});
