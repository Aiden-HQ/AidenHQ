import { describe, expect, it } from "vitest";
import { ARGS, BOARD_ACTIONS, RaiseCapSchema, card, parseReply, raiseCapRequest, shown, type Request, type RunnerAction } from "../src/approvals.js";
import { Store } from "../src/store.js";

const req = (over: Partial<Request> = {}): Request => ({ issueId: "i1", identifier: "WOR-184", action: "apply", target: "acme/instance", digest: "a".repeat(40), args: { sha: "a".repeat(40) }, sentence: "Apply", reads: "", changes: "instance.yaml", cost: "none", details: "diff", requestedBy: "runner", ...over });

describe("raise_cap", () => {
  it("is the owner's, doubles only, and is never the runner's to claim", () => {
    const { approvals } = new Store(":memory:");
    const r = RaiseCapSchema.parse({ scope: "task", agentId: "ag1", subject: "i1", cap: 10, spent: 10.02 });
    const a = approvals.request(raiseCapRequest({ id: "i1", identifier: "WOR-9" }, r, "Aiden"));
    expect(a).toMatchObject({ action: "raise_cap", tier: 2, baseTier: 2, requesterId: null, state: "pending", args: { cap: 10, to: 20 }, sentence: "Double Aiden's task spend cap from $10.00 to $20.00." });
    expect(approvals.request(raiseCapRequest({ id: "i1", identifier: "WOR-9" }, { ...r, spent: 10.4 }, "Aiden")).id).toBe(a.id); // spend moved: the same card
    expect(RaiseCapSchema.safeParse({ ...r, to: 500 }).success).toBe(false); // no typed amount
    expect(approvals.decide(a.id, "approve", "account:x").ok).toBe(true);
    expect(approvals.approved(Object.keys(ARGS) as RunnerAction[])).toEqual([]);
    expect(BOARD_ACTIONS).toContain("raise_cap");
  });
});

describe("approval records", () => {
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


  it("parses only an exact typed reply", () => {
    expect(parseReply("apply WOR-184")).toEqual({ decision: "approve", ref: "WOR-184" });
    expect(parseReply(" Approve wor-7. ")).toEqual({ decision: "approve", ref: "WOR-7" });
    expect(parseReply("reject WOR-9")).toEqual({ decision: "reject", ref: "WOR-9" });
    expect(parseReply("please apply WOR-184")).toBeUndefined();
    expect(parseReply("apply WOR-184 and WOR-185")).toBeUndefined();
  });
  it("a different request is a different digest", () => {
    const only = [{ repo: "acme/app", branch: "fix/x", sha: "a".repeat(40) }];
    expect(card("push", { only: [{ ...only[0]!, sha: "b".repeat(40) }] }).digest).not.toBe(card("push", { only }).digest);
    expect(card("apply", { repo: "acme/i", branch: "b", sha: "c".repeat(40), files: ["instance.yaml"] }, "+x").digest).not.toBe(card("apply", { repo: "acme/i", branch: "b", sha: "c".repeat(40), files: ["instance.yaml"] }, "+y").digest);
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

