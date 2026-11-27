import { describe, expect, it } from "bun:test";
import { commentView, isSystemNote } from "../src/board.js";
import { milestonesOf } from "../src/task-truth.js";
import { Paperclip } from "../src/paperclip.js";

describe("session follow-ups", () => {
  it("a wake notice is a system note, never the owner's words", () => {
    const c = { id: "c1", body: "[wake] Your wait is up: x\n\n<!-- aidenhq-wake -->", authorType: "user", authorUserId: "me", createdAt: "2026-11-25T09:00:00.000Z" };
    expect(isSystemNote(c.body)).toBe(true);
    expect(commentView(c as never, "me", []).author.kind).toBe("board");
  });

  it("a run its machinery stopped (exit 143) reads as stopped, not failed", () => {
    const fact = (data: Record<string, unknown>) => ({ type: "job.ended", subject: "job:j1", at: "2026-11-25T09:00:00.000Z", data });
    const text = (data: Record<string, unknown>) => milestonesOf({ task: "t", facts: [fact(data)] } as never)[0]!.text;
    expect(text({ state: "failed", exit: 143, why: "W: WS authentication failed" })).toBe("Run stopped");
    expect(text({ state: "failed", exit: 1, why: "boom" })).toBe("Run failed: boom");
  });

  it("a miss in the agent roster can read the list again", async () => {
    let reads = 0;
    const pc = new Paperclip("http://kernel", "co", "key", (async () => { reads++; return new Response(JSON.stringify([{ id: "a", name: "A" }]), { status: 200, headers: { "content-type": "application/json" } }); }) as never);
    await pc.agents();
    await pc.agents();
    expect(reads).toBe(1);
    await pc.agents(true);
    expect(reads).toBe(2);
  });
});
