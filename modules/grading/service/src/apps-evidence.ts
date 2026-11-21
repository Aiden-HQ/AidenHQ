// An app deliverable's evidence for the grader, from apps-mcp with this module's own token (role apps.read, apps-mcp readers.ts):
// an app's status row, the one app of a repo, every deploy of one commit and the live view of one page.
type Json = any;
/** apps-mcp's /internal API as this module calls it. */
export type AppsCall = (method: string, path: string, body?: unknown) => Promise<Json>;

export function appsEvidence(apps: AppsCall) {
  const status = (): Promise<{ name: string; repo?: string }[]> => apps("GET", "/internal/status");
  return {
    // null: the registry was read and has no such app. undefined: the registry could not be read, so nothing is known. The
    // two are never the same answer: a timeout or a 500 from apps-mcp is unavailable evidence, not "this ref is not an app".
    app: async (name: string): Promise<{ name: string; repo?: string } | null | undefined> => {
      const rows = await status().catch(() => undefined);
      return rows ? (rows.find((a) => a.name === name) ?? null) : undefined;
    },
    // Several apps in one repo: no single app vouches for the PR.
    appOfRepo: async (repo: string) => {
      const same = (await status()).filter((a) => a.repo?.toLowerCase() === repo.toLowerCase());
      return same.length === 1 ? same[0]! : null;
    },
    // Every deploy of one exact commit, over apps-mcp's whole deploy table (the status row's list is bounded).
    deployHistory: async (name: string, sha: string) => (await apps("GET", `/internal/deploys/${name}/${sha}`)).deploys ?? [],
    view: (name: string, path: string, cap?: number) => apps("POST", "/internal/view", { name, path, ...(cap ? { cap } : {}) }),
  };
}
