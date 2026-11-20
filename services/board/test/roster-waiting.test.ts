import { describe, expect, it } from "vitest";
import { roster } from "../src/activity.js";
import type { Agent } from "../src/paperclip.js";

const agent = (id: string) => ({ id, name: id, status: "idle", metadata: {} }) as unknown as Agent;

describe("roster state", () => {
  it("an agent with only a parked wait is waiting, not queued; due work still reads queued", () => {
    const act = {
      running: [], recent: [], failing: [],
      queued: [{ agent: "b", n: 1 }],
      parked: [{ agent: "a", n: 1, until: "2026-11-27T00:00:00.000Z", cause: "PR merged" }, { agent: "b", n: 1, until: "2026-11-27T00:00:00.000Z", cause: "later" }],
    };
    const r = roster([agent("a"), agent("b"), agent("c")], [], new Map(), act);
    expect(r.map((x) => [x.id, x.state, x.stateNote, x.waitUntil])).toEqual([["a", "waiting", "PR merged", "2026-11-27T00:00:00.000Z"], ["b", "queued", undefined, undefined], ["c", "idle", undefined, undefined]]);
  });
});
