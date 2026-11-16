import { describe, expect, it } from "vitest";
import { ARGS, BOARD_ACTIONS, RaiseCapSchema, card, digestText, parseReply, raiseCapRequest, shown, type Approval, type Request, type RunnerAction } from "../src/approvals.js";
import { Store } from "../src/store.js";

const req = (over: Partial<Request> = {}): Request => ({ issueId: "i1", identifier: "WOR-184", action: "apply", target: "acme/instance", digest: "a".repeat(40), args: { sha: "a".repeat(40) }, sentence: "Apply", reads: "", changes: "instance.yaml", cost: "none", details: "diff", requestedBy: "runner", ...over });

const mergeCard = (numbers: number[], over: Partial<Request> = {}): Request => {
  const prs = numbers.map((number) => ({ repo: "acme/app", number, url: `https://github.com/acme/app/pull/${number}` }));
  return { issueId: "i1", identifier: "WOR-184", action: "merge", args: { prs }, requestedBy: "runner", ...card("merge", { prs }), ...over };
};

describe("raise_cap", () => {
  it("is the owner's, doubles only, and is never the runner's to claim", () => {
    const { approvals } = new Store(":memory:");
    const r = RaiseCapSchema.parse({ scope: "task", agentId: "ag1", subject: "i1", cap: 10, spent: 10.02 });
    const a = approvals.request(raiseCapRequest({ id: "i1", identifier: "WOR-9" }, r, "Aiden"));
    // The AI reviewer reads it first (Tier 2 on its merits): it may only escalate, its approve or reject shown to the owner.
    expect(a).toMatchObject({ action: "raise_cap", tier: 1, baseTier: 2, reviewFirst: "owner", requesterId: null, state: "pending", args: { cap: 10, to: 20 }, sentence: "Double Aiden's task spend cap from $10.00 to $20.00." });
    expect(approvals.request(raiseCapRequest({ id: "i1", identifier: "WOR-9" }, { ...r, spent: 10.4 }, "Aiden")).id).toBe(a.id); // spend moved: the same card
    expect(RaiseCapSchema.safeParse({ ...r, to: 500 }).success).toBe(false); // no typed amount
    const v = { digest: a.digest, reason: "x", model: "~openai/gpt-luna-latest" };
    expect(approvals.review(a.id, { ...v, decision: "approve" }).ok).toBe(false);
    expect(approvals.review(a.id, { ...v, decision: "reject", code: "policy_other" }).ok).toBe(false);
    expect(approvals.review(a.id, { ...v, decision: "escalate", code: "owner_tier" })).toMatchObject({ ok: true, approval: { tier: 2 } });
    expect(approvals.decide(a.id, "approve", "account:x").ok).toBe(true);
    expect(approvals.approved(Object.keys(ARGS) as RunnerAction[])).toEqual([]);
    expect(BOARD_ACTIONS).toContain("raise_cap");
  });
});

