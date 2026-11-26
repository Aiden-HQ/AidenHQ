// The UI testing page's own tools (the module view ui://design/page, docs/design/board-ui.md "Modules"): design_overview reads
// each app's settings, today's spend against its cap, its running pass and its last run; design_configure proposes the whole
// settings.ui_testing as one typed change, which the board files on the owner's Save (structuredContent._aidenhq.settings_change).
// Nothing is filed here. Logins are never read back: only whether one is set (the board's Sign-ins panel writes them).
import type { Tool } from "./mcp.ts";
import type { Store } from "./store.ts";
import { readApps, type App, type Login } from "./passes.ts";

type Dict = Record<string, unknown>;
const obj = (properties: object, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export interface OverviewDeps {
  store: Store;
  apps: () => App[];
  logins: () => Record<string, Login>;
  /** What the app's passes billed in the current UTC day: the scheduler's own sum of the gateway ledger. */
  spentToday: (app: string) => Promise<number>;
}

/** An app's last ended run, as the page's list shows it. */
function lastRun(store: Store, app: string) {
  const row = store.runs({ app, limit: 20 }).runs.find((r) => r.status !== "running");
  if (!row) return undefined;
  const report = (store.run(row.id).report ?? {}) as Dict;
  const list = (k: string) => (Array.isArray(report[k]) ? (report[k] as Dict[]) : []);
  const cov = (report.coverage ?? {}) as Dict;
  return {
    run: row.id, ended: row.ended ?? row.started, status: row.status,
    improvements: list("improvements").length, bugs: list("bugs").filter((b) => b.verified !== false).length,
    coverage: { done: Number(cov.done ?? 0), total: Number(cov.total ?? 0) },
    cost_usd: row.cost_usd ?? 0,
  };
}

export function overviewTools(d: OverviewDeps): Tool[] {
  return [
    {
      name: "design_overview",
      description: "Every app set up for UI testing: its settings (url, repo, schedule, spend mode, live-app mode, daily cap, models, recording), today's spend, whether a login is set, its running pass and its last run's summary.",
      inputSchema: obj({}),
      run: async () => {
        const logins = d.logins();
        const apps = await Promise.all(d.apps().map(async (a) => {
          const active = d.store.runs({ app: a.name, limit: 20 }).runs.find((r) => r.kind === "pass" && r.status === "running");
          const last = lastRun(d.store, a.name);
          return {
            name: a.name, url: a.url, ...(a.repo ? { repo: a.repo } : {}), aidenhq_app: a.aidenhq_app,
            schedule: a.schedule, spend: a.spend, live_mode: a.live_mode, day_cap_usd: a.day_cap_usd, models: a.models, recording: a.recording,
            today_usd: await d.spentToday(a.name), login: Boolean(logins[a.name]),
            ...(active ? { active: { run: active.id, started: active.started } } : {}),
            ...(last ? { last } : {}),
          };
        }));
        return { apps };
      },
    },
    {
      name: "design_configure",
      description: "Propose the apps tested by the UI Reviewer (settings.ui_testing), the whole list: { apps: [{ name, url, repo?, aidenhq_app?, live_mode?, schedule?, day_cap_usd?, spend?, models?, recording? }] }. Checked as the service reads it; the owner saves it from the UI testing page.",
      inputSchema: obj({ apps: { type: "array", items: { type: "object" } } }, ["apps"]),
      run: async (a, who) => {
        if (who.kind !== "owner") throw new Error("the apps under UI testing are the owner's: they set them on the UI testing page");
        if (!Array.isArray(a.apps)) throw new Error("apps is the whole list of apps");
        const value = { apps: a.apps as Dict[] };
        const { errors } = readApps(JSON.stringify(value));
        if (errors.length) throw new Error(errors.join("; "));
        const was = new Set(d.apps().map((x) => x.name)), now = new Set(value.apps.map((x) => String(x.name)));
        const changes = [...[...now].filter((n) => !was.has(n)).map((n) => `add ${n}`), ...[...was].filter((n) => !now.has(n)).map((n) => `remove ${n}`)];
        return { changes: changes.length ? changes : ["update the apps' settings"], _aidenhq: { settings_change: [{ kind: "setting", key: "ui_testing", value }] } };
      },
    },
  ];
}
