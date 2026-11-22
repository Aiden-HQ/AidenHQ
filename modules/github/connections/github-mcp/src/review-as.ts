// Who code review posts as, per repo (what review-post.ts's writer last picked, kept in <state>/review-as.json), and the GitHub
// card's rows from it: the App, and per org whether code review posts there as the App or as the owner. Where it posts as the
// owner, the row suggests the App (create it, or install it there); the board drops that suggestion once the owner dismisses it
// for that org (the row's `dismiss` key). Only a broken App needs the owner (its row warns); every other row is `ok`.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { StatusLine } from "./client.js";
import type { GitHubApp } from "./github-app.js";

const HINT = "Code review can post as its own GitHub App, so it doesn't share your write limit.";

export function reviewAs({ file, app }: { file: string; app: Pick<GitHubApp, "slug" | "failure"> }) {
  let byRepo: Record<string, "owner" | "app"> = {};
  try { if (existsSync(file)) byRepo = JSON.parse(readFileSync(file, "utf8")) as typeof byRepo; } catch { byRepo = {}; }
  return {
    /** Best effort: the card's record never fails a review, and a write that failed is tried again on the next one. */
    record(repo: string, identity: "owner" | "app"): void {
      const k = repo.toLowerCase();
      if (byRepo[k] === identity) return;
      const next = { ...byRepo, [k]: identity };
      try {
        writeFileSync(`${file}.tmp`, JSON.stringify(next));
        renameSync(`${file}.tmp`, file);
        byRepo = next;
      } catch { /* the card shows the last saved record until a later write lands */ }
    },
    lines(): StatusLine[] {
      const slug = app.slug(), failure = app.failure();
      const install = slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : undefined;
      const out: StatusLine[] = [];
      // A broken App (its key, a suspension, a refusal) fails code review's writes where it is installed: that is the owner's to fix.
      if (failure) out.push({ label: "Code review App", value: `${slug ? `@${slug}[bot] ` : ""}isn't working: ${failure}`, state: "warn", action: { label: "Replace", admin: "/setup/github-app" } });
      else if (slug) out.push({ label: "Code review App", value: `@${slug}[bot]`, state: "ok", action: { label: "Install", href: install! } });
      const orgs = new Map<string, { app: number; all: number }>();
      for (const [repo, as] of Object.entries(byRepo)) {
        const o = repo.split("/")[0]!;
        const c = orgs.get(o) ?? { app: 0, all: 0 };
        c.all++;
        if (as === "app") c.app++;
        orgs.set(o, c);
      }
      for (const [org, c] of [...orgs].sort(([a], [b]) => a.localeCompare(b))) {
        const value = c.app === c.all ? "posts as the App" : c.app === 0 ? "posts as you" : `posts as the App on ${c.app} of ${c.all} repos`;
        const line: StatusLine = { label: `Code review in ${org}`, value, state: "ok" };
        if (c.app < c.all) {
          line.hint = HINT;
          line.action = install ? { label: "Install the App", href: install } : { label: "Create the App", admin: "/setup/github-app" };
          line.dismiss = `review-app:${org}`;
        }
        out.push(line);
      }
      return out;
    },
  };
}