describe("approval records", () => {
  it("a moved-head refusal is recorded stale, not rejected", () => {
    const { approvals } = new Store(":memory:");
    const a = approvals.request({ ...req({ action: "push" }), tier: 1, reason: "agents-org-branch", args: { only: [{ repo: "acme/app", branch: "fix/x", sha: "a".repeat(40) }] } });
    expect(approvals.review(a.id, { digest: a.digest, decision: "reject", reason: "moved since the card", model: "~openai/gpt-luna-latest", code: "stale_head" })).toMatchObject({ ok: true, approval: { state: "stale", reviewCode: "stale_head" } });
    expect(approvals.get(a.id)).toMatchObject({ state: "stale" });
  });

  it("approves once, is claimed once, and reports its outcome once", () => {
    const { approvals } = new Store(":memory:");
    const a = approvals.request(req());
    expect(a.state).toBe("pending");
    expect(approvals.request(req()).id).toBe(a.id); // the same request again: the same record
    expect(approvals.claim(a.id)).toBeUndefined(); // not approved yet
    expect(approvals.decide(a.id, "approve", "board").ok).toBe(true);
    expect(approvals.decide(a.id, "reject", "board")).toEqual({ ok: false, reason: "this approval is approved" });
    const claimed = approvals.claim(a.id)!;
    expect(claimed.state).toBe("used");
    expect(approvals.claim(a.id)).toBeUndefined(); // consumed
    expect(approvals.finish(a.id, "not-the-nonce", false, "forged")).toBe(false); // only the claimer reports
    expect(approvals.finish(a.id, claimed.nonce, true, "landed")).toBe(true);
    expect(approvals.finish(a.id, claimed.nonce, false, "again")).toBe(true); // a retried report changes nothing
    expect(approvals.get(a.id)).toMatchObject({ outcome: "applied", outcomeText: "landed" });
  });

  it("a rejected record can't be claimed; a changed request replaces the open one", () => {
    const { approvals } = new Store(":memory:");
    const a = approvals.request(req());
    approvals.decide(a.id, "reject", "board");
    expect(approvals.claim(a.id)).toBeUndefined();
    const b = approvals.request(req({ digest: "b".repeat(40) }));
    const c = approvals.request(req({ digest: "c".repeat(40) }));
    expect(approvals.get(b.id)).toMatchObject({ state: "expired", outcomeText: "replaced by a newer request" });
    expect(approvals.pendingOn("wor-184").map((x) => x.id)).toEqual([c.id]);
  });

  it("a merge request for another PR never expires an approved card for a different PR", () => {
    const { approvals } = new Store(":memory:");
    const pr10 = approvals.request(mergeCard([10], { tier: 1, reason: "product-merge" }));
    expect(approvals.decide(pr10.id, "approve", "reviewer:model").ok).toBe(true);
    const pr9 = approvals.request(mergeCard([9], { tier: 1, reason: "product-merge" }));
    expect(approvals.get(pr10.id)).toMatchObject({ state: "approved" }); // not expired by the other PR's card
    expect(approvals.get(pr9.id)).toMatchObject({ state: "pending", replaced: false });
    expect(approvals.claim(pr10.id)).toBeDefined(); // still claimable and runs on its own
  });

  it("a merge request for the same PR still replaces the earlier card", () => {
    const { approvals } = new Store(":memory:");
    const first = approvals.request(mergeCard([9]));
    const second = approvals.request(mergeCard([9], { digest: "b".repeat(40) }));
    expect(approvals.get(first.id)).toMatchObject({ state: "expired", outcomeText: "replaced by a newer request" });
    expect(approvals.get(second.id)).toMatchObject({ state: "pending", replaced: true });
  });

  it("a card naming several targets replaces only a card naming exactly the same set", () => {
    const { approvals } = new Store(":memory:");
    const both = approvals.request(mergeCard([9, 10]));
    const nine = approvals.request(mergeCard([9]));
    expect(approvals.get(both.id)).toMatchObject({ state: "pending" });
    expect(approvals.get(nine.id)).toMatchObject({ state: "pending", replaced: false });
    const again = approvals.request(mergeCard([10, 9], { digest: "d".repeat(40) }));
    expect(approvals.get(both.id)).toMatchObject({ state: "expired", outcomeText: "replaced by a newer request" });
    expect(approvals.get(again.id)).toMatchObject({ state: "pending", replaced: true });
  });

  it("a typed reply approves only the request the owner was shown: never one that replaced it since (tap the new card)", () => {
    const { approvals } = new Store(":memory:");
    const seen = approvals.request(req());
    const swapped = approvals.request(req({ digest: "b".repeat(40) })); // the agent changes the request after the card went out
    const r = approvals.decideByReply("WOR-184", "approve", "telegram");
    expect(r.ok).toBe(false);
    expect(approvals.get(swapped.id)!.state).toBe("pending");
    expect(approvals.get(seen.id)!.state).toBe("expired");
    expect(approvals.decideByReply("WOR-184", "reject", "telegram").ok).toBe(true); // rejecting is always safe
    const fresh = approvals.request(req({ issueId: "i9", identifier: "WOR-9" }));
    expect(approvals.decideByReply("wor-9", "approve", "telegram")).toMatchObject({ ok: true, approval: { id: fresh.id, state: "approved" } });
    expect(approvals.decideByReply("WOR-9", "approve", "telegram").ok).toBe(false); // nothing pending any more
  });

  it("a bare typed reply asks which card when two merge cards for different PRs are open", () => {
    const { approvals } = new Store(":memory:");
    const pr10 = approvals.request(mergeCard([10]));
    const pr9 = approvals.request(mergeCard([9]));
    const r = approvals.decideByReply("WOR-184", "approve", "telegram");
    expect(r.ok).toBe(false);
    const reason = r.ok ? "" : r.reason;
    expect(reason).toContain(pr10.id);
    expect(reason).toContain(pr9.id);
    expect(reason).toContain("https://github.com/acme/app/pull/10");
    expect(reason).toContain("https://github.com/acme/app/pull/9");
    expect(approvals.get(pr10.id)!.state).toBe("pending");
    expect(approvals.get(pr9.id)!.state).toBe("pending");
  });

  it("a reply naming one PR decides only that card when several are open", () => {
    const { approvals } = new Store(":memory:");
    const pr10 = approvals.request(mergeCard([10]));
    const pr9 = approvals.request(mergeCard([9]));
    expect(approvals.decideByReply("WOR-184", "approve", "telegram", "PR #10")).toMatchObject({ ok: true, approval: { id: pr10.id, state: "approved" } });
    expect(approvals.get(pr9.id)!.state).toBe("pending");
    expect(approvals.decideByReply("WOR-184", "reject", "telegram", "https://github.com/acme/app/pull/9")).toMatchObject({ ok: true, approval: { id: pr9.id, state: "rejected" } });
  });

  it("a bare reply still decides the only open card", () => {
    const { approvals } = new Store(":memory:");
    const pr10 = approvals.request(mergeCard([10]));
    expect(approvals.decideByReply("WOR-184", "approve", "telegram")).toMatchObject({ ok: true, approval: { id: pr10.id, state: "approved" } });
  });

  it("a reply naming a card id that doesn't exist changes nothing and says so", () => {
    const { approvals } = new Store(":memory:");
    const pr10 = approvals.request(mergeCard([10]));
    const r = approvals.decideByReply("WOR-184", "approve", "telegram", "Adeadbeef");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain("Adeadbeef");
    expect(approvals.get(pr10.id)!.state).toBe("pending");
  });

  it("expires after 7 days; used with no outcome shows as unknown", () => {
    const { approvals } = new Store(":memory:");
    const t0 = new Date("2026-11-01T00:00:00Z");
    const a = approvals.request(req(), t0);
    const later = new Date(t0.getTime() + 8 * 86_400_000);
    expect(shown(a, later.getTime())).toBe("expired");
    expect(approvals.decide(a.id, "approve", "board", later).ok).toBe(false);
    const b = approvals.request(req({ issueId: "i2" }));
    approvals.decide(b.id, "approve", "board");
    const used = approvals.claim(b.id)!;
    expect(shown(used, Date.now() + 3 * 3_600_000)).toBe("unknown");
  });


  it("parses a task, card id or target, never a sentence", () => {
    expect(parseReply("apply WOR-184")).toEqual({ decision: "approve", ref: "WOR-184" });
    expect(parseReply(" Approve wor-7. ")).toEqual({ decision: "approve", ref: "WOR-7" });
    expect(parseReply("reject WOR-9")).toEqual({ decision: "reject", ref: "WOR-9" });
    expect(parseReply("approve")).toEqual({ decision: "approve" });
    expect(parseReply("approve A1b2c3d4e")).toEqual({ decision: "approve", target: "A1b2c3d4e" });
    expect(parseReply("approve PR #10")).toEqual({ decision: "approve", target: "PR #10" });
    expect(parseReply("approve https://github.com/acme/app/pull/10")).toEqual({ decision: "approve", target: "https://github.com/acme/app/pull/10" });
    expect(parseReply("approve WOR-184 PR #10")).toEqual({ decision: "approve", ref: "WOR-184", target: "PR #10" });
    expect(parseReply("please apply WOR-184")).toBeUndefined();
    expect(parseReply("apply WOR-184 and WOR-185")).toBeUndefined();
  });
  it("a different request is a different digest", () => {
    const only = [{ repo: "acme/app", branch: "fix/x", sha: "a".repeat(40) }];
    expect(card("push", { only: [{ ...only[0]!, sha: "b".repeat(40) }] }).digest).not.toBe(card("push", { only }).digest);
    expect(card("apply", { repo: "acme/i", branch: "b", sha: "c".repeat(40), files: ["instance.yaml"] }, "+x").digest).not.toBe(card("apply", { repo: "acme/i", branch: "b", sha: "c".repeat(40), files: ["instance.yaml"] }, "+y").digest);
  });
});

