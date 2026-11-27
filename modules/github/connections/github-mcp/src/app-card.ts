// The board's GitHub card rows for the instance's GitHub App (docs/design/github-identity.md "The card"): the App itself (its bot
// and an Install link, or what is broken with Replace, or the suggestion to create one), and each installation with the
// permissions it hasn't accepted yet (until it does, the ops that need them go as the owner there). Read from GitHub, refreshed in
// the background at most every 10 minutes: `lines()` answers at once with the last read.
import type { StatusLine } from "./client.js";
import type { GitHubApp } from "./github-app.js";

const REFRESH_MS = 10 * 60_000;
const HINT = "AidenHQ can act on GitHub as its own App, so the fleet's work doesn't spend your rate limit or carry your name.";

export function appCard(app: Pick<GitHubApp, "configured" | "identity" | "installations" | "failure">, now: () => number = Date.now) {
  let rows: StatusLine[] = [];
  let at = 0;
  let running = false;
  async function refresh() {
    running = true;
    try {
      if (!app.configured()) { rows = [{ label: "GitHub App", value: "not set up: the fleet acts on GitHub as you", state: "ok", hint: HINT, action: { label: "Create the App", admin: "/setup/github-app" }, dismiss: "github-app" }]; return; }
      const bot = await app.identity().catch(() => undefined);
      const installs = bot ? await app.installations().catch(() => undefined) : undefined;
      const failure = app.failure();
      const slug = bot?.login.replace(/\[bot\]$/, "");
      const out: StatusLine[] = [failure || !bot
        ? { label: "GitHub App", value: `${bot ? `@${bot.login} ` : ""}isn't working: ${failure ?? "GitHub didn't say who it is"}`, state: "warn", action: { label: "Replace", admin: "/setup/github-app" } }
        : { label: "GitHub App", value: `@${bot.login}`, state: "ok", action: { label: "Install", href: `https://github.com/apps/${encodeURIComponent(slug!)}/installations/new` } }];
      for (const i of (installs ?? []).sort((a, b) => a.account.localeCompare(b.account))) {
        const where = i.repos === "all" ? "all repositories" : "selected repositories";
        out.push(i.lagging.length
          ? { label: `App on ${i.account}`, value: `${where}; accept its new permissions (${i.lagging.join(", ")}): until then the ops that need them act as you there`, state: "warn", action: { label: "Review", href: i.html_url } }
          : { label: `App on ${i.account}`, value: where, state: "ok", action: { label: "Configure", href: i.html_url } });
      }
      rows = out;
    } finally { at = now(); running = false; }
  }
  return {
    lines(): StatusLine[] {
      if (!running && now() - at >= REFRESH_MS) void refresh();
      return rows;
    },
    refresh,
  };
}
