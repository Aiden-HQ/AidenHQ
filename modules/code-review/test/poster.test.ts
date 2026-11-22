// What code review files for a post or reply: the instance's hosts, home paths and addresses a review quotes in its comment text
// are removed first, so a quoted fixture address never blocks the post; the PR's own names (repo, file paths) stay as they are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernelPoster } from "../service/src/adapters.ts";

test("comment text loses its instance details in one pass and never grows; the target and anchors are untouched", async () => {
  const filed: any[] = [];
  const kernel = { call: async (_m: string, path: string, body: any) => (path === "/v1/tasks" ? { id: "T-1" } : (filed.push(body), { id: "w-1", state: "claimed" })) } as any;
  const poster = kernelPoster(kernel);
  const title = `${"t".repeat(191)} 10.0.0.7`;
  const review = { repo: "acme/app", pr: 1, head: "a".repeat(40), coverage: { reviewed: [], excluded: [], incomplete: "failed at /home/ci/agents.acme.ts.net/log" }, stale_guidance: ["see fd12::34"],
    findings: [{ id: "f1", path: "fixtures/192.0.2.10.json", title, why: "reads /home/runner/work/x.json on agents.acme.ts.net and fd7a:115c:a1e0::5", evidence: "ok" }] };
  await poster.post({ run: "r1", target: { repo: "acme/app", number: 1, head: "a".repeat(40) }, review: review as any, previous: null, gated: false });
  await poster.reply({ repo: "acme/app", number: 1, head: "a".repeat(40), comment: 9, body: "Fixed: moved it off 10.0.0.7" });
  const text = JSON.stringify(filed.map((f) => ({ ...f, args: { ...f.args, review: f.args.review && { ...f.args.review, findings: f.args.review.findings.map(({ path, ...rest }: any) => rest) } } })));
  for (const leak of ["10.0.0.7", "/home/", "agents.acme.ts.net", "fd7a:115c", "fd12::34"]) assert.ok(!text.includes(leak), leak);
  const f = filed[0].args.review.findings[0];
  assert.equal(f.path, "fixtures/192.0.2.10.json", "the anchor is the PR's own file path");
  assert.ok(f.title.length <= title.length && f.title.endsWith("[x]"));
  assert.equal(filed[0].args.review.coverage.incomplete, "failed at [x]");
  assert.equal(filed[1].args.body, "Fixed: moved it off [x]");
});
