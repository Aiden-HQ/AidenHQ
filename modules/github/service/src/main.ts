// codehost-github's service (module.yaml services): reads its files and settings, then serves service.ts.
//   CODEHOST_KEY_FILE       the module's own token: the kernel calls the executor with it, and it reports outcomes with it
//   GITHUB_APP_DIR          the App's vault dir (app_id, key.pem); absent: every GitHub action fails, saying so
//   TASKS_DIR               the job workspaces (work/tasks); absent: push, pr and clone fail, saying so
//   CACHE_DIR               the bare cache clones (its data dir)
//   AGENTS_ORG, INSTANCE_REPO, PRODUCT_REPO
//   GITHUB_MAINTAINER_REPOS the maintained repos (setting maintainer_repos): those with dependabot on get the PR watch's Dependabot duty
//   OWNER_NAME              who the design reviewer's task says approved a merge that doesn't wait for it
// Its loops start here: the merge queue, the release train, the PR watch, the design reviews' sweep and the
// reviewed refs' tidying.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { appClient, inOrg } from "./github-app.ts";
import { parseRepos } from "./aidenhq-sdk/maintained-repos.ts";
import { createService } from "./service.ts";
import { startPrWatch } from "./pr-watch.ts";
import { startTidy } from "./tidy.ts";

const env = process.env;
const read = (f?: string) => (f && existsSync(f) ? readFileSync(f, "utf8").trim() : "");
const log = (msg: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ svc: "github", msg, ...f }));
const key = read(env.CODEHOST_KEY_FILE);
if (!key) throw new Error("codehost-github: CODEHOST_KEY_FILE is empty");
const appDir = env.GITHUB_APP_DIR ?? "";
const app = appDir && read(join(appDir, "app_id")) && read(join(appDir, "key.pem")) ? appClient({ appId: read(join(appDir, "app_id")), key: read(join(appDir, "key.pem")), log }) : undefined;
const agentsOrg = env.AGENTS_ORG ?? "";
const gh = async (method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(`https://api.github.com${path}`, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})), remaining: Number(r.headers.get("x-ratelimit-remaining") ?? NaN) };
};

const handle = createService({
  key, kernelUrl: env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", cacheDir: env.CACHE_DIR ?? "/cache", tasksDir: env.TASKS_DIR || undefined,
  app, gh, agentsOrg, allowedOrgs: (env.ALLOWED_ORGS ?? "").split(",").filter(Boolean), instanceRepo: env.INSTANCE_REPO || undefined,
  productRepo: env.PRODUCT_REPO || undefined, selfName: env.OWNER_NAME || undefined,
  churnExclude: (env.CHURN_EXCLUDE ?? "").split(",").map((g) => g.trim()).filter(Boolean),
  log,
});
log("starting", { app: Boolean(app), tasks: Boolean(env.TASKS_DIR), agentsOrg });
const cacheDir = env.CACHE_DIR ?? "/cache";
handle.startMerges();
handle.startReleases();
handle.startDesignReviews();
handle.startFlow();
startTidy({ cacheDir, log });
// The fleet's own PRs (the product repo; Dependabot's tasks, an agent's PR that conflicts) and the Dependabot PRs of every maintained
// repo with dependabot on: only with the App and the product repo set. A maintained repo in the agents org is the fleet's own.
if (app && env.PRODUCT_REPO) {
  const repos = new Map<string, "all" | "dependabot">([[env.PRODUCT_REPO, "all"]]);
  for (const m of parseRepos(env.GITHUB_MAINTAINER_REPOS ?? "")) {
    if (m.dependabot && !repos.has(m.repo)) repos.set(m.repo, inOrg(agentsOrg, m.repo) ? "all" : "dependabot");
  }
  startPrWatch({ repos: [...repos].map(([repo, duties]) => ({ repo, duties })), kernelUrl: env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", key, cacheDir, app, gh, log, flow: handle.flow });
}
const server = createServer((req, res) => void handle(req, res));
server.listen(Number(env.PORT ?? 8100), "0.0.0.0");
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
