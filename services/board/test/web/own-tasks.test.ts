// My tasks and Home's Your day count the owner's own tasks with one function: a task assigned to an agent is never "mine".
import { describe, expect, it } from "vitest";
import { mineOf, visibleOf, BACKLOG_TOP } from "../../web/src/own-tasks";
import type { Card } from "../../web/src/types";

const c = (id: string, assignee: string | null) => ({ id, assignee }) as Card;

describe("own tasks", () => {
  it("keeps only the owner's tasks and caps Backlog unless a search is on", () => {
    const items = { triage: [c("a", "me"), c("b", "agent")], today: [c("t", "agent")], tomorrow: [], later: [], backlog: Array.from({ length: 6 }, (_, i) => c(`k${i}`, "me")) };
    const mine = mineOf(items);
    expect(mine.triage.map((x) => x.id)).toEqual(["a"]);
    expect(mine.today).toEqual([]);
    expect(visibleOf(mine, false, false).backlog).toHaveLength(BACKLOG_TOP);
    expect(visibleOf(mine, true, false).backlog).toHaveLength(6);
  });
});
