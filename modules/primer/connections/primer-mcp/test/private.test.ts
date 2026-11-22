import { describe, expect, it } from "vitest";
import { publisher } from "../src/publish.js";
import type { Owners } from "../src/owners.js";
import type { Reports } from "../src/reports.js";

const noOwners: Owners = { get: () => undefined, set: () => {}, documentsOf: () => [] };
const memoryReports = (): Reports => { const m = new Map<string, string>(); return { get: (k) => m.get(k.toLowerCase()), set: (k, v) => void m.set(k.toLowerCase(), v) }; };
const codeReview = { agent: "", key: "", name: "", roles: [], kind: "module", module: "code-review" };
const args = (over: object = {}) => ({ title: "Repo review: acme/widgets", content: "# Verdict\n", format: "markdown", versionNote: "abc1234", private: true, repo_key: "acme/widgets", ...over });

/** A Primer: documents with a visibility and collaborators, its tools, and what the executor asked of it. */
function primer(o: { shared?: Set<string>; collaborators?: Record<string, string[]>; flaky?: boolean; noVersion?: boolean; raw?: Record<string, string>; afterVersion?: () => void } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const privates: string[] = [];
  let n = 0;
  const docs = new Set<string>();
  const call = async (name: string, a: Record<string, unknown>) => {
    calls.push([name, a]);
    await new Promise((r) => setTimeout(r, 3)); // overlapping filings interleave
    if (o.raw?.[name] !== undefined) return { text: o.raw[name]! };
    if (name === "primer_add_version") o.afterVersion?.();
    if (name === "primer_create_document") { const id = `doc-${++n}-aaaa`; docs.add(id); return { text: JSON.stringify({ documentId: id, url: `https://primer.example/d/${id}` }) }; }
    if (name === "primer_get_document") return o.flaky ? { text: "upstream timeout", isError: true } : { text: JSON.stringify({ document: { id: a.documentId, visibility: o.shared?.has(String(a.documentId)) ? "org" : "private" } }) };
    if (name === "primer_list_collaborators") return { text: JSON.stringify({ collaborators: o.collaborators?.[String(a.documentId)] ?? [] }) };
    if (name === "primer_add_version") return o.noVersion ? { text: JSON.stringify({ reconciliation: { conflict: 1 } }) } : { text: JSON.stringify({ versionNumber: calls.filter((c) => c[0] === "primer_add_version").length + 1, url: `https://primer.example/d/${a.documentId}` }) };
    throw new Error(name);
  };
  const reports = memoryReports();
  const ex = publisher(call, noOwners, { makePrivate: async (id, title) => void privates.push(`${id}:${title}`), reports });
  const file = (a: object, id: string) => ex.execute({ id, kind: "primer.publish", args: a, digest: "d", idempotency_key: id });
  return { ex, file, calls, privates, reports };
}

