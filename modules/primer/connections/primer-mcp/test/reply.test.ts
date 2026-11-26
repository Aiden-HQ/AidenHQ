import { describe, expect, it } from "vitest";
import { replier } from "../src/reply.js";
import type { Owner, Owners } from "../src/owners.js";

const owners: Owners = { get: () => ({ agent: "a1", task: "T-1" }) as Owner, set: () => {}, documentsOf: () => [] };
const requester = { agent: "a1", key: "architect", name: "A", roles: [], kind: "run" };
const plan = (answer: unknown, thread: string, task = "T-1") =>
  replier(async () => ({ text: JSON.stringify(answer) }), owners).plan({ kind: "primer.reply", args: { document_id: "d1", thread_id: thread, body: "ok" }, requester, task });

describe("primer.reply tiering", () => {
  it("finds a thread among a version's comments or a live document's own, and only on the agent's own document", async () => {
    const answer = { comments: [{ thread_id: "t-version" }], live: { threadCount: 1, comments: [{ thread_id: "t-live" }] } };
    expect((await plan(answer, "t-version")).raise).toBeUndefined();
    expect((await plan(answer, "t-live")).raise).toBeUndefined();
    expect((await plan(answer, "t-other")).raise).toMatchObject({ tier: 2, rule: "primer-reply-not-own" });
    expect((await plan(answer, "t-live", "T-2")).raise?.tier).toBe(2);
  });
});