describe("the daily digest", () => {
  it("lists only the owner's cards (Tier 2), never Tier 0 runs or what the AI reviewer decided", () => {
    const rec = (over: Partial<Approval>) => ({ identifier: "WOR-1", action: "pr", target: "acme/app", state: "pending", tier: 2, expiresAt: "2999-01-01T00:00:00Z", ...over }) as Approval;
    const text = digestText([rec({ identifier: "WOR-1", state: "auto", tier: 0 }), rec({ identifier: "WOR-2", state: "approved", tier: 1, decidedBy: "reviewer:~openai/gpt-luna-latest" }), rec({ identifier: "WOR-3", state: "rejected", tier: 1, decidedBy: "reviewer:~z-ai/glm-flash-latest", review: "x" }), rec({ identifier: "WOR-4", review: "drops a table" }), rec({ identifier: "WOR-5", state: "rejected", decidedBy: "owner:telegram" })]);
    expect(text).toMatch(/2 cards were yours to decide/);
    expect(text).toMatch(/WOR-4 .*still waiting for you · reviewer's note: drops a table/);
    expect(text).toMatch(/WOR-5 .*rejected/);
    expect(text).not.toMatch(/WOR-[123]\b/);
    expect(digestText([rec({ tier: 0, state: "auto" }), rec({ tier: 1, state: "approved" })])).toBeNull();
  });
});

describe("the worked case: a new agent in trial is one card", () => {
  it("files tap 1 for the review chaser's folder, and one tap approves it once", () => {
    const { approvals } = new Store(":memory:");
    const args = { repo: "acme/instance", branch: "fleet/new-agent-review-chaser", sha: "c".repeat(40), files: ["agents/review-chaser/AGENTS.md", "agents/review-chaser/agent.yaml"] };
    const diff = "+++ b/agents/review-chaser/agent.yaml\n+trial: true\n+reports_to: architect\n";
    const c = card("apply", args, diff);
    expect(c.changes).toContain("agents/review-chaser/agent.yaml");
    expect(c.details).toBe(diff);
    const a = approvals.request({ issueId: "i9", identifier: "WOR-9", action: "apply", args, requestedBy: "Fleet Engineer", ...c });
    expect(approvals.decide(a.id, "approve", "board").ok).toBe(true);
    expect(approvals.claim(a.id)?.args).toEqual(args);
    expect(approvals.claim(a.id)).toBeUndefined();
  });
});

