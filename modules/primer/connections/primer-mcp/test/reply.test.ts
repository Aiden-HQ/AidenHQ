import { describe, expect, it } from "vitest";
import { replier } from "../src/reply.js";
import type { Owner, Owners } from "../src/owners.js";

const memory = (initial: [string, Owner][] = []): Owners => {
  const m = new Map<string, Owner>(initial);
  return { get: (id) => m.get(id), set: (id, o) => void m.set(id, o), documentsOf: (o) => [...m].filter(([, v]) => v.agent === o.agent && v.task === o.task).map(([id]) => id) };
};
const requester = { agent: "a1", key: "engineer", name: "Ada", roles: [], kind: "run" };
const answer = (tool: string) =>
  tool === "primer_get_document"
    ? { text: '{"documentId":"01a1-doc0","title":"Finance Plan"}' }
    : { text: '{"comments":[{"thread_id":"th-1","comment_id":"c-1","body":"Please cut section 2"}]}' };

describe("primer.reply executor", () => {
  it("names the thread by its document's title and its first comment, never by ids", async () => {
    const ex = replier(async (name) => answer(name), memory());
    const plan = await ex.plan({ kind: "primer.reply", args: { document_id: "01a1-doc0", thread_id: "th-1" }, requester, task: "T-1" });
    expect(plan.card?.what).toBe('resolving a thread in "Finance Plan"');
    expect(plan.card?.changes).toBe("Marks the comment thread “Please cut section 2” resolved.");
    expect(JSON.stringify(plan.card)).not.toMatch(/th-1|01a1-doc0/);
    expect(plan.raise).toMatchObject({ tier: 2, rule: "primer-reply-not-own" });
  });

  it("keeps a Tier 1 reply on the agent's own document, and quotes the reply text", async () => {
    const ex = replier(async (name) => answer(name), memory([["01a1-doc0", { agent: "a1", task: "T-1" }]]));
    const plan = await ex.plan({ kind: "primer.reply", args: { document_id: "01a1-doc0", thread_id: "th-1", body: "Cutting section 2 now." }, requester, task: "T-1" });
    expect(plan.raise).toBeUndefined();
    expect(plan.card?.what).toBe('a reply on a thread in "Finance Plan"');
    expect(plan.card?.changes).toContain("“Cutting section 2 now.”");
    expect(plan.card?.changes).toContain("“Please cut section 2”");
  });

  it("stays the owner's when the thread isn't in the document, however the title reads", async () => {
    const ex = replier(async () => ({ text: '{"title":"Finance Plan","comments":[{"thread_id":"other"}]}' }), memory([["01a1-doc0", { agent: "a1", task: "T-1" }]]));
    expect((await ex.plan({ kind: "primer.reply", args: { document_id: "01a1-doc0", thread_id: "th-1" }, requester, task: "T-1" })).raise?.tier).toBe(2);
  });

  it("reuses the filing plan's name on the kernel's revalidation plan, and reads nothing there", async () => {
    let calls = 0;
    const ex = replier(async (name) => (calls++, answer(name)), memory([["01a1-doc1", { agent: "a1", task: "T-1" }]]));
    const args = { document_id: "01a1-doc1", thread_id: "th-1" };
    const filed = await ex.plan({ kind: "primer.reply", args, requester, task: "T-1" });
    expect(calls).toBe(2);
    const again = await ex.plan({ kind: "primer.reply", args, requester, task: "T-1", revalidate: true });
    expect(calls).toBe(2);
    expect(again.card).toEqual(filed.card);
  });
});
