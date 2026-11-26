// Issue identity: the store remembers each marker's issue number per repo, the pass task lists the app's current repo's, and a
// changed repo starts afresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../service/src/store.ts";
import { createPasses, readApps, type App } from "../service/src/passes.ts";
import { designTools } from "../service/src/tools.ts";
import { fakeKernel } from "./kernel.fake.ts";

test("a noted issue number wins over search, and a changed repo starts afresh", async () => {
  const store = openStore(mkdtempSync(join(tmpdir(), "design-")));
  let apps: App[] = readApps(JSON.stringify({ apps: [{ name: "acme", url: "https://acme.example.com", repo: "Acme/App" }] })).apps;
  const k = fakeKernel();
  const passes = createPasses({ store, apps: () => apps, logins: () => ({}), kernel: k.passes, boardUrl: "https://board.example.com/" });
  const tools = new Map(designTools(store, { passes, apps: () => apps, logins: () => ({}) }).map((t) => [t.name, t]));
  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args, { agent: "ui-agent", roles: [] });

  await call("design_issue_note", { app: "acme", marker: "aidenhq-ui:design:acme", repo: "acme/app", number: 41 });
  await assert.rejects(call("design_issue_note", { app: "acme", marker: "aidenhq-ui:design:beta", repo: "acme/app", number: 2 }), /marker/);
  const first = (await call("design_pass_start", { app: "acme", depth: "scan" })) as { run: string; task: string };
  const text = k.byId(first.task).description;
  assert.match(text, /aidenhq-ui:design:acme → acme\/app#41/);
  assert.match(text, /https:\/\/board\.example\.com\/#\/team\/m\/ui-testing \(run r-/);
  assert.deepEqual(((await call("design_run", { run: first.run })) as { issues: unknown[] }).issues, [{ app: "acme", repo: "acme/app", marker: "aidenhq-ui:design:acme", number: 41 }]);

  k.close(first.task, "done"); store.endPass(first.run, "failed", "test");
  apps = readApps(JSON.stringify({ apps: [{ name: "acme", url: "https://acme.example.com", repo: "acme/new" }] })).apps;
  const second = (await call("design_pass_start", { app: "acme", depth: "scan" })) as { task: string };
  assert.doesNotMatch(k.byId(second.task).description, /#41/);
  assert.match(k.byId(second.task).description, /Issues in acme\/new: none filed yet/);
});
