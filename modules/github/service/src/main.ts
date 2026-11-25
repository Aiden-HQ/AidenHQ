// The GitHub process (module.yaml services.github): github-mcp's two connections and sign-in (8086, 8087) and the code host
// (8100) in one Node process, sharing the owner's one sign-in (spec 2026-11-20-github-owner-identity §1). Reads its files and
// settings, then serves service.ts.
//   CODEHOST_KEY_FILE       the module's own token: the kernel calls the executor with it, and it reports outcomes with it
//   TASKS_DIR               the job workspaces (work/tasks, read-only: their boxes' bundles); absent: push and pr fail, saying so
//   CACHE_DIR               the bare cache clones and the held writes (its data dir)
//   GITHUB_FLEET_ORG        github_fleet_org: where the fleet's repos live on GitHub ("" while unset)
//   INSTANCE_REPO, PRODUCT_REPO
//   GITHUB_MAINTAINER_REPOS the maintained repos (setting maintainer_repos): the fleet merges and closes there
//   GITHUB_RELEASE_WINDOW_MINUTES release_window_minutes: the release train's batch window (minutes)
//   GITHUB_REVIEW_GATED     the repos code review gates (comma-separated; compile derives it): their merges wait for its verdict,
//                           asked with the module's own token
// Its loops start here: the change feed (feed.ts: the one timer-driven reader of GitHub, which also schedules the src_github sync
// and Flow's churn and backfill, and feeds Flow, the design reviews and the release train in-process), the merge queue, the held
// writes, the release train's kernel-only minute, the design reviews' retries and the reviewed refs' tidying. The PR watch is the
// ship module's (modules/ship): it reaches GitHub, code review's verdict and pr-tasks.json through /internal/ship/* here
// (ship-routes.ts), with its own module token.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mergeable } from "./git-auth.ts";
// github-mcp's built entry (the image builds it beside this tree): it starts both connections and hands back the owner's access.
import { startGithubMcp } from "../../connections/github-mcp/dist/src/main.js";
import { parseRepos } from "./aidenhq-sdk/maintained-repos.ts";
import { createService, reviewerOf, shipAdoptions } from "./service.ts";
import { gitHubApp } from "../../connections/github-mcp/dist/src/github-app.js";
import { join } from "node:path";
import { createReviewGate } from "./review-gate.ts";
import { serveOps } from "./ops.ts";
import { shipRoutes } from "./ship-routes.ts";
import { isModule } from "../../connections/github-mcp/dist/src/module-caller.js";
import { startTidy } from "./tidy.ts";
import { createFeed } from "./feed.ts";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";

const env = process.env;
const read = (f?: string) => (f && existsSync(f) ? readFileSync(f, "utf8").trim() : "");
const log = (msg: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ svc: "github", msg, ...f }));
const key = read(env.CODEHOST_KEY_FILE);
if (!key) throw new Error("github: CODEHOST_KEY_FILE is empty");
const { access, reportNeed, sync, sources } = await startGithubMcp();
const fleetOrg = env.GITHUB_FLEET_ORG ?? "";