describe("a module's private report (primer.publish with private)", () => {
  it("creates the document private to the owner; a version of it stays at the floor", async () => {
    const p = primer();
    const plan = await p.ex.plan({ kind: "primer.publish", args: args(), requester: codeReview, task: "T-1" });
    expect(plan.raise).toBeUndefined();
    expect(plan.card?.changes).toContain("only its owner can read it");
    expect((await p.file(plan.args as object, "k-0000000000000001")).text).toMatch(/^New version v\d on Primer \(document doc-1-aaaa/);
    expect(p.privates).toEqual(["doc-1-aaaa:Repo review: acme/widgets"]);
    // The report reaches Primer only after the document is private: created with a placeholder, then the report as a version.
    expect(p.calls.find((c) => c[0] === "primer_create_document")?.[1].content).not.toContain("Verdict");
    // Created under a title that names no repo (the report's own is set once the document is private).
    expect(p.calls.find((c) => c[0] === "primer_create_document")?.[1].title).toBe("Repo review");
    expect(p.calls.filter((c) => c[0] === "primer_add_version")).toHaveLength(1);
    expect(p.reports.get("acme/widgets")).toBe("doc-1-aaaa");
    const v = await p.ex.plan({ kind: "primer.publish", args: args({ documentId: "doc-1-aaaa" }), requester: codeReview, task: "T-1" });
    expect(v.raise).toBeUndefined();
    const out = await p.file(v.args as object, "k-0000000000000002");
    expect(out.text).toMatch(/^New version v\d on Primer \(document doc-1-aaaa/);
    expect(p.calls.filter((c) => c[0] === "primer_add_version").at(-1)).toEqual(["primer_add_version", expect.objectContaining({ documentId: "doc-1-aaaa", versionNote: "abc1234" })]);
    expect(p.privates).toEqual(["doc-1-aaaa:Repo review: acme/widgets"]);
  });

  it("is a version of the repo's own document only: a document the caller names, or one an agent files, never gets it", async () => {
    const p = primer();
    await p.file(args(), "k-0000000000000003");
    await p.file(args({ documentId: "someone-elses-doc", baseVersionNumber: 5 }), "k-0000000000000004");
    // The version number belongs to the document the caller named, never to the report's own.
    expect(p.calls.filter((c) => c[0] === "primer_add_version").every((c) => c[1].baseVersionNumber === undefined)).toBe(true);
    expect(p.calls.filter((c) => c[0] === "primer_add_version").map((c) => c[1].documentId)).toEqual(["doc-1-aaaa", "doc-1-aaaa"]);
    // An agent's version of a document it didn't publish is still the owner's call.
    const agent = { agent: "a1", key: "x", name: "A", roles: [], kind: "run" };
    const plan = await p.ex.plan({ kind: "primer.publish", args: args({ documentId: "doc-1-aaaa", private: undefined, repo_key: undefined }), requester: agent, task: "T-2" });
    expect(plan.raise?.tier).toBe(2);
    // Only a module files a private report: an agent never repoints a repo's report document.
    await expect(p.ex.plan({ kind: "primer.publish", args: args(), requester: agent, task: "T-2" })).rejects.toThrow(/module only/);
    await expect(p.ex.plan({ kind: "primer.publish", args: args({ private: undefined, repo_key: undefined }), requester: codeReview, task: "T-1" })).rejects.toThrow(/private reports only/);
    await expect(p.ex.plan({ kind: "primer.publish", args: { ...args(), repo_key: undefined }, requester: codeReview, task: "T-1" })).rejects.toThrow(/repo_key/);
  });

  it("a report that was shared wider, or given a collaborator, becomes a new private document", async () => {
    const p = primer({ shared: new Set(["doc-1-aaaa"]) });
    await p.file(args(), "k-0000000000000005");
    const out = await p.file(args(), "k-0000000000000006");
    expect(out.text).toContain("(document doc-2-aaaa");
    expect(out.text).toContain("the earlier report doc-1-aaaa is shared wider");
    expect(p.privates.map((x) => x.split(":")[0])).toEqual(["doc-1-aaaa", "doc-2-aaaa"]);
    expect(p.reports.get("acme/widgets")).toBe("doc-2-aaaa");
    const q = primer({ collaborators: { "doc-1-aaaa": ["someone"] } });
    await q.file(args(), "k-0000000000000007");
    expect((await q.file(args(), "k-0000000000000008")).text).toContain("(document doc-2-aaaa");
  });

  it("a failed audience read fails the publish instead of starting a second document", async () => {
    const p = primer();
    await p.file(args(), "k-000000000000000c");
    const q = primer({ flaky: true });
    q.reports.set("acme/widgets", "doc-1-aaaa");
    await expect(q.file(args(), "k-000000000000000d")).rejects.toThrow(/upstream timeout/);
    expect(q.calls.filter((c) => c[0] === "primer_create_document")).toHaveLength(0);
  });

  it("concurrent first publishes on one repo yield one document", async () => {
    const p = primer();
    const outs = await Promise.all([p.file(args(), "k-0000000000000009"), p.file(args({ repo_key: "Acme/Widgets" }), "k-000000000000000a"), p.file(args({ repo_key: "acme/other" }), "k-000000000000000b")]);
    expect(outs.every((o) => o.ok)).toBe(true);
    expect(p.calls.filter((c) => c[0] === "primer_create_document")).toHaveLength(2);
    expect(p.calls.filter((c) => c[0] === "primer_add_version")).toHaveLength(3);
    expect(p.reports.get("acme/widgets")).toBe("doc-1-aaaa");
  });

  it("fails the filing when Primer applies no version, so a placeholder is never a done report", async () => {
    const p = primer({ noVersion: true });
    const out = await p.file(args(), "k-0000000000000099");
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/No new version on Primer[\s\S]*wasn't published/);
  });

  it("a null collaborator answer is a failure, not a missing document; a share that lands during the write is reported", async () => {
    const shared = new Set<string>();
    const p = primer({ shared, afterVersion: () => void shared.add("doc-1-aaaa") });
    await p.file(args(), "k-0000000000000010");
    shared.clear();
    const out = await p.file(args(), "k-0000000000000011");
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/replaced by a placeholder/);
    expect(p.calls.filter((c) => c[0] === "primer_add_version").at(-1)?.[1].content).toBe("This private report is being prepared.");
    const o: NonNullable<Parameters<typeof primer>[0]> = { afterVersion: () => { o.flaky = true; } };
    const f = primer(o);
    await f.file(args(), "k-0000000000000014");
    o.flaky = false;
    const unknown = await f.file(args(), "k-0000000000000015");
    expect(unknown).toMatchObject({ ok: true });
    expect(unknown.text).toMatch(/privacy couldn't be confirmed/);
    const q = primer({ raw: { primer_list_collaborators: "null" } });
    await q.file(args(), "k-0000000000000012");
    await expect(q.file(args(), "k-0000000000000013")).rejects.toThrow(/answered no data/);
    expect(q.calls.filter((c) => c[0] === "primer_create_document")).toHaveLength(1);
  });
});
