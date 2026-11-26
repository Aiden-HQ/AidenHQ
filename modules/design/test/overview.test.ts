import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcp } from "../service/src/mcp.ts";
import { openStore } from "../service/src/store.ts";
import { readApps } from "../service/src/passes.ts";
import { overviewTools } from "../service/src/overview.ts";

const acme = { name: "acme", url: "https://acme.example.com" };
const beta = { name: "beta", url: "https://beta.example.com", repo: "acme/beta" };
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

function seed(o: { apps: object[]; todayUsd: Record<string, number> }) {
  const store = openStore(mkdtempSync(join(tmpdir(), "design-")));
  const { apps } = readApps(JSON.stringify({ apps: o.apps }));
  const handle = createMcp("design", overviewTools({ store, apps: () => apps, logins: () => ({}), spentToday: async (a) => o.todayUsd[a] ?? 0 }));
  // The page's calls are the owner's own (the board's view route): structuredContent comes back.
  const call = async (name: string, args: object) => {
    const out = (await handle({ id: 1, method: "tools/call", params: { name, arguments: args as Record<string, unknown> } }, async () => ({ agent: "", key: "", name: "owner", roles: [], tool: name, call: "c", kind: "owner" }))) as { result: { content: { text: string }[]; structuredContent: any; isError?: boolean } };
    if (out.result.isError) throw new Error(out.result.content[0]!.text);
    return out.result;
  };
  return { store, call };
}

test("overview reports each app's state and configure returns one typed change", async () => {
  const { store, call } = seed({ apps: [acme, beta], todayUsd: { acme: 1.2 } });
  const { run } = store.start({ target: acme.url, kind: "review", model: "m", app: "acme", agent: "reviewer" });
  store.finish(run, "reviewer", { improvements: Array(7).fill({}), bugs: [{ verified: true }, { verified: true }], coverage: { done: 12, total: 40 }, cost_usd: 1.2, issues: { design: "https://github.com/acme/app/issues/41", bugs: [] } });
  const o = (await call("design_overview", {})).structuredContent;
  assert.deepEqual(pick(o.apps[0], ["name", "today_usd", "login", "schedule", "spend", "day_cap_usd"]), { name: "acme", today_usd: 1.2, login: false, schedule: "on-request", spend: "standard", day_cap_usd: 5 });
  assert.deepEqual(pick(o.apps[0].last, ["run", "improvements", "bugs", "coverage", "cost_usd", "issue_url"]), { run, improvements: 7, bugs: 2, coverage: { done: 12, total: 40 }, cost_usd: 1.2, issue_url: "https://github.com/acme/app/issues/41" });
  assert.equal(o.apps[1].last, undefined);
  const c = (await call("design_configure", { apps: [{ ...acme, schedule: "after-deploy" }, beta] })).structuredContent;
  const [change] = c._aidenhq.settings_change;
  assert.deepEqual(pick(change, ["kind", "key"]), { kind: "setting", key: "ui_testing" });
  assert.equal(change.value.apps[0].schedule, "after-deploy");
  await assert.rejects(call("design_configure", { apps: [{ ...acme, day_cap_usd: 500 }] }), /day_cap_usd/);
});
