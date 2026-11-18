import { describe, expect, it } from "vitest";
import { publisher } from "../src/publish.js";
import { replier } from "../src/reply.js";
import type { Owner, Owners } from "../src/owners.js";

const requester = { agent: "a1", key: "engineer", name: "Ada", roles: [], kind: "job" };
const memory = (): Owners => {
  const m = new Map<string, Owner>();
  return { get: (id) => m.get(id), set: (id, o) => void m.set(id, o), documentsOf: (o) => [...m].filter(([, v]) => v.agent === o.agent && v.task === o.task).map(([id]) => id) };
};

describe("primer.publish executor", () => {
  it("plans either request shape into the document it publishes, and publishes exactly that once approved", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const ex = publisher(async (name, args) => {
      calls.push([name, args]);
      return { text: name === "primer_create_document" ? '{"url":"https://primer.example/d/01a1-doc0"}' : "ok" };
    }, memory());
    // The runner's request (path is a label) and an agent's primer_create_document call plan the same way.
    const plan = await ex.plan({ kind: "primer.publish", args: { title: "Report", content: "# Report\n", format: "markdown", path: ".aidenhq/primer.md", junk: 1 }, requester, task: "T-1" });
    expect(plan.args).toEqual({ title: "Report", content: "# Report\n", format: "markdown", path: ".aidenhq/primer.md", by: { agent: "a1", task: "T-1" } });
    expect(plan.targets?.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.card?.what).toBe('the new document "Report"');
    expect(calls).toEqual([]);
    expect(await ex.execute({ id: "k-0000000000000001", kind: "primer.publish", args: plan.args, digest: "d", idempotency_key: "k-0000000000000001" }))
      .toEqual({ ok: true, text: "Published on Primer: https://primer.example/d/01a1-doc0 (document 01a1-doc0)" });
    expect(calls).toEqual([["primer_create_document", { title: "Report", content: "# Report\n", format: "markdown" }]]);
    // An agent's primer_add_version call: a version of that document.
    const v = await ex.plan({ kind: "primer.publish", args: { documentId: "01a1-doc0", content: "<h1>v2</h1>", format: "html", versionNote: "v2" }, requester, task: "T-2" });
    expect(v.targets).toMatchObject({ document: "01a1-doc0" });
    // A version of a document another task published is the owner's: an agent's own `own` never counts, the runner's (job) does.
    expect(v.raise).toMatchObject({ tier: 2, rule: "primer-version-not-own" });
    const agent = { ...requester, kind: "run" };
    expect((await ex.plan({ kind: "primer.publish", args: { documentId: "01a1-doc0", content: "x", own: true }, requester: agent, task: "T-2" })).raise?.tier).toBe(2);
    const vouched = await ex.plan({ kind: "primer.publish", args: { documentId: "01a1-doc0", content: "x", own: true }, requester, task: "T-1" });
    expect([vouched.raise, (vouched.args as any).own]).toEqual([undefined, true]);
    await ex.execute({ id: "k-0000000000000002", kind: "primer.publish", args: v.args, digest: "d", idempotency_key: "k-0000000000000002" });
    expect(calls.at(-1)).toEqual(["primer_add_version", { documentId: "01a1-doc0", content: "<h1>v2</h1>", format: "html", versionNote: "v2" }]);
  });

  it("tiers a version by who published the document: the agent's own is the AI reviewer's, any other the owner's", async () => {
    const owners = memory();
    const ex = publisher(async () => ({ text: '{"url":"https://primer.example/d/01a1-doc0"}' }), owners);
    const run = { agent: "a1", key: "researcher", name: "Ada", roles: [], kind: "run" };
    const created = await ex.plan({ kind: "primer.publish", args: { title: "T", content: "x", by: { agent: "evil", task: "T-9" } }, requester: run, task: "T-1" });
    expect((created.args as any).by).toEqual({ agent: "a1", task: "T-1" });
    await ex.execute({ id: "k-0000000000000003", kind: "primer.publish", args: created.args, digest: "d", idempotency_key: "k-0000000000000003" });
    expect(owners.get("01a1-doc0")).toEqual({ agent: "a1", task: "T-1" });
    const version = (r: typeof run, task: string) => ex.plan({ kind: "primer.publish", args: { documentId: "01a1-doc0", content: "y", own: true }, requester: r, task });
    expect((await version(run, "T-1")).raise).toBeUndefined();
    expect((await version(run, "T-2")).raise?.tier).toBe(2);
    expect((await version({ ...run, agent: "a2" }, "T-1")).raise?.tier).toBe(2);
  });

  it("tiers a thread reply by the document the thread is on", async () => {
    const owners = memory();
    owners.set("01a1-doc0", { agent: "a1", task: "T-1" });
    const calls: string[] = [];
    const ex = replier(async (name, args) => { calls.push(name); return { text: args.documentId === "01a1-doc0" ? "thread th-1 [open]" : "" }; }, owners);
    const run = { agent: "a1", key: "researcher", name: "Ada", roles: [], kind: "run" };
    const own = await ex.plan({ kind: "primer.reply", args: { thread_id: "th-1", body: "Addressed in v2: done" }, requester: run, task: "T-1" });
    expect([own.raise, own.targets]).toEqual([undefined, { thread: "th-1", document: "01a1-doc0" }]);
    expect((await ex.plan({ kind: "primer.reply", args: { thread_id: "th-2", body: "x" }, requester: run, task: "T-1" })).raise?.tier).toBe(2);
    await ex.execute({ id: "k-0000000000000004", kind: "primer.reply", args: own.args, digest: "d", idempotency_key: "k-0000000000000004" });
    expect(calls.at(-1)).toBe("primer_reply_to_thread");
  });

  it("refuses an empty document and a new one without a title", async () => {
    const ex = publisher(async () => ({ text: "" }));
    await expect(ex.plan({ kind: "primer.publish", args: { title: "T", content: "  " }, requester, task: "T-1" })).rejects.toThrow(/empty/);
    await expect(ex.plan({ kind: "primer.publish", args: { content: "x" }, requester, task: "T-1" })).rejects.toThrow(/title/);
  });
});
