// What code review files for a post or reply: the instance's hosts, home paths and addresses a review quotes from the PR are
// removed first, so a quoted fixture address never blocks the post (the kernel's instance-details check is the backstop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernelPoster } from "../service/src/adapters.ts";

test("a review's quoted address, path and tailnet host are removed from what is filed; clean text and the target are untouched", async () => {
  const filed: any[] = [];
  const kernel = { call: async (_m: string, path: string, body: any) => (path === "/v1/tasks" ? { id: "T-1" } : (filed.push(body), { id: "w-1", state: "claimed" })) } as any;
  const poster = kernelPoster(kernel);
  const review = { repo: "acme/app", pr: 1, head: "a".repeat(40), findings: [{ id: "f1", title: "Fixture uses 192.168.1.10", why: "reads /home/runner/work/x.json on agents.acme.ts.net and fd7a:115c:a1e0::5", evidence: "ok" }] };
  await poster.post({ run: "r1", target: { repo: "acme/app", number: 1, head: "a".repeat(40) }, review: review as any, previous: null, gated: false });
  await poster.reply({ repo: "acme/app", number: 1, head: "a".repeat(40), comment: 9, body: "Fixed: moved it off 10.0.0.7" });
  const text = JSON.stringify(filed);
  for (const leak of ["192.168.1.10", "/home/runner", "agents.acme.ts.net", "fd7a:115c:a1e0::5", "10.0.0.7"]) assert.ok(!text.includes(leak), leak);
  assert.match(filed[0].args.review.findings[0].title, /Fixture uses \[instance detail removed\]/);
  assert.equal(filed[0].args.repo, "acme/app");
  assert.equal(filed[1].args.body, "Fixed: moved it off [instance detail removed]");
});
