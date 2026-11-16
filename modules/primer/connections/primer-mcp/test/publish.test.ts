import { describe, expect, it } from "vitest";
import { publisher } from "../src/publish.js";

const requester = { agent: "a1", key: "engineer", name: "Ada", roles: [], kind: "job" };

describe("primer.publish executor", () => {
  it("plans either request shape into the document it publishes, and publishes exactly that once approved", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const ex = publisher(async (name, args) => {
      calls.push([name, args]);
      return { text: name === "primer_create_document" ? '{"url":"https://primer.example/d/01a1-doc0"}' : "ok" };
    });
    // The runner's request (path is a label) and an agent's primer_create_document call plan the same way.
    const plan = await ex.plan({ kind: "primer.publish", args: { title: "Report", content: "# Report\n", format: "markdown", path: ".aidenhq/primer.md", junk: 1 }, requester, task: "T-1" });
    expect(plan.args).toEqual({ title: "Report", content: "# Report\n", format: "markdown", path: ".aidenhq/primer.md" });
    expect(plan.targets?.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.card?.what).toBe('the new document "Report"');
    expect(calls).toEqual([]);
    expect(await ex.execute({ id: "k-0000000000000001", kind: "primer.publish", args: plan.args, digest: "d", idempotency_key: "k-0000000000000001" }))
      .toEqual({ ok: true, text: "Published on Primer: https://primer.example/d/01a1-doc0 (document 01a1-doc0)" });
    expect(calls).toEqual([["primer_create_document", { title: "Report", content: "# Report\n", format: "markdown" }]]);
    // An agent's primer_add_version call: a version of that document.
    const v = await ex.plan({ kind: "primer.publish", args: { documentId: "01a1-doc0", content: "<h1>v2</h1>", format: "html", versionNote: "v2" }, requester, task: "T-1" });
    expect(v.targets).toMatchObject({ document: "01a1-doc0" });
    await ex.execute({ id: "k-0000000000000002", kind: "primer.publish", args: v.args, digest: "d", idempotency_key: "k-0000000000000002" });
    expect(calls.at(-1)).toEqual(["primer_add_version", { documentId: "01a1-doc0", content: "<h1>v2</h1>", format: "html", versionNote: "v2" }]);
  });

  it("refuses an empty document and a new one without a title", async () => {
    const ex = publisher(async () => ({ text: "" }));
    await expect(ex.plan({ kind: "primer.publish", args: { title: "T", content: "  " }, requester, task: "T-1" })).rejects.toThrow(/empty/);
    await expect(ex.plan({ kind: "primer.publish", args: { content: "x" }, requester, task: "T-1" })).rejects.toThrow(/title/);
  });
});
