import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { repoAllowed, useEngines } from "../agents.mjs";
import { loadConfig } from "../config.mjs";
import { repoKey } from "../../../../kernel/src/kinds.ts";
import { kernelJobs, readEngines } from "../engines.mjs";
import { jailProblem } from "../../../../kernel/src/sandbox.ts";
import { sandboxConfig } from "../../../../kernel/src/sandbox-config.ts";
import { setGitAuth, setUntrusted } from "../../../../modules/codehost-github/src/git.mjs";
import { DEFAULT_IDENTITY, WRITE, appClient, ghOptions, mergeOptions, ownRepo as appOwnRepo, pushPermissions } from "../../../../modules/codehost-github/src/github-app.ts";
import { Paperclip } from "../paperclip.ts";
import { createMetrics } from "../metrics.ts";
import { Board } from "../recurring.ts";
import { State } from "../state.ts";
import { normalizeRepo } from "../../../../modules/codehost-github/src/repos.ts";

const execFileP = promisify(execFile);
const cfg = loadConfig();
const pc = new Paperclip(cfg);
const state = new State(cfg.stateDir);
const log: any = (msg: any, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
// Engineer jobs run in the kernel (kernel/src/jobs.ts): the runner asks for them and follows them.
const jobsApi = kernelJobs(cfg);
// The reviewer-eval gate's runs (evalgate.ts) use the same sandbox, launched here: in its own network when that works.
const evalSandbox = sandboxConfig();
if (jailProblem(evalSandbox)) evalSandbox.pasta = undefined;
// The instance's GitHub App: its key stays in this process; tokens go only to the git/gh child that needs one,
// and a read-only one for its task's repos to each job's gh (jobGhToken).
const app = cfg.githubApp && appClient({ appId: readFileSync(cfg.githubApp.appIdFile, "utf8").trim(), key: readFileSync(cfg.githubApp.keyFile, "utf8"), log });
/**
 * The App when an installation of it includes this repo; undefined → the old path (host gh login, deploy keys). The App
 * is public: installations outside the agents org and allowed_orgs (strangers') are ignored.
 */
async function appFor(slug: any) {
  const repo = normalizeRepo(slug ?? "");
  return app && repo && repoAllowed(repo, cfg.allowed_orgs) && (await app.covers(repo.slug).catch((err: any) => (log("github app check failed", { repo: repo.slug, err: String(err.message).slice(0, 200) }), false))) ? app : undefined;
}
const gho = async (slug: any, perms: any, extra?: any) => ghOptions(await appFor(slug), slug, perms, extra);
// Outside our own repos (github-app.ts ownRepo) the App only pushes and opens PRs. Their reviewers are us, so internal names
// are fine there too.
/** One repository however written (kernel/src/kinds.ts repoKey: the kernel holds the runner's writes with the same key). */
const sameRepo = (a: any, b: any) => Boolean(repoKey(a)) && repoKey(a) === repoKey(b);
const ownRepo = (slug: any) => appOwnRepo(slug, cfg.agentsOrg, cfg.productRepo);
const ghoMerge = async (slug: any, extra?: any, perms = WRITE) => mergeOptions(await appFor(slug), slug, { agentsOrg: cfg.agentsOrg, productRepo: cfg.productRepo }, perms, extra);
/** A re-run's token: only this (the App needs Actions: write; without it the re-run is refused and the check's failure stands). */
const RERUN: any = { actions: "write" };
/** The design review's pending status needs Commit statuses: write (the App's merge token has them read-only). */
const STATUS = { ...WRITE, statuses: "write" };
/** Commit identity for agents and landed commits: the App's bot, else "AidenHQ agent"; never the owner's. */
const botIdentity = async () => (app ? await app.identity().catch((err: any) => (log("github app identity failed", { err: String(err.message).slice(0, 200) }), DEFAULT_IDENTITY)) : DEFAULT_IDENTITY);
if (app) {
  const pushPerms = (slug: any, write: any) => pushPermissions(write, slug, cfg.agentsOrg, cfg.productRepo);
  setGitAuth({
    cacheRoot: join(cfg.workDir, "repos"),
    token: async (slug: any, write: any) => (await appFor(slug))?.token(slug.split("/")[0], { repositories: [slug.split("/")[1]], permissions: pushPerms(slug, write) }),
  });
  log("github app on", { agents_org: cfg.agentsOrg });
}
// The task folders' clones are the agents' to write (.git included): the runner's git scrubs their config before using them.
setUntrusted({ tasksDir: join(cfg.workDir, "tasks"), hooksDir: join(cfg.workDir, ".guard-hooks") });
const logsDir = join(cfg.stateDir, "logs");
mkdirSync(logsDir, { recursive: true, mode: 0o700 });

const running = new Map(); // issueId → { controller, jobId, identifier, startedAt, info, pid (its run going), finishing }
// Aborted on a restart: the runs going on stop being followed here and are left to the next runner, which adopts them.
const detach = new AbortController();
const queue: any = []; // { issue, instructions }
const metrics = createMetrics(); // the monitoring module's runner metrics (metrics.ts)
// The engines the enabled modules provide (config/engines.json): how agents.mjs picks and names them.
useEngines(readEngines(cfg));
const boardApi: any = (() => {
  try {
    return new Board(cfg.boardInternalUrl, cfg.boardTokenFile, cfg.reviewerKeyFile);
  } catch (err: any) {
    log("board unreachable: no board token (recurring tasks and the Agents view are off)", { err: String(err.message ?? err).slice(0, 200) });
    return undefined;
  }
})();
const board: any = cfg.recurring?.enabled === false ? undefined : boardApi;
// The loop brake: every runner comment is reported to the board, which cancels its wake past the daily limit on that task.
if (boardApi) pc.posted = (issueId, commentId) => void boardApi.post("/internal/wake-check", { issue: issueId, comment: commentId }).catch((err: any) => log("wake check failed", { err: String(err.message ?? err).slice(0, 200) }));

export { RERUN, STATUS, app, appFor, board, boardApi, botIdentity, cfg, detach, evalSandbox, execFileP, gho, ghoMerge, jobsApi, log, logsDir, metrics, ownRepo, pc, queue, running, sameRepo, state };
