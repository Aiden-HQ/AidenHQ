import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { publisher } from "../src/publish.js";
import { reportRoute, type Reports } from "../src/report.js";
import type { Owners } from "../src/owners.js";

const memoryReports = (): Reports => { const m = new Map<string, string>(); return { get: (r) => m.get(r.toLowerCase()), set: (r, id) => void m.set(r.toLowerCase(), id) }; };
const noOwners: Owners = { get: () => undefined, set: () => {}, documentsOf: () => [] };

/** A kernel that files primer.publish records through the real planner and executor, deciding them at once. */
function fakeKernel() {
  const privates: string[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  let n = 0;
  const ex = publisher(async (name, args) => {
    calls.push([name, args]);
    return name === "primer_create_document" ? { text: `{"documentId":"doc-${++n}-aaaa","url":"https://primer.example/d/doc-${n}-aaaa"}` } : { text: `{"versionNumber":${calls.filter((c) => c[0] === "primer_add_version").length + 1},"url":"https://primer.example/d/${args.documentId}"}` };
  }, noOwners, async (id) => void privates.push(id));
  const records: any[] = [];
  const call = async (method: string, path: string, body?: any) => {
    if (path === "/v1/tasks") return { id: "task-1" };
    if (path === "/v1/writes") {
      const requester = { agent: "", key: "", name: "", roles: [], kind: "module", module: "primer" };
      const plan = await ex.plan({ kind: body.kind, args: body.args, requester, task: body.task });
      await new Promise((r) => setTimeout(r, 5)); // the review takes a moment: concurrent filings overlap
      const out = await ex.execute({ id: "k-1", kind: body.kind, args: plan.args, digest: "d", idempotency_key: "k-1" });
      const rec = { id: `w-${records.length}`, state: out.ok ? "done" : "failed", outcome: out, plan };
      records.push(rec);
      return rec;
    }
    throw new Error(`${method} ${path}`);
  };
  return { call, calls, records, privates };
}

let server: Server | undefined;
afterEach(() => void server?.close());
async function serve(over: { module?: boolean | undefined; kernel?: ReturnType<typeof fakeKernel>; reports?: Reports } = {}) {
  const k = over.kernel ?? fakeKernel();
  const route = reportRoute({ kernelUrl: "http://kernel", call: k.call, reports: over.reports ?? memoryReports(), isModule: async (_u, _a, m) => (m === "code-review" ? ("module" in over ? over.module : true) : false), pollMs: 1 });
  server = createServer(async (req, res) => { if (!(await route(req, res))) res.writeHead(404).end(); }).listen(0);
  const port = (server.address() as AddressInfo).port;
  const post = async (b: object) => { const r = await fetch(`http://127.0.0.1:${port}/internal/report`, { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(b) }); return { status: r.status, json: (await r.json()) as any }; };
  return { post, k };
}
const report = (over: object = {}) => ({ repo: "acme/widgets", title: "Repo review: acme/widgets", content: "# Verdict\n", versionNote: "abc1234 2026-11-22", ...over });

describe("POST /internal/report", () => {
  it("rejects callers that aren't code review's", async () => {
    const denied = await serve({ module: false });
    expect((await denied.post(report())).status).toBe(401);
    expect(denied.k.records).toEqual([]);
    const down = await serve({ module: undefined });
    expect((await down.post(report())).status).toBe(503);
    expect(down.k.records).toEqual([]);
  });

  it("first publish creates a private document, the second adds a version of it at the normal tier", async () => {
    const { post, k } = await serve();
    const first = await post(report());
    expect(first).toMatchObject({ status: 200, json: { documentId: "doc-1-aaaa", version: 1, url: "https://primer.example/d/doc-1-aaaa" } });
    expect(k.calls[0]![0]).toBe("primer_create_document");
    expect(k.privates).toEqual(["doc-1-aaaa"]);
    expect(k.records[0].plan.card.changes).toContain("only its requester");
    const second = await post(report({ documentId: "doc-1-aaaa", content: "# Verdict v2\n" }));
    expect(second).toMatchObject({ status: 200, json: { documentId: "doc-1-aaaa", version: 2 } });
    expect(k.calls[1]).toEqual(["primer_add_version", expect.objectContaining({ documentId: "doc-1-aaaa", versionNote: "abc1234 2026-11-22" })]);
    expect(k.records[1].plan.raise).toBeUndefined();
    expect(k.privates).toEqual(["doc-1-aaaa"]);
    // Never a version of a document that isn't the repo's report.
    expect((await post(report({ documentId: "other-doc-0000" }))).status).toBe(400);
  });

  it("concurrent first publishes for one repo yield one document", async () => {
    const { post, k } = await serve();
    const rs = await Promise.all([post(report()), post(report()), post(report({ repo: "acme/other" }))]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(k.calls.filter((c) => c[0] === "primer_create_document")).toHaveLength(2); // acme/widgets once, acme/other once
    expect(rs[0]!.json.documentId).toBe(rs[1]!.json.documentId);
    expect(rs[1]!.json.version).toBe(2);
    expect(rs[2]!.json.documentId).not.toBe(rs[0]!.json.documentId);
  });
});
