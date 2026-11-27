// The chooser (github-mcp client.ts actorFor) over a test's fake access: the owner everywhere, or the App where `app.on(repo, op)`
// says it is installed and permitted. Each actor's calls go through the fake's own rest, marked with whose they are (`as`).
const DOCS: Record<string, string> = { CREATE_COMMIT: "mutation createCommitOnBranch", UPDATE_REFS: "mutation updateRefs", DEQUEUE: "mutation dequeuePullRequest" };

type Rest = (method: string, path: string, body?: any, o?: any) => Promise<{ status: number; body: any; headers: Headers }>;
export function withActors<A extends { rest: Rest; identity: () => Promise<{ login: string; name: string; email: string }>; token: () => Promise<string> }>(access: A, app?: { on: (repo: string, op: string) => boolean; rest: Rest; botId?: number; login?: string; tokens?: string[] }) {
  const actor = (kind: "owner" | "app") => {
    const rest: Rest = kind === "app" ? app!.rest : (m, p, b, o) => access.rest(m, p, b, o);
    return {
      kind, key: kind === "app" ? "app:55" : "owner", ...(kind === "app" ? { botId: app!.botId ?? 900 } : {}),
      identity: kind === "app" ? async () => ({ login: app!.login ?? "acme-app[bot]", name: app!.login ?? "acme-app[bot]", email: "900+acme-app[bot]@users.noreply.github.com" }) : () => access.identity(),
      rest,
      graphql: async (query: string, variables: Record<string, unknown>) => (await rest("POST", "/graphql", { query, variables })).body,
      mutate: (name: string, variables: Record<string, unknown>) => rest("POST", "/graphql", { query: DOCS[name], variables }),
      gitToken: kind === "app" ? async () => (app!.tokens?.push("app"), "app-token") : async () => (app?.tokens?.push("owner"), access.token()),
    };
  };
  return Object.assign(access, {
    actorFor: async (target: { repo?: string; org?: string }, op: string) => actor(app && target.repo && app.on(target.repo, op) ? "app" : "owner"),
    actorByKey: async (key: string) => actor(key.startsWith("app:") ? "app" : "owner"),
  });
}