// A list the parser refuses (an old key after an upgrade) leaves no repo maintained and says why, rather than taking the code host down.
const maintained = (() => { try { return parseRepos(env.GITHUB_MAINTAINER_REPOS ?? ""); } catch (e) { log("maintainer_repos refused: no repo is maintained until it is fixed", { err: String((e as Error).message).slice(0, 300) }); return []; } })();
// compile always sets it (module.yaml's default, 5-1440): anything else is a broken deploy, so fail loudly.
const releaseWindowMinutes = Number(env.GITHUB_RELEASE_WINDOW_MINUTES);
if (!Number.isInteger(releaseWindowMinutes) || releaseWindowMinutes < 1) throw new Error(`github: GITHUB_RELEASE_WINDOW_MINUTES is not a positive number of minutes: ${env.GITHUB_RELEASE_WINDOW_MINUTES}`);
// Code review's verdict for the merge queue and for ship's watch loop (/internal/ship/verdict) alike.
const reviewGate = createReviewGate({ gated: (env.GITHUB_REVIEW_GATED ?? "").split(",").filter(Boolean), url: "http://code-review:8098", key: () => key });
const githubApp = gitHubApp({ dir: join(env.GITHUB_STATE_DIR ?? "/state", "github-app") });
const handle = createService({
  key, kernelUrl: env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", cacheDir: env.CACHE_DIR ?? "/cache", tasksDir: env.TASKS_DIR || undefined,
  access, reportNeed, ops: serveOps, fleetOrg, allowedOrgs: (env.ALLOWED_ORGS ?? "").split(",").filter(Boolean), instanceRepo: env.INSTANCE_REPO || undefined,
  productRepo: env.PRODUCT_REPO || undefined, maintained: maintained.map((r) => r.repo), releaseWindowMinutes,
  churnExclude: (env.CHURN_EXCLUDE ?? "").split(",").map((g) => g.trim()).filter(Boolean),
  reviewGate,
  // The ship module's adoptions, only while it is on (compiled): absent, every write naming an adoption is refused.
  ...(env.GITHUB_SHIP === "1" ? { ship: shipAdoptions({ url: "http://ship:8101", key: () => key }) } : {}),
  // The reviewer identity is the owner's one GitHub App (the one code review posts as), where it is installed.
  reviewer: reviewerOf(githubApp), app: githubApp,
  log,
});
log("starting", { connected: access.connected(), tasks: Boolean(env.TASKS_DIR), fleetOrg });
const cacheDir = env.CACHE_DIR ?? "/cache";
handle.startMerges();
handle.startHeld();
handle.startReleases();
handle.startDesignReviews();
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
const feed = createFeed({
  gh: access.rest, cacheDir, kernel: kernelClient(kernelUrl, key), log,
  // The repos the code host manages, the maintained ones included: always watched.
  // Signed out, the set can't be read: the feed keeps what it watched (and its state) until GitHub is back.
  managed: async () => {
    if (!access.connected()) throw new Error("GitHub isn't connected");
    return [...new Set([...(await handle.managedRepos()), ...maintained.map((r) => r.repo.toLowerCase())])];
  },
  kindOf: (who, association, repo, seen) => handle.flow.kindOf(who, association, repo, seen),
  member: (who, association, repo) => handle.flow.isMember(who, association, repo),
  started: (repo, prs, head, at) => { for (const n of prs) handle.flow.checksStarted(repo, n, head, at); },
  hooks: [
    handle.flow.observe({ runs: (repo, sha) => feed.runs(repo, sha), rollup: (repo, sha) => feed.rollup(repo, sha) }),
    handle.designReviews.observe({ pr: (repo, n) => feed.pr(repo, n) }),
    // The train reads instance.yaml again when the instance repo's default branch moves.
    (e) => { if (e.kind === "push" && env.INSTANCE_REPO && e.resource === env.INSTANCE_REPO.toLowerCase()) void handle.train?.refresh(String(e.data?.after ?? "") || undefined).catch((err: Error) => log("instance.yaml read failed", { err: err.message.slice(0, 200) })); },
  ],
  ...(sources ? { record: (scope: string, fn: () => Promise<number>) => sources.run("github_feed", scope, fn) } : {}),
  background: [
    ...(sync ? [{ name: "src_github sync", first: 30_000, run: sync }] : []),
    { name: "churn", first: 60_000, run: () => handle.flow.churnPass() },
  ],
});
handle.useFeed(feed);
// A write this process makes (a status, a re-run, an update-branch, a merge) reads that repo again within 15 s.
access.onWrite((_method, path) => { const m = /^\/repos\/([^/]+\/[^/?]+)(\/[^?]*)?/.exec(path); if (m) feed.touch(m[1]!, /\/(statuses|rerun|rerequest|update-branch|merge)\b/.test(m[2] ?? "")); });
feed.start();
startTidy({ cacheDir, log });
const ship = shipRoutes({
  gh: access.rest, decision: handle.shipDecision, gate: reviewGate, cacheDir,
  allowed: (repo) => mergeable(repo, fleetOrg, env.PRODUCT_REPO || undefined, maintained.map((r) => r.repo)),
  isShip: (auth) => isModule(kernelUrl, auth, "ship"),
});
const server = createServer((req, res) => void ship(req, res).then((done) => done || handle(req, res)));
server.listen(Number(env.PORT ?? 8100), "0.0.0.0");
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
