import { describe, expect, it } from "vitest";
import { card, fakeRecords } from "./fake-records.js";
import { MIRROR, mirrorTick } from "../src/mirror.js";
import { PaperclipError, type PaperclipApproval } from "../src/paperclip.js";

const BOARD = "local-board";

/**
 * Paperclip's approvals, in memory. As on the real API, an approval the board's key files carries `requestedByUserId`
 * (its own user); one another caller files does not.
 */
function fakeApprovals(opts: { failCreate?: boolean; failRetire?: boolean; boardUser?: string } = {}) {
  const rows: (PaperclipApproval & { issues?: string[] })[] = [];
  let n = 0;
  const retire = async (id: string, task: string) => {
    if (opts.failRetire) throw new Error("control plane down");
    const row = rows.find((r) => r.id === id);
    if (!row) throw new PaperclipError("Paperclip POST /api/approvals/x/reject → 404: Approval not found", 404);
    // As paperclip.ts does: unlink from the task first, so no review-path wake can name it, then resolve the approval.
    row.issues = (row.issues ?? []).filter((i) => i !== task);
    row.status = "rejected";
  };
  const pc = {
    me: async () => opts.boardUser ?? BOARD,
    approvals: async (status = "pending") => rows.filter((r) => r.status === status),
    createApproval: async (body: { type: string; issueIds: string[]; requestedByAgentId?: string; payload: { [k: string]: unknown } }) => {
      if (opts.failCreate) throw new Error("control plane down");
      const row = { id: `a-${++n}`, type: body.type, status: "pending", requestedByUserId: opts.boardUser ?? BOARD, payload: body.payload, issues: body.issueIds };
      rows.push(row);
      return row;
    },
    retireApproval: retire,
  };
  return { pc, rows, pending: () => rows.filter((r) => r.status === "pending") };
}

const log = { info() {}, warn() {} };
const cardOf = (id: string, extra = {}) => card({ id, issueId: `t-${id}`, identifier: `WOR-${id}`, requesterId: "agent-7", ...extra });

