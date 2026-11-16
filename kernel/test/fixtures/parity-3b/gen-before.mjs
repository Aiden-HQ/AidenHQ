// The 3b parity oracle, generated once at da6d03cf (before the board's approval store was deleted): what today's code does
// with a request after classify(), through the runner's filing (fileApproval's fields), the board's store (request, review,
// decide, claim, veto, replacement, expiry), the runner's verdict handling (reviewOne: afterReview, retries, shadow) and the
// board's card text. kernel/test/parity-3b.test.mjs replays the same table through the kernel and compares.
//   node --disable-warning=ExperimentalWarning kernel/test/fixtures/parity-3b/gen-before.mjs > kernel/test/fixtures/parity-3b/before.json
import { DatabaseSync } from "node:sqlite";
import { Approvals, card, raiseCapRequest } from "../../../../services/board/src/approvals.ts";
import { afterReview, autonomyCap, reviewFirstOf, routineCapped, meritOwner } from "../../../../services/runner/src/tiers.mjs";
import { CASES, VERDICTS, CARDS, LUNA } from "./table.mjs";

const cardTier = (t) => (!t.reject && (t.tier === 1 || t.reviewFirst) ? 1 : 2);
const baseOf = (...ts) => (ts.length && ts.every(Boolean) ? Math.max(...ts.map((t) => (t.reject ? 2 : (t.baseTier ?? t.tier)))) : undefined);
const TIERS = { meritOwner, routineCapped };
/** A case's tier object: the classify() output it stands for, then the instance's autonomy as tierFor applies it. */
export const tierOf = (c, mode) => autonomyCap(c.wrap ? TIERS[c.wrap[0]](c.t, c.wrap[1]) : c.t, mode);

const board = () => new Approvals(new DatabaseSync(":memory:"));
const base = (b, action, args, t) => ({ issueId: "i-1", identifier: "ACME-1", action, args, requestedBy: "an Engineer", ...card(action, args, action === "apply" ? "diff --git a/x b/x" : ""), ...t });
const ARGS = { action: "push", args: { only: [{ repo: "acme/app", branch: "feat/x", sha: "a".repeat(40), patch: "b".repeat(64) }] } };
const view = (a) => a && { queue: a.state === "pending" ? (a.tier === 1 ? "review" : "owner") : a.state === "auto" ? "auto" : a.state, reviewFirst: a.reviewFirst, panel: a.panel, code: a.reasonCode, baseTier: a.baseTier, decidedBy: a.decidedBy, reviewCode: a.reviewCode, review: a.review?.slice(0, 60) ?? null };

/** fileApproval's fields from a tier object, then the board's store (with an earlier owner no on the task when `veto`). */
function file(b, t, veto) {
  if (veto) {
    const old = b.request(base(b, ARGS.action, { only: [{ ...ARGS.args.only[0], sha: "c".repeat(40), patch: "d".repeat(64) }] }, { tier: 2 }));
    b.decide(old.id, "reject", "account:owner");
  }
  if (t.reject) return { refused: true };
  if (t.tier === 0) return { queue: "auto" };
  return view(b.request(base(b, ARGS.action, ARGS.args, { tier: cardTier(t) === 1 ? 1 : undefined, reason: t.reason, baseTier: baseOf(t), reasonCode: t.rule, panel: Boolean(t.panel) && cardTier(t) === 1, reviewFirst: cardTier(t) === 1 ? reviewFirstOf(t) ?? null : null })));
}

/** reviewOne's handling of one model verdict on a pending Tier 1 card, then the board's review(). */
function verdict(b, a, t, mode, raw) {
  let input = { ...t };
  if (a.reviewFirst && !input.reject && (input.tier < 2 || input.reviewFirst)) input = { ...input, reviewFirst: true, ...(a.reviewFirst === "owner" ? { byMerit: true } : {}) };
  const owners = input.tier > 1 && !input.reviewFirst;
  let v = owners ? { decision: "escalate", code: "tier_raised", reason: `code now puts it at Tier 2: ${input.reason}`, model: LUNA } : afterReview(input, raw.decision === "failed" ? { decision: "escalate", code: "reviewer_failed", reason: "the reviewer failed (x)", model: LUNA } : raw);
  if (v.code === "reviewer_failed") v = input.byMerit ? { ...v, decision: "escalate", code: "owner_tier", reason: `The AI reviewer couldn't read it (${v.reason}, 6 times). It is Tier 2 on its merits, so the owner decides: ${input.reason}` } : { ...v, decision: "reject", reason: `${v.reason}, 6 times: ask again later.` };
  const post = mode === "full" || v.decision === "escalate" || (mode === "off" && v.decision === "reject") ? v : { ...v, decision: "escalate", code: "shadow", reason: `Shadow (autonomy: tier0): the reviewer would ${v.decision} this. ${v.reason}` };
  if (raw.panel_marked) b.markPanel(a.id, a.digest);
  const r = b.review(a.id, { digest: a.digest, decision: post.decision, reason: post.reason, model: post.model, ...(post.second ? { second: post.second } : {}), ...(post.code ? { code: post.code } : {}) });
  return r.ok ? { posted: post.decision, ...view(r.approval) } : { posted: post.decision, refused: r.reason, ...view(b.get(a.id)) };
}

