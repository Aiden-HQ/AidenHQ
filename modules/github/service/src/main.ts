// The GitHub process (module.yaml services.github): github-mcp's two connections and sign-in (8086, 8087) and the code host
// (8100) in one Node process, sharing the owner's one sign-in (spec 2026-11-20-github-owner-identity §1). Reads its files and
// settings, then serves service.ts.
//   CODEHOST_KEY_FILE       the module's own token: the kernel calls the executor with it, and it reports outcomes with it
//   TASKS_DIR               the job workspaces (work/tasks, read-only: their boxes' bundles); absent: push and pr fail, saying so
//   CACHE_DIR               the bare cache clones and the held writes (its data dir)
//   GITHUB_FLEET_ORG        github_fleet_org: where the fleet's repos live on GitHub ("" while unset)
//   INSTANCE_REPO, PRODUCT_REPO
//   GITHUB_MAINTAINER_REPOS the maintained repos (setting maintainer_repos): the fleet merges and closes there; those with dependabot on get
//                           the PR watch's Dependabot duty
//   GITHUB_MIGRATE_FROM_APP  the retired App's id, for the one release that moves the repos' rules off it (migrate.ts)
//   GITHUB_REVIEW_GATED     the repos code review gates (comma-separated; compile derives it): their merges wait for its verdict,
//                           asked with the module's own token
// Its loops start here: the merge queue, the held writes, the release train, the PR watch, the design reviews' sweep and the
// reviewed refs' tidying.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { inOrg } from "./git-auth.ts";
// github-mcp's built entry (the image builds it beside this tree): it starts both connections and hands back the owner's access.
import { startGithubMcp } from "../../connections/github-mcp/dist/src/main.js";
import { parseRepos } from "./aidenhq-sdk/maintained-repos.ts";
import { createService, reviewerOf, shipAdoptions } from "./service.ts";
import { gitHubApp } from "../../connections/github-mcp/dist/src/github-app.js";
import { join } from "node:path";
import { createReviewGate } from "./review-gate.ts";
import { serveOps } from "./ops.ts";
import { startAppMigration } from "./migrate.ts";
import { startPrWatch } from "./pr-watch.ts";
import { startTidy } from "./tidy.ts";

const env = process.env;
const read = (f?: string) => (f && existsSync(f) ? readFileSync(f, "utf8").trim() : "");
const log = (msg: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ svc: "github", msg, ...f }));
const key = read(env.CODEHOST_KEY_FILE);
if (!key) throw new Error("github: CODEHOST_KEY_FILE is empty");
const { access, reportNeed } = await startGithubMcp();
const fleetOrg = env.GITHUB_FLEET_ORG ?? "";

const maintained = parseRepos(env.GITHUB_MAINTAINER_REPOS ?? "");
// DELETE in the release after #1065: compile sets GITHUB_MIGRATE_FROM_APP to the retired App's id; the first sign-in with the
// new scopes rewrites the repos' rules that name that App (migrate.ts), and merges hold until then.
const retiredAppId = Number(env.GITHUB_MIGRATE_FROM_APP ?? "");
const migration = retiredAppId > 0
  ? startAppMigration({ access, appId: retiredAppId, cacheDir: env.CACHE_DIR ?? "/cache", fleetOrg, productRepo: env.PRODUCT_REPO || undefined, maintained: maintained.map((r) => r.repo), instanceRepo: env.INSTANCE_REPO || undefined, kernelUrl: env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", key, log })
  : undefined;
const gateOptions = { gated: (env.GITHUB_REVIEW_GATED ?? "").split(",").filter(Boolean), url: "http://code-review:8098", key: () => key };
const reviewGate = createReviewGate(gateOptions);
// The watcher's own gate: its outage timer is separate, so a PR the merge queue never sees can't age the queue's bypass.
const watchGate = createReviewGate(gateOptions);
const handle = createService({
  key, kernelUrl: env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", cacheDir: env.CACHE_DIR ?? "/cache", tasksDir: env.TASKS_DIR || undefined,
  access, reportNeed, holdMerges: () => migration?.pending() ?? false, ops: serveOps, fleetOrg, allowedOrgs: (env.ALLOWED_ORGS ?? "").split(",").filter(Boolean), instanceRepo: env.INSTANCE_REPO || undefined,
  productRepo: env.PRODUCT_REPO || undefined, maintained: maintained.map((r) => r.repo),
  churnExclude: (env.CHURN_EXCLUDE ?? "").split(",").map((g) => g.trim()).filter(Boolean),
  reviewGate,
  // The ship module's adoptions, only while it is on (compiled): absent, every write naming an adoption is refused.
  ...(env.GITHUB_SHIP === "1" ? { ship: shipAdoptions({ url: "http://ship:8101", key: () => key }) } : {}),
  // The reviewer identity is the owner's one GitHub App (the one code review posts as), where it is installed.
  reviewer: reviewerOf(gitHubApp({ dir: join(env.GITHUB_STATE_DIR ?? "/state", "github-app") })),
  log,
});
log("starting", { connected: access.connected(), tasks: Boolean(env.TASKS_DIR), fleetOrg });
const cacheDir = env.CACHE_DIR ?? "/cache";
handle.startMerges();
handle.startHeld();
handle.startReleases();
handle.startDesignReviews();
handle.startFlow();
startTidy({ cacheDir, log });
// The fleet's own PRs (the product repo; Dependabot's tasks, an agent's PR that conflicts) and the Dependabot PRs of every maintained
// repo with dependabot on: whenever the product repo is set. A maintained repo in the fleet org is the fleet's own.
if (env.PRODUCT_REPO) {
  const repos = new Map<string, "all" | "dependabot">([[env.PRODUCT_REPO, "all"]]);
  for (const m of maintained) {
    if (m.dependabot && !repos.has(m.repo)) repos.set(m.repo, inOrg(fleetOrg, m.repo) ? "all" : "dependabot");
  }
  startPrWatch({ repos: [...repos].map(([repo, duties]) => ({ repo, duties })), kernelUrl: env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", key, cacheDir, gh: access.rest, connected: () => access.connected(), log, flow: handle.flow, reviewGate: watchGate });
}
const server = createServer((req, res) => void handle(req, res));
server.listen(Number(env.PORT ?? 8100), "0.0.0.0");
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
