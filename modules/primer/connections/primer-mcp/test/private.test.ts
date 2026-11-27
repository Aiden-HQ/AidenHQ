import { describe, expect, it } from "bun:test";
import { publisher } from "../src/publish.js";
import type { Owners } from "../src/owners.js";

const noOwners: Owners = { get: () => undefined, set: () => {}, documentsOf: () => [] };
const codeReview = { agent: "", key: "", name: "", roles: [], kind: "module", module: "code-review" };
const args = (over: object = {}) => ({ title: "Repo review: acme/widgets", content: "# Verdict\n", format: "markdown", versionNote: "abc1234", private: true, repo_key: "acme/widgets", ...over });

/** A Primer: its tools, and what the executor asked of it. */
function primer(o: { noVersion?: boolean } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const privates: string[] = [];
  let n = 0;
  const call = async (name: string, a: Record<string, unknown>) => {
    calls.push([name, a]);
    if (name === "primer_create_document") { const id = `doc-${++n}-aaaa`; return { text: JSON.stringify({ documentId: id, url: `https://primer.example/d/${id}` }) }; }
    if (name === "primer_add_version") return o.noVersion ? { text: JSON.stringify({ reconciliation: { conflict: 1 } }) } : { text: JSON.stringify({ versionNumber: 1, url: `https://primer.example/d/${a.documentId}` }) };
    throw new Error(name);
  };
  const done = new Map<string, string>();
  const ex = publisher(call, noOwners, { makePrivate: async (id, title) => void privates.push(`${id}:${title}`), done: { get: (k) => done.get(k), set: (k, v) => void done.set(k, v) } });
  const file = (a: object, id: string) => ex.execute({ id, kind: "primer.publish", args: a, digest: "d", idempotency_key: id });
  return { ex, file, calls, privates };
}

describe("a module's private report (primer.publish with private)", () => {
  it("is a new document made private before it holds the report, every time", async () => {
    const p = primer();
    const plan = await p.ex.plan({ kind: "primer.publish", args: args(), requester: codeReview, task: "T-1" });
    expect(plan.raise).toBeUndefined();
    expect(plan.card?.changes).toContain("only its owner can read");
    expect((await p.file(plan.args as object, "k-0000000000000001")).text).toMatch(/^New version v\d on Primer \(document doc-1-aaaa/);
    expect((await p.file({ ...(plan.args as object), versionNote: "def5678" }, "k-0000000000000002")).text).toMatch(/\(document doc-2-aaaa/);
    expect(p.privates.map((x) => x.split(":")[0])).toEqual(["doc-1-aaaa", "doc-2-aaaa"]);
    // Created with a placeholder under a title naming no repo; the report arrives only as a version, after the document is private.
    const created = p.calls.filter((c) => c[0] === "primer_create_document");
    expect(created).toHaveLength(2);
    expect(created.every((c) => !String(c[1].content).includes("Verdict") && c[1].title === "Repo review")).toBe(true);
    expect(p.calls.filter((c) => c[0] === "primer_add_version").every((c) => String(c[1].content).includes("Verdict"))).toBe(true);
  });

  it("never names a document; only a module files it, and only a private report", async () => {
    const p = primer();
    const agent = { agent: "a1", key: "x", name: "A", roles: [], kind: "run" };
    await expect(p.ex.plan({ kind: "primer.publish", args: args({ documentId: "someone-elses-doc" }), requester: codeReview, task: "T-1" })).rejects.toThrow(/always a new document/);
    await expect(p.ex.plan({ kind: "primer.publish", args: args(), requester: agent, task: "T-2" })).rejects.toThrow(/module only/);
    await expect(p.ex.plan({ kind: "primer.publish", args: args({ private: undefined, repo_key: undefined }), requester: codeReview, task: "T-1" })).rejects.toThrow(/private reports only/);
    await expect(p.ex.plan({ kind: "primer.publish", args: { ...args(), repo_key: undefined }, requester: codeReview, task: "T-1" })).rejects.toThrow(/repo_key/);
    // An agent's version of a document it didn't publish is still the owner's call.
    const plan = await p.ex.plan({ kind: "primer.publish", args: args({ documentId: "doc-1-aaaa", private: undefined, repo_key: undefined }), requester: agent, task: "T-2" });
    expect(plan.raise?.tier).toBe(2);
  });

  it("fails the filing when Primer applies no version, so a placeholder is never a done report", async () => {
    const out = await primer({ noVersion: true }).file(args(), "k-0000000000000099");
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/No new version on Primer[\s\S]*wasn't published/);
  });

  it("a write filed again, even at once, for the same report finds its document and makes no second", async () => {
    const p = primer();
    const [a, b] = await Promise.all([p.file(args(), "k-0000000000000020"), p.file(args(), "k-0000000000000021")]);
    const c = await p.file(args(), "k-0000000000000022");
    expect([a.text, b.text, c.text].every((t) => t === a.text)).toBe(true);
    expect(p.calls.filter((c) => c[0] === "primer_create_document")).toHaveLength(1);
    expect(p.calls.filter((c) => c[0] === "primer_add_version")).toHaveLength(1);
    await expect(p.ex.plan({ kind: "primer.publish", args: args({ versionNote: undefined }), requester: codeReview, task: "T-1" })).rejects.toThrow(/versionNote/);
  });
});