const out = { generated_at: "da6d03cf", filing: [], verdicts: [], cards: {}, veto: [], replace: [], expiry: null };
for (const c of CASES) {
  for (const mode of ["off", "tier0", "full"]) {
    const t = tierOf(c, mode);
    for (const veto of [false, true]) {
      const b = board();
      const filed = file(b, t, veto);
      out.filing.push({ case: c.name, mode, veto, ...filed });
      if (filed.queue !== "review") continue;
      for (const [vn, raw] of Object.entries(VERDICTS)) {
        const b2 = board();
        file(b2, t, veto);
        const a = b2.pending(Date.now(), 1).find((x) => x.action === ARGS.action && x.args.only[0].sha === "a".repeat(40));
        out.verdicts.push({ case: c.name, mode, veto, verdict: vn, ...verdict(b2, a, t, mode, raw) });
      }
    }
  }
}
for (const [name, [action, args, diff]] of Object.entries(CARDS)) {
  const { digest, ...shown } = action === "raise_cap" ? raiseCapRequest({ id: "i-1", identifier: "ACME-1" }, args, "Acme Agent") : card(action, args, diff);
  out.cards[name] = Object.fromEntries(["target", "sentence", "changes", "reads", "cost", "details"].map((k) => [k, shown[k]]));
}
// The owner's veto, content-keyed: the latest owner no; a no on exactly this content (digest or patch keys) until the owner
// approves that same content; a branch request without patch keys fails closed against any owner no.
{
  const only = (sha, patch) => ({ only: [{ repo: "acme/app", branch: "feat/x", sha, ...(patch ? { patch } : {}) }] });
  const b = board();
  const x = b.request(base(b, "push", only("1".repeat(40), "e".repeat(64)), { tier: 2 }));
  b.decide(x.id, "reject", "account:owner");
  const y = b.request(base(b, "push", { only: [{ repo: "acme/app", branch: "feat/y", sha: "2".repeat(40), patch: "f".repeat(64) }] }, { tier: 2 }));
  b.decide(y.id, "approve", "account:owner");
  out.veto.push({ name: "same patch rejected, other content approved later", vetoed: b.ownerVetoed("i-1", "push", undefined, only("3".repeat(40), "e".repeat(64))) });
  out.veto.push({ name: "other content after an owner yes", vetoed: b.ownerVetoed("i-1", "push", undefined, only("4".repeat(40), "9".repeat(64))) });
  out.veto.push({ name: "no patch keys after an owner no", vetoed: b.ownerVetoed("i-1", "push", undefined, only("5".repeat(40))) });
  const c = board();
  const z = c.request(base(c, "push", only("6".repeat(40), "7".repeat(64)), { tier: 2 }));
  c.decide(z.id, "reject", "stale:watcher");
  out.veto.push({ name: "a watcher's stale no is no veto", vetoed: c.ownerVetoed("i-1", "push", undefined, only("8".repeat(40), "7".repeat(64))) });
  const d = board();
  const w = d.request(base(d, "push", only("6".repeat(40), "7".repeat(64)), { tier: 2 }));
  d.decide(w.id, "reject", "account:owner");
  out.veto.push({ name: "the latest owner decision is a no", vetoed: d.ownerVetoed("i-1", "push", undefined, only("8".repeat(40), "a".repeat(64))) });
}
// Replacement: the same task, action and target replaces the open card; another target is its own card.
{
  const b = board();
  const one = b.request(base(b, "push", ARGS.args, { tier: 2 }));
  const again = b.request(base(b, "push", ARGS.args, { tier: 2 }));
  const two = b.request(base(b, "push", { only: [{ ...ARGS.args.only[0], sha: "9".repeat(40) }] }, { tier: 2 }));
  const other = b.request(base(b, "push", { only: [{ ...ARGS.args.only[0], branch: "feat/other" }] }, { tier: 2 }));
  out.replace.push({ name: "the same request is the same card", same: again.id === one.id });
  out.replace.push({ name: "a changed request on the same target replaces it", first: b.get(one.id).state, second: two.state, replaced: two.replaced });
  out.replace.push({ name: "another target is its own card", other: other.state, replaced: other.replaced, second: b.get(two.id).state });
}
// Expiry: a card is decided within 7 days or not at all.
{
  const b = board();
  const a = b.request(base(b, "push", ARGS.args, { tier: 2 }), new Date(Date.now() - 8 * 86_400_000));
  out.expiry = { decided: b.decide(a.id, "approve", "account:owner").ok };
}
console.log(JSON.stringify(out, null, 1));
