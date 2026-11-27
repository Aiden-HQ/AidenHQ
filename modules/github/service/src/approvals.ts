// The approvals ship's approve write made as the GitHub App, by PR (docs/design/github-identity.md "Approvals"): a session box's
// App token can post a review as the same bot, so an App approval counts toward a merge only when its review id is one recorded
// here (merge-gate.ts approvedAt). Kept in a file beside the code host's other state; the newest 2,000 PRs.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function approvals(dir: string) {
  const file = join(dir, "app-approvals.json");
  const all = (): Record<string, string[]> => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
  const key = (repo: string, n: number) => `${repo.toLowerCase()}#${n}`;
  return {
    /** The review ids the App's approve write made on `repo#n`. */
    of: (repo: string, n: number): string[] => all()[key(repo, n)] ?? [],
    record(repo: string, n: number, id: string | number): void {
      const a = all();
      const k = key(repo, n);
      a[k] = [...new Set([...(a[k] ?? []), String(id)])];
      const kept = Object.fromEntries(Object.entries(a).slice(-2000));
      writeFileSync(`${file}.tmp`, JSON.stringify(kept));
      renameSync(`${file}.tmp`, file);
    },
  };
}
