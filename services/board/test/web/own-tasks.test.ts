// Mine, Delegated and Home's Your day count with the same functions: a task assigned to an agent is never "mine", and the
// delegated groups follow the kernel's lanes.
import { describe, expect, it } from "bun:test";
import { delegatedCount, delegatedOf, mineCount, mineOf, upcomingGroups, waitingOf } from "../../web/src/own-tasks";
import type { Card, WorkCard } from "../../web/src/types";

const c = (id: string, assignee: string | null, more: Partial<Card> = {}) => ({ id, assignee, labels: [], title: id, createdAt: new Date().toISOString(), ...more }) as Card;
const w = (id: string, lane: string, more: Partial<WorkCard> = {}) => ({ ...c(id, "agent"), state: { lane }, closedAt: null, ...more }) as unknown as WorkCard;
const board = { timezone: "UTC", rollsOn: "2030-01-02" };

describe("tasks lists", () => {
  it("counts only the owner's tasks, and groups Upcoming by day", () => {
    const items = { triage: [c("a", "me"), c("b", "agent")], today: [], tomorrow: [c("t", "me")], later: [c("l1", "me", { scheduled: { date: "2030-01-05", bucket: "later" } }), c("l2", "me")], backlog: [c("k", "me")] };
    const mine = mineOf(items);
    expect(mineCount(mine)).toBe(5);
    expect(upcomingGroups(mine, board).map((g) => [g.label.replace(/^.* · /, ""), g.cards.map((x) => x.id)])).toEqual([["Wed, Jan 2", ["t"]], ["Sat, Jan 5", ["l1"]], ["Coming up", ["l2"]]]);
  });

  it("puts what needs the owner or is blocked under Waiting on you, and counts what is open", () => {
    const now = new Date().toISOString();
    const g = delegatedOf([w("1", "working"), w("2", "needs_you"), w("3", "blocked"), w("4", "waiting"), w("5", "done", { closedAt: now }), w("6", "done", { closedAt: "2020-01-01T00:00:00Z" }), { ...w("7", "working"), assignee: "me" }], );
    expect(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((x) => x.id)]))).toEqual({ working: ["1"], waiting: ["2", "3"], queued: ["4"], done: ["5"] });
    expect(delegatedCount(g)).toBe(4);
  });

  it("says who waits on the owner from Intake's title", () => {
    expect(waitingOf(c("x", "me", { title: "Reply to Priya: audit timeline", labels: [{ name: "needs-response", color: "" }] }))).toMatch(/^Priya is waiting for you · /);
    expect(waitingOf(c("y", "me"))).toBeUndefined();
  });
});