describe("a card mirrored as a linked pending approval", () => {
  it("an open record leaves exactly one pending linked approval, and leaving the open state retires it", async () => {
    const records = fakeRecords([cardOf("k-open")]);
    const { pc, pending } = fakeApprovals();

    expect(await mirrorTick({ pc, records, log })).toEqual({ created: 1, retired: 0 });
    expect(pending()).toHaveLength(1);
    expect(pending()[0]).toMatchObject({ status: "pending", issues: ["t-k-open"], payload: { [MIRROR]: "k-open", task: "t-k-open" } });

    // Decided on the kernel: the record is no longer open, so its mirror stops pending.
    records.cards[0] = cardOf("k-open", { state: "used", outcome: "applied" });
    expect(await mirrorTick({ pc, records, log })).toEqual({ created: 0, retired: 1 });
    expect(pending()).toHaveLength(0);
  });

  it("reconciles from Paperclip alone: a missing mirror is created, an orphan is retired, two ticks leave one", async () => {
    const records = fakeRecords([cardOf("k-a"), cardOf("k-b"), cardOf("k-done", { state: "used", outcome: "applied" })]);
    const { pc, pending } = fakeApprovals();
    // A previous tick filed k-done's mirror and never retired it; k-a and k-b have none.
    await pc.createApproval({ type: "request_board_approval", issueIds: ["t-k-done"], payload: { [MIRROR]: "k-done", task: "t-k-done" } });

    expect(await mirrorTick({ pc, records, log })).toEqual({ created: 2, retired: 1 });
    expect(pending().map((r) => r.payload?.[MIRROR]).sort()).toEqual(["k-a", "k-b"]);

    expect(await mirrorTick({ pc, records, log })).toEqual({ created: 0, retired: 0 });
    expect(pending()).toHaveLength(2);
  });

  it("a duplicate mirror for one open record is retired, leaving one", async () => {
    const records = fakeRecords([cardOf("k-a")]);
    const { pc, pending } = fakeApprovals();
    const one = { type: "request_board_approval", issueIds: ["t-k-a"], payload: { [MIRROR]: "k-a", task: "t-k-a" } };
    await pc.createApproval(one);
    await pc.createApproval(one);
    expect(await mirrorTick({ pc, records, log })).toEqual({ created: 0, retired: 1 });
    expect(pending()).toHaveLength(1);
  });

  it("leaves another caller's approval alone, even one carrying the marker", async () => {
    const records = fakeRecords([]);
    const { pc, rows, pending } = fakeApprovals();
    rows.push({ id: "foreign", type: "request_board_approval", status: "pending", requestedByUserId: "someone-else", payload: { [MIRROR]: "k-secret" } });
    expect(await mirrorTick({ pc, records, log })).toEqual({ created: 0, retired: 0 });
    expect(pending().map((r) => r.id)).toEqual(["foreign"]);
  });

  it("never changes a record's state: the mirror is bookkeeping, not a decision", async () => {
    const before = cardOf("k-a");
    const records = fakeRecords([{ ...before }]);
    const { pc } = fakeApprovals();
    await mirrorTick({ pc, records, log });
    expect(records.cards[0]).toEqual(before);
    records.cards[0] = cardOf("k-a", { state: "used", outcome: "applied", decidedBy: "reviewer" });
    await mirrorTick({ pc, records, log });
    expect(records.cards[0]).toMatchObject({ state: "used", outcome: "applied", decidedBy: "reviewer" });
  });

  it("a failing create leaves the card filed, visible and decidable; the next tick heals it", async () => {
    const records = fakeRecords([cardOf("k-a")]);
    await expect(mirrorTick({ pc: fakeApprovals({ failCreate: true }).pc, records, log })).resolves.toEqual({ created: 0, retired: 0 });
    expect(records.cards[0]?.state).toBe("pending");
    expect(await records.list("pending")).toHaveLength(1);
    expect(await mirrorTick({ pc: fakeApprovals().pc, records, log })).toEqual({ created: 1, retired: 0 });
  });

  it("a failing retire is retried next tick, and an approval already gone is not an error", async () => {
    const records = fakeRecords([cardOf("k-a")]);
    const stuck = fakeApprovals({ failRetire: true });
    await mirrorTick({ pc: stuck.pc, records, log });
    records.cards[0] = cardOf("k-a", { state: "used", outcome: "applied" });
    expect(await mirrorTick({ pc: stuck.pc, records, log })).toEqual({ created: 0, retired: 0 });
    expect(stuck.pending()).toHaveLength(1);

    const up = fakeApprovals();
    up.rows.push(...stuck.rows);
    expect(await mirrorTick({ pc: up.pc, records, log })).toEqual({ created: 0, retired: 1 });
    expect(up.pending()).toHaveLength(0);
  });

  it("retires by unlinking first, so a mirror that is a task's only review path never wakes it", async () => {
    // Paperclip's reject route wakes the assignee of each still-linked issue whose review path went with the approval.
    const records = fakeRecords([cardOf("k-a")]);
    const { pc, rows } = fakeApprovals();
    await mirrorTick({ pc, records, log });
    expect(rows[0]?.issues).toEqual(["t-k-a"]);

    records.cards[0] = cardOf("k-a", { state: "rejected", outcome: "failed" });
    await mirrorTick({ pc, records, log });
    // The approval is resolved (it no longer counts as a wait) but is linked to nothing: a reject that finds no linked
    // issue queues no wake.
    expect(rows[0]?.status).toBe("rejected");
    expect(rows[0]?.issues).toEqual([]);
  });

  it("leaves a mirror whose payload names no task, rather than retire it and wake the task", async () => {
    const records = fakeRecords([]);
    const { pc, rows, pending } = fakeApprovals();
    rows.push({ id: "no-task", type: "request_board_approval", status: "pending", requestedByUserId: BOARD, payload: { [MIRROR]: "k-gone" } });
    expect(await mirrorTick({ pc, records, log })).toEqual({ created: 0, retired: 0 });
    expect(pending().map((r) => r.id)).toEqual(["no-task"]);
  });

  it("does nothing when the board's own identity cannot be read", async () => {
    const records = fakeRecords([cardOf("k-a")]);
    const { pc, pending } = fakeApprovals();
    pc.me = async () => Promise.reject(new Error("control plane down"));
    expect(await mirrorTick({ pc, records, log })).toEqual({ created: 0, retired: 0 });
    expect(pending()).toHaveLength(0);
  });
});
